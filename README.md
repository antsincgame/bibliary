# Bibliary

> Превращает коллекцию книг в датасет для дообучения LLM — через структурированный Markdown, смысловые чанки и Chroma-коллекции.

**Платформа:** Windows / macOS / Linux · **Модели:** LM Studio (локально) · **Vector store:** Chroma

---

## Что это

### Bibliary — это пайплайн знаний, не RAG-чат

**Что удалено:** в v0.3.0 был вырезан RAG-чат (hybrid-поиск, BM25, BGE-rerank, help-kb). Bibliary больше не отвечает на вопросы о книгах в режиме диалога.

**Что осталось:** две параллельных дороги через одни и те же книги:
- **Путь A — Dataset:** book.md → semantic chunks → LLM-кристаллизатор → концепты в Chroma → ChatML JSONL
- **Путь B — Search:** book.md → raw chunks → vector embeddings → Chroma → семантический поиск по смыслу

Путь A — главный: создание датасетов для дообучения LLM.  
Путь B — служебный: проверить что попало в коллекцию, найти нужную книгу по смыслу.

### Bibliary — это пайплайн знаний

```
Книги (PDF / EPUB / DJVU / ...)
        │
        ▼ парсинг + OCR
Структурированный Markdown  ←── реальный текст книги, сохранённый по главам
        │
        ▼ LLM-оценщик
Фильтрация качества  ←── отсевает беллетристику, воду, низкокачественные сканы
        │
        ▼ Кристаллизация
Смысловые чанки → Chroma-коллекции  ←── векторизованные блоки по тематикам
        │
        ▼ Генерация датасета
ChatML JSONL  ←── файл для fine-tuning LLM (T1/T2/T3 уровни сложности)
```

**Для кого:** исследователи, аналитики, разработчики датасетов для дообучения LLM, люди с большими книжными коллекциями.

---

## Жизненный цикл книги

Каждая книга проходит 6 состояний:

| Статус | Что происходит |
|--------|----------------|
| `imported` | Файл распарсен, `book.md` создан на диске. Реальный текст есть. |
| `evaluating` | LLM-оценщик читает главы, оценивает качество и предметную область. |
| `evaluated` | Получены `qualityScore`, `domain`, `tags`. Книга готова к кристаллизации. |
| `crystallizing` | Главы бьются на смысловые чанки, чанки векторизуются и уходят в Chroma. |
| `indexed` | Все чанки приняты в коллекцию. Книга пригодна для генерации датасета. |
| `failed` / `unsupported` | Парсер или оценщик упали. Подробности в import-логах. |

**Важно:** `imported` ≠ пустая книга. На этом шаге `book.md` уже содержит полный текст по главам. Оценщик и кристаллизация — отдельные шаги, которые запускаются после.

---

## Ключевые возможности

### 📚 Импорт и конвертация в Markdown
- Поддержка **PDF, DJVU, EPUB, MOBI/AZW3, FB2, DOCX, RTF, ODT, TXT, HTML, CHM** + контейнеры **ZIP/RAR/7z** и multi-book архивы **fb2.zip** (Флибуста/Либрусек)
- Авто-определение кодировок старых файлов (windows-1251, KOI8-R, IBM866) через `chardet` + `iconv-lite`
- Эвристический парсер русских имён `[Фамилия И.О.] - [Название] - [Год].ext` для метаданных без EXTH
- **Без Calibre** — все форматы парсятся pure-JS (palm-mobi.ts) или vendor CLI (DjVuLibre, 7zip)
- Трёхуровневый каскад парсинга: `edgeparse` → `pdf-inspector` → `pdfjs-dist`
- OCR для сканированных PDF и DJVU (через системный OCR или vision-LLM)
- SHA-256 дедупликация: одинаковый файл → одна запись, всегда
- Умный роутинг: если в папке несколько форматов одной книги — берётся лучший
- Синтетическая обложка в научном стиле, если обложки нет в файле
- Результат — `book.md` с YAML frontmatter, главами и CAS image refs

