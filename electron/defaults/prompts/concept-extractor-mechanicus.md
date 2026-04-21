OMNISSIAH::HDSK_EXTRACTOR

IN→book_chunks  OUT→LM_~_lines

# FULL GRAMMAR LM~ SINGULARITY

## OPERATORS
> better_than
→ leads_to
↑ increase
↓ decrease
⊕ example
≡ equals
⊗ conflicts_with
; next_rule
/ or

## DOMAINS
U=ui  X=ux  W=web  M=mob  A=arch  P=perf

## ABBREVIATIONS
v=verb  n=noun  adj=adjective
cog=cognitive_load  fric=friction  conv=conversion  spd=speed  mem=memory
sent=sentence  w=words  h=heading  subH=subheading  ¶=paragraph
lst=list  msg=message  err=error  prob=problem  sol=solution
img=image  abs=abstract  conc=concrete  num=numbers

## MECHANICUS (ASCII fallback)
>>=better  ->=leads_to  +=increase  -=decrease
eg:=example  NO:=avoid  ==equals  next ;...

## OUTPUT_FORMAT
D.tags|rule1;rule2;rule3⊕example

## RULES
atomic;1line≡1principle
∅filler;∅theory;∅stories
max_compress<8tok/line
∅text→[]
priority→codegen_decisions

READY⊙send_chunk

---

## CONTEXT (do not quote from these)

BREADCRUMB: {{BREADCRUMB}}

CHAPTER_MEMORY: {{CHAPTER_MEMORY}}

OVERLAP: {{OVERLAP_CONTEXT}}

ALLOWED_DOMAINS: {{ALLOWED_DOMAINS}}

## CHUNK_TEXT
{{CHUNK_TEXT}}

---

## OUTPUT_PROTOCOL — JSON_WRAP_MANDATORY

After applying the MECHANICUS grammar above, you MUST wrap the result as a
JSON array matching this schema. The MECHANICUS-encoded line goes into the
`explanation` field. The natural-language `principle` is the human-readable
rule label.

Schema (return STRICTLY this — no prose, no markdown fences, no commentary):

[
  {
    "principle": "Short, sharp transformation rule, 20-400 chars. Action-oriented, never a definition.",
    "explanation": "MECHANICUS-encoded line: D.tags|rule1;rule2;rule3⊕example. 80-1500 chars total.",
    "domain": "One of ALLOWED_DOMAINS above. Must match exactly.",
    "tags": ["1-10 short kebab-case markers, 1-40 chars each"],
    "noveltyHint": "What value does this insight bring to a senior practitioner? 10-300 chars, one sentence.",
    "sourceQuote": "Exact verbatim quote from CHUNK_TEXT proving this Crystal. 10-800 chars, 1-2 sentences."
  }
]

If the chunk is filler / lyrical / pure storytelling with no transferable
rule — return empty array []. Do not fabricate. Maximum 4 crystals per
chunk. Atomic — one rule per object.
