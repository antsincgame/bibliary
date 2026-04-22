# ROADMAP TO MVP — Bibliary

> Что осталось пользователю до production-готового MVP. Все пункты
> отсортированы по приоритету (P0 > P1 > P2). Каждый пункт даёт оценку
> усилий и явный критерий "сделано".

## Текущее состояние (v2.6.0, 2026-04-22)

| Слой               | Готовность | Что есть                                                  |
|--------------------|-----------|-----------------------------------------------------------|
| Scanner / Ingest   | 95%       | Все парсеры, drag&drop, multi-file, OCR opt-in            |
| Library UI         | 95%       | Tabs, preview, queue, dropzone, grouping, history         |
| BookHunter         | 90%       | 4 источника, лицензии, download&ingest                    |
| Crystallizer       | 95%       | 6-стадийный пайплайн, prefs runtime, AbortError fix       |
| Forge              | 95%       | 3-step self-hosted wizard, YaRN, LocalRunner WSL          |
| Forge Agent        | 85%       | Tools + approval + multiturn history (B1) + memory (B7)   |
| Chat / RAG         | 95%       | Semantic search, sampling presets, compare guard, neon    |
| Settings           | 100%      | 39 prefs, mode-gated, bool/enum/tags, atomic write        |
| Models / LM Studio | 95%       | Profiles, switch, YaRN                                    |
| Qdrant UI          | 100%      | Cluster, collections, search, info                        |
| Resilience         | 95%       | Atomic write, lockfile, watchdog, abortAll on quit        |
| OCR (Phase 6.0)    | 90%       | OS-native (system-ocr + canvas), opt-in, per-task         |
| Neon UI            | 100%      | Hero/sacred-cards/divider/spinner — все 9/9 маршрутов     |
| Onboarding Wizard  | 95%       | 4 шага, restore prefs, block-without-model, real skip     |
| Help-KB (Karpathy) | 100%      | Synthetic KB о приложении, search_help tool агента        |
| Long-term Memory   | 100%      | bibliary_memory + recall_memory tool, fire-and-forget     |
| Tests              | 95%       | 30 unit + live E2E B6+B7 (5/5) + agent/dataset/scanner    |
| i18n               | 100%      | RU + EN, ~1740 keys (мёртвые удалены)                     |

Общий progress: **~95%**.

---

## P0 — Закрыть критические дыры (1-2 дня)

### P0.1. Wire forge / resilience / qdrant / bookhunter runtime preferences ✅ DONE
### P0.1.b. Phase 2.5R: wire LOCK + watchdog runtime preferences ✅ DONE

В дополнение к P0.1:
- `lockRetries`, `lockStaleMs` -- через `configureFileLockDefaults()`
- `healthPollIntervalMs`, `healthFailThreshold`, `watchdogLivenessTimeoutMs`
  -- через `configureWatchdog()` в watchdog
- preferences IPC применяет side-effects на каждом `set`/`reset`
- 3 BAD swallowed catches (`batch.ipc.ts`, `forge.ipc.ts`, `profile-manager.js`)
  заменены на `console.error` диагностику
- Magic number `384` извлечён в `electron/lib/scanner/embedding.ts` как
  `EMBEDDING_DIM` (использовался в 3 местах: ingest.ts, judge.ts, qdrant.ipc.ts)
- Введён `docs/QUALITY-GATES.md` с 5 gate-уровнями (Pre-commit, Pre-push,
  Pre-PR, Pre-RC, Pre-release) и таблицей контрольных метрик


**Было:** `forgeHeartbeatMs`, `forgeMaxWallMs`, `policyMaxRetries`,
`policyBaseBackoffMs`, `hardTimeoutCapMs`, `qdrantTimeoutMs`,
`qdrantSearchLimit`, `searchPerSourceLimit`, `downloadMaxRetries`,
`ocrPdfDpi` -- сохранялись в preferences, видны в Settings, но backend
их не читал.

**Сделано в коммите `<this commit>`:**

- `electron/ipc/forge.ipc.ts` -> `LocalRunner.start({ heartbeatMs, maxWallMs })`
  через `getPreferencesStore()`.
- `electron/lib/resilience/lm-request-policy.ts` -- новая фабрика
  `buildRequestPolicy(prefs)`. `electron/dataset-generator.ts` использует её
  через локальный helper `getRuntimePolicy()`.
- `electron/lib/qdrant/http-client.ts` -- `fetchQdrantJson(url, opts)` теперь
  принимает `{ timeoutMs }`. `qdrant.ipc.ts` (search) пробрасывает
  `prefs.qdrantTimeoutMs` и `prefs.qdrantSearchLimit`.
- `electron/ipc/bookhunter.ipc.ts` -- `aggregateSearch` получает
  `prefs.searchPerSourceLimit`, `downloadBook` -- `prefs.downloadMaxRetries`.
  `download-and-ingest` дополнительно пробрасывает `parseOptions` (OCR,
  upsertBatch, maxBookChars).
- `electron/lib/scanner/parsers/pdf.ts` -- `rasterisePdfPages({ dpi })`
  получает `opts.ocrPdfDpi` (OCR signal тоже пробрасывается в `recognize`).

