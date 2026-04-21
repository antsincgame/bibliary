# Bibliary

Vector knowledge base for UX, SEO, copywriting and UI design concepts.
Stores expert knowledge as embeddings in Qdrant and serves it via RAG-augmented chat through LM Studio.

## Architecture

```
src/                   TypeScript core — embedding, loading, search, RAG chat
electron/              Electron desktop app (main process, IPC, preload)
electron/lib/
  ├─ resilience/       Phase 2.5R — общая платформа отказоустойчивости
  │                    (atomic-write, file-lock, checkpoint-store, telemetry,
  │                     batch-coordinator, watchdog, lm-request-policy)
  ├─ token/            TokenBudgetManager + JSON-Schema + ContextOverflowGuard
  └─ prompts/          FsPromptStore (data/prompts/*.json/md, editable из UI)
electron/defaults/     Bundled дефолтные prompts (копируются при первом запуске)
renderer/              Frontend — HTML/CSS/JS chat UI
renderer/components/   resume-banner, resilience-bar (UI Phase 2.5R)
scripts/               CLI utilities (export, dedup, inventory)
scripts/test-*.ts      Acceptance-tests resilience-блока (см. ниже)
scripts/test-lib/      Mock LM Studio HTTP server для тестов
data/concepts/         JSON concept files (the knowledge base)
data/finetune/         Dataset workspace (chunks, batches, gold, checkpoints)
data/telemetry.jsonl   Structured event log (rotating > 50 МБ)
data/prompts/          User-editable prompts (mechanicus + dataset-roles)
docs/RESILIENCE.md     Подробное описание Resilience Layer
```

См. [docs/RESILIENCE.md](docs/RESILIENCE.md) для полной картины Phase 2.5R.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (for Qdrant)
- [LM Studio](https://lmstudio.ai/) (local LLM inference)
- Node.js 20+

## Quick start

```bash
# 1. Start Qdrant
docker compose up -d

# 2. Install dependencies
npm install

# 3. Create .env from template
cp .env.example .env

# 4. Initialize collection and load concepts
npm run init
npm run load -- data/concepts/some-file.json

# 5. Search or chat
npm run search -- "responsive navigation patterns"
npm run chat
```

## Electron app

```bash
npm run electron:dev     # development
npm run electron:build   # production build (.exe)
```

## Dataset generator

Превращает `source-chunks.json` в JSONL-датасет (T1/T2/T3 на каждый chunk) для fine-tuning.

```bash
# UI (через Electron) или CLI:
npx tsx scripts/generate-batch.ts --batch-size 15 --delay-ms 0 --few-shot 2 --context 32768
```

UI и CLI используют **общий engine** — `dataset-generator.ts` поверх Phase 2.5R платформы.
Ключевые гарантии: per-chunk atomic save, mid-batch resume, watchdog при offline LM Studio,
graceful shutdown с non-zero exit code при потере данных.

Подробности — [docs/RESILIENCE.md](docs/RESILIENCE.md).

## Acceptance tests (Phase 2.5R)

```bash
npx tsx scripts/test-platform.ts          # 12 — atomic, lock, checkpoint, telemetry
npx tsx scripts/test-token.ts             # 16 — budget, GBNF schema, overflow-guard
npx tsx scripts/test-resume-batch.ts      # 9  — startBatch, append, integrity recovery, race
npx tsx scripts/test-graceful-shutdown.ts # 4  — flushAll ok / timeout / empty
npx tsx scripts/test-watchdog.ts          # 5  — через mock LM Studio (~35s)
npx tsx scripts/test-roles-shape.ts [N]   # требует живой LM Studio + загруженная модель
```

41 unit-тест без LM Studio + 1 интеграционный с живым LLM. Все скрипты возвращают exit 0
при успехе, 1 при провале — пригодно для CI.

## Data scripts

| Command | Description |
|---------|-------------|
| `npm run export` | Export all Qdrant points to `data/_export-all.json` |
| `npm run duplicates` | Find near-duplicate concepts by vector similarity |
| `npm run inventory` | Generate `data/_inventory.md` from exported data |
| `npm run generate-batch` | CLI dataset generator (см. выше) |
| `npm run validate-batch` | Валидация JSONL батча против схемы |

## Concept schema

Each concept is a JSON object validated by Zod:

```json
{
  "principle": "Action-oriented rule (3-300 chars)",
  "explanation": "MECHANICUS-encoded instruction (10-2000 chars)",
  "domain": "ui | ux | web | mobile | seo | copy | perf | arch | research",
  "tags": ["kebab-case", "specific", "subtopic"]
}
```

## License

MIT
