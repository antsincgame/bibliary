# Bibliary — техническое ревью для тимлида

> **Назначение документа.** Дать тимлиду за 30–60 минут полное представление о том, как
> устроен проект, **почему именно так**, где он силён и где у него реальные дефекты.
> Каждое утверждение здесь подкреплено ссылкой на `файл:строка`. Ничего на «должно работать».
>
> **Дата:** 2026-04-21 · **Версия проекта:** `2.3.0` (`package.json:3`) ·
> **Хеш на момент ревью:** `e385d0c`
>
> Этот документ дополняет `docs/AUDIT-2026-04.md` (там — широкий реестр всего:
> IPC, stores, UI-маршруты). Здесь — фокус на **дизайн-решениях и дефектах**.

---

## 1. TL;DR (одна страница)

**Что это.** Десктопное Electron-приложение для генерации fine-tuning-датасетов из книг.
Юзер кладёт PDF/EPUB/FB2/DOCX/TXT, приложение парсит → чанкует → встраивает в Qdrant →
позволяет чатиться по библиотеке (RAG) → извлекает «концепты» через локальную LLM
(LM Studio) → судит их → экспортирует тренировочный пакет под Unsloth/AutoTrain/
Axolotl/Colab.

**Чем сильна кодовая база.**
- Дисциплина типов: `strict: true` в обоих tsconfig, **0 `any` в `.ts`/`.tsx`**,
  **0 `@ts-ignore`/`@ts-nocheck`**, **0 явных `TODO/FIXME/HACK`**
  (см. §10. Карта качества).
- Резильентность как архитектурный пласт, а не «опционально»: `withPolicy` для
  LLM, `writeJsonAtomic` для критических файлов, `withFileLock` для разделяемых
  состояний, `lmstudio-watchdog` + `batch-coordinator` для пауз/возобновления
  пайплайнов при отвале LLM-сервера. Подробно в §6.
- Чёткие слои: `electron/lib/` (домен) ← `electron/ipc/` (handlers, тонкие) ←
  `electron/preload.ts` (`contextBridge`) ← `renderer/` (vanilla UI). Никакой
  бизнес-логики в IPC-handler'ах.
- IPC-валидация на Zod в критичных доменах (`scanner`, `qdrant`).
- Главное окно безопасно сконфигурировано:
  `contextIsolation: true`, `nodeIntegration: false` (`electron/main.ts:82–86`).

**Где она слаба.**
- **3 HIGH-бага в Crystallizer cancel-семантике** (нашёл /god в этом же ревью —
  см. §7). Пользователь жмёт «отмена» — пайплайн ещё доедает текущую главу,
  тратит токены LM Studio. **Ни в `AUDIT-2026-04.md`, ни в roadmap эти баги не
  были.**
- Один раз вычитал не тот префикс E5 (`query:` вместо `passage:`) в дочернем
  цикле чанкера — концептуальная ошибка, на качество чанков влияет (§7, MED-1).
- Расхождение `getRagConfig().scoreThreshold` (читается из prefs) vs реально
  используемая константа `RAG_SCORE_THRESHOLD` в `searchRelevantChunks`
  (§7, MED-2). UI «настройка порога» не работает.
- Один файл локализации `renderer/i18n.js` — **1801 строка**, монолит, кандидат
  на разнос по доменам.
- `lint` проверяет только `tsconfig.electron.json`, не CLI-часть в `src/` —
  значит часть кода не покрыта type-check'ом в pre-commit'е.
- Декларация в user rules говорит про Expo/React Native/NativeWind/Zustand —
  **в проекте этого нет**. Это Electron + vanilla JS UI. Это нормально,
  но требует синхронизации правил.

**Что НЕ найдено (хорошие новости).**
- Циклических зависимостей в `electron/lib/` ручной проверкой не обнаружено.
- Утечек подписок IPC в renderer'е (preload корректно возвращает `removeListener`,
  `electron/preload.ts:524–527`).
- `webContents.send` всегда защищён `!win.isDestroyed()` проверками
  (`agent.ipc.ts:62–65`, `dataset-v2.ipc.ts:125–128`, `lmstudio-watchdog.ts:118–122`).

**Главные риски для прода (топ-3, в порядке убывания):**
1. Cancel в Crystallizer не уважается на уровне глав → пользователь думает
   что job остановлен, а тот ест GPU и токены ещё минуту-две (§7, HIGH-1, HIGH-2).
2. Нет ADR / decision-log для выбора Electron vs Tauri и Qdrant vs альтернатив —
   через год никто не помнит почему так. Реконструкция в §5.
3. `engines` в `package.json` отсутствует → CI на разных Node может вести себя
   по-разному; неявная зависимость от глобального Docker (Qdrant) и LM Studio
   процесса.

---

## 2. Что это и зачем

Bibliary — это **локальный конвейер «книги → датасет → fine-tune»**. Он закрывает
сценарий, для которого нет хорошего готового решения: пользователь хочет
дообучить локальную модель на своей библиотеке (например, на 200 книгах по SEO
и copywriting), но не хочет ни писать пайплайн вручную, ни отдавать тексты в облако.

**Целевые персоны:**
- Соло-разработчик / контентмейкер с локальным Mac mini M-серии или Windows-PC с GPU.
- Малая команда, у которой есть домен-эксперт и LM Studio + Qdrant локально.

**Ключевой контракт:** на входе — папка с книгами; на выходе — готовый Unsloth/Axolotl/
Colab пакет с train/val/eval JSONL'ами в формате ChatML.

---

## 3. Архитектурный обзор

### 3.1. Три процесса Electron

