# ROADMAP TO MVP — Bibliary

> Что осталось пользователю до production-готового MVP. Все пункты
> отсортированы по приоритету (P0 > P1 > P2). Каждый пункт даёт оценку
> усилий и явный критерий "сделано".

## Текущее состояние (v2.5.2, апрель 2026)

| Слой               | Готовность | Что есть                                                  |
|--------------------|-----------|-----------------------------------------------------------|
| Scanner / Ingest   | 95%       | Все парсеры, drag&drop, multi-file, OCR opt-in            |
| Library UI         | 95%       | Tabs, preview, queue, dropzone, grouping, history         |
| BookHunter         | 90%       | 4 источника, лицензии, download&ingest                    |
| Crystallizer       | 90%       | 6-стадийный пайплайн, прогресс, persist                   |
| Forge              | 80%       | Bundle generator, local runner, eval-harness              |
| Forge Agent        | 70%       | Tools registry, approval, активность                      |
| Chat / RAG         | 90%       | Semantic search, sampling presets, compare mode           |
| Settings           | 100%      | 32 prefs, mode-gated, bool/enum/tags, atomic write        |
| Models / LM Studio | 95%       | Profiles, switch, YaRN                                    |
| Qdrant UI          | 100%      | Cluster, collections, search, info                        |
| Resilience         | 90%       | Atomic write, lockfile, watchdog, telemetry, banner       |
| OCR (Phase 6.0)    | 90%       | OS-native (system-ocr + canvas), opt-in, per-task         |
| Neon UI            | 70%       | Hero, sacred cards, divider, neon-helpers (7/9 routes)    |
| i18n               | 100%      | RU + EN, 1730+ keys                                       |

Общий progress: **~88%**.

---

## P0 — Закрыть критические дыры (1-2 дня)

### P0.1. Wire forge / resilience / qdrant / bookhunter runtime preferences ✅ DONE

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

### P0.2. E2E тест полного цикла

**Проблема:** есть `scripts/e2e-book-ingest.ts` и `e2e-library-ux.ts`, но они
покрывают только Library. Нет цепочки **drop → ingest → crystallize → forge bundle → eval**.

**Решение:** добавить `scripts/e2e-full-mvp.ts` -- скрипт прогоняющий sample
PDF (включая 1 scanned + 1 image) через все стадии. Проверяет JSON snapshots.

**Критерий "сделано":** `npm run test:e2e:mvp` зелёный за <10 минут на pure-CPU.

### P0.3. Auto-update / OTA каналы

**Проблема:** electron-builder конфигурация есть, но publisher (GitHub
Releases / S3) не настроен. Пользователю придётся вручную качать новые
версии.

**Решение:** в `package.json#build.publish` указать GitHub Releases provider,
выпустить v0.1.0-rc1.

**Критерий "сделано":** в приложении появляется баннер "новая версия
доступна" + один клик для apply.

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

### P1.3. Полный Neon rollout

Ещё 2 маршрута без Neon: `Chat` (только частично) и `Docs`. Нужно:
`buildNeonHero` + `wrapSacredCard` для main panels. Минимум усилий, большой
визуальный эффект.

### P1.4. Onboarding wizard improvements

`renderer/components/welcome-wizard.js` существует, но не вызывается на
первом запуске. Нужно: проверить `data/preferences.json` отсутствует →
показать wizard (4 шага: language, LM Studio URL, Qdrant URL, OCR opt-in).

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