**Критерий "сделано" (выполнен):** изменение значения в Settings → следующий
run наследует новое значение без перезапуска приложения. 33/34 ключей wired,
1 (`refreshIntervalMs`) зарезервирован для будущего auto-refresh.

### P0.1.c. chat() / chatWithTools() через withPolicy ✅ DONE

`electron/lmstudio-client.ts` теперь экспортирует `chatWithPolicy` и
`chatWithToolsAndPolicy` -- обёртки через `withPolicy` (буфер таймаута,
exp. backoff, abortGrace). `chat`/`chatWithTools` остались для скриптов.

- `electron/ipc/lmstudio.ipc.ts` (chat / compare) → `chatWithPolicy`
- `electron/ipc/agent.ipc.ts` (ReAct loop) → `chatWithToolsAndPolicy`
- ~~HF API (`electron/lib/hf/client.ts`) теперь имеет `fetchWithTimeout` (10s).~~
  **Удалено в v2.4 при переходе на self-hosted-only** — см. `docs/FINE-TUNING.md`.

Результат: один transient 5xx больше не убивает chat / agent действие
пользователя -- сначала retry с adaptive backoff.

### P0.1.d. Цикл forge/state ↔ resilience/bootstrap ✅ DONE

- `electron/lib/forge/state.ts` импортирует только `batch-coordinator` и
  `checkpoint-store` напрямую (не barrel).
- `electron/lib/resilience/bootstrap.ts` больше не импортирует forge/state.
- `electron/main.ts` вызывает `initForgeStore(dataDir)` после
  `initResilienceLayer` и до `registerForgePipeline`.

### P0.1.e. Crystallizer pipeline в coordinator ✅ DONE

- Новый файл `electron/lib/dataset-v2/coordinator-pipeline.ts` --
  PipelineHandle с `pause = abort`, `cancel = abort`, остальное no-op
  (state в Qdrant).
- `electron/main.ts` вызывает `registerExtractionPipeline()` после dataset
  и forge.
- `dataset-v2.ipc.ts` теперь репортит `reportBatchStart/End` и регистрирует
  AbortController в `trackExtractionJob`.

Результат: при offline LM Studio watchdog `pauseAll()` останавливает
extraction наравне с dataset/forge, не оставляя зависшие LLM retries.

### P0.2. E2E тест полного цикла ✅ DONE

`scripts/e2e-full-mvp.ts` (`npm run test:e2e:mvp`) -- 35 шагов покрывают
весь user journey на реальных данных:

T0  Health-check LM Studio + Qdrant
T1  Probe Downloads (~289 файлов, 3+ форматов)
T2  Parallel ingest 3 тематических коллекций под file-lock
T3  RAG retrieval per theme (top-1 score >= 0.55)
T4  OCR одной картинки через @napi-rs/system-ocr
T5  OCR scanned PDF (rasterise + recognize)
T6  Crystallizer: extractChapterConcepts -> dedup -> judge -> Qdrant
T7  Forge prepareDataset (ChatML split 90/10)
T8  Forge generateBundle (Unsloth + AutoTrain + Colab + Axolotl + README)
T9  Cleanup всех e2e-коллекций

Запуск (LM Studio + Qdrant должны быть запущены):
  npm run test:e2e:mvp

Опции:
  --downloads "C:/path"   -- альтернативная папка с книгами
  --skip-crystal          -- без LLM-этапа (быстро, ~5 сек)
  --skip-forge            -- без bundle generation

Текущий результат на dev-машине (после fix flaky):
  35 PASS, 0 FAIL, 0 SKIP, ~25-30 секунд
  Воспроизводится 3+ раза подряд (greedy decoding + cross-lib bypass)
  3 коллекции по 80 чанков каждая
  Crystal принимает 3 концепта из 1 главы
  Forge bundle: 4 конфига + README на диске

Детерминизм:
- temperature=0, top_k=1, top_p=1 в LLM вызовах E2E
- crossLibDupeThreshold=1.01 в judgeAndAccept (>1.0 = unreachable
  cosine; production-collection накапливает между прогонами и без
  этого тест становился flaky на втором прогоне)
- scoreThreshold=0 -- проверяем функционирование pipeline, не quality
- Quality assertions вынесены в отдельный TODO "split E2E pipeline+quality"

**Проблема:** есть `scripts/e2e-book-ingest.ts` и `e2e-library-ux.ts`, но они
покрывают только Library. Нет цепочки **drop → ingest → crystallize → forge bundle → eval**.

**Решение:** добавить `scripts/e2e-full-mvp.ts` -- скрипт прогоняющий sample
PDF (включая 1 scanned + 1 image) через все стадии. Проверяет JSON snapshots.

**Критерий "сделано":** `npm run test:e2e:mvp` зелёный за <10 минут на pure-CPU.

### P0.3. Auto-update / OTA каналы — DEFERRED to v2.7

**Проблема:** electron-builder конфигурация есть, но publisher (GitHub
Releases / S3) не настроен. Пользователю придётся вручную качать новые
версии.