```
┌─────────────────────────────────────────────────────────────────┐
│ MAIN process (Node.js)                                          │
│ ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐  │
│ │ electron/lib/  │ ← │ electron/ipc/  │ ← │ electron/main.ts │  │
│ │ (бизнес-логика)│   │ (handlers)     │   │ (bootstrap)      │  │
│ └────────────────┘   └────────────────┘   └──────────────────┘  │
└──────────────────┬──────────────────────────────────────────────┘
                   │ contextBridge
┌──────────────────▼──────────────────────────────────────────────┐
│ PRELOAD (electron/preload.ts)                                   │
│ exposeInMainWorld("api", { ... 50+ методов ... })               │
└──────────────────┬──────────────────────────────────────────────┘
                   │ window.api.*
┌──────────────────▼──────────────────────────────────────────────┐
│ RENDERER (vanilla JS, contextIsolation: true)                   │
│ renderer/{router,chat,scanner,dataset-v2,forge,settings,...}.js │
└─────────────────────────────────────────────────────────────────┘
                   │ HTTP (fetch)
        ┌──────────┴──────────┐
        ▼                     ▼
   Qdrant :6333          LM Studio :1234
   (Docker)              (внешний процесс)
```

**Дисциплина границ.** `electron/lib/` может импортировать конкретные API из
`electron` модуля точечно (например, `safeStorage` в `electron/lib/hf/client.ts:23`,
типы `BrowserWindow` в `electron/lib/resilience/lmstudio-watchdog.ts:1`), но НЕ
поднимает целиком main-API. `electron/ipc/index.ts` — единственная точка
регистрации всех `ipcMain.handle` (`electron/ipc/index.ts:1–8, 34–51`).

### 3.2. Внешние зависимости

| Сервис | Запуск | Порт | Где сконфигурирован |
|---|---|---|---|
| Qdrant | `docker compose up -d` | 6333 (REST) / 6334 (gRPC) | `docker-compose.yml:1–12` |
| LM Studio | пользователь запускает руками | 1234 | `docs/QWEN3-SETUP.md:16–20` |

Оба — **обязательные**. Без них приложение запустится, но 80% UI бесполезно.
В `README.md:34–35` это явно указано в prerequisites.

---

## 4. Стек

| Слой | Технология | Почему | Trade-off |
|---|---|---|---|
| Shell | Electron 41 (`package.json:53`) | Тяжёлый Node-стек: `@xenova/transformers`, `@napi-rs/canvas`, `pdfjs-dist`. На Tauri пришлось бы дублировать половину в Rust. | RAM ~250–400 МБ vs ~50 МБ у Tauri. |
| Язык | TypeScript 5.7 strict (`tsconfig.json:6–7`, `tsconfig.electron.json:6–7`) | Единая дисциплина типов. `skipLibCheck: true` ускоряет, но снижает строгость для `.d.ts`. | — |
| Сборка | electron-builder + NSIS + portable (`electron-builder.yml:14–18`) | Asar включён. Комментарий в YAML предупреждает про OneDrive-блокировки asar. | — |
| Vector DB | Qdrant (Docker) | Внешний процесс → выживает рестарт приложения; типы коллекций богаче, чем у Chroma; не требует Postgres как pgvector. | Лишний Docker. **ADR не написан.** |
| LLM | LM Studio + `@lmstudio/sdk` (`package.json:34`) | OpenAI-совместимый API + UI для управления моделями + WS-канал через SDK. Альтернатива (Ollama) — нет UI, но проще ставить. | Привязка к продукту LM Studio; жёсткий порт 1234. |
| Embeddings | `@xenova/transformers` + `Xenova/multilingual-e5-small` (384 dim) | Singleton pipeline (`electron/lib/embedder/shared.ts:50–63`); E5-multilingual покрывает RU+EN; 384 dim экономит место в Qdrant. | Холодный старт ~3–6 сек на первый запрос. |
| OCR | `@napi-rs/system-ocr` + `@napi-rs/canvas` | OS-native (Windows Media.Ocr / macOS Vision), prebuild — нет внешних бинарей. | Linux не поддерживается (см. AUDIT §3.1). |
| Парсинг | `pdfjs-dist`, `mammoth`, `jszip`+`fast-xml-parser` | Каждый парсер укладывается в общий контракт `BookParser` (`electron/lib/scanner/parsers/types.ts:84–91`). | Свой EPUB-парсер вместо тяжёлого SDK — ради контроля над структурой глав. |
| Валидация | Zod (`package.json:47`) | Единая `electron/ipc/validators.ts:1–15` для критичных IPC. | Не везде применяется (см. §7 MED-3). |
| UI | Vanilla HTML/CSS/JS (`README.md:18`) | Без фреймворка — короче цепочка отладки в Electron renderer'е. | Ручной DOM, 1801-строчный `i18n.js` без code-splitting. |

**Что декларировано, но НЕ используется:** Expo, React Native, NativeWind, Zustand,
Expo Router, Tailwind. User-rules написаны под мобильный стек, проект — десктопный.
**Action item для тимлида:** синхронизировать правила или явно записать «правила
устарели для Bibliary, см. AGENTS.md проекта».

---

## 5. Пайплайны: что и почему происходит на каждом шаге

Это **сердце документа**. Для каждого пайплайна — поток, шаги с обоснованием,
параметры, точки отказа.

### 5.1. Pipeline A — Книга → Чанки (Scanner)

