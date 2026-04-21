# PHASE 3 PLAN — Bibliary Renderer Feature Work

> После Phase 1 (5 bug fixes) и Phase 2 (5 extract-method refactors) кодовая
> база renderer'а готова к feature work. Этот документ — глубокий план
> следующей фазы с ROI-расчётом по `/omnissiah-docs/refactor-rubric`.

---

## Положение дел на старте Phase 3

### Что закрыто (Phase 1 + Phase 2, 10 коммитов)

| Phase | Commit | Суть |
|---|---|---|
| 1.1 | `b169ab9` | guard `STATE.busy` в `sendPrompt` + try/catch в approval-handler |
| 1.2 | `b169ab9` | (вместе с 1.1) |
| 1.3 | `403e39d` | теневой `t` → `eventType` в `handleAgentEvent` |
| 1.4 | `5ae1f79` | jobId-фильтр стейл-событий в Crystallizer `handleEvent` |
| 1.5 | `6571e11` | disable delete во время активного ingest + i18n-ключи RU/EN |
| 2.1 | `37de872` | `renderControls` 127 → 17 строк, +4 builder (DRY model row) |
| 2.2 | `e2bc95e` | `handleEvent` 89 → 12 строк (dispatcher + 7 stage handlers) |
| 2.3 | `0a5fcad` | `handleAgentEvent` 98 → 9 строк (dispatcher + 9 type handlers) |
| 2.4 | `e1b744d` | `mountAgent` 86 → 16 строк (6 builder/bind хелперов) |
| 2.5 | `729d32f` | `mountLibrary` 143 → 33 строки (8 builder/subscribe хелперов) |

### Метрики health-check (baseline для Phase 3)

- **TypeScript `tsc --noEmit`:** 0 errors ✅
- **ESLint `renderer/*.js`:** 0 errors / 9 baseline warnings ✅
- **Unit tests `test:dataset-v2`:** 12/12 PASS ✅
- **Scanner smoke `test:scanner`:** 4/4 PASS ✅
- **Функции >50 строк:** 0 в renderer/dataset-v2.js, renderer/forge-agent.js, renderer/library.js
- **Теневые имена i18n `t`:** 0 (все переименованы в `eventType`)
- **Race conditions в renderer:** нет известных

---

## 5 почему — зачем Phase 3?

```
ПРОБЛЕМА: После Phase 1+2 у нас чистая база, но 0 новой функциональности.
  ↓
Почему 1: Phase 1+2 — это техдолг, не feature work.
  ↓
Почему 2: Техдолг разблокирует следующие фичи — становится дешевле добавить.
  ↓
Почему 3: Цель проекта — MVP (`ROADMAP-TO-MVP.md`), не идеальный код.
  ↓
Почему 4: Чистый код без следующего шага к MVP = ловушка "улучшаем ради улучшения".
  ↓
Почему 5: Phase 3 = возврат к feature work на уже почищенной базе, с измеримыми
          метриками готовности (88% → 92% по таблице ROADMAP).
```

**Корень:** Phase 3 закрывает высокоROI-пункты из P1-блока `ROADMAP-TO-MVP.md`
и доводит проект до первого RC.

---

## Кандидаты Phase 3 — ROI-таблица

По рубрике `/omnissiah-docs/refactor-rubric`:
**ROI = (Боль × 3) / (Стоимость × 2)** — >2.0 делать сейчас, 1.0-2.0 в спринт, <1.0 отложить.

| # | Кандидат | Источник | Боль | Стоимость | ROI | Решение |
|---|---|---|---|---|---|---|
| 3.1 | Onboarding wizard wire (`welcome-wizard.js` готов, не подключён) | ROADMAP P1.4 | 4 (новые юзеры теряются) | 1 (wire 30 мин) | **6.0** | ✅✅ ПЕРВЫМ |
| 3.2 | Real-time прогресс ingest внутри dropzone | ROADMAP P1.1 | 4 (нет UX feedback) | 2 (один файл, 2-3 ч) | **3.0** | ✅ ДЕЛАТЬ |
| 3.3 | Session restore (persist `STATE.books`+`STATE.selected`) | ROADMAP P1.2 | 4 (потеря выбора при рестарте) | 3 (новый JSON-store + restore) | **2.0** | ✅ В СПРИНТ |
| 3.4 | Toast system (замена ~10 `alert()` на неблокирующие тосты) | ROADMAP P1.5 | 3 (alert блокирует UI) | 3 (новый компонент + миграция) | **1.5** | 🟡 СПРИНТ |
| 3.5 | Полный Neon rollout (Chat + Docs routes) | ROADMAP P1.3 | 3 (визуал) | 3 (2 экрана) | **1.5** | 🟡 СПРИНТ |
| 3.6 | Phase 0 audit-tools (`check-i18n.ts`, `audit-renderer.ts`) | план 2.3 из roadmap-refactor | 2 (не блокирует) | 2 (2 скрипта по 100 строк) | **1.5** | 🟡 ПОЛЕЗНО |
| 3.7 | i18n dictionary splitting | изначальный план Phase 3 | 2 (редко правят) | 4 (большой blast radius) | **0.75** | ❌ ОТЛОЖИТЬ |

