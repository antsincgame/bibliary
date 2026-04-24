# Bibliary -- State of the Project

> Срез состояния на v2.7.0 (Library + Dataset Factory). История до v2.6
> сохранена в нижних разделах для контекста; что-то что больше не отражает
> код помечено `[archived]`.
> Дата: 2026-04-24.

## TL;DR

```
Готовность к pilot:     ~98%  (Library + Pre-flight Evaluation в проде, smoke зелёный)
Готовность к v0.1.0:    ~92%  (осталось auto-update + bookhunter policy)
Готовность к public:    ~70%  (док-сайт + видео-онбординг, ~2 недели)
```

Линия v2.7 закрыта: библиотека книг хранится на FS, оценивается reasoning-моделью
до тяжёлой crystallization, dataset-фабрика пишет ChatML JSONL для LoRA с
per-domain prompt-presets. Smoke-test через playwright-electron подтверждает,
что preload bridge и IPC handlers живы. Ядро (parser + scanner + dataset-v2 +
library + RAG + LM Studio bridge) работает на реальных данных без моков.

**v2.7.0 (2026-04-24) — Library + Dataset Factory:**
- File-System First Library + Pre-flight Evaluation pipeline
- DataGrid Catalog с фильтрами quality / hide fiction
- Thematic Qdrant Collections (`targetCollection` сквозь pipeline)
- Dataset synthesis (`scripts/dataset-synth.ts`) с 10 per-domain prompt-пресетами
  и `--include-reasoning` для R1-style distillation
- Batch cancellation, robust E2E (timeout + global rejection handlers)
- Shared storage contract → batch-runner extract → 65 unit/integration tests
- Real Electron smoke-test (playwright-electron) через `npm run test:smoke`

**v2.6.0 (2026-04-22) — Overmind Agent + UX Stabilization:**
- Multiturn-история агента (B1) + sanitizeAgentHistory с unit-тестами
- Synthetic KB о приложении (B6) — bibliary_help Qdrant + tool search_help
- Long-term memory диалогов (B7) — bibliary_memory + tool recall_memory
- UX полировка (Three Strikes): Welcome wizard restore/block/skip,
  Forge step validation, Chat Compare guard, Forge step pills indicator
- Полный Neon rollout (P1.3) — Chat и Docs hero (9/9 маршрутов)

---

## 1. Что сделано (по фазам)

### Phase 2.5 -- Resilience layer (95% done)

- atomic write (`writeJsonAtomic`) везде где есть persist
- `withFileLock` для всех критичных JSON: profiles, prompts, forge,
  preferences, **scanner-progress** (последний добавлен `f22b057`)
- LM Studio watchdog: poll + offline notification + coordinator pause/resume
- batch-coordinator: pipeline registration, pause/resume/flushAll on
  shutdown
- `withPolicy` для LLM calls: adaptive timeout + exponential backoff +
  abortGrace для LM Studio bug #1203. Применён в:
  - dataset-generator (исторически)
  - **chat handler** через `chatWithPolicy` (`03bc361`)
  - **agent loop** через `chatWithToolsAndPolicy` (`03bc361`)
- File lock retries/stale + watchdog timing -- runtime configurable
  через preferences.

**Не покрыто (P1):**
- BookHunter sources (gutendex/openlibrary/archive/arxiv) -- их fetch
  работает с `signal`, но без unified policy. Транзитные 5xx падают
  сразу.

### Phase 2.6 -- Book Scanner (95% done)

- 5 parsers: pdf / epub / fb2 / docx / txt + 7 image extensions для OCR
- `probeBooks` (folder walk, dedup, cap depth) + `probeFiles` (D&D)
- `parseBook(opts)` принимает ParseOptions (OCR, signal)
- `chunkBook` -- topological semantic chunker (drift-aware)
- `ingestBook` -- streaming parse → chunk → embed → Qdrant batch upsert,
  resumable через scanner-progress.json
- **scanner-progress.json теперь под file-lock** (`f22b057`)

