# Launch writeup — drafts

Post copy for the launch. These are 90%-there drafts — edit freely. The
strategy: lead with the visual (the knowledge-graph view) and the
topology-vs-flat-facts angle; stay honest about being a late entrant.

Replace `[link]` and `[screenshot/GIF]` placeholders before posting.

---

## Show HN

### Title — pick one (each carries the concrete number)

- `Show HN: I turned 35GB of my ebooks into a knowledge-graph dataset`
- `Show HN: Bibliary – books to a topological knowledge graph + LLM datasets`
- `Show HN: Extract a knowledge graph (not flashcards) from your book library`

### Body

> I have ~35GB of books — PDFs, EPUBs, a lot of DJVU and other formats
> nothing modern reads — and I wanted to fine-tune models on them. Every
> tool I tried did one of two things: doc parsers gave me markdown, and
> "dataset builders" gave me flat Q&A pairs. Both throw away the
> *topology* — which concept causes which, which entity relates to which.
> That's the part that makes a fine-tune reason instead of recite.
>
> Bibliary keeps it. Point it at a library and it extracts a portable
> `subject → predicate → object` graph plus JSONL / ShareGPT / ChatML
> datasets you can train on directly. There's an interactive view of the
> graph it builds: [screenshot/GIF]
>
> It runs as one container — SQLite + the local filesystem, no external
> database. `docker compose up` and you're in; no keys required just to
> boot (bring your own LLM provider — Anthropic / OpenAI / a local LM
> Studio — for the extraction itself). OCR is CPU-only (Tesseract,
> including Cyrillic + Chinese), and it parses the long tail — DJVU, CHM,
> FB2, MOBI — that most tooling ignores.
>
> Honest context: this space is crowded (Marker, MinerU, LightRAG,
> Easy Dataset, …) and I'm a late entrant. The wedge I care about is the
> one none of them ship: a *portable, topology-preserving training
> dataset*. Doc parsers stop at markdown; GraphRAG tools build topology
> but lock it inside a retrieval index. Bibliary's output is a file you
> own.
>
> Repo: [link]. The graph view ships with a sample (Darwin's *On the
> Origin of Species*) so you can see the shape of the output before
> importing anything. Feedback very welcome — especially on extraction
> quality.

**Notes**
- Keep the "honest context" paragraph. HN rewards candour about being
  late far more than it punishes it; pretending to be first reads as
  naive and invites a pile-on.
- The body is first-person and specific. "I built X because I hit
  problem Y" outperforms "check out my project".

---

## r/LocalLLaMA

Different audience, different framing — not an ad, a "built a thing".
Lead with the image.

**Title:** `Built a tool that turns book libraries into topology-preserving fine-tuning datasets (a knowledge graph, not flat Q&A)`

**Body:**

> [graph screenshot up top]
>
> I kept hitting the same wall building training data from books: the
> parsers give you markdown, the dataset tools give you flat Q&A pairs.
> Neither keeps the *relations* — the causal chains, the entity links,
> the actual structure of the knowledge.
>
> So I built Bibliary. It extracts a `subject → predicate → object`
> graph from a library and exports JSONL / ShareGPT / ChatML. Runs in
> one container on SQLite — `docker compose up`, no BaaS. Bring your own
> LLM (LM Studio works — it's all local if you want it to be).
>
> The screenshot is the built-in sample graph (Darwin's *Origin of
> Species*). Curious what this sub thinks of the extraction approach —
> there's an "AURA" filter that drops banalities (a concept has to clear
> ≥2 of authorship / specialization / revision / causality), and I'm not
> sure I've got the threshold right.
>
> Repo: [link]

**Notes**
- r/LocalLLaMA reacts well to "it's all local if you want" — keep it.
- Ending on a genuine open question ("not sure I've got the threshold
  right") invites the technical thread that keeps a post alive. Don't
  fake it — that really is an open question.

---

## Longer writeup (optional — blog post / GitHub Discussion)

If you want a long-form piece to link from the HN/Reddit posts, expand
the body above with:

- **The 35GB story** — why a personal library, why fine-tuning over RAG.
- **What "topology" buys you** — a worked example: the same chunk as flat
  Q&A vs. as a graph fragment, side by side.
- **The pipeline** — import → evaluate (an LLM scores the book 0-10) →
  crystallize (extract Δ-topology) → export. Async + crash-recoverable.
- **The build** — why SQLite over a BaaS (one container, a modest VPS),
  why CPU-only OCR, the legacy-format long tail.
- **What's not done** — honest limitations; e.g. the scanner core is
  mid-migration behind a golden-corpus regression gate.

Keep it technical and concrete. The writeup *is* the launch artifact.
