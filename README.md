# Bibliary

> Персональная база знаний из книг. Загрузи тысячи PDF и DJVU — приложение само извлечёт из них принципы, идеи и факты, векторизует их и позволит искать по смыслу.

**Версия:** 0.6.0 · **Платформа:** Windows (portable .exe), Linux x64 (AppImage/.deb) · **Модели:** LM Studio (локально)

> **v0.6.0 — Smart Import Pipeline Foundation готов**: централизованный
> ModelPool с OOM recovery, Universal Light-First Cascade (text-layer → OS OCR
> → vision-LLM), двухступенчатый DjVu конвертер, защита heavy-очереди от DDoS.
> Снижение нагрузки vision-LLM ~50x при импорте больших DjVu библиотек.
> Подробнее: [`docs/smart-import-pipeline.md`](docs/smart-import-pipeline.md).

---

## Что это такое

Bibliary — десктопное Electron-приложение, которое превращает коллекцию книг в живую базу знаний. Вместо того чтобы читать книги вручную, вы указываете папку с файлами — программа парсит их, оценивает качество, извлекает структурированные знания с помощью локальных LLM и кладёт всё в векторную базу Qdrant. Потом по этой базе можно искать.

**Для кого:** исследователи, аналитики, люди с большими книжными коллекциями, разработчики датасетов для дообучения LLM.

---

## Ключевые возможности

### 📚 Библиотека
- Импорт **PDF, DJVU, EPUB, DOCX, HTML, ZIP/RAR/7z** архивов с книгами
- Автоматическое определение языка и дедупликация
- OCR для сканированных PDF и DJVU (через системный OCR)
- Трёхуровневый каскад парсинга: `pdf-inspector` → `edgeparse` → `pdfjs-dist`
- Предварительная оценка книги (10–30 сек) перед тяжёлой обработкой — выбраковывает воду и беллетристику

### 🧠 Извлечение знаний
- **Кристаллизация** — LLM извлекает принципы, факты и связи из каждой главы
- Топологическое извлечение: не просто факты, а граф событий → причин → следствий
- Поддержка reasoning-моделей (Qwen3, GLM-4, DeepSeek-R1): автоматически убирает `<think>` блоки перед оценкой

### 🔍 Поиск
- **Встроенный UI семантического поиска** (раздел «Поиск» в боковом меню):
  поиск по векторам в Qdrant через `multilingual-e5-small` (384-мерный
  cross-lingual эмбеддер). Не требует точных слов — ищет смысл.
- Picker коллекций (показывает только непустые), регулировка порога сходства
  (scoreThreshold), сниппеты результатов с метаданными (книга/глава/тэги).
- Под капотом всё то же — `qdrant:search` IPC. Если предпочитаете внешний
  клиент, Qdrant Web UI по-прежнему доступен на
  `http://localhost:6333/dashboard`.

### 🏆 Олимпиада моделей
- Автоматический турнир: каждая загруженная в LM Studio модель проходит 14 испытаний по ролям пайплайна
- Роли: кристаллизатор, оценщик, судья, переводчик, детектор языка, украинский специалист, vision-роли (meta / OCR / illustration)
- По итогам автоматически назначает лучшую модель на каждую роль
- Поддержка LM Studio SDK: полный контроль GPU offload, контекст, flash attention для каждой роли

### 📊 Датасеты
- Генерация ChatML JSONL датасетов для дообучения LLM из накопленных знаний
- T1/T2/T3 уровни сложности на каждый чанк
- Поддержка reasoning-трейсов (R1-style)

### 🔭 Поиск книг
- BookHunter: автоматический поиск книг по названию и автору через открытые источники

---

## Архитектура

