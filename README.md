# Bibliary

> Turn a library of books into a **topological knowledge graph** and
> training-ready datasets — entities, relations and causal chains kept
> intact, not flattened into Q&A pairs.

Most tools that "process books for LLMs" land in one of two buckets:
doc parsers hand you **markdown**, dataset builders hand you **flat
Q&A pairs**. Both throw away the *topology* — which concept causes
which, which entity relates to which, the chain that makes the
knowledge reusable. Bibliary keeps it.

Point it at 35 GB of PDFs, EPUBs and DJVUs and get back a portable
`subject → predicate → object` graph plus JSONL / ShareGPT / ChatML
datasets you can fine-tune on directly.

Runs as **one container** — SQLite + the local filesystem, no external
database, no message broker. `docker compose up` and you're in.

---

## Quick start

```bash
git clone <this-repo> bibliary && cd bibliary
docker compose up --build
# → http://localhost:3000  — register; the first user becomes admin
```

No database to provision, no API keys required just to boot. Bring your
own LLM provider (Anthropic / OpenAI / a local LM Studio) and configure
it per-user in **Settings → Providers** once you're in.

<details>
<summary>Production hardening</summary>

For an internet-facing deployment, set these in `.env` before
`docker compose up` (the app boots fine without them in development):

- `NODE_ENV=production`
- `JWT_PRIVATE_KEY_PEM` / `JWT_PUBLIC_KEY_PEM` — an RS256 keypair
  (`openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048`)
- `BIBLIARY_ENCRYPTION_KEY` — 32+ chars, encrypts per-user provider
  keys at rest (`openssl rand -hex 32`)
- `COOKIE_SECURE=true` — behind HTTPS
- `BIBLIARY_REGISTRATION_DISABLED=true` — once you've seeded your account

</details>

---

## Why topology, not flashcards

A flat Q&A dataset answers *"what"*. A topological one also encodes
*"why"* and *"how it connects"* — and that's the part that makes a
fine-tune reason instead of recite.

- **Topology-preserving extraction** — every accepted concept ships
  with at least one `subject → predicate → object` triple, so the
  dataset is graph-ready with no post-processing.
- **Δ-topology layers** — hierarchy-aware chunking (every chunk carries
  its `H1 > H2 > H3` breadcrumb), L0 propositions / L1 section chunks /
  L2 chapter summaries, plus a canonicalized **entity graph** with
  alias capture and typed relations.
- **AURA filter** — refuses to extract banalities. A concept must
  satisfy ≥2 of *authorship / specialization / revision / causality*
  or the chunk is skipped — so the dataset is signal, not filler.
- **Graph-blended retrieval** — chunk search scores `α·cosine + β·PPR`
  (Personalized PageRank seeded from query entities), tunable per request.
- **Three export formats** — JSONL (atomic), ShareGPT (turn-based),
  ChatML (HuggingFace SFT). Multi-tier Q&A synthesis with Jaccard dedup.

---

## Supported formats

The obvious ones — and the long tail almost nothing else reads:

| Format | Notes |
|--------|-------|
| **PDF** | pdfjs + a Tesseract OCR cascade for scanned pages |
| **EPUB** | OPF spine + NCX nav, with a spine fallback for broken NCX |
| **DJVU** | djvu.js (WASM) + djvulibre CLI fallback; OCR cascade for image DjVu |
| **MOBI / AZW / AZW3 / PDB / PRC** | pure-JS PalmDoc + EXTH / KF8 |
| **FB2** | nested sections |
| **CHM** | Microsoft Compiled HTML (7z + composite-HTML) |
| **DOCX / ODT** | heading-style mapping |
| **RTF** | control-code text extraction |
| **HTML / TXT** | encoding-aware (BOM → meta → chardet) |
| **CBZ / CBR** | comic archives |
| **TIFF / PNG / JPEG** | image-only → OCR pipeline |

OCR is **CPU-only** — native Tesseract for **rus / ukr / eng / chi-sim /
chi-tra**, no GPU and no Python sidecar. A vision-capable LLM (any
provider you've configured) is the Tier-2 fallback.

---

## How it works

```
        ┌────────────────────────────────┐
        │ Browser UI (Vanilla JS + Vite) │
        │   /library  /datasets  /admin  │
        └───────────────┬────────────────┘
                        │ cookie auth + SSE
        ┌───────────────▼────────────────┐
        │     Hono backend (Node 22)     │
        └───────┬────────────────┬───────┘
                │                │
        ┌───────▼──────┐  ┌──────▼───────┐
        │ SQLite       │  │ sqlite-vec   │
        │ documents +  │  │ chunks +     │
        │ file store   │  │ concepts +   │
        │ (bibliary.db)│  │ entity graph │
        └──────────────┘  └──────────────┘
```

Books upload to the local filesystem; metadata, jobs and extracted
concepts live in `bibliary.db`; embeddings and the topology graph live
in `vectors.db` (sqlite-vec). One process, two SQLite files, a `/data`
volume — that's the whole footprint.

The pipeline: **import** (parse → markdown) → **evaluate** (an LLM
scores the book 0-10) → **crystallize** (extract Δ-topology) →
**export** (stream a dataset). It's an async, crash-recoverable queue —
load 100 books, come back later, the dataset is ready; a restart
resumes in-flight jobs cleanly.

---

## LLM providers

Bring your own keys — Bibliary never ships you an inference bill.
Assign a provider per *role* in **Settings → Providers**:

| Role | Does |
|------|------|
| `evaluator` | Scores a book 0-10, flags fiction / filler |
| `crystallizer` | Extracts Δ-topology JSON; also drives L2 summaries + dataset Q&A |

Three interchangeable backends: **Anthropic** (Claude — prompt caching
+ extended thinking), **OpenAI** (GPT-4o / o1 — JSON mode + vision),
**LM Studio** (any OpenAI-compatible local model — Qwen, Llama, …).
Per-user keys are AES-256-GCM encrypted at rest.

---

## Sizing

Built for **one small VPS**, not a cluster:

|        | Minimum | Recommended |
|--------|---------|-------------|
| CPU    | 2 vCPU  | 4 vCPU      |
| RAM    | 2 GB    | 4 GB        |
| Disk   | 20 GB   | 100 GB+     |

Everything CPU-only and in-process: the Hono backend, both SQLite
databases, Tesseract + djvulibre + 7zip, and the ~120 MB
multilingual-e5 ONNX embedder. Heavy LLM inference goes *out* to your
configured provider — it never runs on the Bibliary pod.

---

## Development

```bash
npm install
cp .env.example .env        # boots as-is in development

npm run dev                 # server (tsx watch) + Vite, concurrently
npm run lint                # typecheck + eslint
npm run test:fast:serial    # unit suite (node:test)
npm run build               # server + web bundle
```

`npm run golden:check` runs the
[golden-corpus](tests/golden-corpus/README.md) regression gate for
scanner changes (inert until you add fixtures).

---

## License

MIT — see [`LICENSE`](LICENSE). Bundled dependencies keep their own
licenses; `jszip` is dual-licensed MIT / GPL-3.0-or-later and Bibliary
uses it under MIT.

---

## Acknowledgements

Standing on the shoulders of **GraphRAG** (Microsoft) — entity-merge
inspiration · **RAPTOR** (Stanford) — the bottom-up L2 summary tree ·
**HippoRAG** (OSU NLP) — Personalized PageRank from query entities ·
**LightRAG** (HKUDS) — dual-level entity-merged retrieval ·
**multilingual-e5** (Microsoft / Xenova) — the embedder ·
**sqlite-vec** (Alex Garcia) — the embedded vector store · **Hono** —
the HTTP framework.
