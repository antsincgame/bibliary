# Colibri Roadmap — Bibliary как полностью JS-нативный аналог Calibre

> Документ обновлён 2026-05-03 (rev. 3). Релиз 0.8.0 — фаланга закрыта.
> Reader Purge выполнен; Versator pipeline работает; KaTeX полностью
> локально; никаких внешних серверов.

## История изменений документа

- **Rev. 1 (2026-05-02 утро)** — первоначальный план A+B на foliate-js. Calibre
  оставался опциональным fallback для CHM/LIT/LRF/PDB/PRC/SNB/TCR.
- **Rev. 2 (2026-05-02 вечер)** — после code review (Google) выявлены 5 слепых
  зон под старые торренты: DJVU без рендера, кодировки, RAR/fb2.zip, метаданные
  из имён файлов, привязка к Calibre. **Принят имперский приказ: Calibre
  удаляется полностью.** Roadmap переработан.
- **Rev. 3 (2026-05-03)** — после Iter 9.1-9.7 принят новый имперский приказ:
  **«Читалку уничтожить, нам нужна конвертация только»**. foliate-js native
  reader был сочтён избыточной нагрузкой проекта. Поход переключён на
  **Versator** — build-time premium-вёрстка `book.md` под научную литературу
  (typograf, callouts, definitions, drop caps, Tufte sidenotes, KaTeX local).
  Все эти изменения вошли в релиз 0.8.0. См. CHANGELOG для подробностей.

## Текущее состояние (после релиза 0.8.0)

| Подсистема | Статус | Источник |
|---|---|---|
| Calibre cascade | удалён полностью (Iter 9.5-9.6) | rev. 2 |
| Encoding-aware импорт | работает (`encoding-detector.ts`) | rev. 2 |
| RAR / fb2.zip multi-book | работает (`archive-extractor.ts`) | rev. 2 |
| Filename heuristic русский | работает (`filename-parser.ts`) | rev. 2 |
| MOBI/AZW/PDB pure-JS | работает (`palm-mobi.ts`) | rev. 2 |
| CHM через 7zip | работает (`chm.ts`) | rev. 2 |
| DJVU импорт через `djvutxt` | работает (`parsers/djvu.ts`) | rev. 2 |
| **Native reader (foliate-js)** | **удалён** | **rev. 3** |
| **`bibliary-book://` protocol** | **удалён** | **rev. 3** |
| **DJVU UI-рендер (`ddjvu-pdf.ts`)** | **удалён** | **rev. 3** |
| **Versator layout pipeline** | **работает** (8 модулей, 35 тестов) | **rev. 3** |
| **KaTeX local (vendored)** | **работает** (~283 KB) | **rev. 3** |
| **Bibliary Scientific CSS-тема** | **работает** (`renderer/styles.css`) | **rev. 3** |