**Не покрыто:**
- exponential growth scanner-progress.json при росте библиотеки -- решение
  per-book file (P2)

### Phase 3.0 -- BookHunter (90% done)

- 4 источника: Project Gutenberg, Internet Archive, arXiv, Open Library
- License whitelist (только Public Domain / CC)
- Aggregator + dedup кандидатов
- Downloader с retry на 5xx, `maxRetries` из preferences
- IPC: search, download, download-and-ingest, **cancel**, progress
- UI: real progress bar + Cancel + Retry (`64f4139` + `e3826b1`)

**Не покрыто:**
- История поисков (P2)
- Только-download без ingest (есть в IPC, нет в UI -- P2)

### Phase 3.1 -- Crystallizer (95% done)

- 6-stage pipeline: parse → chunker → extractor → intra-dedup → judge →
  upsert into Qdrant `dataset-accepted-concepts`
- Live progress events → renderer alchemy log
- **Реджистрация в coordinator** -- watchdog теперь паузит extraction
  при offline LM Studio (`ba7e6a3`)
- **Manual reject button** на каждой принятой карточке (`31144b8`)
- conceptId/domain в judge.accept events для точечного reject

### Phase 3.2 -- Dataset Generator (старый, 80%)

- 3-фазная генерация (T1/T2/T3) ChatML examples
- Resume через checkpoint store
- через `withPolicy` (LLM-аware retry)

### Phase 3.3 -- Дообучение (Forge) -- v2.4 self-hosted, 95% done

- **3-step wizard** (Подготовка → Параметры → Workspace), 100% локально
- **2 target**: workspace (Unsloth Python + Axolotl YAML + README) +
  inline LocalRunner ("Запустить в WSL") с live-стримом метрик
- **YaRN** интегрирован: пресет «Глубокий контекст», auto-suggest при
  превышении native context, rope_scaling в Unsloth/Axolotl configs
- LocalRunner: heartbeat watchdog (`forgeHeartbeatMs`), max-wall-clock
  (`forgeMaxWallMs`), оба runtime configurable
- Eval harness (ROUGE + LLM-as-judge) с AbortSignal
- **Удалено в v2.4** (бритва Оккама, см. `docs/FINE-TUNING.md`):
  Colab notebook generator, AutoTrain YAML generator, HuggingFace token
  widget, hf:* IPC namespace, electron/lib/hf/, поля pushToHub/hubModelId.
  Bibliary стал 100% private + local. Backward-compat: enum target в
  ForgeRunStateSchema принимает "colab"/"autotrain" для чтения старых
  чекпоинтов; новый код пишет только "bundle".

**Не покрыто:**
- Auto-import GGUF в LM Studio после успешной тренировки (есть ручная
  кнопка, авто-флоу пока не делали)
- Multi-run experiment matrix (запуск N spec'ов параллельно с разными
  hyperparams)

### Phase 4.0 -- Forge Agent (70% done)

- ReAct loop с tools registry (12 tools)
- Approval gate для destructive actions
- **chatWithToolsAndPolicy** -- agent теперь устойчив к flaky LM Studio
- abortAllAgents на quit (`edff388`)
- Stop button с realным diagnostic (`13433fd`)

**Не покрыто:**
- Streaming tool execution UI (видно только финальный результат)

### Phase 5.0 -- Neon UI (70% done)

- Design tokens (cyan/gold/violet/emerald glows, sacred-cards, dividers)
- 7/9 маршрутов: Library, Qdrant, Crystal, Forge, Models, Dataset, Settings
- Phase 6.0 dropzone в Library с keyboard a11y + multi-file open

**Не покрыто:**
- Chat hero / Docs hero (используют старые header-стили)

### Phase 6.0 -- OCR (95% done)

- `@napi-rs/system-ocr` (Windows.Media.Ocr + Vision Framework, prebuild)
- `@napi-rs/canvas` для рендеринга PDF страниц
- Image parser (PNG/JPG/JPEG/BMP/TIFF/WEBP)
- Opt-in PDF OCR fallback при rawCharCount === 0
- DPI / language / accuracy все runtime configurable
- UI badge "OCR: win32 / unavailable" + per-task toggle
- API соответствует реальному `recognize()` (исправлено в `44c80fe`)