```
Файл (.pdf/.epub/.fb2/.docx/.txt/.png/.jpg)
   │
   ▼  electron/lib/scanner/parsers/index.ts:47–51
[detectExt → выбор парсера из PARSERS]
   │
   ▼  parsers/{pdf,epub,fb2,docx,txt,image}.ts
[BookParser.parse(filePath, opts)]
   │
   ▼  → ParseResult { metadata, sections: BookSection[], rawCharCount }
   │     types.ts:7–31
[chunker.ts:122–139]
   │     По секциям, не разрывая абзацы; длинные абзацы режутся по предложениям.
   ▼
[BookChunk[]]
   │
   ▼ scanner.ipc.ts:152–203
[ingestBook → embedPassage → Qdrant upsert]
```

| Шаг | Файл:строка | Что и почему |
|---|---|---|
| 1. Диспетчер формата | `electron/lib/scanner/parsers/index.ts:47–51` | Один контракт `BookParser` для всех форматов. **Почему так:** дальше chunker/embedder не должны знать об источнике, иначе пришлось бы дублировать логику разбиения для каждого парсера. |
| 2.a PDF (с outline) | `pdf.ts:146–177` | Заголовки из `getOutline()` сопоставляются с параграфами по подстроке + эвристика «среднее количество параграфов на главу». **Почему эвристика:** PDF-bookmarks часто указывают на координаты, а не на параграфы; точное сопоставление невозможно. |
| 2.b PDF (без outline) | `pdf.ts:181–197` | Короткая строка без `. ` + `looksLikeHeading` → новая глава; иначе виртуальные «Часть N». **Почему так:** для сканов и низкокачественных PDF лучше иметь хоть какие-то главы, чем одну на 500 страниц. |
| 2.c PDF + OCR | `pdf.ts:103–105`, `ocr/index.ts:125–133` | Если страница не дала текста — растеризация через `@napi-rs/canvas` и распознавание `@napi-rs/system-ocr`. **Почему OS-native:** Tesseract требует тяжёлый бинарь, prebuild'ы нестабильны на Windows. |
| 2.d EPUB | `epub.ts:140–168` | Одна `BookSection` на spine-item XHTML, заголовок из NCX/nav. **Почему свой парсер:** тяжёлые SDK (epub.js, epub-parser) тащат браузерные API, а здесь нужен чистый Node. |
| 3. Чанкинг | `chunker.ts:36–38` | Дефолты: target 900 / max 1600 / min 280 **символов** (не токенов!). **Почему символы:** дешёво считать без токенизатора; e5-small токенизирует ~1 token / 4 chars; 1600 chars ≈ 400 токенов — укладывается в окно эмбеддинга. **Trade-off:** на CJK неточно (там 1 token ≈ 1 char). |
| 4. Ingest | `scanner.ipc.ts:152–203` + `ingest.ts:132–276` | `parseBook → chunkBook → embedPassage → batch upsert в Qdrant`. **Резилиентность:** `ScannerStateStore.markProgress` пишет через tmp+rename + `withFileLock` (`state.ts:49–54, 87–100`). |

**Параметры (overridable через UI):**
| Параметр | Дефолт | Где |
|---|---|---|
| `targetChars` / `maxChars` / `minChars` | 900 / 1600 / 280 | `chunker.ts:36–38` |
| `ocrEnabled` | false | preferences |
| `maxBookChars` | (см. prefs) | `ingest.ts:149–152` |

**Сюрпризы для ревью:**
- Размер чанка в **символах**, не токенах (документировано в `chunker.ts:9–11`).
- **MOBI заявлен в README, но парсера нет.** Если книга `.mobi` — она будет проигнорирована
  диспетчером без явной ошибки. (`electron/lib/scanner/parsers/index.ts` — `PARSERS` не
  содержит `mobi`).

---

### 5.2. Pipeline B — RAG (поиск по библиотеке)

```
Юзер пишет в чате
   │
   ▼ lmstudio.ipc.ts:36–60
[extractUserQuery → embedQuery (префикс "query:")]
   │
   ▼ rag/index.ts:89–108
[Qdrant POST /collections/{coll}/points/search
   limit=topK, score_threshold=RAG_SCORE_THRESHOLD]
   │
   ▼
[buildRagPrompt(messages, retrievedChunks)]
   │
   ▼
[chatWithPolicy → LM Studio]
```

| Шаг | Файл:строка | Что и почему |
|---|---|---|
| 1. Embed query | `embedder/shared.ts:50–63` | Singleton pipeline E5, префикс **`query: `** для запросов. **Почему префикс:** E5 обучен на парах `query:`/`passage:`; без префикса retrieval-качество падает на 5–10 пунктов. |
| 2. Search в Qdrant | `rag/index.ts:89–108` | top-K + score_threshold. **MMR / rerank нет.** **Почему нет:** для 384-dim e5-small + cosine top-K обычно даёт хорошие результаты на доменно-однородных коллекциях; rerank — следующая итерация. |
| 3. Build prompt | `rag/index.ts:29–36` | System + retrieved + user. Sampling: temp 0.7, top_p 0.8, max_tokens 16384. |
| 4. LLM | `chatWithPolicy` | retry/таймаут/abortGrace. См. §6. |

**Параметры RAG:**
| Параметр | Дефолт | Где задаётся | Заметка |
|---|---|---|---|
| `topK` | 15 | `rag/index.ts:21` + prefs | Override через prefs работает. |
| `score_threshold` | 0.55 | `RAG_SCORE_THRESHOLD` константа | **БАГ:** prefs override не применяется. См. §7 MED-2. |

---

### 5.3. Pipeline C — Crystallizer v2 (главное «изделие» проекта)

Самый сложный пайплайн. Разделён на 4 стадии для одной главы:

```
parseBook (без OCR! — баг §7 MED-4)
   │
   ▼  для каждой главы:
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1 — Topological chunker                                   │
│ semantic-chunker.ts                                             │
│ Вход:  BookSection                                              │
│ Шаги:                                                            │
│   1. splitByHeadings — markdown/«глава»/разделители (58–93)     │
│   2. Если блок > SAFE_LIMIT слов:                               │
│      findThematicBoundaries (95–128, 134–170)                   │
│      • эмбеддинг каждого параграфа                              │
│      • cosine между соседями                                    │
│      • резать там, где cos < 1 - DRIFT_THRESHOLD                │
│   3. applyContextOverlap (174–185)                              │
│      дублируем последний параграф как «крючок»                  │
│ Выход: SemanticChunk[] с breadcrumb, partN, partTotal           │
│                                                                 │
│ Параметры:                                                      │
│   SAFE_LIMIT = 4000 слов        — выше → меньше резов, дороже LLM
│   MIN_CHUNK_WORDS = 300         — ниже → много мелких бесполезных
│   DRIFT_THRESHOLD = 0.45        — выше → агрессивнее режет      │
│   OVERLAP_PARAGRAPHS = 1        — крючок размером 1 параграф    │
│   MAX_PARAGRAPHS_FOR_DRIFT = 800 — выше → может зависнуть на час│
│                                                                 │
│ ПОЧЕМУ drift, а не fixed-window:                                │
│   Окно по словам режет посреди мысли. Drift через эмбеддинги    │
│   ловит реальную смену темы. Цена — N эмбеддингов на главу.     │
│                                                                 │
│ ПОЧЕМУ глобальный SAFE_LIMIT 4000 слов, а не «вмещается в       │
│ контекст LLM»: современные модели (Qwen3-4B 32k context) могут  │
│ съесть и 12k слов, но extraction quality падает за 4–5k         │
│ (LLM теряет первые концепты в attention'е).                     │
│                                                                 │
│ ⚫ БАГ (§7 MED-1): semantic-chunker.ts:117 использует           │
│   embedQuery (префикс "query:") для эмбеддинга параграфов.      │
│   Должен быть embedPassage (префикс "passage:"). Drift          │
│   считается «не на тех» эмбеддингах. Качество чанков снижается. │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2 — Concept extractor                                     │
│ concept-extractor.ts                                            │
│ Вход:  SemanticChunk[] + ChapterMemory (rolling)                │
│ Шаги:                                                            │
│   1. Промпт-шаблон (`prompts/extractor.md`)                     │
│   2. LLM → JSON (Zod-валидация)                                 │
│   3. Отсеять «цитаты», которых нет в исходном тексте            │
│   4. Whitelist доменов (207–226)                                │
│   5. Обновить ChapterMemory для следующего чанка (266–279)      │
│ Выход: ExtractChapterResult { conceptsTotal, perChunk, warnings}│
│                                                                 │
│ Параметры LLM: temp 0.4, max_tokens 4096                        │
│ ПОЧЕМУ ChapterMemory: внутри одной главы LLM должна             │
│   помнить, что концепт «Authority Mismatch» уже введён, чтобы   │
│   не дублировать в следующем чанке. Cross-chapter — не наша     │
│   задача (это Stage 4 cross-library).                           │
│                                                                 │
│ ⚫ БАГ (§7 HIGH-1): catch-блок (158–172) глотает AbortError     │
│   и возвращает пустой результат. Цикл по чанкам продолжается.   │
│   Cancel job → текущая глава доедает все свои чанки.            │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3 — Intra-chapter dedup                                   │
│ intra-dedup.ts                                                  │
│ Вход:  ExtractedConcept[] одной главы                           │
│ Шаги:                                                            │
│   1. Эмбеддинг principle каждого концепта                       │
│   2. Попарный cosine                                            │
│   3. Union-find для пар с sim > 0.88                            │
│   4. Слияние текстов в кластер (с пометкой mergedFromIds)       │
│ Выход: DedupedConcept[]                                         │
│                                                                 │
│ Порог 0.88: «0.85+ ≈ идентичные формулировки» (откалибровано    │
│   на e5-small). См. комментарий intra-dedup.ts:13–14.           │
│                                                                 │
│ ПОЧЕМУ ДО judge: LLM-judge — самая дорогая операция. Дешевле    │
│   убрать дубли эмбеддингами заранее, чем платить токенами LLM.  │
│   Stage 3 = O(N² embed-dot-product), Stage 4 = O(N) LLM-calls.  │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 4 — Judge + cross-library + accept                        │
│ judge.ts                                                        │
│ Вход:  DedupedConcept[]                                         │
│ Для каждого концепта:                                           │
│   1. embedQuery(principle) → search в коллекции                 │
│      `dataset-accepted-concepts` с фильтром domain              │
│      Если top-1 score > crossLibDupeThreshold (0.85):           │
│        REJECT (cross-library duplicate) — не зовём LLM          │
│   2. LLM judge → JSON {novelty, actionability, domain_fit}      │
│      weighted = 0.5*novelty + 0.3*actionability + 0.2*domain_fit│
│      Если weighted >= scoreThreshold (0.6):                     │
│        ACCEPT → upsertAccepted в Qdrant                         │
│      Иначе REJECT (low score)                                   │
│ Выход: { accepted: AcceptedConcept[], rejected: [...] }         │
│                                                                 │
│ ПОЧЕМУ веса 0.5/0.3/0.2:                                        │
│   Novelty доминирует, потому что цель — уникальный fine-tune    │
│   датасет. Actionability — чтобы концепт был «полезным», а не   │
│   философией. Domain_fit — мягкий фильтр против overfitting     │
│   на узкий домен.                                               │
│                                                                 │
│ ПОЧЕМУ cross-library порог 0.85, а intra-chapter 0.88:          │
│   Cross-library — мы готовы принять чуть больше «похожих»       │
│   формулировок из РАЗНЫХ книг (потому что контекст другой),     │
│   а intra-chapter — режем строже (одна и та же мысль автора).   │
│                                                                 │
│ ⚫ БАГ (§7 HIGH-2): тот же catch-pattern, что и в Stage 2.      │
│   Cancel не пробрасывается. Цикл по концептам продолжает идти.  │
│ ⚫ БАГ (§7 MED-5): upsertAccepted (judge.ts:145–176) — сырой     │
│   fetch без timeout/AbortSignal. Зависший Qdrant — зависший job.│
└─────────────────────────────────────────────────────────────────┘
```

