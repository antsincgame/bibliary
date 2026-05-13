# syntax=docker/dockerfile:1.7
#
# Bibliary backend image — Hono server + Vite-built renderer, ready
# для Coolify / любой Docker-host'а (single-port HTTP, env-config).
#
# Stage 1 (builder):
#   - Full Node 22 + Debian Bookworm для нативных модулей
#     (better-sqlite3, sqlite-vec).
#   - npm ci (включая devDeps), затем tsc -p tsconfig.server.json + vite build.
#
# Stage 2 (runtime):
#   - Slim Debian с binary dependencies для парсинга (djvulibre, 7zip,
#     tesseract + lang packs RU/UK/EN).
#   - Только runtime-deps в node_modules (npm ci --omit=dev).
#   - Volume mount-points /data (sqlite-vec, temps) и /tmp (per-import).
#
# Health-check бьёт /health (Hono → public route, не требует Appwrite).

ARG NODE_VERSION=22-bookworm
ARG NODE_VERSION_SLIM=22-bookworm-slim

# ─────────────────────────────────────────────────────────────────────
# Stage 1 — builder
# ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# Системные deps для native compile (better-sqlite3 → python+make+g++ при
# отсутствии prebuilt для linux-x64). На Bookworm prebuilt доступен —
# но оставляем toolchain для редких случаев когда npm пересобирает.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Сначала только package.json + lockfile → лучшее использование Docker
# layer cache (если deps не менялись, не пересобираем nm).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# Источники + Vite config (за пределами renderer/).
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY server ./server
COPY renderer ./renderer
COPY shared ./shared
COPY scripts/appwrite-bootstrap.ts ./scripts/appwrite-bootstrap.ts

# Electron/lib пока требуется server-side через parsers-bridge.ts:
# scanner core ещё не выехал в server/lib (Phase 12 prep). До тех пор
# копируем электронные исходники как «runtime data» — без сборки.
COPY electron/lib ./electron/lib

# Vite build кладёт renderer в dist-renderer/, tsc — server в
# dist-server/server/...
RUN npx vite build && npx tsc -p tsconfig.server.json

# ─────────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION_SLIM} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    BIBLIARY_DATA_DIR=/data

# Runtime apt deps:
#   - djvulibre-bin → ddjvu / djvutxt (parsers/djvu-cli.ts)
#   - p7zip-full   → 7z (chm.ts, cbz.ts, archive-extractor.ts)
#   - tesseract-ocr + lang packs → OCR Tier 1a fallback for scanned PDFs.
#     Focus on three families: Cyrillic (rus, ukr), Chinese (chi-sim,
#     chi-tra), English (eng). Each pack ~30MB → 4 packs add ~120MB to
#     the runtime image. Total CPU OCR; no GPU, no Python sidecar.
#   - ca-certificates → HTTPS к Anthropic/OpenAI/Appwrite
RUN apt-get update && apt-get install -y --no-install-recommends \
      djvulibre-bin \
      p7zip-full \
      tesseract-ocr \
      tesseract-ocr-rus \
      tesseract-ocr-ukr \
      tesseract-ocr-eng \
      tesseract-ocr-chi-sim \
      tesseract-ocr-chi-tra \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Production deps only — devDeps уже сделали свою работу в builder.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --omit=dev

# Compiled artifacts из builder.
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/dist-renderer ./dist-renderer
COPY --from=builder /app/electron/lib ./electron/lib

# Strip any stray source maps before they ship — tsconfig.server has
# sourceMap=false and Vite has sourcemap gated on BIBLIARY_RENDERER_SOURCEMAPS,
# but belt-and-braces in case a future config drift re-enables them.
RUN find /app/dist-server /app/dist-renderer -name "*.map" -delete 2>/dev/null || true

# Non-root execution.
RUN useradd --system --uid 1500 --shell /bin/bash --create-home bibliary && \
    mkdir -p /data && chown -R bibliary:bibliary /app /data
USER bibliary

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["node", "dist-server/server/main.js"]