> **Архивный текст ниже** описывает rev. 2 план (foliate-js + bibliary-book://).
> Сохранён как историческая справка о промежуточных итерациях. Актуальное
> состояние — таблица выше.

---

## Контекст и решение

«Colibri» — Calibre. Цель — полная функциональная парность плюс уникальные
AI-возможности Bibliary, **без зависимости от внешних бинарей** (Calibre,
Python, Pandoc) на критическом пути для **рендеринга и парсинга**. Допускается
использование GPL-CLI как subprocess (DjVuLibre `ddjvu`, 7zip), потому что
лицензионно изолировано и уже вендорится Bibliary.

**Целевая аудитория**: исследователи, имеющие старые торрент-дампы с Либрусека,
Флибусты, IT-архивов 90-х—2000-х. Файлы: DJVU сканы, fb2.zip multi-book
архивы, RAR solid archives, TXT/HTML в windows-1251/KOI8-R/DOS-866, MOBI
без метаданных с именами `[Фамилия И.О.] - [Название] - [Год].mobi`.

## Архитектурные принципы (rev. 2)

| Принцип | Что значит |
|---------|-----------|
| **MIT-clean** | Никакого GPL/AGPL кода в `electron/`, `renderer/` (исключая `vendor/`) |
| **CLI subprocess допустим** | DjVuLibre `ddjvu`, 7zip — вызываются как процессы, не линкуются |
| **vendor/ — изолирован** | foliate-js (MIT), djvulibre (GPL CLI), 7zip (LGPL) — каждый под своей лицензией, копи-лефт не распространяется на наш код |
| **Calibre = афинянин** | Удаляется полностью. Замены в каждой нише |
| **Encoding-aware импорт** | Все текстовые форматы пропускаются через `chardet` + `iconv-lite` перед парсингом |
| **Filename heuristic** | Если внутри файла нет метаданных — парсим имя файла регулярками |

## Поток рендеринга после rev. 2

```
[Пользователь нажал «Читать здесь»]
            │
            ▼
   detectExt(originalPath) ──► .epub / .mobi / .azw3 / .fb2 / .cbz / .pdf
            │                       │
            │                       ▼
            │              foliate-js view.js (iframe)
            │                       │
            │                       ▼
            │              fetch('bibliary-book://<id>') ──► protocol.handle
            │                                                  ──► file://original.{ext}
            │
            └──────► .djvu  ──► protocol.handle расширен:
                                  └─► getDjvuAsPdf(bookId)
                                        └─► cache hit? отдать tmpPdf
                                        └─► cache miss?
                                              └─► ddjvu --format=pdf input.djvu tmp.pdf
                                              └─► pdfjs-dist рендерит
```

## Состояние парсеров (rev. 2)

### ✅ Уже работают (без правок)

| Формат | Парсер | Как |
|--------|--------|-----|
| PDF | `parsers/pdf.ts` | pdfjs-dist + edgeparse (text-layer первым делом) |
| EPUB | `parsers/epub.ts` | jszip + xml-parser |
| FB2 | `parsers/fb2.ts` | xml-parser (нужно добавить chardet перед чтением) |
| DOCX | `parsers/docx.ts` | mammoth |
| DOC | `parsers/doc.ts` | (legacy, требует доработки) |
| RTF | `parsers/rtf.ts` | regex-based (нужно добавить chardet) |
| ODT | `parsers/odt.ts` | jszip |
| HTML/HTM | `parsers/html.ts` | cheerio (нужно добавить chardet) |
| TXT | `parsers/txt.ts` | (нужно добавить chardet) |
| DJVU/DJV | `parsers/djvu.ts` | DjVuLibre djvutxt (text extraction для импорта) |
| CBZ/CBR | `parsers/cbz.ts` | 7zip extract → pdf-lib |
| Images | `parsers/image.ts`, `tiff.ts` | sharp + system-ocr |

### 🟡 Заменяются в этой итерации

| Формат | Было (Calibre) | Стало | Файл |
|--------|----------------|-------|------|
| MOBI | Calibre cascade | foliate-js mobi.js (Node-port) | `parsers/foliate-mobi.ts` |
| AZW | Calibre cascade | foliate-js mobi.js | `parsers/foliate-mobi.ts` |
| AZW3 | Calibre cascade | foliate-js mobi.js | `parsers/foliate-mobi.ts` |
| PRC | Calibre cascade | foliate-js mobi.js | `parsers/foliate-mobi.ts` |
| PDB | Calibre cascade | foliate-js mobi.js (с TEXtREAd magic) | `parsers/foliate-mobi.ts` |
| CHM | Calibre cascade | 7zip extract → composite-html | `parsers/chm.ts` |

### 🔴 Удаляются полностью (мёртвые форматы 90-2010-х)

| Формат | Причина |
|--------|---------|
| LIT | MS Reader, deprecated 2012, < 0.01% коллекций |
| LRF | Sony BBeB, deprecated 2010 |
| SNB | Shanda Bambook, мёртв |
| TCR | Psion 90s, мёртв |

Удаление: `parsers/index.ts`, `import-magic-guard.ts`, локали, тесты.

### 🆕 Новые возможности

| Feature | Файл | Описание |
|---------|------|----------|
| Encoding detection | `scanner/encoding-detector.ts` | chardet + iconv-lite для всех текстовых форматов |
| Filename metadata | `library/filename-metadata-parser.ts` | Регулярки на `[Автор] - [Название] - [Год]` |
| RAR support | `library/archive-extractor.ts` | Расширение списка ARCHIVE_EXTS, 7zip уже умеет |
| fb2.zip multi-book | `library/archive-extractor.ts` | Detect внутри: 1 .fb2 = single book, N .fb2 = multi-archive (рассыпать) |
| DJVU native render | `electron/main.ts:registerBookProtocol` | Расширение: для .djvu вызывает ddjvu→PDF→pdfjs-dist |

## План итераций (rev. 2)

### Iter 9 — Native Reader Foundation

#### ✅ Iter 9.1 — Vendor + Protocol + Skeleton (ЗАВЕРШЕНО 2026-05-02)
- `scripts/download-foliate-js.cjs` (MIT, 23 файла + 2 директории)
- `protocol.handle("bibliary-book", ...)` в main.ts
- `renderer/library/native-reader.js` skeleton
- Кнопка «Читать здесь» + i18n

#### 🟡 Iter 9.2 — Encoding-aware imports (ТЕКУЩИЙ ПОХОД)
**Шаги манифеста** (этой сессии):
1. `npm install chardet iconv-lite` ✅
2. `electron/lib/scanner/encoding-detector.ts` — модуль авто-определения
3. Интеграция в `parsers/txt.ts`, `parsers/html.ts`, `parsers/rtf.ts`, `parsers/fb2.ts`
4. Tests `tests/encoding-detector.test.ts`

**Артефакт**: TXT/HTML/RTF/FB2 в windows-1251/KOI8-R/DOS-866 импортируется
как UTF-8 без кракозябр.

#### 🟡 Iter 9.3 — Filename metadata heuristic (ТЕКУЩИЙ ПОХОД)
1. `electron/lib/library/filename-metadata-parser.ts` — регулярки для русских коллекций
2. Интеграция как fallback в `bookhunter` поиск метаданных
3. Tests `tests/filename-metadata-parser.test.ts`

**Артефакт**: книга `Толстой Л.Н. - Война и мир - 1869.pdf` импортируется
с заполненными author/title/year даже без метаданных внутри файла.

#### 🟡 Iter 9.4 — Archive expansion (ТЕКУЩИЙ ПОХОД)
1. Расширение `archive-extractor.ts`: добавить `.rar` в `ARCHIVE_EXTS`
2. Multi-book detection для `.fb2.zip` / больших `.zip` с N>10 fb2 внутри
3. Tests `tests/archive-extractor-rar.test.ts`, `tests/fb2-zip-multi-book.test.ts`

**Артефакт**: пользователь скармливает `flibusta_2024.fb2.zip` (50000 книг) —
импорт сразу рассыпает на отдельные книги без ручной распаковки.

#### 🟡 Iter 9.5 — Calibre Replacement Foundation (ТЕКУЩИЙ ПОХОД)
1. `parsers/foliate-mobi.ts` — Node.js обёртка над `vendor/foliate-js/mobi.js`
   - Расширить magic = BOOKMOBI ИЛИ TEXtREAd (PalmDoc subtype)
   - Обходим DOM-зависимость (`document.createElement`) — заменяем на `htmlparser2` или текстовый walk
2. `converters/ddjvu-pdf.ts` — обёртка над DjVuLibre `ddjvu --format=pdf`
   - Кэш через существующий `converters/cache.ts`
   - Heavy lane scheduler
3. `parsers/chm.ts` — 7zip extract → composite-html-detector
4. Tests для каждого

**Артефакт**: MOBI/AZW/AZW3/PRC/PDB/CHM/DJVU импортируются и читаются без Calibre.

#### 🟡 Iter 9.6 — Switch parsers/index.ts + Удаление Calibre (ТЕКУЩИЙ ПОХОД)
1. `parsers/index.ts` — заменить calibre-formats imports на foliate-mobi и chm
2. `parsers/index.ts` — удалить LIT/LRF/SNB/TCR из SUPPORTED
3. Удалить файлы: `parsers/calibre-formats.ts`, `converters/calibre.ts`,
   `converters/calibre-cli.ts`
4. Удалить `calibrePathOverride` из `preferences/store.ts`,
   `preferences.ipc.ts`
5. Удалить UI override из `renderer/settings/sections.js`
6. Удалить ссылки на calibre из `import-task-scheduler.ts`,
   `import-magic-guard.ts`, `vision-ocr.ts` (комментарии)
7. Удалить calibre-warning ключи из `renderer/locales/{ru,en}.js`

#### 🟡 Iter 9.7 — DJVU native rendering (ТЕКУЩИЙ ПОХОД)
1. Расширение `bibliary-book://` protocol handler — для .djvu вызывает
   `getDjvuAsPdf(bookId)`
2. `getDjvuAsPdf` использует `ddjvu-pdf.ts` converter (уже создан в 9.5)
3. Добавление `djvu`, `djv` в `FOLIATE_NATIVE_EXTS`
4. Smoke test: открыть DJVU в native reader

#### 🟡 Iter 9.8 — Tests rewrite + final check (ТЕКУЩИЙ ПОХОД)
1. Переписать `tests/converters-calibre.test.ts` → `tests/converters-ddjvu-pdf.test.ts`
2. Переписать `tests/parsers-mobi-azw-chm.test.ts` → `tests/parsers-foliate-mobi.test.ts`
3. Переписать `tests/parsers-cbz-tcr-lit-lrf-rb-snb.test.ts` → `tests/parsers-cbz.test.ts` (drop dead formats)
4. Удалить `tests/regression-rb-not-book.test.ts` (RB удалён ранее)
5. Обновить `tests/regression-ms-pdb-reject.test.ts` (PDB теперь поддерживается через foliate-mobi)
6. Финальная проверка: typecheck + lint + test:fast

#### 🟡 Iter 9.9 — Docs sync (ТЕКУЩИЙ ПОХОД)
1. README — секция «Поддерживаемые форматы», убрать Calibre
2. CHANGELOG — запись 0.8.0
3. `docs/future-formats.md` — обновить статусы
4. `docs/smart-import-pipeline.md` — обновить упоминания

### Iter 10 — Format Converter UI (1–2 недели, отдельный поход)

Цель: пользователь конвертирует книги в любой формат через UI.

**Замечание (rev. 2)**: после удаления Calibre конвертация идёт через
**foliate-js + custom code**. EPUB/MOBI/AZW3/FB2/PDF — через комбинацию
foliate-js парсеров и pdf-lib/jszip. Это сложнее, чем просто звать ebook-convert.
Возможно вернёмся к опциональному Calibre **в этой итерации** только для
конвертации (не для импорта/чтения), но **отдельной фичей с явной
установкой пользователем**, изолированной от main path.

### Iter 11 — Bulk Metadata Editor (1–2 недели)

После 9.3 у нас уже есть filename heuristic. В Iter 11:
- Расширение `display-meta.js`: inline-edit полей
- Auto-fetch panel: OpenLibrary, ISBN-DB, Google Books
- Drag-drop обложки
- Batch operations

### Iter 12 — Расширение форматов (1 неделя)

Без Calibre: добавляем форматы только если есть pure-JS/Apache/MIT парсер.

| Формат | Стратегия |
|--------|-----------|
| AZW4 (Print Replica) | foliate-js mobi.js может справиться |
| HTMLZ, TXTZ | jszip + chardet (тривиально) |
| FBZ | jszip + fb2 parser (тривиально) |
| CBC, CB7 | 7zip + cbz cascade |
| OEB, OPF | xml-parser (тривиально) |
| PML | regex-based (опционально) |
| **iBooks (.ibooks/.iba)** | EPUB с extra metadata — foliate-js epub.js + custom |

### Iter 13 — OPDS Server (опционально)

Не зависит от удаления Calibre.

## Структура vendor/ после rev. 2

```
vendor/                        # верхний уровень репозитория
├── djvulibre/win32-x64/       # GPL CLI: djvutxt, ddjvu, ... (уже есть)
└── 7zip/win32-x64/            # LGPL CLI (уже есть)

renderer/vendor/foliate-js/    # MIT JS, копируется в build (уже есть)
├── LICENSE                    # MIT
├── view.js, paginator.js, ...
├── epub.js, mobi.js, fb2.js, comic-book.js, pdf.js
├── reader.html, reader.js
├── ui/, vendor/ (zip.js, fflate, pdfjs)
└── VERSION.txt
```

## Итоговая поддержка форматов (после Iter 9.9)

### Reading (native viewer foliate-js + ddjvu→PDF→pdfjs)
- ✅ EPUB, MOBI, AZW, AZW3, PRC, PDB, FB2, FBZ, CBZ, CBR, PDF, **DJVU**, **DJV**

### Importing only (no native viewer, но книга парсится в book.md)
- ✅ DOCX, DOC, RTF, ODT, HTML, HTM, TXT, CHM
- ✅ Images: PNG, JPG, JPEG, BMP, TIF, TIFF, WEBP

### Archive containers (распаковка перед импортом)
- ✅ ZIP, RAR, 7Z, **fb2.zip multi-book**, TAR, GZ, BZ2, XZ (через 7zip)

### Удалены
- ❌ LIT, LRF, SNB, TCR (мёртвые форматы)
- ❌ Calibre cascade (полностью)

## Лицензионная карта

| Компонент | Лицензия | Тип использования | Влияние на Bibliary |
|-----------|----------|-------------------|---------------------|
| foliate-js | MIT | Vendoring, прямой code reuse | ✅ совместим |
| pdfjs-dist | Apache-2.0 | npm dependency | ✅ совместим |
| chardet, iconv-lite | MIT | npm dependency | ✅ совместим |
| 7zip CLI | LGPL | CLI subprocess | ✅ изолирован |
| DjVuLibre `ddjvu` | GPL-2 | CLI subprocess | ✅ изолирован (только вызов exe) |
| ~~Calibre `ebook-convert`~~ | ~~GPL-3~~ | **удалено** | ✅ |
| jschardet (отвергнут) | LGPL-2.1 | — | — |
| RussCoder/djvujs (отвергнут) | GPL-2 | — | заразит, не используем |
| djvujs-dist npm (отвергнут) | Proprietary | — | не используем |

## Связанные документы

- `docs/future-formats.md` — список форматов с приоритетами
- `docs/smart-import-pipeline.md` — текущий импорт-пайплайн
- `electron/lib/scanner/parsers/foliate-mobi.ts` — новый MOBI parser (Iter 9.5)
- `electron/lib/scanner/parsers/chm.ts` — новый CHM parser (Iter 9.5)
- `electron/lib/scanner/converters/ddjvu-pdf.ts` — DJVU→PDF (Iter 9.5, 9.7)
- `electron/lib/scanner/encoding-detector.ts` — chardet/iconv (Iter 9.2)
- `electron/lib/library/filename-metadata-parser.ts` — heuristic (Iter 9.3)