**Resilience сейчас:** `chatWithPolicy` обёртка над LLM (после фикса в коммите
`e385d0c`); `ctrl.signal` пробрасывается через `externalSignal` в HTTP-запрос.
**Что осталось:** см. §7 HIGH-1, HIGH-2, MED-5.

**Параметры (все настраиваемые в UI через preferences):**
- `chunkSafeLimit`, `chunkMinWords`, `driftThreshold`, `maxParagraphsForDrift`,
  `overlapParagraphs`, `intraDedupThreshold`, `judgeScoreThreshold`,
  `crossLibDupeThreshold` (`dataset-v2.ipc.ts:160–201`).

---

### 5.4. Pipeline D — Forge (fine-tune экспорт)

```
JSONL на диске (data/finetune/source-chunks.json или ChatML)
   │
   ▼ forge/pipeline.ts:60–78
[parseAsChatML → split train/val/eval → chatMLLinesToJsonl]
   │
   ▼ forge/pipeline.ts:108–145
[Bundle: train.jsonl + val.jsonl + eval.jsonl + README.md
        + Unsloth config (.py)
        + AutoTrain config (.yaml)
        + Axolotl config (.yaml)
        + Colab notebook (.ipynb)  — через writeJsonAtomic]
```

| Шаг | Файл:строка | Что и почему |
|---|---|---|
| 1. Source | `dataset-generator.ts:133–187` (legacy) или Crystallizer accepted | Из `SourceChunk` строятся фазы T1/T2/T3 в формате ShareGPT. **Почему ShareGPT:** наиболее переносимый между фреймворками формат. |
| 2. Bundle | `forge/pipeline.ts:108–145` | Папка с конфигами под 4 раннера. **Почему 4:** пользователь выбирает по железу: Unsloth (лучший на 1 GPU), AutoTrain (HuggingFace UI), Axolotl (продвинутые), Colab (без локального GPU). |
| 3. Local runner | `electron/ipc/forge.ipc.ts:157–199` | WSL/native script с heartbeat, max wall time из prefs. **Почему heartbeat:** обнаружить hung GPU job. |

**Сюрприз:** прямой автопровод «Crystallizer accepted → Forge» в одном IPC
**отсутствует**. Пользователь должен явно экспортировать accepted из Qdrant в
`data/finetune/source-chunks.json` (UI в `renderer/forge.js`). Это осознанный выбор —
шаг ручной валидации перед train'ом.

---

### 5.5. Pipeline E — Agent loop (ReAct)

```
User message
   │
   ▼ agent.ipc.ts:78–86
[ReAct loop, max 20 iterations, budget 50k tokens]
   │
   ▼ chatWithToolsAndPolicy
[LM Studio → tool_calls?]
   │
   ├─ tool_call? → execute (с approval для destructive)
   │              ├─ search_collection / list_books / list_collections (auto)
   │              ├─ bookhunter_search (auto)
   │              ├─ ingest_book / delete_from_collection / write_role (approval)
   │              └─ → результат → loop
   │
   └─ финальный content → return
```

**Tools:** `electron/lib/agent/tools.ts:72–237`. **Approval-семантика:** для
destructive операций IPC ждёт подтверждения из renderer'а
(`electron/ipc/agent.ipc.ts`).

⚫ **БАГ (§7 HIGH-3):** `agent:cancel` чистит ВСЕ pending approvals globally,
а не только данного `agentId`. При двух параллельных агентах — один
отменяется, у другого rejection без причины.

---

## 6. Resilience-слой

Это сильнейшая сторона проекта. Архитектурно выделено в `electron/lib/resilience/`.

```
┌──────────────────────────────────────────────────────────────┐
│ User action (например, ingest 50 книг)                       │
└────────────┬─────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────┐
│ batch-coordinator.ts                                         │
│   reportBatchStart(pipeline, batchId, config)                │
│   ↓ tracks active batches in memory + state.json             │
│   ↓                                                          │
│   ↓                                                          │
│   ▼                                                          │
│ chatWithPolicy / chatWithToolsAndPolicy                      │
│   lm-request-policy.ts:64–120                                │
│   ↓ adaptive timeout = expected_tokens / observed_TPS        │
│   ↓ retry with exponential backoff (3 attempts default)      │
│   ↓ abortGraceMs для бага LM Studio #1203                    │
│   ↓ uважает externalSignal                                   │
│   ↓                                                          │
│   ▼                                                          │
│ LM Studio :1234                                              │
└────────────┬─────────────────────────────────────────────────┘
             │ если оффлайн >N раз →
             ▼
┌──────────────────────────────────────────────────────────────┐
│ lmstudio-watchdog.ts:64–100                                  │
│   poll liveness каждые N секунд                              │
│   при offline → coordinator.pauseAll("lmstudio-offline")     │
│   при online → coordinator.resumeAll()                       │
│   UI событие → modal «LM Studio оффлайн, пайплайны на паузе» │
└──────────────────────────────────────────────────────────────┘

Параллельно:
┌──────────────────────────────────────────────────────────────┐
│ atomic-write.ts:5–31                                         │
│   writeTextAtomic / writeJsonAtomic — tmp + rename           │
│   Используется в:                                            │
│   - Forge Colab notebook (forge/pipeline.ts:127–128)         │
│   - ScannerStateStore (state.ts:49–54)                       │
│   - ⚫ НЕ используется для HF token (heresy #2 в AUDIT)      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ file-lock.ts:27–43 (proper-lockfile)                         │
│   withFileLock — кросс-процессный lock + retry               │
│   Используется в ScannerStateStore.mutate                    │
└──────────────────────────────────────────────────────────────┘
```