---

## Детализация High-ROI кандидатов

### 3.1 Onboarding Wizard Wire (ROI 6.0)

**Что:** `renderer/components/welcome-wizard.js` уже существует (252 строки),
но не вызывается на первом запуске. Нужно подключить.

**Изменения:**
- `electron/main.ts` или `renderer/bootstrap.js`: проверка `data/preferences.json`
  на первом старте → если отсутствует, router.push("/welcome")
- `renderer/router.js`: зарегистрировать маршрут `/welcome`
- Wizard 4 шага: language, LM Studio URL, Qdrant URL, OCR opt-in
- После "Финиш" → writePreferences + navigate to "/library"

**Критерий "сделано":**
- Первый запуск (удалена `data/`) → показывает wizard, по завершению
  создаёт preferences.json и открывает библиотеку.
- Повторные запуски — не показывают wizard.

**Риск:** НИЗКИЙ. Wizard изолирован, не меняет существующие routes.

**Blast radius:** 2 файла (router.js + bootstrap).

---

### 3.2 Real-time Dropzone Progress (ROI 3.0)

**Что:** При drag&drop файлов в dropzone сейчас нет визуального прогресса.
`STATE.activeIngests` уже отслеживает активные, `STATE.queue` — ожидающие.

**Изменения:**
- `renderer/library.js`: новая функция `buildDropzoneOverlay(activeCount, queueCount)`
- `runOne` + `pumpQueue` вызывают `refreshDropzoneOverlay()` на каждое изменение
- CSS: positioning absolute внутри dropzone, fade-in/out, анимация прогресса
- i18n-ключи: `library.dropzone.progress.active`, `library.dropzone.progress.queue`

**Критерий "сделано":**
- Drop 5 файлов → overlay "Обрабатывается 2 из 5 · в очереди 3"
- Каждый завершённый ingest обновляет цифры
- По завершению всех — overlay исчезает с fade-out

**Риск:** НИЗКИЙ. Чистое добавление UI-слоя, не трогает логику ingest.

**Blast radius:** 1 файл renderer + CSS + 2 i18n ключа × 2 языка.

---

### 3.3 Session Restore (ROI 2.0)

**Что:** Persist выбранных книг/коллекции между запусками приложения.

**Изменения:**
- Новый файл: `electron/lib/library/session-store.ts`
  - `saveSession({ collection, bookAbsPaths, selected })` — debounced 500ms
  - `loadSession()` → `{ collection, bookAbsPaths, selected } | null`
  - `clearSession()` — для "New session" кнопки
  - Хранится в `data/library-session.json`
- IPC-handler: `library:save-session`, `library:load-session`, `library:clear-session`
- `renderer/library.js::mountLibrary`: на старте вызвать `library:load-session`,
  восстановить `STATE.books` + `STATE.selected` + `STATE.collection`
- `renderer/library.js`: в `runOne`, `cancelAll`, `addBooks`, `toggleSelect`
  — вызывать debounced `library:save-session`
- Preference `library.restoreSessionOnStartup` (default: true) в Settings

**Критерий "сделано":**
- Выбрал 50 книг из 100 → закрыл → открыл → 50 книг восстановлены, 50 отмечены.
- Настройка "Restore on startup = off" → session не загружается.

**Риск:** СРЕДНИЙ. Добавляется новый stateful слой, надо аккуратно debounce
(иначе spam записей на диск).

**Blast radius:** 1 новый файл electron + 1 IPC + renderer/library.js + settings.

---

## Последовательность Phase 3 (5-7 рабочих дней)

