# Bibliary — Release Deploy Instruction

Copy-paste runbook for deploying Bibliary from scratch on a fresh
Linux host. Two paths covered:

- **Local Docker** — verify the image on your laptop / dev box first
- **Coolify** — production deploy with auto-SSL + webhooks

Each step has a verification command. If a verification fails, stop and
read the troubleshooting section at the bottom before proceeding.

---

## 0. Prerequisites

Host requirements (modest-server target):

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU      | 2 vCPU  | 4 vCPU |
| RAM      | 2 GB    | 4 GB |
| Disk     | 20 GB   | 100 GB |
| Network  | 100 Mbps | 1 Gbps |
| OS       | Debian 12 / Ubuntu 22.04+ | same |

Software:

```bash
docker --version       # need 24+
docker compose version # need v2
git --version
openssl version
```

If any is missing, install via your distro's package manager.

For **Coolify** path you ALSO need:

- Domain pointing at your host (A or AAAA record)
- Coolify already installed (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`)

---

## 1. Clone + generate secrets

```bash
git clone https://github.com/antsincgame/bibliary.git
cd bibliary
git checkout claude/refactor-library-web-app-xHXXo   # or main once merged

cp .env.example .env
```

### 1a. Generate JWT keypair (RS256)

```bash
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

Paste contents into `.env`:

```bash
# Linux/macOS shell-safe paste — single-quotes preserve newlines
echo "JWT_PRIVATE_KEY_PEM='$(cat jwt-private.pem)'" >> .env
echo "JWT_PUBLIC_KEY_PEM='$(cat jwt-public.pem)'" >> .env
```

For Coolify UI: paste the PEM contents directly into the multi-line
env-var field (Coolify supports it).

### 1b. Generate AES master key + admin email allowlist

```bash
# 32-byte hex (= 64 chars) for AES-256-GCM master key
ENC_KEY=$(openssl rand -hex 32)
echo "BIBLIARY_ENCRYPTION_KEY=$ENC_KEY" >> .env

# Optional: pre-authorize specific emails as admin on signup
echo "BIBLIARY_ADMIN_EMAILS=you@example.com" >> .env
```

### 1c. Set production essentials in `.env`

Open `.env` and ensure these are set:

```bash
NODE_ENV=production
COOKIE_SECURE=true                  # required when NODE_ENV=production
APPWRITE_ENDPOINT=https://appwrite.your-domain.tld/v1   # set later in §2
CORS_ORIGINS=https://bibliary.your-domain.tld
APPWRITE_PROJECT_ID=                # filled after Appwrite bootstrap (§2)
APPWRITE_API_KEY=                   # filled after Appwrite bootstrap (§2)
```

**Boot will FAIL** if any of these are missing when `NODE_ENV=production`:
- `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`
- `BIBLIARY_ENCRYPTION_KEY` (≥32 chars)
- `COOKIE_SECURE=true`

This is intentional — fail fast instead of 500ing on the first login.

### 1d. Verify .env locally

```bash
# Sanity check — no secret values printed; just keys
grep -E "^[A-Z_]+=" .env | cut -d= -f1 | sort
```

You should see at minimum: `APPWRITE_API_KEY`, `APPWRITE_ENDPOINT`,
`APPWRITE_PROJECT_ID`, `BIBLIARY_ENCRYPTION_KEY`, `COOKIE_SECURE`,
`CORS_ORIGINS`, `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`,
`NODE_ENV`.

---

## 2. Bring up Appwrite

Bibliary stores user accounts, book metadata, dataset jobs, audit
log, and large blobs (originals, markdown, covers, dataset exports)
in Appwrite. Sqlite-vec holds only vectors + the topology graph.

### Local Docker path

```bash
# Brings up Appwrite + MariaDB + Redis + Bibliary backend.
docker compose -f docker-compose.prod.yml up -d

# Wait for Appwrite to become healthy (30-60s):
until docker compose -f docker-compose.prod.yml ps appwrite --format json | grep -q '"Health":"healthy"'; do
  echo "  ...waiting for Appwrite";
  sleep 5;
done
echo "Appwrite is up."
```

### Coolify path

1. Coolify → Services → New → **Appwrite** template
2. Set domain `appwrite.your-domain.tld` and **Deploy**
3. Wait for green status
4. Open `https://appwrite.your-domain.tld/console` in browser
5. Create the initial Appwrite root account

### Both paths — create project + API key

1. Visit `https://appwrite.your-domain.tld/console` (or
   `http://localhost/console` for local Docker)
2. **Create project** named `Bibliary`
3. Copy the **Project ID** → paste into `.env` as `APPWRITE_PROJECT_ID`
4. **Settings → API Keys → Create API key**:
   - Scopes (check all): `databases.read`, `databases.write`,
     `collections.read`, `collections.write`, `documents.read`,
     `documents.write`, `users.read`, `users.write`, `attributes.read`,
     `attributes.write`, `indexes.read`, `indexes.write`, `buckets.read`,
     `buckets.write`, `files.read`, `files.write`
   - Expiration: **Never** (or set a long rotation reminder)
5. Copy the **API Key** → `.env` as `APPWRITE_API_KEY`

### Verify connectivity

```bash
# From your laptop:
curl -sS https://appwrite.your-domain.tld/v1/health -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" | head
# Expect: {"name":"appwrite","ping":...}
```

---

## 3. Bootstrap Bibliary collections + buckets

```bash
# Local Docker: backend container is already running; exec into it
docker compose -f docker-compose.prod.yml restart bibliary    # pick up updated .env
docker compose -f docker-compose.prod.yml exec bibliary npm run appwrite:bootstrap
```

```bash
# Coolify: open Coolify terminal for the Bibliary app, then:
npm run appwrite:bootstrap
```

The bootstrap script is **idempotent** — safe to rerun. Expected
output ends with:

```
[appwrite-bootstrap] OK. 12 collections, 4 buckets.
```

### Verify

```bash
curl -sS http://localhost:3000/health/live | python3 -m json.tool
# Expect: { "ok": true, "version": "2.0.1", ... }

curl -sS http://localhost:3000/health | python3 -m json.tool
# Expect: { "ok": true, "checks": { "appwrite": {"ok": true}, "vec": {"ok": true} } }
```

If `/health` returns 503 with `appwrite.ok=false` — re-check
`APPWRITE_ENDPOINT` / `APPWRITE_API_KEY` in `.env`, then
`docker compose restart bibliary`.

---

## 4. First user → admin

The first user to register against an empty `users` collection
auto-becomes admin. The registration endpoint is mutex-serialized
on single-pod, so two concurrent registers can't both promote.

```bash
# Open the app
xdg-open https://bibliary.your-domain.tld    # or http://localhost:3000

# In the UI: Register tab → email + password (8+ chars)
# You're now admin. Open Settings → you should see the "Admin" tab.
```

Programmatic alternative:

```bash
curl -sS -c cookies.txt \
  -H "Content-Type: application/json" \
  -X POST https://bibliary.your-domain.tld/api/auth/register \
  -d '{"email":"you@example.com","password":"longenoughpassword"}'

# Verify role
curl -sS -b cookies.txt https://bibliary.your-domain.tld/api/auth/me | python3 -m json.tool
# Expect: { "user": { ..., "role": "admin" } }
```

---

## 5. Close public registration

After the first admin is seeded, lock down sign-ups:

```bash
# Append to .env:
echo "BIBLIARY_REGISTRATION_DISABLED=true" >> .env

# Restart backend to pick up:
docker compose -f docker-compose.prod.yml restart bibliary
# OR in Coolify: Redeploy
```

### Verify

```bash
curl -sS -X POST https://bibliary.your-domain.tld/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"intruder@example.com","password":"longenoughpassword"}'
# Expect HTTP 403 + body "registration_disabled"
```

You can still create more admins via Appwrite console → Databases →
users collection → Create Document → set `role: "admin"`. UI-driven
admin creation is a deferred feature (see `FINAL-STATUS.md`).

---

## 6. Configure LLM providers

In the UI: **Settings → Providers**.

For each provider you want to use:

1. Pick **Anthropic** / **OpenAI** / **LM Studio**
2. Paste API key (or LM Studio URL `http://host.docker.internal:1234`)
3. Click **Test** — expect `OK · N models · ...`
4. Repeat for other providers if you want fallback

Then assign roles:

| Role | Recommended models |
|------|--------------------|
| `evaluator`    | Claude Sonnet, GPT-4o, or a 14B+ thinking model in LM Studio |
| `crystallizer` | Claude Sonnet, GPT-4o, or a 7B+ thinking model in LM Studio |

Each user assigns their own provider+model independently — keys are
AES-256-GCM-encrypted at rest, decrypted only in process memory.

---

## 7. Smoke test the full pipeline

```bash
# In the UI: Library → drag-drop a small PDF/EPUB
# Wait until status = "imported"
# Click Evaluate → wait for qualityScore to appear
# Filter qualityScore ≥ 5, isFictionOrWater = false → select → Crystallize
# Enter collection name: "smoke-test-v1"
# Wait for extraction to complete (5-15 min depending on book + LLM)
# Datasets → Build new → JSONL → Download
# Open .jsonl — should contain DeltaKnowledge JSON per line
```

If the extraction stalls:

```bash
# Inspect job state
curl -sS -b cookies.txt https://bibliary.your-domain.tld/api/library/jobs | python3 -m json.tool

# Inspect queue depth (admin-only)
curl -sS -b cookies.txt https://bibliary.your-domain.tld/api/admin/jobs/depth
```

---

## 8. Production hardening checklist

- [ ] `COOKIE_SECURE=true` (boot enforces this in production)
- [ ] JWT keys + AES master key set (boot enforces)
- [ ] `BIBLIARY_REGISTRATION_DISABLED=true` after first admin seeded
- [ ] Reverse proxy (Traefik/Caddy/nginx) strips caller-supplied
      `X-Forwarded-For` — Coolify's Traefik does this by default
- [ ] HTTPS active (Coolify auto-SSL via Let's Encrypt)
- [ ] Backups scheduled:
  - Appwrite MariaDB: `docker compose exec mariadb mysqldump ...`
  - sqlite-vec: copy `data/vectors.db` + `data/vectors.db-wal`
    + `data/vectors.db-shm`
- [ ] Disk quota / monitoring on `/data` volume (vectors.db grows
      with embedded chunks)
- [ ] Reverse-proxy timeout > 30s (SSE event stream needs it)
- [ ] `_APP_STORAGE_LIMIT` env in Appwrite ≥ your largest book file

---

## 9. Operations cheat sheet

```bash
# Inspect health
curl -sS https://bibliary.your-domain.tld/health/live    # always 200 if alive
curl -sS https://bibliary.your-domain.tld/health         # 200 only if deps healthy

# Tail logs
docker compose -f docker-compose.prod.yml logs -f bibliary

# Restart with new .env
docker compose -f docker-compose.prod.yml restart bibliary

# Run Appwrite bootstrap again (idempotent — safe)
docker compose -f docker-compose.prod.yml exec bibliary npm run appwrite:bootstrap

# Inspect sqlite-vec
docker compose -f docker-compose.prod.yml exec bibliary \
  sqlite3 /data/vectors.db "SELECT level, COUNT(*) FROM chunks GROUP BY level"

# Cancel a stuck job (as admin)
curl -sS -b cookies.txt -X POST \
  https://bibliary.your-domain.tld/api/admin/jobs/JOBID/cancel
```

---

## 10. Troubleshooting

### Boot fails: `Invalid environment variables`

The config schema rejected your `.env`. The error message names the
field. Common causes:

- `JWT_PRIVATE_KEY_PEM` empty → step 1a
- `BIBLIARY_ENCRYPTION_KEY` shorter than 32 chars → re-run `openssl rand -hex 32`
- `COOKIE_SECURE=false` while `NODE_ENV=production` → set to `true`
- `APPWRITE_ENDPOINT` not a URL → must include `https://` and `/v1` suffix

### `/health` returns 503 with `appwrite.ok=false`

The backend can't reach Appwrite. Verify:

```bash
# From inside Bibliary container:
docker compose exec bibliary curl -sS $APPWRITE_ENDPOINT/health
```

If Appwrite is reachable but the project ID is wrong:

```bash
docker compose exec bibliary curl -sS \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
  $APPWRITE_ENDPOINT/databases
```

### Embedder cold-start hangs at startup

First boot downloads the multilingual-e5-small ONNX model (~120 MB) to
`data/models/`. With slow network this can take 1-2 minutes. Skip
pre-warming if you'd rather not block boot:

```bash
echo "BIBLIARY_SKIP_EMBEDDER_PREWARM=1" >> .env
```

First `/search` call will pay the cold-start instead. Lazy load works
either way.

### Upload returns 413

Default upload cap is 200 MB. For larger files:

```bash
# Bump to 1 GB
echo "BIBLIARY_UPLOAD_MAX_BYTES=1073741824" >> .env
docker compose -f docker-compose.prod.yml restart bibliary
```

Reverse proxy may have its own cap — check Traefik / nginx config too.

### Extraction stuck in `running` state after server restart

The queue has an automatic orphan-reset: jobs in `running` with
`updatedAt` > 5min old get reset to `queued` on next worker drain.
If a job is stuck longer than that, force-cancel from admin panel
(Admin → Jobs → Cancel).

### "Admin" tab missing in sidebar

You're not an admin. Verify:

```bash
curl -sS -b cookies.txt https://bibliary.your-domain.tld/api/auth/me
# Look for "role": "admin"
```

If you registered before someone else, you should be admin. If not,
have an existing admin promote you via Admin → Users.

### CORS errors in browser console

`CORS_ORIGINS` in `.env` doesn't include the URL the browser is using.
Add it (comma-separated, exact match):

```bash
CORS_ORIGINS=https://bibliary.your-domain.tld,https://www.bibliary.your-domain.tld
```

### `npm audit` shows 1 moderate

`fast-xml-parser` has a moderate CVE in `XMLBuilder` (which Bibliary
doesn't use — we only parse XML, not build it). The fix is in 5.x
which is a breaking change for the scanner parsers. Documented as
known-and-accepted in `FINAL-STATUS.md`.

---

## What's next after deploy

If everything in §3-§7 passed, the service is operational. Common
next steps:

- **Invite more users**: while `BIBLIARY_REGISTRATION_DISABLED=true`,
  add them via Appwrite console → users collection
- **Set up daily backups** for `/data/vectors.db` + Appwrite MariaDB
- **Tune model assignments** per user in Settings → Providers
- **Monitor `/health`** with Uptime Kuma or similar
- **Schedule periodic `audit_log` prune** if GDPR retention applies

For deeper architectural background see [`FINAL-STATUS.md`](FINAL-STATUS.md).