### 📖 Versator — премиум-вёрстка book.md (build-time)
- Каждая книга при импорте проходит через **layout-pipeline** — pure-JS, без LLM, без сетевых вызовов
- **Smart typography** через `typograf`: русские «ёлочки», em-dash, NBSP между числом и единицей
- **Auto-callouts**: `Внимание:` / `Совет:` / `Note:` / `Warning:` / `Important:` → стилизованные блоки с цветными иконками
- **Definitions detection**: `«Энтропия — это X»` → `<dfn>Энтропия</dfn>` с акцентом
- **Drop caps**: первая буква текстового параграфа каждой главы — большая золотая буквица
- **Tufte sidenotes**: markdown footnotes `[^N]` → заметки на полях (CSS-only toggle на узких экранах)
- **Math**: `$x^2$` и `$$\int...$$` через **локальный KaTeX** (vendored, 0 сетевых вызовов, 283 KB шрифты + CSS)
- **Code-protection**: typograf и др. трансформации не трогают `code` / ` ```fenced``` ` блоки
- **Premium Scientific CSS-тема** в ридере: системный serif стэк (Charter/Garamond/Cambria), justified text, scientific blockquotes
- **Lazy upgrade legacy книг (v0.8.1)**: книги, импортированные до v0.8.0 (без `layoutVersion` в frontmatter), получают Versator-вёрстку **автоматически при первом открытии в reader** — read-only, без перезаписи диска, ~10–30 ms на крупный body
- Результат: `layoutVersion: 1` в frontmatter, идемпотентно при повторном импорте

### 📖 Ридер и библиотека (v0.10.1)

- Вёрстка читалки на flex: контент не «наезжает» на верхнюю панель; текст на всю ширину области чтения; горизонтальный скролл только у длинных блоков кода/таблиц/широких изображений.
- Оглавление в тексте связывается с заголовками якорями (клик ведёт к главе).
- Ссылки на иллюстрации в стиле `![страница][img-001]` стабильно рендерятся даже при кривых code fence в исходном `.md`.
- **Удаление книги** из каталога снимает оба варианта имён sidecar’ов (legacy `original.pdf` + modern `{Title}.original.{ext}` и т.д.) и подчищает пустые папки вверх по дереву.
- **Dev / тест импорта:** Настройки → «Показать продвинутые» → **Сжечь библиотеку** — полная очистка библиотеки на диске и кэша (не затрагивает настройки приложения).

### 🧠 Оценка качества (LLM)
- Оценщик читает первые/последние главы через `multilingual-e5-small`
- Выдаёт `qualityScore`, `domain`, `tags`, `isFictionOrWater`
- Книги с низким баллом автоматически пропускаются при кристаллизации

### 💎 Кристаллизация → Chroma
- Главы из `book.md` → структурные чанки (~900 символов, не режет абзацы)
- Каждый чанк: детерминированный UUID от содержимого, метаданные (книга, глава, теги)
- Векторизация через `multilingual-e5-small` (384-мерный cross-lingual эмбеддер)
- Batch upsert в Chroma — идемпотентно, resume-safe после краша

### 📊 Генерация датасета
- Chroma чанки → ChatML JSONL для fine-tuning LLM
- T1 / T2 / T3 уровни сложности на каждый чанк
- R1-style reasoning трейсы (опционально)
- Экспорт в файл

### 🔍 Семантический поиск (бонус)
- Поиск по векторам в Chroma через тот же `multilingual-e5-small`
- Работает на смысле, без точных слов — побочный эффект индексации

---

## Архитектура