### Preferences infrastructure (100% wired в runtime)

- 39 ключей в Zod schema, atomic write + file lock
- 38/39 wired в runtime (1 reserved -- `refreshIntervalMs`)
- Settings UI с Simple/Advanced/Pro tier gating
- 4 типа полей: int/float, bool, enum, tags
- runtime side-effects на set/reset (watchdog, file-lock пересобираются)

---

## 2. Слабые места (что НЕ работает идеально)

### 🔴 Critical (нужно до v0.1.0)

| Слабость | Где | Почему опасно | Статус |
|---|---|---|---|
| ~~Нет E2E test полного pipeline~~ | `scripts/e2e-full-mvp.ts` (35 шагов) | Покрывает drop→ingest→crystal→forge bundle | ✅ DONE (v2.5) |
| Нет auto-update channel | `package.json#build.publish` пустой | Пользователь не получит фикс автоматически | DEFERRED v2.7 |
| `bookhunter/sources/*` без unified policy | gutendex.ts, archive.ts, openlibrary.ts, arxiv.ts | Один транзитный 5xx -- empty results без объяснения | OPEN |

### 🟠 High (нужно до beta)

| Слабость | Где | Решение |
|---|---|---|
| 2× embedder в памяти | `scanner/ingest.ts:74` + `rag/index.ts:61` -- два singleton'а одной модели | Single shared singleton (~150 MB save) |
| Нет zod-валидации на IPC boundary | 17 IPC файлов, ручные typeof проверки | Centralised validator middleware |
| CSP отсутствует на BrowserWindow | `main.ts:34` -- только contextIsolation | Добавить session.defaultSession.webRequest.onHeadersReceived |
| `intra-dedup` O(N²) | `dataset-v2/intra-dedup.ts:122` | Threshold-based bucketing для N>50 |
| `chat history` без cap | `renderer/chat.js:19` | Скользящее окно + persist через preferences |

### 🟡 Medium (после v0.1.0)

| Слабость | Где | Заметка |
|---|---|---|
| 7 файлов >400 строк | dataset.js:981, library.js:847, forge.js:549, ... | Type 2 refactor, нужны smoke tests сначала |
| `buildContextSlider` 320 строк | components/context-slider.js | Type 2 refactor candidate |
| `scanner-progress.json` полная перезапись на каждый flush | scanner/state.ts:55 | Per-book file для thousand+ books |
| Нет streaming в chat | lmstudio-client.ts:155 | UX win, но требует SSE handling в renderer |
| `refreshIntervalMs` визуален но не wired | Settings UI | Подключить к models-page poll loop ИЛИ удалить |

### 🟢 Low / cosmetic

- `pageBufferToTempPng/safeUnlink` уже удалены (`44c80fe`)
- 0 TODO/FIXME/HACK в коде
- 0 `console.log` в electron production paths
- 0 `any` типов в публичных API
- 0 `throw "Not implemented"`

---

## 3. Что сделано в текущей серии sessions

### Sessions timeline