```
bibliary/
├── electron/              # Main process (Node.js + Electron)
│   ├── main.ts            # Точка входа, регистрация IPC
│   ├── preload.ts         # Безопасный мост renderer ↔ main
│   ├── ipc/               # IPC-обработчики (library, arena, dataset, qdrant...)
│   └── lib/
│       ├── library/       # Импорт, парсинг, хранилище книг
│       ├── llm/           # LM Studio клиент, роли, Олимпиада
│       │   └── arena/     # olympics.ts, disciplines.ts, scoring.ts, lms-client.ts
│       ├── scanner/       # Парсеры форматов (PDF, DJVU, EPUB, HTML...)
│       ├── embedder/      # Векторизация текста и изображений
│       ├── qdrant/        # Клиент Qdrant, коллекции
│       ├── dataset-v2/    # Пайплайн генерации датасетов
│       ├── preferences/   # Настройки (Zod-схема, SQLite)
│       └── resilience/    # Atomic-write, file-lock, watchdog, checkpoint
├── renderer/              # Frontend (Vanilla JS, без фреймворков)
│   ├── library/           # UI библиотеки и каталога
│   ├── models/            # UI выбора моделей и Олимпиады
│   ├── locales/           # Локализация (ru, en)
│   └── styles.css
├── tests/                 # 60+ unit и integration тестов
│   └── smoke/             # Electron smoke-тесты через Playwright
├── scripts/               # CLI утилиты и E2E тесты
└── data/                  # Данные (библиотека, кэш, чекпоинты)
    └── library/{id}/      # original.{ext} + book.md + metadata
```

### Поток данных

```
Папка с файлами
      │
      ▼
  Импорт + парсинг (3-уровневый каскад)
      │
      ▼
  Предоценка книги (LLM, ~30 сек) ─── плохое качество/вода → пропуск
      │
      ▼
  Кристаллизация (LLM извлекает принципы по главам)
      │
      ▼
  Векторизация (multilingual-e5-small, 384-dims)
      │
      ▼
  Qdrant (коллекции по тематикам)
      │
      ▼
  Семантический поиск (через Qdrant API)
```

---

## Требования

