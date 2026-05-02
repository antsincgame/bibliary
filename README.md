# Bibliary

> Превращает коллекцию книг в датасет для дообучения LLM — через структурированный Markdown, смысловые чанки и Qdrant-коллекции.

**Версия:** 0.8.0 · **Платформа:** Windows (portable .exe) · **Модели:** LM Studio (локально)

---

## Что это

### Bibliary — это пайплайн знаний, не RAG-чат

**Что удалено:** в v0.3.0 был вырезан RAG-чат (hybrid-поиск, BM25, BGE-rerank, help-kb). Bibliary больше не отвечает на вопросы о книгах в режиме диалога.

**Что осталось:** две параллельных дороги через одни и те же книги:
- **Путь A — Dataset:** book.md → semantic chunks → LLM-кристаллизатор → концепты в Qdrant → ChatML JSONL
- **Путь B — Search:** book.md → raw chunks → vector embeddings → Qdrant → семантический поиск по смыслу

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
Смысловые чанки → Qdrant-коллекции  ←── векторизованные блоки по тематикам
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
| `crystallizing` | Главы бьются на смысловые чанки, чанки векторизуются и уходят в Qdrant. |
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
- Результат: `layoutVersion: 1` в frontmatter, идемпотентно при повторном импорте

### 🧠 Оценка качества (LLM)
- Оценщик читает первые/последние главы через `multilingual-e5-small`
- Выдаёт `qualityScore`, `domain`, `tags`, `isFictionOrWater`
- Книги с низким баллом автоматически пропускаются при кристаллизации

### 💎 Кристаллизация → Qdrant
- Главы из `book.md` → структурные чанки (~900 символов, не режет абзацы)
- Каждый чанк: детерминированный UUID от содержимого, метаданные (книга, глава, теги)
- Векторизация через `multilingual-e5-small` (384-мерный cross-lingual эмбеддер)
- Batch upsert в Qdrant — идемпотентно, resume-safe после краша

### 📊 Генерация датасета
- Qdrant чанки → ChatML JSONL для fine-tuning LLM
- T1 / T2 / T3 уровни сложности на каждый чанк
- R1-style reasoning трейсы (опционально)
- Экспорт в файл

### 🏆 Олимпиада моделей
- Автоматический турнир по ролям: кристаллизатор, оценщик, судья, переводчик, vision
- Выбирает лучшую модель для каждой роли из загруженных в LM Studio
- Поддержка reasoning-моделей (Qwen3, DeepSeek-R1): убирает `<think>` перед оценкой

### 🔍 Семантический поиск (бонус)
- Поиск по векторам в Qdrant через тот же `multilingual-e5-small`
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
│       │   ├── ingest.ts           # parse → chunk → embed → Qdrant (Browse tab)
│       │   └── embedding.ts        # multilingual-e5-small wrapper
│       ├── dataset-v2/     # Кристаллизация + генерация ChatML JSONL
│       │   ├── extraction-runner.ts   # Qdrant чанки → LLM → Q&A пары
│       │   ├── semantic-chunker.ts    # Семантическое разбиение (dataset путь)
│       │   ├── export.ts              # Сериализация в ChatML JSONL
│       │   └── coordinator-pipeline.ts# Watchdog-aware batch coordinator
│       ├── llm/            # LM Studio клиент, роли, Олимпиада
│       │   └── arena/              # olympics.ts, disciplines.ts, lms-client.ts
│       ├── embedder/       # multilingual-e5-small (ONNX, CPU/GPU)
│       ├── qdrant/         # Qdrant клиент, управление коллекциями
│       ├── resilience/     # Circuit breaker, bulkhead, watchdog, AIMD, checkpoint
│       └── preferences/    # Настройки (Zod-схема, SQLite)
├── renderer/              # Frontend (Vanilla JS, без фреймворков)
│   ├── library/           # UI библиотеки: импорт, каталог, ридер, лог
│   ├── models/            # UI моделей и Олимпиады
│   ├── dataset-v2*.js     # UI генерации датасетов
│   ├── search.js          # UI семантического поиска
│   ├── locales/           # Локализация (ru, en)
│   └── styles.css
├── tests/                 # 60+ unit и integration тестов
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
   chunkChapter() + cosine drift              Float32[384] → Qdrant upsert
   delta-extractor.ts:
     LLM(crystallizer) → концепты            ← Используется в семантическом поиске
   embed(essence) → Qdrant upsert
   upsertBook(status='indexed')
          │
          ▼ [раздел Crystal / Датасеты]
 dataset-v2/concept-loader.ts → Qdrant.scroll(collection) → концепты
 dataset-v2/export.ts → ChatML JSONL (T1/T2/T3) + reasoning traces
