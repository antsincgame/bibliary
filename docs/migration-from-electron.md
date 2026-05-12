# Migrating from legacy Electron Bibliary to the web service

This guide is for users running the old Windows Electron desktop build
who want to move their library + concepts to the multi-user web
service.

> The Electron build is **frozen but not deleted** as of Phase 13.
> Renderer-side legacy is gone (5 dataset-v2 files + batch-actions);
> the scanner core under `electron/lib/scanner/` is still consumed at
> runtime by the web server via `parsers-bridge.ts`. You can no longer
> build the Electron `.exe` from this repo, but the parser code lives
> on inside the web pod.

---

## What carries over vs. what you re-do

| Asset | Carries over? | How |
|-------|---------------|-----|
| **Books (source files)** | Yes — manually | Drag-drop from disk into the web UI |
| **Markdown conversions** | No — re-converted on import | Web pod runs the same parsers |
| **Concepts / DeltaKnowledge** | Yes — via JSONL export | Old Electron app had a "Dataset → Export JSONL" path |
| **Embeddings** | No — re-computed | Web uses multilingual-e5 in sqlite-vec; old build used LanceDB |
| **Evaluator scores** | No — re-run | New `qualityScore + isFictionOrWater` schema is web-only |
| **API keys** | No — re-enter | Different encryption scheme; you'll paste keys in Settings → Providers |
| **Settings** | No — defaults | Web is multi-user, per-user provider role assignments |

---

## Step 1 — Export concepts from old Electron build

In the old desktop app, open **Dataset → Export → JSONL**. Save the
output `.jsonl` somewhere — you'll re-import it in step 4 (optional).

Each line is a DeltaKnowledge object with the same schema the web
service emits (`domain / essence / cipher / proof / relations[] /
tags[]`). The schemas are intentionally compatible.

---

## Step 2 — Deploy the web service

Follow [`docs/deployment.md`](deployment.md). For a 2 vCPU / 2 GB VPS
the modest-server tuning section gets you running in ~30 minutes.

---

## Step 3 — Register + configure providers

1. Open `https://bibliary.your-domain.tld`.
2. Register the first account — it auto-becomes admin.
3. Go to **Settings → Providers**.
4. Paste your Anthropic / OpenAI key, or point to your LM Studio URL.
5. Click **Test** for each — you should see "OK · N models · …".
6. Assign roles:
   - **evaluator** → a reasoning-capable model (Claude Sonnet, GPT-4o,
     a 14B+ thinking LLM in LM Studio)
   - **crystallizer** → same or a 7B+ thinking model
7. Pre-seed `BIBLIARY_ADMIN_EMAILS` in `.env` *before* opening to
   public registration if you want more than one admin.

---

## Step 4 — Bulk import your library

1. Open the **Library** tab.
2. Drag-and-drop a folder of books onto the catalog. The import
   pipeline parses each file → markdown → chunks → ready for
   evaluation.
3. Select all imported books → click **Evaluate**. Each book gets a
   quality score 0-10 and an `isFictionOrWater` flag.
4. Filter by `qualityScore ≥ 5` (or higher) and `isFictionOrWater = false`.
5. Select the filtered books → click **Crystallize** → enter a
   collection name (e.g. `training-v1`).
6. Watch the queue progress through the Audit / Jobs admin tabs.

For a 50-book batch against Claude Sonnet, expect ~30-60 minutes of
LLM time. The queue is async + crash-safe — close the browser, come
back later.

---

## Step 5 — (Optional) Import legacy concepts

The web service exposes ingestion via the standard `POST /books/:id/extract`
flow, not a "load this JSONL" endpoint. If you have a large pile of
concepts from the Electron build and want them in your web library
without re-running the LLM, you have two options:

**Option A — re-extract** (recommended). Just re-import the books and
let the crystallizer run again. Δ-topology adds entity graph + L2
summaries + L0 propositions that the old build never produced.

**Option B — direct Appwrite insert** (advanced). Write a one-off
script that creates `concepts` documents for each line of the legacy
JSONL with `userId`, `bookId`, `collectionName`, `payload` (the line
itself), `accepted: true`, `vectorRowId: null`. You'll get the
concepts but lose the embeddings + graph layer.

---

## Step 6 — Export your dataset

Once crystallization finishes:

1. Go to **Datasets** tab.
2. Click **Build new** → pick collection + format (JSONL / ShareGPT /
   ChatML).
3. ShareGPT / ChatML formats fan out each concept into multi-tier Q&A
   (T1 surface / T2 applied / T3 synthesis) via the crystallizer
   provider; expect another ~10-30 minutes.
4. Download `.jsonl` from the history list.

---

## What you give up

- **Native shell integration** — no system file dialog, no
  "Open in Finder" / "Reveal in Explorer" buttons. Web is browser-
  bound; downloads go through the standard browser UI.
- **Offline first-run** — Appwrite + the embedder model fetch on
  first start. Pre-warm in your build pipeline if your target
  environment is air-gapped.
- **System OCR** (`@napi-rs/system-ocr`) — Windows.Media.Ocr was
  available in Electron; Linux Coolify falls back to the bundled
  Tesseract.

---

## What you gain

- **Multi-user** — invite collaborators with their own provider keys.
- **Audit log** — every admin action and every burn-all is auditable.
- **Admin panel** — per-user storage, queue depth, job cancellation
  from one screen.
- **Δ-topology** — L0 / L1 / L2 retrieval grain + entity graph + PPR
  search. The legacy build had concepts and a flat vector index;
  the web service has a knowledge graph.
- **Streaming chapter splitter** — peak RAM is O(largest unit) instead
  of O(book); 500 MB markdown files no longer OOM the pod.
- **CI** — Linux-only test pipeline; no more Windows-NTFS flake.

---

## If something breaks

- Bibliary's primary diagnostic is the **Audit** admin tab plus
  `docker compose logs -f bibliary` from the host.
- Submit issues at the repo — include the user-id of the affected
  account, the action that failed, and the matching audit row.
- The whole Electron build is preserved in git history; you can
  always check out a pre-Phase-13 tag if you need the legacy desktop
  workflow back temporarily.