| Компонент | Версия | Назначение |
|-----------|--------|------------|
| [LM Studio](https://lmstudio.ai/) | 0.3+ | Локальный инференс LLM |
| [Qdrant](https://qdrant.tech/) | 1.7+ | Векторная база данных |
| [Docker](https://www.docker.com/) | любая | Для запуска Qdrant |
| Node.js | 18+ | Для сборки из исходников |
| Windows | 10/11 x64 | Портабельная версия |

**Минимальное железо:** 8 GB RAM, GPU не обязателен (но сильно ускоряет).  
**Рекомендуемое:** 16 GB RAM, GPU с 6+ GB VRAM (для S/M-class моделей).

---

## Быстрый старт

### Вариант 1: Портативный артефакт по платформе

**Windows x64:**
1. Скачайте `Bibliary 0.4.4.exe` (portable) из [Releases](https://github.com/antsincgame/bibliary/releases)
2. Запустите LM Studio, загрузите любую модель
3. Запустите Qdrant: `docker run -p 6333:6333 qdrant/qdrant`
4. Запустите `Bibliary 0.4.4.exe` — всё готово (без установки)

**Linux x64 (экспериментально):**
1. Скачайте `Bibliary-0.4.4.AppImage` из [Releases](https://github.com/antsincgame/bibliary/releases) или `.deb` для apt-based дистро
2. Установите Qdrant + LM Studio (можно в Docker)
3. AppImage: `chmod +x Bibliary-0.4.4.AppImage && ./Bibliary-0.4.4.AppImage`
   - Если AppImage требует FUSE: `./Bibliary-0.4.4.AppImage --appimage-extract-and-run`
4. .deb: `sudo apt install ./bibliary_0.4.4_amd64.deb`

> Note: Linux-сборка собрана как побочный артефакт от cross-platform-фундамента. Активно тестируется только Windows-портабл; macOS-релизы не планируются на 0.4.x.

### Вариант 2: Из исходников

```bash
# Клонируем репозиторий
git clone https://github.com/antsincgame/bibliary.git
cd bibliary

# Устанавливаем зависимости
npm install

# Копируем конфиг
cp .env.example .env
# Отредактируйте .env если Qdrant или LM Studio запущены не на стандартных портах

# Запускаем в режиме разработки
npm run electron:dev
```

### Конфигурация (.env)

```env
QDRANT_URL=http://localhost:6333      # URL Qdrant
QDRANT_API_KEY=                       # API ключ (опционально)
QDRANT_COLLECTION=concepts            # Имя коллекции по умолчанию
LM_STUDIO_URL=http://localhost:1234   # URL LM Studio
BIBLIARY_GOOGLE_BOOKS_API_KEY=        # Google Books API (опционально)
```

---

## Использование

### 1. Импорт книг

Откройте раздел **Библиотека → Импорт**, укажите папку с книгами. Поддерживаются:
- `PDF` — полнотекстовый и сканированный (OCR)
- `DJVU` — только с OCR
- `EPUB`, `DOCX`, `HTML`
- `ZIP`, `RAR`, `7z` — архивы с книгами внутри

Индикатор показывает текущий файл в процессе. Тяжёлые файлы (сканы) занимают дольше.

### 2. Выбор моделей

Откройте раздел **Модели**. Здесь два блока:

**Роли пайплайна** — вручную назначьте модель на каждую роль:
- `Кристаллизатор` — извлекает знания
- `Оценщик` — оценивает качество книги
- `Судья` — финальная оценка концептов
- `Переводчик` — переводит концепты
- `Детектор языка` — определяет язык текста
- `Украинский специалист` — работа с украинскими текстами
- `Vision (обложка/OCR/иллюстрации)` — анализ изображений

**Олимпиада** — автоматический подбор лучшей модели на каждую роль:
1. Загрузите в LM Studio несколько моделей
2. Нажмите **Запустить Олимпиаду**
3. Через 1–10 минут лучшие модели автоматически назначатся на роли

Настройки Олимпиады сохраняются между сессиями.

### 3. Кристаллизация

После импорта выберите книги в каталоге и запустите **Кристаллизовать**. LLM прочитает каждую главу и извлечёт структурированные принципы, которые уйдут в Qdrant.

### 4. Поиск

Откройте раздел **Поиск** в боковом меню (иконка лупы). Выберите Qdrant-коллекцию,
введите фразу или вопрос, нажмите **Найти**. Поиск семантический — не нужны точные слова,
работает на смысле.

- **Порог сходства** (slider) — отсекает слабые совпадения. По умолчанию 0.45;
  поднимайте если результаты «размыты», опускайте если ничего не находится.
- **Первый запрос дольше** (3–5 сек) — прогрев multilingual-e5-small эмбеддера.
  Последующие — мгновенные (~100 мс на сервере + RTT до Qdrant).
- **Кнопка «Открыть в библиотеке»** — найдёт книгу в каталоге по пути и откроет
  Reader. Если книга была вне Qdrant-импорта — кнопка скопирует путь в буфер.

---

## Разработка

```bash
# Запуск тестов
npm test                    # все unit-тесты
npm run test:smoke          # Electron smoke-тесты через Playwright
npm run typecheck           # TypeScript проверка без компиляции
npm run lint                # ESLint

# Сборка
npm run electron:build              # production build (installer)
npm run electron:build-portable     # portable .exe
```

### Структура тестов

```
tests/
├── smoke/                  # Electron smoke (запуск, IPC, preload)
├── olympics-*.test.ts      # Олимпиада (scoring, lifecycle, SDK, thinking)
├── library-*.test.ts       # Импорт, дедупликация, хранилище
├── parsers-*.test.ts       # Форматы (PDF, HTML)
├── delta-extractor-*.test.ts  # Извлечение знаний
└── ...                     # 60+ тестов суммарно
```

### Ключевые модули

| Файл | Назначение |
|------|------------|
| `electron/lib/llm/arena/olympics.ts` | Оркестрация Олимпиады |
| `electron/lib/llm/arena/lms-client.ts` | LM Studio клиент (REST + SDK) |
| `electron/lib/llm/arena/disciplines.ts` | Испытания и скоринг |
| `electron/lib/library/import.ts` | Пайплайн импорта |
| `electron/lib/scanner/parsers/` | Парсеры форматов |
| `electron/lib/preferences/store.ts` | Настройки (Zod-схема) |
| `electron/ipc/index.ts` | Регистрация IPC-обработчиков |
| `renderer/models/models-page.js` | UI Моделей и Олимпиады |
| `renderer/library.js` | UI Библиотеки |

---

## Известные ограничения

- **Основная платформа — Windows x64** (portable .exe). Linux x64 (AppImage/.deb/.tar.gz) собирается из тех же исходников через `release-linux.yml`, но активно не тестируется. macOS не поддерживается в 0.4.x.
- **LM Studio обязателен** — приложение не имеет встроенного инференса, работает только с локальным LM Studio.
- **Qdrant обязателен** — без него кристаллизация и UI-поиск недоступны. Достаточно запустить через Docker.
- **OCR медленный** — сканированные DJVU/PDF с OCR обрабатываются медленно (минуты на книгу). Можно отключить OCR при импорте.
- **OCR недоступен на Linux** — `@napi-rs/system-ocr` использует Windows.Media.Ocr (Win) и Vision Framework (macOS); на Linux нет встроенного OS-OCR. Альтернатива: vision-LLM (Qwen3-VL-8B и др.) для текстовых сканов.

---

## Changelog

Полный список изменений: [CHANGELOG.md](CHANGELOG.md)

**v0.4.1** (2026-04-30) — UI семантического поиска + DX foundation
- Новый раздел «Поиск» в боковом меню: выбор коллекции, ввод запроса, регулировка
  порога сходства, сниппеты результатов с метаданными книги/главы/тэгов
- Кнопка «Открыть в библиотеке» (находит книгу по пути) и «Скопировать путь»
- ABI dual-stash для better-sqlite3 (`scripts/ensure-sqlite-abi.cjs`):
  переключение Node ABI ↔ Electron ABI без `npm rebuild` (~50 мс copy вместо
  десятков секунд)
- Linux CI baseline: smoke.yml расширен полным test suite на ubuntu-latest
- [docs/cross-platform.md](docs/cross-platform.md): инвентарь нативных
  зависимостей и план Phase 4–5 (Linux x64 + macOS arm64/x64 builds)

**v0.3.1** (2026-04-30)
- Code review: удалены 3 dead test-helper экспорта (`tokenizeForBM25`, `_resetPdfInspectorCacheForTests`, `parseFrontmatter` re-export из `evaluator-queue`)
- Подчищены устаревшие комментарии после обрезки RAG/help-kb стека (`tokenize.ts`, `model-profile.ts`)

**v0.3.0** (2026-04-30)
- Удалён весь RAG/hybrid/BGE-rerank/BM25-sparse стек — поиск теперь dense-only через Qdrant
- Удалён Help KB и связанная UI-панель Hybrid Search
- Удалены отдельные индексы иллюстраций (`bibliary_illustrations`, image-embedder) и CLIP-векторизация
- Унифицированы три vision-prefs (`visionMetaModel`/`visionOcrModel`/`visionIllustrationModel`) в один `visionModelKey` + миграция
- Олимпиада обрезана с 29 до 14 дисциплин (убраны дубликаты по ролям)
- Удалены legacy-поля префов (`ragTopK`, `imageVectorIndexEnabled`)
- Удалены 4 неиспользуемых CLI-скрипта (`dry-run-walker`, `load-librarian`, `load-bundle-classifier`, `run-olympics`) и vendor-дубликаты (`marked.umd.js`, `purify.min.js`)
- 3 vitest-теста мигрированы на `node:test` — единый раннер без отдельной зависимости
- В каталоге добавлена кнопка отмены батч-кристаллизации
- Исправлена утечка IPC-слушателей и зомби-обработчики UI

**v0.2.8** (2026-04-30)
- Восстановлен пайплайн импорта (DJVU OCR не блокирует очередь)
- Исправлен UI-баг: открытая книга больше не "следует" за пользователем при смене раздела
- Добавлена real-time индикация файла в процессе (`file-start` фаза)
- Синхронизированы роли пайплайна в UI Моделей (vision_meta, vision_ocr, vision_illustration)
- Настройки Олимпиады сохраняются между сессиями
- Исправлена утечка IPC-слушателей при переключении языка

**v0.2.7** (2026-04-29)
- LM Studio SDK integration: per-role GPU offload, context, flash attention
- Исправлен баг 0/100 для reasoning-моделей (Qwen3, GLM-4, DeepSeek-R1)
- `stripThinkingBlock` поддерживает `<think>` и `<thinking>` теги
- Масштабирование maxTokens для thinking-моделей (4x overhead)
- Рефакторинг `olympics.ts` → 4 модуля

---

## Лицензия

MIT — используйте, форкайте, встраивайте.

---

## Автор

Сделано с упрямством исследователя. Если у вас большая книжная коллекция и вы хотите из неё сделать что-то полезное — это инструмент для вас.

[GitHub](https://github.com/antsincgame/bibliary) · Issues приветствуются
