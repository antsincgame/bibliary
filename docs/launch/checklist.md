# Launch checklist

The bet (from the strategy plan): **reposition + a visual artifact**, on a
clean single-container repo. Stars are a distribution problem, not a code
problem — >90% of repos never pass 100 stars because nobody saw them. This
checklist is the distribution half.

**Already done on this branch:**
- Appwrite removed — the repo is one `docker compose up`, no BaaS.
- README repositioned around the "topology, not flashcards" hook.
- Interactive knowledge-graph view shipped — renders a real sample
  (Darwin's *Origin of Species*) with zero setup.
- Golden-corpus regression harness for the scanner.

**Still yours — the launch acts only you can do:**

## Pre-launch (before anything is public)

- [ ] **Set the repo metadata.** GitHub → repo → About:
  - Description: `Turn book libraries into a topological knowledge graph + LLM fine-tuning datasets — topology preserved, not flattened to Q&A. One container, BYO LLM.`
  - Topics: `llm` `fine-tuning` `training-data` `synthetic-data` `knowledge-graph` `rag` `dataset` `epub` `pdf` `djvu` `ocr` `self-hosted` `sqlite` `topology`
- [ ] **Social-preview image.** Settings → Social preview → upload a
  screenshot of the knowledge-graph view (the Darwin sample looks the
  part). This is the card that renders when the link is shared anywhere.
- [ ] **Demo GIF in the README.** Record the graph view: open `/graph`,
  let the force layout settle, tap a hub node to isolate its
  neighbourhood. 5-10s, looped, near the top of the README.
  (`docker compose up` → http://localhost:3000 → Graph.)
- [ ] **Test `docker compose up` on a clean machine.** The quick-start is
  the single biggest conversion lever — if it fails for a visitor the
  launch is dead. Verify on a fresh box, not your dev machine.
- [ ] **Publish the sample dataset.** Export a dataset from the sample
  library and put it on Hugging Face — a concrete artifact the writeup
  can point to ("here's the output, not just the tool").
- [ ] **Cold-read the README.** Hand it to someone who's never seen it.
  They should understand what it does and how to try it in 30 seconds,
  without scrolling. If not, fix the first screen.
- [ ] **Seed the first 100-300 stars.** Before going public, share the
  repo with people who'd genuinely use it — your network, relevant
  Discords/Slacks, colleagues. A repo at 0 stars on the HN front page
  converts far worse than one at 150. This is reach, not manipulation —
  do NOT buy stars (see "Don't", below).

## Launch day

- [ ] **Timing: Tuesday-Thursday, 08:00-10:00 PT.** Highest HN traffic;
  a full day for the post to build before the US evening.
- [ ] **Post Show HN.** Title + body drafts are in `writeup-draft.md` —
  concrete-number title, first-person and honest body.
- [ ] **Cross-post r/LocalLLaMA** (~686K members — exactly the audience).
  Different framing: "built a thing, feedback welcome", not an ad. Lead
  with the graph screenshot. Draft in `writeup-draft.md`.
- [ ] **Be at the keyboard for the first 2 hours.** Answer every comment
  — fast, substantive replies are what keep an HN post climbing.
- [ ] **Coordinate the spike inside 48h.** Crossing GitHub Trending
  compounds reach: roughly ~50-100 stars/24h hits the language page,
  ~200+/24h hits all-languages. Network seed + HN + Reddit landing in
  the same window is what gets you there.

## Don't

- **Don't buy stars.** ~16.66% of repos with 50+ stars show purchased
  activity, AI/LLM repos are the most scrutinized, and the FTC has fined
  for it. It's detectable and it kills credibility permanently.
- **Don't solicit HN upvotes.** Asking people to upvote a specific HN
  post is detected and flag-kills the post. Share the link; let it ride.

## Track

- Stars per 24h against the Trending thresholds above.
- Honest success metric: **the first 100-500 stars from the launch
  spike** — not overnight virality. Bibliary is a late entrant in a
  crowded space; the wedge is real but execution of the launch is what
  decides it.

## Wave 2 (~2-4 weeks later)

The model "Olympics" (`electron/lib/llm/arena/olympics.ts`) spun out as a
standalone local-LLM extraction benchmark + public leaderboard — a second
launch beat that re-engages r/LocalLLaMA and funnels back to Bibliary.
Scope it as its own plan once launch 1 has landed.
