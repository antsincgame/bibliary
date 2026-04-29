# Bibliary Project Audit: Olympics Role Arena

Date: 2026-04-29

## Executive Summary

The critical risk in the current project is not the idea of the Olympics feature itself, but that it was behaving too much like a generic model benchmark while being wired into a production dataset pipeline. Bibliary needs role-specific model calibration: each selected model must be safe for the exact job it will perform during import, extraction, evaluation, translation, language detection, and vision handling.

The most severe defect was resource ownership. Olympics controlled LM Studio directly, but it was not fully coordinated with the global LLM activity model. This created two classes of failures:

- It could overload LM Studio by loading multiple models or by inheriting already-loaded instances from a previous crash.
- It could run while import/evaluator/extraction jobs were using LM Studio, causing model unloads or VRAM pressure during active dataset generation.

This audit fixes the immediate P0/P1 defects and documents the remaining architectural work required to make Olympics a reliable role-arena subsystem.

## Scope Reviewed

Primary files reviewed:

- `electron/lib/llm/arena/olympics.ts`
- `electron/ipc/arena.ipc.ts`
- `renderer/models/models-page.js`
- `electron/lib/resilience/telemetry.ts`
- `tests/olympics-weights.test.ts`
- `tests/olympics-lifecycle.test.ts`

Adjacent project areas considered:

- LM Studio model lifecycle and global lock coordination
- Import pipeline resource safety
- Parser/import filter hardening
- Role preferences applied by Olympics recommendations
- UI visibility for long-running calibration

## Findings And Fixes

### P0: LM Studio Resource Contention

**Problem.** Olympics talked to LM Studio directly but did not participate in `globalLlmLock`. That meant a user could start Olympics while import, evaluator queue, or another background LLM task was active.

**Impact.** This can unload a model that an active pipeline is using, amplify VRAM pressure, and produce freezes or corrupted calibration results.

**Fix.**

- `arena:run-olympics` now checks `globalLlmLock.isBusy()` before starting.
- If LM Studio is busy, the run is rejected with a clear error listing busy reasons.
- While Olympics is running, it registers its own `globalLlmLock` probe so other LLM jobs can see the calibration session as busy.
- The probe is unregistered in `finally`.

**Files.**

- `electron/ipc/arena.ipc.ts`

### P0: Unsafe Model Lifecycle After Crash

**Problem.** A previous run could leave multiple LM Studio loaded instances alive. The first lifecycle fix tested models sequentially, but did not clear selected pre-loaded instances before starting.

**Impact.** Even with sequential load/test/unload, a baseline with 3-6 already-loaded models can still exhaust RAM/VRAM and repeat the BSOD risk.

**Fix.**

- Olympics now cleans already-loaded selected model instances before running.
- Each model is then handled as: `load -> all role disciplines -> unload`.
- Unload is performed in `finally`, including abort/error paths.
- If load fails, a cleanup pass runs for that model to catch late/partial loads.

**Files.**

- `electron/lib/llm/arena/olympics.ts`
- `tests/olympics-lifecycle.test.ts`

### P1: Load Operation Could Hang Without Timeout

**Problem.** `lmsLoadModel()` used the external abort signal directly. If a signal existed but was not aborted, the load call could miss the intended 180 second timeout.

**Impact.** Olympics could appear frozen during LM Studio load, especially after GPU/driver pressure.

**Fix.**

- `lmsLoadModel()` now owns an internal `AbortController`.
- The internal controller is connected to both caller abort and a hard 180 second timeout.
- Event listeners and timeout handles are cleaned up in `finally`.

**Files.**

- `electron/lib/llm/arena/olympics.ts`

### P1: Empty Role Selection Ran All Roles

**Problem.** Backend role filtering only applied when `roles.length > 0`. If the user unchecked all role boxes, the request behaved like no filter and ran every role.

**Impact.** The UI semantics were inverted for the most dangerous case: a user trying to run nothing could accidentally start a full calibration.

**Fix.**

- Backend now treats an explicit empty roles array as zero disciplines and throws.
- UI rejects empty role selection before calling IPC.
- Regression test added.

**Files.**

- `electron/lib/llm/arena/olympics.ts`
- `renderer/models/models-page.js`
- `tests/olympics-lifecycle.test.ts`

### P1: Cache Key Was Too Weak

**Problem.** Olympics cache was keyed only by selected model names and discipline IDs.

**Impact.** If LM Studio metadata changed for the same model key, cached recommendations could persist despite changes in size, architecture, or capabilities.

**Fix.**

- Cache key now includes a model fingerprint:
  - key
  - params string
  - size bytes
  - architecture
  - vision/reasoning/tool-use capabilities

**Files.**

- `electron/lib/llm/arena/olympics.ts`

### P1: Insufficient Post-Mortem Logging

**Problem.** UI logs disappear after app/system crash. Console logs alone are not enough to reconstruct a failed calibration.

**Fix.**

- Added structured telemetry events:
  - `olympics.run` start/done
  - `olympics.model_lifecycle` cleanup/load/unload phases
- UI now displays model loading, loaded, unloaded, load-failed, and VRAM guard events.

**Files.**

- `electron/lib/resilience/telemetry.ts`
- `electron/lib/llm/arena/olympics.ts`
- `renderer/models/models-page.js`

## Role Arena Assessment

### What Olympics Does Well

