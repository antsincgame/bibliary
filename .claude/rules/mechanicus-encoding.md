# MECHANICUS Encoding Rules — Bibliary Knowledge Base

## Purpose

Encode editorial wisdom from books into compressed MECHANICUS format for vector storage (Chroma) and LLM system prompt injection via RAG. Each chunk = one retrievable editorial skill.

## Target Collection

Defined in `.env` as `CHROMA_COLLECTION`. Always check `.env` before loading.

## Language: English Only

- `principle` — English. This is the semantic search key.
- `explanation` — English MECHANICUS code. All operators, examples, labels in English.
- `tags` — English lowercase kebab-style.
- Examples inside `eg:` — English shorthand with underscores: `"register_so_we_know_where_to_deliver"`
- NO Russian anywhere. Not in examples, not in comments, not in tags.

## Schema

```json
{
  "principle": "string (3-300 chars) — action-oriented rule, not a definition",
  "explanation": "string (10-500 chars) — MECHANICUS code, strict JSON escaped quotes",
  "domain": "copy | seo | design — choose based on content context",
  "tags": ["string[]", "1-10 tags", "1-50 chars each"]
}
```

Extra fields (`chapter`, `subtopic`) are silently stripped by Zod — do NOT include them.

## MECHANICUS Syntax

```
X.<domain>|rule_name: instruction_chain

Operators:
  ->    sequence / leads to
  >>    transformation (before >> after) — LEFT is bad, RIGHT is good
  +     combine / add
  -     reduces / removes
  ==    equivalence / means
  !=    not equal
  NO:   antipattern (what NOT to do)
  NOT   negation within expression
  eg:   concrete example from the source
  ;     statement separator
```

`<domain>` matches the `domain` field value: `X.copy|`, `X.seo|`, `X.design|`, etc.

## What to Encode: SKILLS, Not Definitions

### CORRECT — Transformation rule with actionable insight:

```
"principle": "Cutting noise makes text cleaner not better — better needs substance added"
"explanation": "X.copy|clean_vs_useful: cut_noise -> cleaner (NOT better NOT more_interesting); better == add_substance; two_separate_steps; NO:stop_after_cutting eg: \"loan_on_best_terms\" -> cleaned_to_nothing -> filled: \"cash_loan_at_X%_card_delivered_to_home_or_office\""
```

### WRONG — Dictionary definition:

```
"principle": "Stop words are filler words that add no meaning"
"explanation": "X.copy|stop_words: definition -> words_without_meaning; examples: obviously, in_general..."
```

### The Test

Ask: "Can a practitioner USE this chunk to TRANSFORM their work right now?"
- YES -> good chunk
- NO, it just explains what something IS -> rewrite as transformation rule

## Chunk Structure Pattern

Each `explanation` follows this skeleton:

```
X.<domain>|rule_label: core_instruction; elaboration; NO:antipattern; eg: "before" >> "after"
```

1. **Domain prefix** — `X.<domain>|` where `<domain>` matches the `domain` field (copy, seo, design, etc.)
2. **Rule label** — 1-3 word camelCase identifier after the prefix
3. **Core instruction** — the main action using `->`, `==`, `+`
4. **Elaboration** — nuance, conditions, consequences (`;` separated)
5. **Antipattern** — `NO:` what the naive approach does wrong
6. **Example** — `eg:` with concrete before `>>` after from the source

## Chunking Strategy

- One chunk per DISTINCT insight (not per page, not per paragraph)
- A 5-page section typically yields 3-7 chunks
- Merge related paragraphs into one chunk if they teach the same skill
- Split if a section teaches two genuinely different techniques

## Quality Checklist

- [ ] Principle is an imperative/declarative RULE, not a noun phrase
- [ ] Explanation encodes HOW to do it, not WHAT a term means
- [ ] `X.<domain>|` prefix matches the `domain` field value
- [ ] At least one `eg:` with before `>>` after (LEFT=bad, RIGHT=good)
- [ ] At least one `NO:` antipattern
- [ ] Zero Russian text anywhere
- [ ] Examples use underscored_english_shorthand
- [ ] All quotes inside `explanation` string MUST be escaped: `\"`
- [ ] Tags are specific to the subtopic, not generic ("stop-words" not "words")
- [ ] Explanation stays under 500 chars — one idea per chunk

## Etalon Reference: Chapter 1

```json
{
  "principle": "Replace bureaucratic text with human specifics",
  "explanation": "X.copy|bureaucratic -> human + specifics; add: weekday + full_words + duration + fallback_plan; human_text -support_calls NO:vague_deadlines eg: \"cold/hot_water_off_until_done\" >> \"water_off_MON_11may_4-6h_tel:XXX\"",
  "domain": "copy",
  "tags": ["clarity", "human-language", "specifics", "editing"]
}
```

## Etalon Reference: Chapter 2 (Stop-words)

```json
{
  "principle": "Hedge clusters signal author insecurity not content subtlety",
  "explanation": "X.copy|hedge_cluster: \"certainly/so_to_speak/of_course/unfortunately/as_they_say\" x5_in_paragraph == author_is_nervous NOT content_is_nuanced; confident_author: state_problem + propose_solution eg: \"certainly_we_must_so_to_speak_review_the_budget\" >> \"review_budget_Q4_or_cash_gap_in_november\"",
  "domain": "copy",
  "tags": ["stop-words", "insecurity", "confidence", "diagnostics"]
}
```

## Loading

```bash
npm run load -- data/concepts/<file>.json
```

UUIDs generated via `uuidv5(principle.toLowerCase().trim())` — changing principle text = new UUID = old entry becomes orphan. Plan cleanup when re-encoding.