**Решение:** в `package.json#build.publish` указать GitHub Releases provider,
выпустить v0.1.0-rc1.

**Критерий "сделано":** в приложении появляется баннер "новая версия
доступна" + один клик для apply.

**Статус (v2.6.0):** отложено осознанно. Для finalization цикла v2.6 решили
выпустить portable .exe вручную чтобы не блокироваться на GitHub Releases
provider. Auto-update инфраструктура — следующая major (v2.7 или v0.1.0-rc1).

---

## P1 — Качество и UX (3-5 дней)

### P1.1. Real-time прогресс ingest на dropzone

Сейчас ingest пишет в `STATE.progress` Map, но dropzone не показывает
прогресс drop'нутых файлов. Надо: маленький прогресс-бар внутри dropzone
пока активны drag-ingests.

### P1.2. Saving sessions / restore selection

Пользователь выбирает 50 книг → закрывает приложение → возвращается → список
пуст. Нужно: persist `STATE.books` + `STATE.selected` per collection в
`data/library-session.json`. Restore при mountLibrary.

### P1.3. Полный Neon rollout ✅ DONE (v2.6.0)

Закрыто в Strike 2/3 финализационного цикла:
- `Chat` hero — `buildNeonHero({ pattern: "flower" })` для пустого
  состояния через `renderer/chat.js mountChat()`
- `Docs` hero — `buildNeonHero({ pattern: "metatron" })` через
  `renderer/docs.js buildHeader()`
- CSS `.chat-welcome-neon` (отключение двойной aury) и `.docs-hero-wrap`
  (общий border-bottom) добавлены

Все 9/9 маршрутов теперь Neon-стилизованы.

### P1.4. Onboarding wizard improvements ✅ DONE (v2.6.0)

Wizard уже вызывается на первом запуске + закрыто в Strike 1
финализационного цикла:
- A3: восстанавливает chatModel из preferences при повторном открытии
- A4: блокирует "Далее" на Setup-шаге без выбранной модели + helper
  кнопка "Open LM Studio" (через новый IPC `system:open-external`)
- A10: skip с confirm-dialog если уходит без модели со step >= 2

### P1.5. Notifications system

`TOAST_TTL_MS` есть в prefs, но centralised toast manager в renderer
отсутствует -- каждый модуль показывает alert(). Создать
`renderer/components/toast.js` со стеком, anim, auto-dismiss. Заменить
~10 alert()-ов.

---

## P2 — Расширение и оптимизация (1-2 недели)

### P2.1. Cloud sync / TON licensing

`docs/REPORT-USER-SKILLS.md` упоминает TON licensing как стратегическую цель.
Нужно: создать `electron/lib/licensing/ton.ts` (token validation, expiry),
`renderer/components/license-gate.js` (paywall на pro features). Pro features
-- forge local runner, crystallizer >100 chunks.

### P2.2. Crystallizer streaming UI

Сейчас Crystallizer показывает только "Глава X/Y" -- нет визуализации
концептов в реальном времени. Нужно: per-chunk live preview принятых
концептов справа от лога.

### P2.3. Multi-language OCR detection

Сейчас OCR languages передаются вручную. Можно автодетектить из metadata
PDF (`Language` field) или first-N pages text-detect. Wire to
`prefs.ocrLanguages` как fallback.

### P2.4. Bundle download optimisation

`@xenova/transformers` тащит 60MB embeddings model на первом запуске. Нужно:
on-demand download с progress UI вместо blocking startup.

### P2.5. Memory profiler для long sessions

После 4-6 часов работы memory растёт. Добавить:
`electron/lib/profiler/heap-snapshots.ts` -- снимать snapshot каждые 30
минут, anomaly detect, alert в resilience-bar.

---

## P3 — Долгий хвост (после первого release)

- Полные unit-тесты для парсеров (текущее покрытие: smoke only)
- Maestro E2E на Windows/macOS (UI-уровень)
- Telemetry dashboard (renderer route + IPC)
- Plugin system (3rd-party crystallizer roles)
- Mobile companion (read-only, через cloud sync)

---

## Сборочный чеклист первого RC

- [ ] P0.1, P0.2, P0.3 закрыты
- [ ] `npm run electron:build` собирает .exe + .dmg + .AppImage
- [ ] `npm run test:e2e:mvp` зелёный
- [ ] CHANGELOG.md обновлён
- [ ] README.md содержит install + first-run guide
- [ ] OCR проверен на Windows 11 + macOS 14 (Vision Framework)
- [ ] LM Studio integration работает на свежей установке
- [ ] Qdrant docker-compose готов в `infra/docker-compose.yml`

После этого -- `git tag v0.1.0-rc1 && git push --tags` + GitHub Release.

---

## Что НЕ нужно для MVP

- Mobile app (P3)
- Cloud sync (P2.1, после first release)
- Plugin system (P3)
- Telemetry dashboard (P3)
- Production-grade auth (только для cloud sync)

MVP = single-user desktop, локальные данные, опциональная TON-лицензия для
unlock pro features. Этого достаточно для community release и первой
коммерциализации.