```
26-04-21 04:48  v2.3   Полный pipeline: BookHunter→Scanner→Crystal→Forge
26-04-21 05:12  ui     Восстановлены битые CSS глифы + Library Neon
26-04-21 05:29  v2.4   Phase 5.0 Neon rollout (7/9 routes) + .editorconfig
26-04-21 13:01  v2.5   Preferences infrastructure + Settings page (mode-gated)
26-04-21 13:28  v2.5.1 Wire 12 preferences runtime + diamond-buddha cleanup
26-04-21 14:07  ocr    Phase 6.0 OS-native OCR (Windows.Media.Ocr + Vision)
26-04-21 14:07  lib    Library drag&drop + multi-file + grouping + OCR toggle
26-04-21 14:07  set    Settings: bool/enum/tags + OCR section
26-04-21 14:08  prefs  Wire UI timing + UI-tester report + roadmap
26-04-21 14:34  ocr    align with real @napi-rs/system-ocr API + wire ocrPdfDpi
26-04-21 14:34  prefs  forge/resilience/qdrant/bookhunter runtime wired
26-04-21 14:46  emb    EMBEDDING_DIM single source of truth
26-04-21 14:46  prefs  Phase 2.5R LOCK + watchdog runtime
26-04-21 14:46  qual   diamond cleanup + QUALITY-GATES.md + UI-tester rev3
26-04-21 14:53  lib    BookHunter download progress + cancel UI
26-04-21 14:53  cry    Crystal manual reject button
26-04-21 14:53  hf     HF token widget on Colab/AutoTrain
26-04-21 14:53  qdr    Show search errors instead of swallowing
26-04-21 15:02  scn    file-lock ScannerStateStore (race fix)
26-04-21 15:02  rag    wire ragTopK + chat sampling
26-04-21 15:02  qt     abortAllAgents on quit + qdrantRaw timeout
26-04-21 15:02  lib    block Retry while ingesting
26-04-21 15:34  pol    chat()/chatWithTools() через withPolicy + HF timeout
26-04-21 15:34  arch   разорван цикл forge/state ↔ resilience
26-04-21 15:34  cry    Crystallizer pipeline в coordinator
26-04-22 v2.4   Forge Self-Hosted: 3-step wizard, YaRN, LocalRunner WSL,
                удалена облачная инфраструктура (Colab/AutoTrain/HF)
26-04-22 v2.5   UX polish: Settings responsive, Library overflow/filter,
                Chat collection/model/welcome, Welcome wizard 5→4 шага,
                Docs rebrand "Книга"→"Справка", Neon Library/Forge/Settings
26-04-22 v2.6   Overmind Agent (B1+B6+B7): multiturn history, synthetic
                KB about app (bibliary_help), long-term dialog memory
                (bibliary_memory). Three Strikes UX: 12 точечных фиксов
                + полный Neon (Chat+Docs). 30 unit-тестов + live E2E.
```

### Метрики цикла

```
Commits:                    24
Files changed (net):        45
Lines added:               ~3500
Lines removed:              ~600
TS errors:                   0
Lint errors:                 0
Mock implementations added:  0  ← MVP-кодекс соблюдён
TODO/FIXME added:            0
console.log added:           0  (только error/warn для diagnostics)

Critical bugs found:         8
Critical bugs fixed:         8
High bugs found:             5
High bugs fixed:             4 (1 -- BookHunter unified policy -- осталось)
```

### Архитектурные улучшения

1. **Resilience contract стал применим к LLM calls** (раньше только dataset
   pipeline; теперь chat + agent тоже).
2. **Циклическая зависимость forge ↔ resilience разорвана** через перенос
   `initForgeStore` в `main.ts`.
3. **Crystallizer first-class в coordinator** -- watchdog теперь paus'ит
   его симметрично с dataset/forge.
4. **Single source of truth для embedding model** (`scanner/embedding.ts`).
5. **Single source of truth для preferences-driven runtime** (38/39 keys
   реально влияют на поведение).

---

## 4. Roadmap до MVP-release

### Sprint 1 -- стабилизация (1-2 недели)

P0 пункты которые ещё не закрыты:

1. **E2E test full MVP pipeline** (`scripts/e2e-full-mvp.ts`)
   - Sample PDF + sample image + sample scanned PDF
   - Полный путь: drop → ingest → crystallize → forge bundle
   - Цель: `npm run test:e2e:mvp` <10 минут на pure-CPU
   - Метрика готовности: тест зелёный 5 раз подряд

2. **BookHunter sources unified policy**
   - Каждый source через `withPolicy` (или local equivalent)
   - HF, gutendex, archive, openlibrary, arxiv, downloader
   - Метрика: 503 на одном source не должен ронять aggregateSearch

