# Bibliary

Vector knowledge base for UX, SEO, copywriting and UI design concepts.
Stores expert knowledge as embeddings in Qdrant and serves it via RAG-augmented chat through LM Studio.

## Architecture

```
src/              TypeScript core — embedding, loading, search, RAG chat
electron/         Electron desktop app (main process, IPC, preload)
renderer/         Frontend — HTML/CSS/JS chat UI
scripts/          Data utilities — export, dedup, inventory
data/concepts/    JSON concept files (the knowledge base)
```

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

## Data scripts

| Command | Description |
|---------|-------------|
| `npm run export` | Export all Qdrant points to `data/_export-all.json` |
| `npm run duplicates` | Find near-duplicate concepts by vector similarity |
| `npm run inventory` | Generate `data/_inventory.md` from exported data |

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