```
ДЕНЬ 1 — Phase 3.1: Onboarding Wizard (ROI 6.0)
├─ Утро: проверить welcome-wizard.js на актуальность
├─ Wire в router.js + bootstrap
├─ Тест: удалить data/preferences.json → проверить что wizard показывается
└─ Commit: feat(onboarding): wire welcome wizard на первый запуск

ДЕНЬ 2-3 — Phase 3.2: Dropzone Progress (ROI 3.0)
├─ День 2 утро: buildDropzoneOverlay + CSS + i18n
├─ День 2 день: wire в runOne/pumpQueue с refreshDropzoneOverlay
├─ День 2 вечер: визуальный smoke-test (drop 5 файлов)
├─ День 3 утро: edge cases (empty queue, все одновременно завершаются)
└─ Commit: feat(library): real-time прогресс ingest на dropzone

ДЕНЬ 3-4 — Phase 3.3: Session Restore (ROI 2.0)
├─ День 3 вечер: electron/lib/library/session-store.ts (JSON atomic writes)
├─ День 4 утро: IPC handlers + preload bridge
├─ День 4 день: wire в renderer/library.js (save/load/clear)
├─ День 4 вечер: Settings toggle + i18n
├─ День 4 вечер: smoke-test restore после kill приложения
└─ Commit: feat(library): session restore между запусками

ДЕНЬ 5 — Phase 3.4: Toast System (ROI 1.5) ИЛИ 3.5 Neon rollout
├─ Выбрать по текущим приоритетам пользователя
└─ Commit: feat(ui): toast manager для неблокирующих уведомлений

ДЕНЬ 6-7 — Phase 3.6 audit-tools + контрольные проверки
├─ scripts/check-i18n.ts — дубликаты, RU/EN parity, runtime-undefined
├─ scripts/audit-renderer.ts — window.api без try/catch, listeners без cleanup
├─ npm scripts: lint:i18n, audit:renderer
├─ Финальный прогон: npm run test:dataset-v2 + test:scanner + lint
└─ Commit: chore(tooling): характеризационные скрипты check-i18n, audit-renderer
```

---

## Инварианты Phase 3 — ЧТО НЕЛЬЗЯ ЛОМАТЬ

1. **JobId-фильтр в `handleEvent`** (Fix 1.4) — остаётся нетронутым.
2. **`renderLog(root)` всегда в конце dispatcher** — Crystallizer UI.
3. **`STATE.currentAgentId` перехват** (forge-agent) — не трогать dispatcher.
4. **id `#cv-start`, `#cv-stop`, `#cv-accepted-total`, `#agent-stop`,
   `#agent-send`, `#agent-input`, `#lib-selected-count`, `#lib-total-count`,
   `#lib-queue-count`, `#lib-collection-suggestions`** — не переименовывать.
5. **CSS-классы `.cv-*`, `.agent-*`, `.lib-*`** — не менять (ломает темизацию).
6. **Lint baseline:** 0 errors / 9 warnings — повышение warnings не допускается.

---

## Критерии готовности Phase 3 → MVP RC1

После завершения Phase 3.1–3.6 проект готов на **~92%** по
`ROADMAP-TO-MVP.md` таблице. Останется:

- **P0.3** Auto-update / OTA — настроить GitHub Releases publisher
  (1 день, отдельная Phase 4)
- **Сборочный чеклист RC1** (`ROADMAP-TO-MVP.md:251-260`)
- `git tag v0.1.0-rc1 && git push --tags`

---

## Риски Phase 3 и смягчение

| Риск | Вероятность | Смягчение |
|---|---|---|
| `welcome-wizard.js` устарел (i18n-ключи не совпадают) | Высокая | Первый шаг 3.1 — быстрый аудит ключей |
| Debounced session-save race с `cancelAll` | Средняя | Use `queueMicrotask` + version tag, test через kill+restart |
| Dropzone-overlay перекрывает drop-events | Средняя | `pointer-events: none` на overlay |
| Toast-component конфликтует с existing alert() | Низкая | Миграция по одному alert() за коммит |
| Neon rollout ломает Chat CSS | Низкая | Прогонять на отдельной ветке, ручной smoke |

---

## Чеклист запуска Phase 3

Перед началом каждого 3.X-шага:

- [ ] `npm run lint` — 0 errors / 9 warnings
- [ ] `npm run test:dataset-v2` — 12/12 PASS
- [ ] `npm run test:scanner` — 4/4 PASS
- [ ] `git status` — рабочая директория чистая
- [ ] Прочитан ROI-пункт и критерий "сделано" для текущего 3.X
- [ ] Понятно, какие инварианты НЕЛЬЗЯ ломать

После каждого 3.X:

- [ ] `npm run lint` — baseline сохранён
- [ ] Атомарный коммит с описанием "what & why" (на русском, по стилю предыдущих)
- [ ] Ручной smoke-test критерия "сделано"
- [ ] Обновить эту таблицу кандидатов (перенести 3.X из PENDING в DONE)

---

## Связанные документы

- `docs/ROADMAP-TO-MVP.md` — стратегический roadmap до RC1
- `docs/TECH-LEAD-REVIEW.md` — архитектурный разбор проекта
- `docs/RESILIENCE.md` — политики устойчивости (критичны при session-restore)
- `/omnissiah-docs/refactor-rubric` — рубрика оценки рефакторинга