3. **Auto-update channel**
   - `package.json#build.publish` → GitHub Releases
   - В renderer: баннер "новая версия" + Restart-to-Apply
   - Метрика: при релизе v0.1.1 пользователь v0.1.0 видит баннер за <24h

### Sprint 2 -- pre-release (2 недели)

4. **Single embedder singleton** (memory win ~150 MB)
5. **Zod validator middleware на IPC** (security baseline)
6. **CSP на BrowserWindow** (defense-in-depth)
7. **Welcome wizard на первом запуске** (onboarding gap)
8. **Centralised toast manager** (заменить ~10 `alert()` на neon-toast)

### Sprint 3 -- public release (3-4 недели)

9. **Type 2 refactor renderer/dataset.js + library.js + forge.js**
   - После того как E2E + smoke тесты дадут safety net
10. **Streaming LLM в chat** (UX win)
11. **Per-book scanner-progress** (избежать contention)
12. **Telemetry dashboard** (внутренняя observability)

### Sprint 4+ -- эволюция

13. TON licensing gate (P2 commercial)
14. Mobile companion (read-only через cloud sync)
15. Plugin system (3rd-party crystallizer roles)
16. Architecture lint rule "no raw fetch outside resilience-wrapped fns"

---

## 5. RC-чек-лист (Sprint 1 done)

```
□ npm run test:e2e:mvp         зелёный 5/5 запусков
□ BookHunter resilience        503 не ломает search
□ Auto-update                  GitHub Releases провайдер настроен
□ Manual smoke на Win11        полный flow drop→crystal→forge bundle
□ Manual smoke на macOS 14     то же + Vision Framework OCR
□ CHANGELOG.md                 заполнен от v0.0 до v0.1.0-rc1
□ README.md                    install + first-run + LM Studio setup
□ Lint / TSC / unit            все зелёные
□ git tag v0.1.0-rc1           push --tags
```

После этого -- GitHub Release v0.1.0-rc1, открытое тестирование 1 неделю,
v0.1.0-final.

---

## 6. Карта рисков

| Риск | Вероятность | Impact | Mitigation |
|---|---|---|---|
| LM Studio API breaking change | Низкая | Высокий | `chatWithPolicy` retry + watchdog уже есть; нужен contract test |
| @napi-rs/system-ocr DLL issues на старом Windows | Средняя | Средний | UI gracefully скрывает OCR при `getOcrSupport() === false` |
| Qdrant out-of-memory при 100k+ концептов | Средняя | Высокий | Документировать sharded collection в README; hard cap UI |
| pdfjs-dist memory leak на huge PDFs | Низкая | Средний | `maxBookChars` уже в preferences; OCR DPI snap |
| Electron 41 → 42 breaking | Низкая | Средний | `package.json` зафиксирован, обновление через RC канал |
| HF rate limit при поиске моделей | Средняя | Низкий | 10s timeout уже добавлен; нужен exponential backoff |

---

## 7. Контракты для будущих изменений

См. `docs/QUALITY-GATES.md`. Кратко:

- **Type 1 рефактор** (rename, extract const, dead code) -- всегда можно
- **Type 2** (split file, change pattern) -- только после smoke тестов
- **Type 3** (replace lib, change API) -- только с migration plan
- **Каждый external call** должен идти через resilience wrapper
- **Каждый IPC handler с filePath/collection** должен валидировать
  (zod, не typeof)

---

## 8. Заключение

Bibliary в **pilot-готовом** состоянии. Ядро устойчиво (resilience layer
+ atomic writes + file locks + watchdog), все 39 preferences runtime-
configurable, OCR работает на Windows и macOS, Crystal first-class в
coordinator, agent loop с retry policy. Главные оставшиеся пробелы --
**E2E тест** (без него невозможно гарантировать стабильность RC) и
**auto-update** (без него обновление = ручная процедура).

Если фокус -- RC за 2 недели, операция: Sprint 1, ничего больше.
Если фокус -- public release, операция: Sprint 1 + 2.
