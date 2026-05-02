/**
 * Единая таблица приоритетов форматов книг для всех pipeline'ов.
 *
 * Где используется:
 *   - cross-format-prededup.ts — выбор формата при дубликате basename в одной папке
 *   - folder-bundle/classifier.ts — выбор «главного» файла bundle.md
 *
 * Соглашение: чем выше число — тем предпочтительнее формат для импорта.
 *
 * Иерархия и обоснование (Иt 10, smart-routing):
 *   - epub=100  reflowable, semantic structure, лучший для RAG/embeddings
 *   - pdf=80    почти всегда есть text-layer, OCR-резерв
 *   - djvu=70   text-layer есть не всегда, OCR обязателен
 *   - djv=69    то же что djvu, легаси-расширение
 *   - fb2=60    XML, чистый текст, но в реальной библиотеке редок
 *   - docx=50   semantic structure, но реже встречается
 *   - doc=40    OLE compound, конвертация теряет часть форматирования
 *   - azw3=36   современный Kindle
 *   - mobi/azw=35 классический Kindle
 *   - rtf=30
 *   - odt=25
 *   - lit=24    Microsoft Reader
 *   - lrf=23    Sony BBeB
 *   - snb=21    Samsung Note Book
 *   - pdb/prc=20 Palm DB
 *   - chm=15    Microsoft Help
 *   - cbz=12    comic ZIP
 *   - cbr=11    comic RAR
 *   - tcr=10    Psion
 *   - txt=10    нет структуры
 *   - html/htm=5
 */
export const FORMAT_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  epub: 100,
  pdf:  80,
  djvu: 70,
  djv:  69,
  fb2:  60,
  docx: 50,
  doc:  40,
  azw3: 36,
  mobi: 35,
  azw:  35,
  rtf:  30,
  odt:  25,
  lit:  24,
  lrf:  23,
  snb:  21,
  pdb:  20,
  prc:  20,
  chm:  15,
  cbz:  12,
  cbr:  11,
  tcr:  10,
  txt:  10,
  html: 5,
  htm:  5,
});

export interface PriorityOptions {
  /** Если true — DjVu приоритетнее PDF (обмен 80↔70). */
  preferDjvuOverPdf?: boolean;
}

export function getPriority(ext: string, opts: PriorityOptions = {}): number {
  const e = ext.toLowerCase();
  if (opts.preferDjvuOverPdf) {
    if (e === "djvu") return 90;
    if (e === "djv") return 89;
  }
  return FORMAT_PRIORITY[e] ?? -1;
}
