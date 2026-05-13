# Bibliary — Deployment (Coolify / Docker)

Single backend container (Hono + Vite-built renderer) + an Appwrite
self-hosted stack (Database + Storage + Realtime). All state lives in
Appwrite + a `/data` volume for sqlite-vec.

This guide targets a **modest single-pod deployment** (2-4 vCPU,
2-4 GB RAM). No GPU, no Python sidecars.

---

## Prerequisites

- Linux host with Docker 24+ and `docker compose` v2.
- (Optional) [Coolify](https://coolify.io/) installed for managed
  deploy + SSL termination via Traefik.
- A domain pointing at the host (Coolify provisions Let's Encrypt
  automatically).

---

## Local Docker quick start

```bash
cp .env.example .env

# 1. JWT keypair (RS256 access tokens, 15-min TTL)
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
# Paste contents into JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM in .env
# (Coolify supports multi-line env values via the UI.)

# 2. AES master key for per-user provider secrets:
openssl rand -hex 32
# Paste into BIBLIARY_ENCRYPTION_KEY

# 3. Bring up the stack:
docker compose -f docker-compose.prod.yml up -d

# 4. First-time Appwrite bootstrap:
#    a. open http://localhost/console
#    b. Create project "Bibliary" → copy project ID → APPWRITE_PROJECT_ID
#    c. Create API key with full databases.* + storage.* + users.* scopes
#       → APPWRITE_API_KEY
#    d. Restart backend so it picks up new env:
docker compose -f docker-compose.prod.yml restart bibliary

# 5. Idempotent collection + bucket creation:
docker compose exec bibliary npm run appwrite:bootstrap

# 6. Use the app:
open http://localhost:3000
```

The first user to register at `http://localhost:3000` automatically
becomes admin. Optionally pre-seed admins via
`BIBLIARY_ADMIN_EMAILS=alice@x,bob@y` in `.env`.

---

## Coolify deployment

1. **Create new application** in Coolify pointing to this repo + branch.
2. **Build pack**: Dockerfile (auto-detected).
3. **Port**: `3000`.
4. **Persistent volume**: mount `/data` — sqlite-vec + temporary files.
5. **Environment variables** — copy from `.env.example`, fill in:
   - `APPWRITE_ENDPOINT` (e.g. `https://appwrite.your-domain.tld/v1`)
   - `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`
   - `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`
   - `BIBLIARY_ENCRYPTION_KEY` — 64-char hex
   - `COOKIE_SECURE=true` (Coolify serves over HTTPS through Traefik)
   - `CORS_ORIGINS=https://bibliary.your-domain.tld`
6. **Appwrite separately** — Coolify has an official Appwrite service
   template. Spin it up, configure project + API key, point Bibliary
   backend at it via env.
7. **Coolify webhooks** — auto-deploy on push to `main` (or your
   release branch).
8. **Bootstrap** — once the container is healthy, run
   `npm run appwrite:bootstrap` once from the Coolify terminal.

---

## Modest-server tuning

For a 2 vCPU / 2 GB RAM host:

### Bibliary backend container
- Set Docker memory limit to **1.5 GB** to keep MariaDB / Redis room.
- Set `NODE_OPTIONS=--max-old-space-size=1024` if you see OOM on
  large book extractions.
- The embedder model (`Xenova/multilingual-e5-small`, ~120 MB)
  cold-loads on first use; warm it by hitting `/api/datasets/search?q=x`
  after deploy.

### Appwrite stack
- The bundled Appwrite docker-compose runs MariaDB + Redis +
  multiple Appwrite containers. Stock config wants ~1 GB+ RAM.
- For low-RAM hosts, tune:
  ```yaml
  _APP_OPTIONS_FORCE_HTTPS: enabled
  _APP_WORKER_PER_CORE: 1   # default 6 — way too many on a 2-vCPU box
  ```
- Storage limit per book: `_APP_STORAGE_LIMIT=104857600` (100 MB).
  Bump if you regularly upload large scanned PDFs.

### Long extractions
- Per-book extraction is dominated by LLM latency, not local compute.
  A 200-chunk book against Claude Sonnet runs ~5-10 minutes.
- The queue heartbeats every 30 s; stale detection at 5 min reclaims
  orphaned `running` jobs on boot.
- Reverse-proxy timeout must be > 30s for SSE streams. Traefik's
  default 60s is fine; nginx defaults to 60s.

---

## Production hardening checklist

- [ ] `COOKIE_SECURE=true` + HTTPS via Coolify/Traefik. *(Boot now
      fails if false when `NODE_ENV=production`.)*
- [ ] `JWT_PRIVATE_KEY_PEM` + `JWT_PUBLIC_KEY_PEM` set. *(Boot fails
      if missing in production.)*
- [ ] Strong `BIBLIARY_ENCRYPTION_KEY` (≥32 chars). *(Boot fails if
      missing in production.)* Rotation requires re-wrap of
      `providerSecretsEncrypted` for every user — not yet automated.
- [ ] Seed the first admin via initial register, then set
      `BIBLIARY_REGISTRATION_DISABLED=true` to close public sign-ups.
      Existing users keep working.
- [ ] `BIBLIARY_UPLOAD_MAX_BYTES` (default 200 MB) — tune up if your
      corpus has giant scanned PDFs; tune down to constrain abuse.
- [ ] Reverse proxy MUST strip caller-supplied `X-Forwarded-For` and
      replace with the real client IP. Bibliary trusts the first
      entry for audit log + rate limiter; without a proxy, attackers
      can spoof the header. Coolify's Traefik handles this correctly
      out of the box.
- [ ] `_APP_STORAGE_LIMIT` env on Appwrite ≥ max book size
- [ ] Reverse-proxy timeout > 30s (SSE event stream)
- [ ] Disk quota on `/data` volume (sqlite-vec grows with embedded
      chunks)
- [ ] Backup strategy: Appwrite MariaDB dumps + `/data/vectors.db`
      (+ WAL + SHM companion files)
- [ ] GDPR: audit log captures IP + user-agent. Indefinite retention
      by default. If your jurisdiction requires bounded retention,
      add a periodic prune query against `audit_log` collection
      filtered on `createdAt < now - N days`.

## Health probes

Bibliary exposes two health endpoints with different semantics:

| Endpoint | Behavior | Use for |
|----------|----------|---------|
| `GET /health/live` | Always 200 if process is alive. No dependency probes. | Liveness probe (restart-on-failure orchestration) |
| `GET /health` | Probes Appwrite + sqlite-vec concurrently. Returns 200 only when both reach within 2.5s; 503 + `{ checks }` map otherwise. | Readiness probe (route-or-drain orchestration). **This is what Coolify's healthcheck should hit.** |

Default Dockerfile `HEALTHCHECK` hits `/health` already — broken
Appwrite correctly drops the pod from rotation.

---

## Operator surface

After deploy, the **Admin** sidebar icon appears for users with
`role=admin`. Four tabs:

- **Users** — list / promote / demote / deactivate / reactivate / delete
- **Jobs** — cross-user job listing (filter by state), in-process queue
  depth, admin-cancel override
- **Storage** — per-user storage usage (originals + markdown + covers +
  dataset exports). Walks Appwrite Storage with an 8s budget; partial
  results flagged.
- **Audit** — `audit_log` viewer with action-filter (auth.login,
  admin.user.*, library.burn_all, admin.job.cancel)

All `/api/admin/*` endpoints are server-side gated by
`requireAuth + requireAdmin`; the sidebar icon visibility is
defense-in-depth, not the security boundary.

---

## Diagnostics

```bash
# Backend health
curl https://bibliary.your-domain.tld/health

# Container shell
docker compose -f docker-compose.prod.yml exec bibliary sh

# Tail logs
docker compose -f docker-compose.prod.yml logs -f bibliary

# Re-run Appwrite bootstrap (idempotent)
docker compose exec bibliary npm run appwrite:bootstrap

# Inspect sqlite-vec inside the pod
docker compose exec bibliary sqlite3 /data/vectors.db ".schema"
docker compose exec bibliary sqlite3 /data/vectors.db \
  "SELECT level, COUNT(*) FROM chunks GROUP BY level"
```

---

## CI

The repository ships with `.github/workflows/ci.yml` — Linux-only,
Node 22, installs djvulibre + p7zip + tesseract-ocr (rus / ukr /
chi-sim / chi-tra). Required step is the Δ-topology smoke suite
(~170 tests); a best-effort step runs the full `tests/*.test.ts` and
won't block merge on pre-existing legacy failures.

No Windows pipeline — the Electron build path was retired in
Phase 13b.
