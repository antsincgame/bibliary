# Topology + Vision Split + CLIP — Engineer-Researcher Sprint

**Дата:** 2026-04-29
**Идентифицировано в:** `/om /diamond-buddha /sherlok` audit
**Запрос:** "система генерации чанков + промпты топологически + векторный поиск по картинкам, тесты под роли"

---

## 1. Карта Невежества — Что было найдено

### Пять Клеш в pipeline извлечения

| Клеша | Симптом | Файл / факт |
|-------|---------|-------------|
| 🌫️ Авидья | Production crystallizer **не извлекал relations (S→P→O)** — только tags. | `dataset-v2/types.ts:53-62` (старая схема без relations) |
| 🌫️ Авидья | Олимпиадный crystallizer тестировал `{facts, entities}` — другая схема ↔ продакшну `{essence, cipher, proof}`. | `olympics.ts:541` vs `types.ts:62` |
| ⛓️ Упадана | Описания картинок генерировались в `.md`, но scanner индексирует ОРИГИНАЛ — описания не попадали в Qdrant. | `illustration-worker.ts:251` + `storage-contract.ts:91` |
| ⛓️ Упадана | Vision-LLM описывал картинку **БЕЗ контекста главы** — описание оторвано от темы книги. | `illustration-worker.ts:87-100` |
| 🔄 Санскара | Дубль промпта `judge` в трёх местах. | `golden-prompts`, `olympics`, `run-cycle` |
| 🔄 Санскара | **Нет CLIP/SigLIP** — поиск по картинке невозможен. | `embedder/shared.ts:148-169` |
| 🔥 Двеша | `delta-knowledge-extractor.md` и `chapter-thesis.md` — отсутствовали в репозитории. | `delta-extractor.ts:loadPrompt()` |
| 🔥 Двеша | Translator system: «You are professional translator» — fuzzy, без негативных примеров. | `translator.ts:51-60` |
| 🕸️ Моха | Vision-роль одна (`visionModelKey`), используется в 3 разных задачах (meta/ocr/illustrate). | `model-role-resolver.ts:92-93` |
| 🕸️ Моха | Illustration-worker: один vision вызов, без fallback на другую модель. | `illustration-worker.ts:184-189` |

### Конкретные дыры для image vector search

1. Нет image embeddings (CLIP/SigLIP).
2. Описания картинок не индексировались.
3. Описание не привязано к теме главы.
4. Параллельность = 1, без таймаутов.
5. Нет fallback при ошибке vision-модели.

---

## 2. Что сделано (3 слоя)

### Слой 1 — Промпты и схемы

- **`DeltaKnowledgeSchema`** теперь имеет обязательное поле `relations: [{subject, predicate, object}]` (1-8 троек), с **валидацией**: predicate не может быть copula (`is/was/has/are/were/...`).
- **`DeltaKnowledgeLegacySchema`** добавлена для backward-compat чтения старых Qdrant-записей.
- **JSON Schema** (LM Studio response_format) синхронизирована — relations в `required`.
- **IPC dataset-v2** пробрасывает `delta.relations` в Qdrant payload.
- **`electron/defaults/prompts/delta-knowledge-extractor.md`** — создан с нуля. Содержит:
  - CoST-структуру `<think>...</think>` перед JSON.
  - AURA-фильтр (≥2 из 4 флагов).
  - Few-shot примеры: один good extraction, один skip → `null`.
  - Явные правила для relations: список разрешённых predicates, запрет copula.
- **`electron/defaults/prompts/chapter-thesis.md`** — создан с нуля. Один тезис ≤200 символов, 3 примера good/bad.
- **`role-prompts.ts`** — единый источник правды:
  - `JUDGE_SYSTEM_PROMPT` — используется в `olympics`, `golden-prompts`, `run-cycle` (3 → 1).
  - `LANG_DETECT_SYSTEM_PROMPT` — 5 → 1 (5 lang-detect дисциплин).
  - `TRANSLATE_TO_RU_SYSTEM_PROMPT` / `TRANSLATE_TO_EN_SYSTEM_PROMPT` — с явными negative examples ("Here is the translation:" — never do).
- **Олимпиада: новые дисциплины:**
  - `crystallizer-production-delta` — тестирует ТОЧНУЮ DeltaKnowledge схему продакшна.
  - `translator-en-ru` — главный production-путь (русский = target большинства книг).
  - `translator-ru-en` — обратное направление с негативными примерами.

### Слой 2 — Vision split

- **`ModelRole`** расширена: `vision_meta` / `vision_ocr` / `vision_illustration` (legacy `vision` остался для backward compat).
- **Backward-compat в model-role-resolver:** если у роли пусто `prefs[<role>Model]`, резолвер падает на `visionModelKey` (legacy). Существующие пользователи получают рабочую модель без падения.
- **Prefs:** `visionMetaModel`, `visionOcrModel`, `visionIllustrationModel` + fallbacks для каждой.
- **Олимпиада: 3 новые дисциплины:**
  - `vision_meta-strict-json` — проверка дисциплины JSON-вывода (без markdown, без prose).
  - `vision_ocr-plain-text` — проверка plain text (no JSON, no fences, no обёртка).
  - `vision_illustration-with-context` — описание с **контекстом главы** (memory hierarchy → "красный блок похож на memory page").