```

**Ключевой архитектурный факт:** `book.md` — каноническое хранилище для каталога, ридера и оценщика. Кристаллизация и raw-ingest **повторно парсят** `original.{ext}` — это гарантирует что LLM видит максимально сырой текст, а не переформатированный Markdown.

---

## Требования

| Компонент | Версия | Назначение |
|-----------|--------|------------|
| [LM Studio](https://lmstudio.ai/) | 0.3+ | Локальный инференс LLM |
| [Qdrant](https://qdrant.tech/) | 1.7+ | Векторная база данных |
| [Docker](https://www.docker.com/) | любая | Запуск Qdrant |
| Windows | 10/11 x64 | Основная платформа |
| RAM | 8+ GB | Минимум; 16+ GB рекомендуется |

**Рекомендуемое железо:** 16–32 GB RAM, GPU с 6+ GB VRAM (для S/M-class моделей в LM Studio).

**Без GPU:** всё работает на CPU, просто медленнее (embedding и OCR — CPU-bound).

---

## Быстрый старт

### Вариант 1: Portable .exe (Windows)

1. Скачайте `Bibliary 0.8.0.exe` из [Releases](https://github.com/antsincgame/bibliary/releases)
2. Запустите Qdrant: `docker run -p 6333:6333 qdrant/qdrant`
3. Запустите LM Studio, загрузите модель (рекомендуется 7–14B reasoning)
4. Запустите `Bibliary 0.8.0.exe` — данные хранятся рядом с exe

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
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=                        # опционально
QDRANT_COLLECTION=concepts             # коллекция по умолчанию
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

**Модели → Роли** — вручную назначьте модели:
- `evaluator` — оценщик качества книги
- `crystallizer` — извлекает знания для датасета
- `judge` — финальная оценка концептов
- `translator` — перевод (для uk/be/kk текстов)
- `vision` — обложки, OCR изображений, иллюстрации

**Модели → Олимпиада** — автоматический подбор:
1. Загрузите несколько моделей в LM Studio
2. Нажмите **Запустить Олимпиаду**
3. Лучшие модели автоматически назначатся на роли

### 3. Кристаллизация

В каталоге выберите `evaluated` книги → **Кристаллизовать**:
- Каждая глава разбивается на смысловые чанки
- Чанки векторизуются и уходят в Qdrant
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
npm run electron:build-portable # portable .exe в корень проекта
```

### Ключевые модули

| Файл | Назначение |
|------|------------|
| `electron/lib/library/md-converter.ts` | Book → Markdown (YAML frontmatter + главы) |
| `electron/lib/library/import-book.ts` | Импорт одной книги: SHA256 → parse → save |
| `electron/lib/library/import.ts` | Оркестрация: walkFiles → dedup → importBook |
| `electron/lib/library/book-evaluator.ts` | LLM оценка качества/домена/тегов |
| `electron/lib/library/revision-dedup.ts` | HARD+REPLACE: лучшее издание побеждает |
| `electron/lib/scanner/chunker.ts` | Структурные чанки из ParseResult |
| `electron/lib/scanner/ingest.ts` | parse → chunk → embed → Qdrant (Browse path) |
| `electron/lib/dataset-v2/` | Кристаллизация + ChatML JSONL export |
| `electron/lib/resilience/` | Circuit breaker, bulkhead, AIMD, watchdog |
| `electron/lib/llm/arena/olympics.ts` | Оркестрация Олимпиады |
| `electron/lib/llm/arena/lms-client.ts` | LM Studio REST + SDK клиент |

### Тесты

```
tests/
├── smoke/                     # Electron smoke: запуск, IPC, preload
├── olympics-*.test.ts         # Олимпиада: scoring, lifecycle, SDK
├── library-*.test.ts          # Импорт, дедупликация, хранилище
├── parsers-*.test.ts          # Форматы: PDF, HTML
├── delta-extractor-*.test.ts  # Извлечение знаний
└── ...                        # 60+ тестов суммарно
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
- **Qdrant обязателен** — без него кристаллизация и поиск недоступны.
- **OCR медленный** — сканированные PDF/DJVU с OCR: минуты на книгу.
- **OCR на Linux** — системный OCR только Win/macOS; альтернатива — vision-LLM.

---

## Changelog

Полный список: [CHANGELOG.md](CHANGELOG.md)

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