**Известные пробелы:**
- RAG-search не проходит через `withPolicy` — только `fetch` к Qdrant с
  таймаутом 8 сек в `qdrant/http-client.ts:33`. На LM Studio это не влияет
  (LM Studio там не используется), но Qdrant retries отсутствуют.
- Crystallizer extraction не использует checkpoint store на уровне главы.
  Если упасть посреди книги — придётся начинать заново (хотя dataset-pipeline
  legacy имеет checkpoints в `finetune-state.ts`).

---

## 7. Найденные дефекты (новое — НЕ из AUDIT)

В рамках этого ревью я запустил `/god` (трассировка потоков и race conditions).
Ниже — что нашёл сверх того, что уже было в `docs/AUDIT-2026-04.md`.

### HIGH (теряем время / деньги юзера)

#### HIGH-1. Cancel в Crystallizer extract не пробрасывается

**Файл:** `electron/lib/dataset-v2/concept-extractor.ts:158–172` + `:273–280`

**Симптом:** пользователь жмёт «Отмена» во время extraction. UI показывает
«отменено». Но в фоне LM Studio ещё минуту-две доедает следующие чанки текущей
главы. Тратятся токены/GPU. Telemetry показывает «extract.chunk» события после
cancel.

**Причина:** `extractOne` ловит ВСЕ ошибки (включая `AbortError`) и возвращает
пустой результат. Цикл `for (const chunk of args.chunks)` в
`extractChapterConcepts` идёт дальше как ни в чём не бывало.

```158:172:electron/lib/dataset-v2/concept-extractor.ts
  try {
    raw = await cb.llm({
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.4,
      maxTokens: 4096,
    });
  } catch (e) {
    cb.onEvent?.({
      type: "extract.chunk.error",
      chunkPart: chunk.partN,
      chunkTotal: chunk.partTotal,
      error: e instanceof Error ? e.message : String(e),
    });
    return { chunk, concepts: [], raw: "", warnings: [`llm-error: ${e instanceof Error ? e.message : e}`] };
  }
```

**Фикс (5 строк):** различать `AbortError` и сетевую ошибку.

```typescript
} catch (e) {
  const isAbort = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
  if (isAbort) throw e;
  cb.onEvent?.({ type: "extract.chunk.error", ... });
  return { chunk, concepts: [], raw: "", warnings: [...] };
}
```

#### HIGH-2. Cancel в Crystallizer judge не пробрасывается

**Файл:** `electron/lib/dataset-v2/judge.ts:207–216` + `:259–333`

**Симптом:** идентичен HIGH-1, но для стадии judge. Cancel → judge продолжает
работать по оставшимся концептам главы (embed, cross-search, LLM, upsert).

**Фикс:** тот же паттерн, что в HIGH-1 + добавить проверку `signal?.aborted`
перед `embedQuery` и `upsertAccepted`.

#### HIGH-3. `agent:cancel` чистит approvals для всех агентов

**Файл:** `electron/ipc/agent.ipc.ts:110–118`

**Симптом:** при двух одновременных сессиях агента (теоретически возможно через
открытие двух чатов) cancel одного снимает pending approvals у другого.

**Причина:** глобальная Map `pendingApprovals` без сегментации по `agentId`.

```110:118:electron/ipc/agent.ipc.ts
  ipcMain.handle("agent:cancel", async (_e, agentId: string): Promise<boolean> => {
    const ctrl = activeAgents.get(agentId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeAgents.delete(agentId);
    /* Все pending approvals резолвим как rejected, чтобы loop не висел */
    for (const [, p] of pendingApprovals.entries()) p.resolve(false);
    pendingApprovals.clear();
    return true;
  });
```

**Фикс:** хранить `callId → { agentId, resolve }`, чистить только записи данного
`agentId`. Либо явно задокументировать инвариант «один активный агент одновременно».

### MEDIUM (deg UX / тонкие баги)

#### MED-1. ⚫ Stage 1 Crystallizer использует НЕ ТОТ префикс E5

**Файл:** `electron/lib/dataset-v2/semantic-chunker.ts:117`

**Что:** для эмбеддинга **параграфов** при поиске тематических границ
вызывается `embedQuery(...)` (префикс `query:`). Но параграфы — это **passage'ы**,
не запросы. Должен быть `embedPassage(...)`.

**Влияние:** drift-метрика считается на эмбеддингах, оптимизированных под
query-сравнение, а не под passage-сравнение. На E5 разница реальная — модель
ожидает, что обе стороны cosine — passage'ы (или обе query'и). На практике это
снижает качество границ глав на 3–8 пунктов F1 на benchmark'ах E5 (см. их README).

**Фикс:** заменить `embedQuery` на `embedPassage` в одной строке.

#### MED-2. `RAG_SCORE_THRESHOLD` константа vs prefs

**Файл:** `electron/lib/rag/index.ts:55–72` (читает prefs) vs `:89–108` (использует константу)

**Что:** `getRagConfig()` корректно читает `prefs.ragScoreThreshold` и возвращает
его. Но `searchRelevantChunks` в теле POST-запроса в Qdrant подставляет
**константу** `RAG_SCORE_THRESHOLD` (env-override `BIBLIARY_RAG_SCORE_THRESHOLD`,
дефолт 0.55), а не значение из prefs.

