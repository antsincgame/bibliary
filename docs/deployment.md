# Bibliary — Web Deployment (Coolify / Docker)

Single backend container (Hono + Vite-built renderer) + Appwrite
self-hosted stack (Database + Storage + Realtime). All state lives
in Appwrite + a `/data` volume for sqlite-vec.

## Quick start (local Docker)

```bash
cp .env.example .env
# Edit .env: fill APPWRITE_PROJECT_ID, APPWRITE_API_KEY, JWT_PRIVATE_KEY_PEM,
# JWT_PUBLIC_KEY_PEM, BIBLIARY_ENCRYPTION_KEY (see helper commands below).

# Generate JWT keypair:
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
# Then base64-encode or paste contents into JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM.

# Generate AES master key:
openssl rand -hex 32

docker compose -f docker-compose.prod.yml up -d

# First-time Appwrite bootstrap:
#   1. open http://localhost/console
#   2. Create project "Bibliary" → copy project ID → APPWRITE_PROJECT_ID
#   3. Create API key with full databases.* + storage.* + users.* scopes
#      → APPWRITE_API_KEY
#   4. Restart backend so it picks up new env: `docker compose restart bibliary`
#   5. Bootstrap collections + buckets:
#      docker compose exec bibliary npm run appwrite:bootstrap

# Use the app:
open http://localhost:3000
```

First-registered user automatically becomes `admin` (no special prompt
required). Optionally pre-seed admins via `BIBLIARY_ADMIN_EMAILS=a@x,b@y`.

## Coolify deployment

1. **Create new application** in Coolify pointing to this repo + branch.
2. **Build pack**: Dockerfile (auto-detected).
3. **Port**: `3000`.
4. **Persistent volume**: mount `/data` (sqlite-vec + temps).
5. **Environment variables** — copy from `.env.example`, fill in:
   - `APPWRITE_ENDPOINT` (e.g. `https://appwrite.your-domain.tld/v1`)
   - `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`
   - `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM` — Coolify supports
     multi-line values via the UI.
   - `BIBLIARY_ENCRYPTION_KEY` — 64-char hex.
   - `COOKIE_SECURE=true` (Coolify serves over HTTPS through Traefik).
   - `CORS_ORIGINS=https://bibliary.your-domain.tld` (no Vite port —
     served same-origin in prod).
6. **Appwrite separately** — Coolify has an official Appwrite service
   template. Spin it up, configure project + API key, point Bibliary
   backend at it via env.
7. **Coolify webhooks** — auto-deploy on push to `main` (or your
   release branch).

## Production hardening checklist

- [ ] `COOKIE_SECURE=true` + HTTPS via Coolify/Traefik.
- [ ] Strong `BIBLIARY_ENCRYPTION_KEY` (rotation requires re-wrap of
      `providerSecretsEncrypted` for every user — not yet automated).
- [ ] `_APP_STORAGE_LIMIT` env on Appwrite ≥ max book size (default
      5 GB in this compose).
- [ ] Reverse-proxy timeout > 30s (long-running SSE event stream).
      Traefik default 60s — OK.
- [ ] Disk quota on `/data` volume (sqlite-vec может расти).
- [ ] Backup strategy: Appwrite MariaDB dumps + `/data/vectors.db`.

## What's NOT yet wired in this image

- Phase 6c: consumers (book-evaluator, dataset-v2 extractor) ещё
  используют legacy LM Studio path внутри `electron/lib/`. До wire-up
  через `withProvider()` per-user provider настройки доступны через UI,
  но crystallization/evaluation идут только через LM Studio.
- Phase 5: ингест-пайплайн пишет в Appwrite, но evaluator queue + dataset-v2
  ещё работают поверх legacy SQLite — для multi-user это разделение
  не критично (impacts admin features, не данные пользователя).
- Phase 9: full admin panel — пока виден только базовый Settings.

## Diagnostics

```bash
# Backend health
curl http://localhost:3000/health

# Container shell
docker compose -f docker-compose.prod.yml exec bibliary sh

# Tail logs
docker compose -f docker-compose.prod.yml logs -f bibliary

# Re-run Appwrite bootstrap (idempotent — повторно безопасно)
docker compose exec bibliary npm run appwrite:bootstrap
```
