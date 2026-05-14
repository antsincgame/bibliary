# Golden corpus benchmark — scaffold

This directory holds **reference book parses** that the
`tests/golden-corpus.test.ts` test runner compares against the current
scanner output. It exists so that any future change to the scanner
pipeline (mupdf swap, MinerU sidecar, Phase 13c full migration) can be
verified for regressions instead of blind-merged.

The directory ships **empty** in git (only this README). Books and
their reference outputs are added by the operator on a machine with
disk + the source books, then optionally committed to a fork or kept
local.

---

## Why empty?

- **Copyright** — most useful test books are not public-domain.
  Committing them in-repo would be a license trap.
- **Size** — even modest fixtures (PDF + scanned DJVU + EPUB) easily
  exceed 100 MB. Inflates clones.
- **Operator-specific** — your golden books should match your real
  corpus (Russian classics? CJK textbooks? academic PDFs?).

---

## Adding a book to the corpus

```
tests/golden-corpus/
├── README.md                 (this file)
├── fixtures/
│   ├── 01-rus-classic.epub   (the book)
│   ├── 01-rus-classic.ref.md (your verified-correct markdown)
│   └── manifest.json         (one entry per fixture)
└── ...
```

`manifest.json` shape:

```json
[
  {
    "name": "01-rus-classic.epub",
    "format": "epub",
    "language": "rus",
    "referenceMarkdown": "01-rus-classic.ref.md",
    "minSimilarity": 0.95,
    "notes": "Project Gutenberg #N — Tolstoy 'War and Peace' vol 1"
  }
]
```

### Generating the reference markdown

The first time you add a book:

1. Run the current scanner against it via the helper script (next
   section).
2. Open the output markdown manually. Verify it's "correct enough" by
   skim:
   - Chapters split right (H1/H2/H3 reasonable)
   - No leaked PDF furniture (page numbers, running headers)
   - Cyrillic / CJK glyphs intact (no mojibake)
   - Tables / figures degraded gracefully (text content survives even
     if formatting drops)
3. Commit the markdown next to the book as `<name>.ref.md`.

After that, the test runner compares the live parser output against
this reference using Levenshtein-similarity (token level).

### Helper scripts (shipped)

A generator + a runner, plus a shared `harness.ts` so both render a
parse through the exact same code path:

```bash
npm run golden:generate             # (re)generate every .ref.md
npm run golden:generate 01-x.epub   # just the named fixture(s)
npm run golden:check                # run the regression gate
```

`golden:generate` parses each fixture with the current scanner and
writes its rendered parse to `<name>.ref.md`. Hand-verify each one (the
checklist above) before committing — that verified snapshot is the gate.

---

## What the test runner enforces

`tests/golden-corpus.test.ts` walks every entry in
`fixtures/manifest.json` and:

1. Calls `parseBook(fixture.path)`
2. Reads the reference markdown
3. Computes a similarity score (Levenshtein-normalized, 0..1)
4. Asserts `similarity >= fixture.minSimilarity`

A typical threshold is 0.95. Below that, the test fails with a diff
preview pointing at the divergent region.

The runner is **not registered** in the required CI step. It's intended
to be invoked manually before/after a scanner change:

```bash
npm run golden:check
```

If a scanner change is planned, the workflow is:

1. **Baseline** — run the runner against the current scanner. Should
   all pass (or you've already accepted some regressions).
2. **Change** — make the scanner modification.
3. **Diff** — re-run. Any new fails are regressions.
4. **Decide** — either revert, or accept and update the reference if
   the new output is genuinely better.

---

## Recommended initial corpus

A useful golden corpus has 15-20 books covering the format zoo:

| # | Format | Language | Focus |
|---|--------|----------|-------|
| 1 | PDF (text-layer) | rus | Cyrillic OCR-free baseline |
| 2 | PDF (scanned) | rus | Tesseract OCR cascade |
| 3 | PDF (academic) | eng | Multi-column + figures |
| 4 | PDF (mixed) | chi-sim | CJK + Latin mix |
| 5 | EPUB | rus | NCX nav, classic literature |
| 6 | EPUB | eng | CSS-heavy, modern tech book |
| 7 | EPUB | eng | Broken NCX → spine fallback |
| 8 | DJVU | rus | Scanned book, vertical text |
| 9 | DJVU | eng | Old scientific paper |
| 10 | CHM | eng | Microsoft Compiled HTML |
| 11 | FB2 | rus | Nested sections |
| 12 | DOCX | rus | Heading style mapping |
| 13 | MOBI | eng | Amazon ebook |
| 14 | RTF | rus | Rich Text Format |
| 15 | HTML | rus | Webpage saved as HTML |

Get them from Project Gutenberg, Internet Archive, ЛитРес free.
Document the source URL in `manifest.json` notes.

---

## Cost estimate

Setting up the initial 15-book corpus: **4-6 hours** for one operator.
Once it exists, every scanner change becomes a 30-second verification
run instead of "ship and pray".