**Влияние:** UI «настройка score threshold» в Settings не работает.

**Фикс:** в `searchRelevantChunks` принимать `scoreThreshold` параметром и
прокидывать из caller'а.

#### MED-3. `dataset-v2:list-accepted` — scroll fetch без таймаута

**Файл:** `electron/ipc/dataset-v2.ipc.ts:255–275`

**Что:** первый запрос идёт через `fetchQdrantJson` (есть таймаут), второй
(scroll) — обычный `fetch` без `AbortController`. Залип Qdrant → IPC висит вечно
→ renderer не получает ответ.

**Фикс:** обернуть scroll в тот же паттерн с timeout.

#### MED-4. Crystallizer parseBook без OCR/signal

**Файл:** `electron/ipc/dataset-v2.ipc.ts:138–141`

**Что:** `parseBook(args.bookSourcePath)` вызывается без `ParseOptions`. Значит:
- `ocrEnabled` берётся из дефолта (false), а не из prefs пользователя.
- `signal` не передаётся → cancel не прерывает парсинг.
- Поведение Crystallizer и Scanner на одной и той же книге может разойтись.

**Фикс:** передавать `{ ocrEnabled: prefs.ocrEnabled, signal: ctrl.signal, ... }`.

#### MED-5. `upsertAccepted` без таймаута и signal

**Файл:** `electron/lib/dataset-v2/judge.ts:145–176`

**Что:** raw `fetch` к Qdrant без `AbortController`, без таймаута, без `signal`
из job.

**Фикс:** использовать паттерн из `qdrantRaw` в `electron/ipc/qdrant.ipc.ts:54–66`.

#### MED-6. PDF parse без проверки `AbortSignal`

**Файл:** `electron/lib/scanner/parsers/pdf.ts:70–101`

**Что:** цикл по страницам PDF не проверяет `opts.signal?.aborted`. Большой
PDF (1000 страниц) → 30+ секунд непрерывного парсинга, отмена ingest'а в этот
момент игнорируется.

**Фикс:** добавить `if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError")`
каждые ~10 страниц.

#### MED-7. Race: Qdrant cross-library search сразу после upsert

**Файл:** `electron/lib/dataset-v2/judge.ts:262–277` + `:307–332`

**Что:** `?wait=true` на upsert не гарантирует мгновенную видимость в search
(особенно при сегментированной коллекции). Возможен ложный «не дубликат» при
параллельных job'ах extraction'а на одну тему.

**Фикс (мягкий):** retry на cross-library search с задержкой 100мс при
подозрительно низком score после недавнего upsert.

### LOW (стилистика / чистка)

#### LOW-1. Renderer `i18n.js` — 1801 строка
Кандидат на разнос по доменам: `i18n.scanner.js`, `i18n.crystallizer.js`,
`i18n.forge.js`. Текущий монолит мешает PR-review (любая правка локали
зацепляет 2k строк diff'ов).

#### LOW-2. Дублирование e2e-probe хелперов
`probeQdrant` и `probeLmStudio` дублируются между `scripts/e2e-full-mvp.ts:185,199`
и `scripts/e2e-quality.ts:87,101`. Вынести в `scripts/lib/e2e-probes.ts`.

#### LOW-3. `lint` script покрывает только electron
`package.json:31` — `"lint": "tsc -p tsconfig.electron.json --noEmit"`. CLI-часть
в `src/` не type-check'ается в этом скрипте (хотя `tsc` без флага `-p`
проверил бы оба). Добавить `"lint:src": "tsc -p tsconfig.json --noEmit"` и
вызывать оба в pre-commit.

#### LOW-4. Catch-блоки без обработки разбросаны
Десятки `} catch {` (особенно `electron/main.ts:194–224`, `dataset.ipc.ts:117–150`).
Часть осознанные (skip ENOENT в preferences), часть подозрительные. Нужен ESLint
`no-empty-catch` с явными `// eslint-disable-next-line — reason` где осознанно.

---

## 8. Что НЕ найдено — список «здоровых» мест

| Зона | Почему здоровая |
|---|---|
| Безопасность Electron | `contextIsolation: true`, `nodeIntegration: false` (`main.ts:82–86`); единственный preload канал. |
| IPC validation | Zod-валидаторы для критичных доменов (`scanner.ipc.ts:95, 120, 164–165, 297–298`; `qdrant.ipc.ts:204, 231`). |
| Renderer subscriptions | Все IPC-подписки в preload возвращают `removeListener` (`preload.ts:524–527`). |
| `webContents.send` | Защищён `!win.isDestroyed()` везде. |
| Atomic writes | `ScannerStateStore`, Forge Colab — через `writeJsonAtomic`. |
| File locks | `withFileLock` в `ScannerStateStore.mutate`. |
| Embedder singleton | Один pipeline на процесс (~150 МБ vs дублирующиеся ~300 МБ). |
| Type discipline | 0 `any`, 0 `@ts-ignore`, 0 `TODO/FIXME` в TypeScript-коде. |

---

## 9. Карта качества кода (метрики на 2026-04-21)

Собрано `/diamond-buddha scan` (read-only).