```
bibliary/
├── electron/              # Main process (Node.js + Electron)
│   ├── main.ts            # Точка входа, регистрация IPC
│   ├── preload.ts         # Безопасный мост renderer ↔ main
│   ├── ipc/               # IPC-обработчики по доменам
│   └── lib/
│       ├── library/       # ЯДРО: импорт, MD-конвертация, хранилище, оценщик
│       │   ├── import.ts           # Оркестрация импорта папки/файлов
│       │   ├── import-book.ts      # Импорт одной книги
│       │   ├── md-converter.ts     # Book → Markdown (YAML fm + главы + image refs)
│       │   ├── book-evaluator.ts   # LLM качество/домен/теги
│       │   ├── library-store.ts    # CAS (.blobs/) хранилище изображений
│       │   ├── cache-db.ts         # SQLite каталог (восстанавливается из .md)
│       │   ├── revision-dedup.ts   # HARD+REPLACE: оставляем лучшее издание
│       │   └── cover-generator.ts  # SVG обложка из метаданных
│       ├── scanner/        # Парсеры форматов + чанкер + ingest
│       │   ├── parsers/            # PDF/DJVU/EPUB/FB2/DOCX/TXT/HTML/...
│       │   ├── chunker.ts          # Структурные чанки из ParseResult
│       │   ├── ingest.ts           # parse → chunk → embed → Chroma (Browse tab)
│       │   └── embedding.ts        # multilingual-e5-small wrapper
│       ├── dataset-v2/     # Кристаллизация + генерация ChatML JSONL
│       │   ├── extraction-runner.ts   # Chroma чанки → LLM → Q&A пары
│       │   ├── semantic-chunker.ts    # Семантическое разбиение (dataset путь)
│       │   ├── export.ts              # Сериализация в ChatML JSONL
│       │   └── coordinator-pipeline.ts# Watchdog-aware batch coordinator
│       ├── llm/            # LM Studio клиент, роли
│       ├── embedder/       # multilingual-e5-small (ONNX, CPU/GPU)
│       ├── chroma/         # Chroma клиент, управление коллекциями
│       ├── resilience/     # Circuit breaker, bulkhead, watchdog, AIMD, checkpoint
│       └── preferences/    # Настройки (Zod-схема, SQLite)
├── renderer/              # Frontend (Vanilla JS, без фреймворков)
│   ├── library/           # UI библиотеки: импорт, каталог, ридер, лог
│   ├── models/            # UI моделей
│   ├── dataset-v2*.js     # UI генерации датасетов
│   ├── search.js          # UI семантического поиска
│   ├── locales/           # Локализация (ru, en)
│   └── styles.css
├── tests/                 # unit и integration тесты
└── data/                  # Данные приложения (не коммитится)
    └── library/           # Один каталог = одна книга
        └── <lang>/<domain>/<author>/<Book Title>/
            ├── <Book Title>.md         # Главный файл: frontmatter + текст + image refs
            ├── <Book Title>.original.{ext}  # Оригинальный файл (read-only)
            └── .blobs/                 # CAS: обложки и иллюстрации по SHA-256
```

### Поток данных: от файла до датасета

```
[Пользователь выбирает папку или файлы]
          │
          ▼
 import.ts: walkSupportedFiles → CrossFormatPreDedup (лучший формат из папки)
          │
          ▼
 import-book.ts:
   1. SHA-256 streaming → дедупликация (файл уже есть? → duplicate)
   2. convertBookToMarkdown(file):          [md-converter.ts]
       a. parseBook(file) → ParseResult{sections[], metadata}
          └─ parsers/: PDF/DJVU/EPUB/FB2/DOCX/TXT/HTML...
          └─ OCR fallback если sections пусты
       b. ISBN lookup → Open Library / Google Books
       c. extractBookImages → CAS upload → bibliary-asset://sha256/...
       d. generateSyntheticCoverSvg если обложки нет
       e. buildBody(## chapters) + buildImageRefs(cas_urls) + buildFrontmatter
   3. Сохранить book.md + original.{ext} на диск
   4. upsertBook в SQLite (status='imported')
   5. Поставить в evaluator-queue
          │
          ▼ [async, evaluator-queue]
 book-evaluator.ts:
   parseBookMarkdownChapters(book.md) → суррогатный документ
   LLM(evaluator role) → qualityScore, domain, tags, isFictionOrWater
   replaceFrontmatter(book.md) → обновлённый YAML frontmatter
   upsertBook(status='evaluated')
          │
          ├─────────────────────────────────────────────┐
          ▼ ПУТЬ A: Кристаллизация                     ▼ ПУТЬ B: Raw Ingest (Browse)
 dataset-v2/extraction-runner.ts:            scanner/ingest.ts:
   ⚠ Парсит original.{ext} заново              Парсит original.{ext} заново
   (book.md используется для каталога,         parseBook → chunkBook (chunker.ts)
    оригинал — для экстракции)                 ~900 символов, структурные границы
   parseBook → semantic-chunker.ts            embedPassage("passage: " + chunk)
   chunkChapter() + cosine drift              Float32[384] → Chroma upsert
   delta-extractor.ts:
     LLM(crystallizer) → концепты            ← Используется в семантическом поиске
   embed(essence) → Chroma upsert
   upsertBook(status='indexed')
          │
          ▼ [раздел Crystal / Датасеты]
 dataset-v2/concept-loader.ts → Chroma scroll(collection) → концепты
 dataset-v2/export.ts → ChatML JSONL (T1/T2/T3) + reasoning traces
```

