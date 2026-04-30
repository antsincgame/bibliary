# Форматы для расширения поддержки Bibliary

> Документ составлен 2026-05-01 по результатам исследования форматов
> электронных книг и архивов. Текущая поддержка: PDF, EPUB, FB2, DOCX,
> DOC, RTF, ODT, HTML, TXT, DJVU + архивы ZIP, RAR, 7Z, CBZ, CBR.

---

## 1. E-book форматы (приоритет по распространённости)

| Формат | Расширение | Magic bytes | Распространённость | Сложность | Приоритет |
|--------|-----------|-------------|--------------------|-----------|-----------| 
| **MOBI** | `.mobi`, `.prc` | `BOOKMOBI` (offset 0x3C–0x43) | Высокая (Kindle legacy) | Средняя (Calibre/KindleUnpack) | P1 |
| **AZW3 (KF8)** | `.azw3`, `.azw` | PDB header + `EXTH` | Высокая (Amazon) | Средняя-Высокая (DRM) | P1 |
| **CHM** | `.chm` | `ITSF` (49 54 53 46) | Средняя (MSDN/WinHelp) | Средняя (7z или libchm) | P2 |
| **LIT** | `.lit` | `ITOLITLS` | Низкая (MS Reader, мёртв) | Высокая (convertlit) | P3 |
| **LRF** | `.lrf` | `LRF\x00` (4C 52 46 00) | Низкая (Sony BBeB, мёртв) | Средняя (Calibre) | P3 |
| **FBZ** | `.fbz` | ZIP + fb2 внутри | Низкая | Низкая (= распаковать ZIP) | P1 |
| **DJVU (`.djv`)** | `.djv` | `AT&T` | Средняя (альтернативное расш.) | Нулевая (уже парсим DJVU) | P0 |
| **TCR** | `.tcr` | `!!8-Bit!!` | Очень низкая (PocketPC) | Низкая | P4 |
| **PDB/PalmDoc** | `.pdb` | PDB header (Palm) | Низкая (Palm OS) | Средняя | P3 |
| **iSilo** | `.pdb` (iSilo subtype) | Специфичный PDB | Очень низкая | Высокая | P4 |
| **SNB** | `.snb` | Специфичный | Очень низкая (Shanda Bambook) | Высокая | P5 |
| **WOLF** | `.wolf` | N/A | Очень низкая (OpenReader) | Высокая | P5 |
| **OEB/OEBPS** | `.opf` | XML | Низкая (предшественник EPUB) | Средняя | P3 |

## 2. Архивные контейнеры

| Формат | Расширение | Magic | 7z CLI поддержка | Приоритет |
|--------|-----------|-------|------------------|-----------|
| **TAR** | `.tar` | `ustar` at offset 257 | Да (`7z x`) | P1 |
| **GZ / GZIP** | `.gz`, `.tgz` | `1F 8B` | Да | P1 |
| **BZ2** | `.bz2`, `.tbz2` | `BZ` (42 5A) | Да | P2 |
| **XZ** | `.xz`, `.txz` | `FD 37 7A 58 5A 00` | Да | P2 |
| **LZMA** | `.lzma` | Нет стандартного magic | Да | P3 |
| **ISO** | `.iso` | `CD001` at offset 32769 | Да | P3 |
| **CAB** | `.cab` | `MSCF` | Да | P3 |
| **ARJ** | `.arj` | `60 EA` | Частично | P4 |
| **LHA/LZH** | `.lha`, `.lzh` | `-lh` at offset 2 | Да | P3 |
| **CPIO** | `.cpio` | `070707` / `070701` | Да | P4 |
| **WIM** | `.wim` | `MSWIM` | Да | P4 |
| **DMG** | `.dmg` | Различный | Нет (macOS only) | P5 |

## 3. Документные форматы (потенциально полезные)

| Формат | Расширение | Что это | Приоритет |
|--------|-----------|---------|-----------|
| **Markdown** | `.md` | Уже текст, просто завернуть в book.md | P0 |
| **AsciiDoc** | `.adoc`, `.asciidoc` | Текст с разметкой | P2 |
| **reStructuredText** | `.rst` | Python-документация | P2 |
| **LaTeX** | `.tex` | Академические книги | P2 |
| **Man pages** | `.1`-`.9` | Unix документация | P4 |
| **Info** | `.info` | GNU info format | P4 |
| **PostScript** | `.ps` | Предшественник PDF | P3 |
| **XPS** | `.xps`, `.oxps` | Microsoft XML Paper | P3 |
| **DVI** | `.dvi` | TeX Device Independent | P3 |

## 4. Мультимедийные / education форматы

| Формат | Расширение | Что это | Приоритет |
|--------|-----------|---------|-----------|
| **SCORM** | `.zip` (manifest) | E-learning пакеты | P4 |
| **IMS Content** | `.zip` | Учебные модули | P4 |

---

## 5. Рекомендуемый порядок расширения

### Итерация 1 (P0 — нулевые усилия)
- `.djv` → добавить в `SUPPORTED_BOOK_EXTS` и `import-magic-guard.ts` (magic уже есть)
- `.md` → добавить в `SUPPORTED_BOOK_EXTS`, парсер = identity (файл = markdown)
- `.fbz` → добавить в `ARCHIVE_EXTS` как alias `.zip` (содержит `.fb2`)

### Итерация 2 (P1 — средние усилия)
- `.mobi` / `.azw3` → npm-пакет `mobi-parser` или `kindleunpack` binary + конвертация в EPUB/HTML, затем стандартный парсинг
- `.tar` / `.gz` / `.tgz` → добавить в `ARCHIVE_EXTS`, 7z CLI уже поддерживает; обновить `extractWith7z`

### Итерация 3 (P2 — заметные усилия)
- `.chm` → 7z умеет распаковывать CHM в HTML; обработать как composite-html
- `.bz2` / `.xz` → аналогично TAR через 7z
- `.tex` / `.adoc` / `.rst` → текстовые форматы, конвертация через pandoc (binary vendor) или regex-парсинг

### Итерация 4+ (P3–P5 — исследовательские)
- LIT, LRF, PDB, PostScript, XPS, DVI → нужны специализированные конверторы
- ISO, CAB, ARJ, LHA → 7z уже умеет; нужна только интеграция в `ARCHIVE_EXTS`

---

## 6. Технические заметки

- **DRM-защита** (AZW, некоторые EPUB): Bibliary НЕ может и НЕ должен обходить DRM.
  Поддерживаем только DRM-free файлы.
- **Calibre как зависимость**: вместо реализации парсеров вручную, можно использовать
  `calibre-ebook.com` CLI (`ebook-convert`) как vendor binary. Плюс: 50+ форматов.
  Минус: огромный binary (~100 MB), лицензия GPL, тяжело bundlить.
- **Pandoc**: лёгкая альтернатива для текстовых форматов (md/rst/adoc/tex → HTML).
  Бинарь ~30 MB, MIT-лицензия.

---

> Обновлять при каждом добавлении нового формата. См. также:
> - `electron/lib/library/types.ts` — `SUPPORTED_BOOK_EXTS`
> - `electron/lib/library/archive-extractor.ts` — `ARCHIVE_EXTS`
> - `electron/lib/library/import-magic-guard.ts` — magic bytes checks
> - `renderer/locales/{ru,en}.js` — `library.import.dropzone.hint`