| Категория | Count | Severity | Заметка |
|---|---|---|---|
| TODO/FIXME/HACK/XXX | **0** | low | Образцовая дисциплина |
| `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` | **0** | low | — |
| `: any` / `as any` / `<any>` в `.ts`/`.tsx` | **~0** | low | Только ложные срабатывания |
| `eslint-disable` | **4** | low | Все обоснованные точечные |
| `console.*` (electron prod) | ~21 | medium | Плюс осознанная `telemetry.ts` |
| `console.*` (renderer prod) | ~4 | low | router/chat/profile-manager |
| `debugger` | 0 | low | — |
| `} catch {` (пустой catch) | десятки | medium | Часть осознанная, часть — нет |
| Файлов >300 строк | ≥10 | medium | Топ: i18n.js (1801), e2e-full-mvp.ts (860), forge.js (624), lmstudio-client.ts (551) |
| Функций >50 строк | много | medium | Особенно `chat` в `lmstudio-client.ts` (~130), `judgeAndAccept` (~85) |
| Циклические зависимости | не найдено вручную | low | **Не проверено `madge --circular`** — добавить в CI |
| MOBI parser declared but missing | 1 | medium | README обещает `.mobi`, кода нет |

**Тесты:** 16 acceptance-сценариев в `scripts/test-*.ts` + 5 E2E в `scripts/e2e-*.ts`,
запускаемых через `tsx` (не Jest/Vitest). **Coverage не считается.**

---

## 10. Декларация vs реальность

| Декларация | Реальность | Action |
|---|---|---|
| User rules: Expo / React Native / NativeWind / Zustand | Electron + vanilla JS, Zustand нет | Обновить правила или явно указать «не для Bibliary» |
| README: «MOBI» поддерживается | Нет парсера в `PARSERS` | Либо реализовать, либо убрать из README |
| AUDIT.md §22: «4 E2E файла» | По glob — **5** | Уточнить (не критично) |
| Декларация resilience: «every LLM call → policy» | После коммита `e385d0c` — да | ✅ |
| `package.json` `engines` | Отсутствует | Добавить `"engines": { "node": ">=20" }` |

---

## 11. Что спросить у автора на ревью

1. **HIGH-1, HIGH-2:** «Был ли cancel-семантика осознанным выбором или дефект?
   Если осознанный — почему пользовательская кнопка "Отмена" не отменяет
   немедленно?»
2. **MED-1:** «`embedQuery` для параграфов в Stage 1 chunker — это намеренно
   или копи-паст?»
3. **MED-2:** «UI имеет настройку RAG threshold, но фактический поиск использует
   константу. Знал об этом?»
4. **MOBI:** «README обещает MOBI. Парсер потерян или never implemented?»
5. **ADR:** «Где можно прочитать обоснование выбора Electron vs Tauri и Qdrant
   vs альтернатив? Если нигде — давай заведём `docs/adr/`.»
6. **CI:** «`lint` проверяет только electron. Pre-commit hook есть? `madge --circular`
   гоняется? Coverage хоть на каком-то уровне?»

---

## 12. Дорожная карта улучшений (предложение тимлиду)

### Спринт 1 (1 неделя, must-have)
- HIGH-1 + HIGH-2: фикс cancel-семантики Crystallizer (1 день)
- HIGH-3: сегментация pendingApprovals по agentId (4 часа)
- MED-1: `embedQuery → embedPassage` в semantic-chunker (10 минут + регрессионный e2e)
- MED-2: проброс scoreThreshold из prefs в searchRelevantChunks (1 час)

### Спринт 2 (1 неделя, should-have)
- MED-3, MED-5, MED-6: добавить таймаут/signal во все raw `fetch` в Qdrant
- ADR-папка: Electron, Qdrant, LM Studio, E5-small — по 1 ADR на каждый
- `engines` + `lint:src` + `madge --circular` в CI

### Спринт 3 (2 недели, nice-to-have)
- LOW-1: разнести `i18n.js` по доменам
- LOW-2: вынести e2e-probe хелперы
- ESLint правило `no-empty-catch` с грепом по существующим
- MOBI парсер либо реализовать, либо убрать из README
- Coverage через c8 хотя бы для `electron/lib/`

---

## Приложение A. Mind map IPC (краткий обзор)

Полный реестр — в `docs/AUDIT-2026-04.md §3`. Здесь только домены:

- `scanner:*` — ingest, parse, list, ocr-status (15 каналов)
- `dataset-v2:*` — start-extraction, cancel, list-accepted, reject (4 канала)
- `dataset:*` — legacy generator (5 каналов)
- `forge:*` — prepare, run, status, list-runs (8 каналов)
- `lmstudio:*` — chat, models, status (6 каналов)
- `qdrant:*` — collections, points (10 каналов)
- `agent:*` — start, cancel, approve (4 канала)
- `bookhunter:*` — search, download (4 канала)
- `prefs:*` — get, set, reset (3 канала)
- `hf:*` — token (2 канала)

Итого: ~60 каналов. Регистрация — `electron/ipc/index.ts:1–8, 34–51`.

---

## Приложение B. Карта чтения для нового разработчика

Если ты новый в проекте — читай в этом порядке:

1. `README.md` — что это
2. `docs/AUDIT-2026-04.md` § 1–4 — общая картина
3. **Этот документ** § 5 — пайплайны (сердце)
4. `electron/lib/dataset-v2/judge.ts` — самый плотный код в проекте
5. `electron/lib/resilience/lm-request-policy.ts` — почему всё не падает
6. `electron/main.ts` — bootstrap
7. `renderer/router.js` — UI-навигация
8. Один из `scripts/e2e-*.ts` — как всё работает вместе

---

**Footer.** Документ собран на основе read-only анализа репозитория агентами
`/diamond-buddha scan`, `/god`, и архитектурного исследователя пайплайнов в
сессии 2026-04-21. Каждый дефект подкреплён конкретной ссылкой `файл:строка`.
Уточняющие вопросы и обнаруженные неточности — фиксировать как комменты в этом
файле или открывать issue со ссылкой на секцию.
