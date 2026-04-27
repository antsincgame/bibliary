# Model roles and automation

## Architecture (registry + shadow arena)

### Roles

| Role | Used when | Primary from prefs | Capabilities |
|------|-----------|-------------------|--------------|
| `chat` | Empty model in `lmstudio:chat` / compare | `chatModel` + fallbacks | — |
| `agent` | Empty model in `agent:start` | `agentModel` → `chatModel` | prefers `trainedForToolUse !== false` |
| `crystallizer` | Dataset v2 without `extractModel` | `extractorModel` → BIG profile | — |
| `judge` | (future callers) | `judge` → extractor → chat | — |
| `vision_meta` / `vision_ocr` | Cover/figure analysis (Semantic Triage) | `visionModelKey` → auto-detect | **vision** capable; priority-sorted: qwen3-vl > qwen2.5-vl > internvl > pixtral > gemma3 > llava |
| `evaluator` | `evaluatorModel` / fallbacks; auto still uses `pickEvaluatorModel` | explicit override in [`book-evaluator.ts`](../electron/lib/library/book-evaluator.ts) |
| `arena_judge` | Arena LLM judge | cascade `arenaJudgeModelKey` → judge → extractor → chat |

Implementation: [`electron/lib/llm/model-role-resolver.ts`](../electron/lib/llm/model-role-resolver.ts).

### Recommended Vision Models (2026)

Load one of these in LM Studio for cover/figure analysis and Semantic Triage. Bibliary auto-detects by name markers and prioritises in this order:

| Priority | Model | VRAM | Why |
|---|---|---|---|
| 1 | `Qwen3.5-9B` (GGUF Q4) | ~8 GB | Native vision, outperforms Qwen3-VL-8B on OCR/Doc benchmarks. April 2026. |
| 2 | `Qwen3-VL-8B-Instruct` (GGUF Q4) | ~8-12 GB | Strong OCR (896 OCRBench), 96.1% DocVQA. Best dedicated VL model at 8B class. |
| 3 | `Qwen3-VL-4B-Instruct` (GGUF Q4) | ~6 GB | Good for triage on lower VRAM. ~91% DocVQA, ~850 OCRBench. |
| 4 | `Qwen2.5-VL-7B-Instruct` (GGUF Q4) | ~6 GB | Proven stable, 128K context, widely tested. |
| 5 | `InternVL3-8B` (GGUF Q4) | ~6 GB | Strong CJK + multilingual layouts. |
| 6 | `Pixtral-12B` (GGUF Q4) | ~8 GB | Good general vision + European languages. |

Download in LM Studio: search `qwen3-vl` or `qwen3.5` → pick `lmstudio-community/Qwen3-VL-8B-Instruct-GGUF` (Q4_K_M) or `Qwen3.5-9B-GGUF`.

Override model: `Settings → Pro → Vision model key` (leave blank for auto-detection).

### Preferences

New fields in [`electron/lib/preferences/store.ts`](../electron/lib/preferences/store.ts): fallback CSV strings per role, `*FallbackToAny` booleans, `evaluatorModel`, `modelRoleCacheTtlMs`, arena toggles, `visionMetaModelAttempts` (aligned with Settings UI).

Settings UI: **Pro** section **Model roles & arena** in [`renderer/settings/sections.js`](../renderer/settings/sections.js).

### TPS

[`electron/lib/resilience/tps-tracker.ts`](../electron/lib/resilience/tps-tracker.ts) tracks EMA **per `modelKey`** and a global fallback. [`chatWithPolicy`](../electron/lmstudio-client.ts) uses `getForModel(request.model)` for adaptive timeouts.

### Shadow arena

- **Ratings**: [`electron/lib/llm/arena/ratings-store.ts`](../electron/lib/llm/arena/ratings-store.ts) → `data/arena-ratings.json`.
- **Golden prompt**: [`electron/lib/llm/arena/golden-prompts.ts`](../electron/lib/llm/arena/golden-prompts.ts).
- **Cycle**: [`electron/lib/llm/arena/run-cycle.ts`](../electron/lib/llm/arena/run-cycle.ts) — pairs of **loaded** models, parallel was replaced with **sequential** chat calls to reduce LM Studio contention; hybrid **LLM judge** (if `arenaUseLlmJudge` + resolvable judge) else latency/length heuristic; Elo update; optional `arenaAutoPromoteWinner` sets `chatModel`.
- **IPC**: `arena:get-ratings`, `arena:run-cycle`, `arena:reset-ratings` — [`electron/ipc/arena.ipc.ts`](../electron/ipc/arena.ipc.ts).
- **Scheduler**: `main.ts` — `setInterval` when `arenaEnabled` at `arenaIntervalMinutes`; cleared on shutdown.

### Iteration 1 (closed)

- Removed inline `PROFILE` from `lmstudio-client`; BIG/SMALL keys only from [`ProfileStore`](../electron/lib/profiles/store.ts).

## Tests

- [`tests/arena-elo.test.ts`](../tests/arena-elo.test.ts) — Elo math sanity.