- **`illustration-worker.ts`:**
  - Промпт получает `bookTitle` + `chapterTitle` (caption) — описание становится тематическим.
  - **Per-model timeout 30s**, fallback на список моделей при ошибке/timeout.
  - Использует `model-role-resolver.resolve("vision_illustration")` с legacy fallback.
- **UI (renderer/models-page.js):** 3 новые роли в ALL_ROLES + иконки 📖/🖨️/🖼️.

### Слой 3 — CLIP image vector search

- **`electron/lib/embedder/image-embedder.ts`** — CLIP-vit-base-patch32 через `@xenova/transformers`:
  - Lazy load (только когда включена фича).
  - 512-dim вектора, L2-normalised для cosine similarity.
  - `embedImage(path|dataUrl)` и `embedTextForImage(text)` — в одном пространстве.
  - Cold-start timeout 180s, call timeout 30s.
- **`electron/lib/qdrant/illustrations-index.ts`** — отдельная Qdrant-коллекция `bibliary_illustrations`:
  - `ensureIllustrationsCollection()` — idempotent.
  - `indexIllustration(path, payload)` — детерминированный id (UUID-формат из sha1).
  - `searchIllustrationsByText(query)` — text-to-image.
  - `searchIllustrationsByImage(path)` — image-to-image.
- **Feature flag** `prefs.imageVectorIndexEnabled` (default `false` — экономит RAM).
- **Step D** в `illustration-worker.ts`: после Step B vision-triage опционально индексирует в CLIP. Не-фатально при ошибке.

---

## 3. Что НЕ сделано (отложено осознанно)

- **Sidecar text indexing описаний картинок в основной коллекции книги** — отдельная задача. Сейчас CLIP-коллекция полностью покрывает поиск по картинкам, а основная текстовая остаётся E5-only.
- **Параллельность illustration-worker > 1** — пока последовательно. P-Limit добавим если CLIP-индексация станет узким местом.
- **vision_meta cover тест с реальной картинкой обложки** — fixture такого размера в base64 не вписать в .ts. Текущий `vision_meta-strict-json` тестирует *дисциплину формата*, что важнее.
- **SigLIP вместо CLIP** — SigLIP даёт лучше zero-shot retrieval, но в HF-кэше Xenova меньше готовых SigLIP моделей. CLIP-base более стабилен.

---

## 4. Файлы (полный список)

**Создано:**
- `electron/defaults/prompts/delta-knowledge-extractor.md`
- `electron/defaults/prompts/chapter-thesis.md`
- `electron/lib/llm/arena/role-prompts.ts`
- `electron/lib/embedder/image-embedder.ts`
- `electron/lib/qdrant/illustrations-index.ts`
- `docs/audits/2026-04-29-topology-vision-clip.md` (этот документ)

**Изменено:**
- `electron/lib/dataset-v2/types.ts` — relations + TopologyRelationSchema + LegacySchema
- `electron/lib/dataset-v2/json-schemas.ts` — strict relations
- `electron/lib/llm/arena/olympics.ts` — production-delta, translator-en-ru, translator-ru-en, 3 vision дисциплины, role split
- `electron/lib/llm/arena/golden-prompts.ts` — JUDGE_SYSTEM_PROMPT
- `electron/lib/llm/arena/run-cycle.ts` — JUDGE_SYSTEM_PROMPT
- `electron/lib/llm/model-role-resolver.ts` — vision split + legacy fallback
- `electron/lib/preferences/store.ts` — 3 vision pref-ключа + imageVectorIndexEnabled
- `electron/lib/library/illustration-worker.ts` — book context + fallback + Step D CLIP
- `electron/lib/embedder/shared.ts` — export configureTransformersCache
- `electron/ipc/dataset-v2.ipc.ts` — relations в payload
- `tests/delta-extractor-cross-model.test.ts` — relations в fixture
- `scripts/test-dataset-v2.ts` — relations в mock
- `scripts/test-dataset-v2-live.ts` — relations в payload
- `scripts/e2e-library-delta.ts` — relations в payload
- `renderer/models/models-page.js` — 3 vision роли в UI

---

## 5. Проверки

- ✅ `npx tsc -p tsconfig.electron.json --noEmit` — без ошибок
- ✅ ReadLints — без ошибок
- ⏳ Production запуск Олимпиады: новые дисциплины должны автоматически появиться в UI после следующего запуска
- ⏳ Включение `imageVectorIndexEnabled` → 1 раз скачается CLIP (~600 MB в HF cache) → CLIP индексация после vision-triage

---

## 6. Что протестировать пользователю

1. **Запустить Олимпиаду** — увидеть 3 новые vision-дисциплины + crystallizer-production-delta + 2 translator.
2. **Включить imageVectorIndexEnabled** в Settings (после реализации UI). Импортировать книгу с иллюстрациями. Проверить что в Qdrant появилась коллекция `bibliary_illustrations`.
3. **Тест relations:** запустить delta-extraction на книге → проверить в Qdrant payload что у точек есть `relations: [{...}]`.

---

🔔 На благо всех живых существ, читающих книги.