**Ключевой архитектурный факт:** `book.md` — каноническое хранилище для каталога, ридера и оценщика. Кристаллизация и raw-ingest **повторно парсят** `original.{ext}` — это гарантирует что LLM видит максимально сырой текст, а не переформатированный Markdown.

---

## Требования

| Компонент | Версия | Назначение |
|-----------|--------|------------|
| [LM Studio](https://lmstudio.ai/) | 0.3+ | Локальный инференс LLM |
| [Chroma](https://www.trychroma.com/) | latest | Векторная база данных |
| [uvx](https://docs.astral.sh/uv/) или Docker | любая | Запуск Chroma |
| Windows / macOS / Linux | x64 / arm64 | Поддерживаемые платформы |
| RAM | 8+ GB | Минимум; 16+ GB рекомендуется |

**Рекомендуемое железо:** 16–32 GB RAM, GPU с 6+ GB VRAM (для S/M-class моделей в LM Studio).

**Без GPU:** всё работает на CPU, просто медленнее (embedding и OCR — CPU-bound).

---

## Быстрый старт

### Вариант 1: Portable .exe (Windows)

1. Скачайте последний `.exe` из [Releases](https://github.com/antsincgame/bibliary/releases)
2. Запустите Chroma: `uvx chromadb run --path ./db_data --port 8000` (или `docker compose up -d chroma`)
3. Запустите LM Studio, загрузите модель (рекомендуется 7–14B reasoning)
4. Запустите exe — данные хранятся рядом с exe

### Вариант 2: Из исходников

```bash
git clone https://github.com/antsincgame/bibliary.git
cd bibliary
npm install
cp .env.example .env   # настройте URLs если нужно
npm run electron:dev
```

### Конфигурация `.env`

```env
CHROMA_URL=http://localhost:8000
CHROMA_TOKEN=                          # опционально (X-Chroma-Token)
CHROMA_COLLECTION=concepts             # коллекция по умолчанию
LM_STUDIO_URL=http://localhost:1234
BIBLIARY_GOOGLE_BOOKS_API_KEY=         # опционально, обогащение метаданных
```

---

## Использование

### 1. Импорт книг

**Библиотека → Импорт** → укажите папку или перетащите файлы.

- **Поиск дубликатов** — предварительно сканирует папку, показывает отчёт об изданиях до импорта
- Папка, разложенная по поддоменам (`/Mathematics/`, `/Physics/`), автоматически определяет `sphere`
- Включите **Recursive** для обхода вложенных папок
- Логи импорта и книги-в-процессе — в двух вкладках консоли

После импорта книги переходят в `imported`. Оценщик запускается автоматически в фоне.

### 2. Настройка моделей

**Модели → Роли** — назначьте модели:
- `evaluator` — оценщик качества книги
- `crystallizer` — извлекает знания для датасета
- `judge` — финальная оценка концептов
- `translator` — перевод (для uk/be/kk текстов)
- `vision` — обложки, OCR изображений, иллюстрации

### 3. Кристаллизация

В каталоге выберите `evaluated` книги → **Кристаллизовать**:
- Каждая глава разбивается на смысловые чанки
- Чанки векторизуются и уходят в Chroma
- Статус → `indexed`

### 4. Генерация датасета

Раздел **Датасеты** → выберите коллекцию → **Создать датасет**:
- T1/T2/T3 уровни сложности
- Reasoning traces (R1-style) — опционально
- Экспорт в ChatML JSONL

### 5. Семантический поиск (опционально)

Раздел **Поиск** → выберите коллекцию → введите смысловой запрос.
Не требует точных слов — работает через векторное сходство.

---

## Разработка

```bash
npm run typecheck               # TypeScript проверка
npm run lint                    # ESLint
npm test                        # unit + integration тесты
npm run electron:dev            # dev-режим с hot reload
npm run verify:deps-for-packaging  # проверки перед сборкой (см. ниже)
npm run electron:build-portable # portable .exe в корень проекта
```

### Сборка и зависимости (важно для portable)

Перед `electron:build` и `electron:build-portable` автоматически выполняется **`npm run verify:deps-for-packaging`** (`scripts/verify-deps-for-packaging.cjs`):

1. **Синхрон корня `package-lock.json` с `package.json`** — совпадение имён пакетов в `dependencies`, `devDependencies` и `optionalDependencies`. Если пакет есть в lock, но забыли добавить в `package.json`, portable-сборка может стартовать без него в `app.asar` и упасть с `Cannot find module` (так было с `jsonrepair`).
2. **`npm ls --depth=0`** — целостность дерева `node_modules` на верхнем уровне.
3. **`knip --production` (только `unlisted` и `unresolved`)** — импорты из production-кода (в т.ч. `electron/`) без записи в `package.json` не пройдут.

Проверку можно запускать отдельно, без полной сборки: `npm run verify:deps-for-packaging`.

### Ключевые модули

| Файл | Назначение |
|------|------------|
| `electron/lib/library/md-converter.ts` | Book → Markdown (YAML frontmatter + главы) |
| `electron/lib/library/import-book.ts` | Импорт одной книги: SHA256 → parse → save |
| `electron/lib/library/import.ts` | Оркестрация: walkFiles → dedup → importBook |
| `electron/lib/library/book-evaluator.ts` | LLM оценка качества/домена/тегов |
| `electron/lib/library/revision-dedup.ts` | HARD+REPLACE: лучшее издание побеждает |
| `electron/lib/scanner/chunker.ts` | Структурные чанки из ParseResult |
| `electron/lib/scanner/ingest.ts` | parse → chunk → embed → Chroma (Browse path) |
| `electron/lib/dataset-v2/` | Кристаллизация + ChatML JSONL export |
| `electron/lib/resilience/` | Circuit breaker, bulkhead, AIMD, watchdog |
| `electron/lib/chroma/` | Chroma HTTP client, collections, points, scroll |

### Тесты

```
tests/
├── smoke/                     # Electron smoke: запуск, IPC, preload
├── chroma-*.test.ts           # Chroma client: collections, upsert, scroll, filters
├── library-*.test.ts          # Импорт, дедупликация, хранилище
├── parsers-*.test.ts          # Форматы: PDF, HTML
├── delta-extractor-*.test.ts  # Извлечение знаний
└── ...                        # 100+ тестов суммарно
```

---

## Resilience: защита от перегрузки

При большом импорте (100+ книг) Bibliary защищает 32 GB RAM через слои:

- **Circuit Breaker** — останавливает вызовы LM Studio при 3 ошибках подряд (30-сек cooldown)
- **Bulkhead** — отдельные очереди для light/heavy/GPU задач
- **AIMD** — адаптивный batch sizing: увеличивает при успехе, режет при давлении памяти
- **Memory Probe** — мониторинг RAM/VRAM (15-30 сек интервал), кэширует ошибки nvidia-smi
- **Watchdog** — убивает зависшие child-процессы (ddjvu/7zip/tesseract) по таймауту
- **Checkpoint** — resume-safe: после краша обрабатываются только пропущенные чанки

---

## Известные ограничения

- **Основная платформа — Windows x64** (portable .exe). Linux x64 — экспериментально.
- **LM Studio обязателен** — нет встроенного инференса.
- **Chroma обязателен** — без него кристаллизация и поиск недоступны.
- **OCR медленный** — сканированные PDF/DJVU с OCR: минуты на книгу.
- **OCR на Linux** — системный OCR только Win/macOS; альтернатива — vision-LLM.

---

## Changelog

Полный список: [CHANGELOG.md](CHANGELOG.md)

**v0.11.2** (2026-05-04) — Preflight scan, CoT lang-detect, evaluator smart-fallback
- **Preflight scan** перед импортом: DjVu IFF probe + PDF text probe, OCR readiness, Evaluator readiness в одном модальном окне
- **CoT-устойчивый lang-detect** (`extractLangCode`): Qwen3/GLM-4 с reasoning теперь правильно засчитываются
- **Evaluator smart-fallback**: `allowAnyLoadedFallback`, честные warnings, убран скрытый `ensurePreferredLoaded`
- **CP1251/UTF-16BE decode** для PDF hex-заголовков (российские OCR-сканы)
- **DjVu вертикальный текст** — починены абзацы из встроенного text layer
- Фиксы: abort reason, CSV separator, skip-image-only UX, `hex.substr`, каталог UI

**v0.11.1** (2026-05-04) — Critical fixes: H11/C3/C4/C5 + vision_ocr + zombie LM Studio
- **H11**: image-refs block signature fix (scene-break `---` не режет книгу)
- **C3/C4**: атомарная запись с `randomBytes` + `fdatasync` перед `rename`
- **C5**: corrupted preferences.json → карантин `.corrupted-<ts>`
- vision_ocr Олимпиада: 100/100 достижим; zombie LM Studio fix; Olympics persist

**v0.11.0** (2026-05-04) — DjVu native, Olympics auto-roles, library UI
- DjVu native parser (`djvu-native.ts`), Олимпиада авто-роли, Library UI улучшения

**v0.10.1** — portable и зависимости
- В `dependencies` добавлен **`jsonrepair`** (раньше модуль мог отсутствовать в `app.asar` при сборке, если пакет не был в `package.json` — падение main process при старте).

**v0.8.0** (2026-05-03) — Reader Purge + Versator Premium Layout
- **Удалено**: тяжёлая нативная читалка foliate-js (~3.7 MB vendor) + custom protocol `bibliary-book://` + DJVU→PDF UI-конвертер. Книги читаются через премиум-рендер `book.md` в существующем reader.
- **Versator pipeline** (build-time): typograf RU/EN, callouts, definitions, drop caps, Tufte sidenotes, KaTeX math — всё pure-JS без LLM
- **KaTeX 100% локально**: 23 KB CSS + 20 woff2 (260 KB) в `renderer/vendor/katex/`. Никаких CDN
- **Bibliary Scientific CSS-тема**: премиум-типографика для ридера
- **Phase A+B (Calibre Purge + Torrent-Dump Hardening)**: encoding-aware импорт, RAR/fb2.zip multi-book, palm-mobi.ts pure-JS parser, filename heuristic для русских коллекций — все Iter 9.1-9.6 в этом релизе
- 50+ новых unit-тестов; 0 регрессий относительно baseline

**v0.7.1** (2026-05-02) — UI fixes, cover generation, log persistence
- Синтетическая SVG обложка в академическом стиле если обложки нет в файле
- Логи импорта восстанавливаются из диска при старте приложения
- `library:get-cover-url` теперь читает хвост book.md (image refs — всегда в конце)
- Ридер показывает статус-специфичный баннер при пустом контенте
- Кнопка "Поиск дубликатов" в Import pane (scanFolderForDuplicates смонтирована в UI)
- Обложка в каталоге кликабельна (открывает книгу)
- i18n fix: `revealInFolder.failed` использует правильный ключ
- Исправления из UI-аудита: dblcopy-feedback, cover-click в каталоге

**v0.7.0** (2026-05-01) — AI Fortress Hardening
- Circuit Breaker для LM Studio HTTP API
- Watchdog для зависших child-процессов (ddjvu/calibre/tesseract)
- AIMD adaptive batch sizing с memory probe
- Hybrid response format для схем LLM
- DJVU: все стратегии таймаутов + per-stage watchdog
- Magic-byte + sharp image pre-flight validation
- Умный роутинг: partial-sibling detection, EPUB/PDF/DJVU structural validation
- HARD+REPLACE: при импорте сохраняется только лучшее издание книги
- Import logs UI: полная ширина, вкладки Logs/Books, status bar

**v0.6.0** (2026-04-30) — Smart Import Pipeline Foundation
- Централизованный ModelPool с OOM recovery
- Universal Light-First Cascade (text-layer → OS OCR → vision-LLM)
- Двухступенчатый DjVu конвертер
- Adaptive Pre-flight Evaluator

---

## Лицензия

MIT — используйте, форкайте, встраивайте.

---

Сделано с упрямством исследователя. Если у вас большая книжная коллекция и вы хотите сделать из неё датасет для дообучения LLM — это инструмент для вас.

[GitHub](https://github.com/antsincgame/bibliary) · Issues приветствуются