- It has explicit project roles: `crystallizer`, `evaluator`, `translator`, `judge`, `lang_detector`, `ukrainian_specialist`, `vision`.
- It uses LM Studio v1 metadata instead of only OpenAI-compatible `/v1/models`.
- It separates champion (best score) from optimum (best speed/quality balance).
- It aggregates by role, which is closer to Bibliary needs than a single global leaderboard.
- It has capability-aware vision filtering and reasoning detection.
- It has lifecycle regression tests for the resource bug that caused the crash risk.

### Where It Still Does Not Fully Match Bibliary

Olympics is currently a role-aware benchmark, not yet a full role-system test harness.

For Bibliary, a role test should answer:

1. Can this model perform this exact pipeline duty?
2. Does it fail safely when the output is malformed?
3. Does it preserve data quality for book-derived datasets?
4. Is it efficient enough to use across thousands of books?
5. Does it avoid hallucinating metadata and false facts?

The current system partially covers this, but still has gaps.

## Recommended Role-System Improvements

### P1: Replace Generic Disciplines With Pipeline Fixtures

Each role should be tested on realistic fixtures shaped like actual Bibliary data.

Recommended fixtures:

- `crystallizer`: noisy OCR section, clean technical section, multilingual section, footnotes/references section.
- `evaluator`: high-quality classic, mid-quality book, low-quality noise, outdated but still useful reference.
- `judge`: compare two conflicting extractions and choose the evidence-grounded one.
- `translator`: preserve technical terms, code identifiers, citations, and dates.
- `lang_detector`: mixed RU/EN/UA document and short ambiguous titles.
- `ukrainian_specialist`: Ukrainian technical prose, Russian false friend traps, Cyrillic OCR noise.
- `vision`: base64 page image with a diagram/table, not just a toy image.

### P1: Store Discipline Expectations As Data

Right now discipline prompts and scorers live inline in `olympics.ts`.

Better structure:

- `electron/lib/llm/arena/disciplines/*.ts`
- one file per role
- fixtures next to scorers
- explicit expected invariants per fixture

This would make it easier to improve prompts without turning `olympics.ts` into a god object.

### P1: Add Structured Output Contracts

For each role, score not only the natural language answer, but also output contract compliance:

- valid JSON when expected
- required keys present
- no markdown wrapper when forbidden
- no empty arrays for non-empty documents
- no fabricated author/year/title
- evidence anchoring where applicable

### P2: Add Calibration Modes

Recommended modes:

- `quick`: 2-3 disciplines, small model set, safe defaults.
- `standard`: all core text roles, S/M classes.
- `deep`: all roles, all selected models, long runtime, strict resource warnings.
- `vision`: only vision-capable models and image/page disciplines.

This maps user intent to resource cost explicitly.

### P2: Persist Reports

In-memory cache is useful, but calibration history should be persisted:

- timestamp
- LM Studio URL
- model fingerprints
- disciplines
- per-role recommendations
- failure reasons
- lifecycle telemetry summary

This would let users compare calibrations over time and recover after app restart.

### P2: Add Real Hardware-Aware Model Budgeting

Current safety is lifecycle-based. It should also estimate whether a model is safe before loading:

- estimate model footprint from `sizeBytes` and quantization
- reserve RAM/VRAM margin
- warn or skip models above configured budget
- expose "unsafe large model" warnings in UI

The lifecycle fix prevents multi-model pileups, but a single model can still be too large.

## Import And Parser Audit Notes

The import subsystem has moved in the right direction:

- file walking is streaming, not buffer-all
- magic-byte validation exists for import candidates
- archive extraction has zip-bomb limits
- suspicious filesystem artifacts are filtered
- archive temp cleanup has a defensive path guard

Remaining recommendations:

- Keep magic validation enabled in production imports.
- Ensure every parser returns warnings for recoverable format problems rather than throwing where possible.
- Continue treating `pdfjs-dist` as emergency-only fallback after `pdf-inspector` and `edgeparse`.
- Persist parser fallback choice in import logs for large imports, because it is essential for post-mortems.

## Verification Performed

Commands run:

- `npx tsc --noEmit -p tsconfig.electron.json`
- `node --import tsx --test tests/olympics-lifecycle.test.ts tests/olympics-weights.test.ts`
- `ReadLints` on changed files

Results:

- TypeScript: pass
- Olympics tests: pass
- Lints: no new diagnostics on checked files

## Current Risk Register

### P1: Single Huge Model Can Still Overload Hardware

The system no longer loads multiple selected models at once, but it can still attempt one model that is too large for the machine. Add explicit memory budget checks before `lmsLoadModel()`.

### P1: Scorers Are Still Mostly Heuristic

The role scorers are deterministic and useful for regression, but they are not yet a full evaluation science layer. Add fixture-driven scorers and adversarial cases.

### P2: Inline Disciplines Make Growth Risky

`olympics.ts` is becoming too large. Move discipline definitions and model lifecycle helpers into separate modules after the current stability fix is proven.

### P2: UI Strings Are Partly Hardcoded

Some new UI text is hardcoded in Russian/English. Localize when the UX stabilizes.

## Recommended Next Operation

The next best engineering step is not adding more benchmark prompts. It is extracting Olympics into four modules:

1. `lms-lifecycle.ts`: load/unload/health/telemetry.
2. `disciplines/`: role fixtures and scorers.
3. `role-aggregator.ts`: role aggregation and recommendation logic.
4. `olympics.ts`: orchestration only.

That would make this feature easier to test, safer to evolve, and aligned with Bibliary's real mission: selecting the right local model for each dataset-generation role.
