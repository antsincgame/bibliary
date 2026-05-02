/**
 * Filename Parser -- extract Author, Title, Year, Edition from folder/file
 * naming conventions commonly used for ebook collections.
 *
 * Cascade of regexes tried in priority order. Both the parent folder name
 * and the file basename (without extension) are parsed; the result with
 * more filled fields wins.
 */

import * as path from "path";

export interface FilenameMeta {
  author?: string;
  title?: string;
  year?: number;
  edition?: string;
}

const DASH = /\s*[-\u2013\u2014]\s*/;

const EDITION_RE = /(?:\d+\s*(?:st|nd|rd|th)\s*(?:edition|ed\.?)|(?:edition|ed\.?)\s*\d+)/i;
const REVISED_RE = /\b(revised|updated|expanded|annotated)\b/i;

interface PatternDef {
  re: RegExp;
  map: (m: RegExpMatchArray) => FilenameMeta;
}

/**
 * Phase A+B Iter 9.3 (rev. 2 colibri-roadmap.md): regex для русских коллекций.
 *
 * Реальные паттерны имён в дампах Либрусека/Флибусты/IT-архивов:
 *   "Толстой Л.Н. - Война и мир - 1869.pdf"        — Cyrillic surname + initials
 *   "Достоевский Ф.М. - Идиот.fb2"                  — без года
 *   "Пушкин А.С. Евгений Онегин (1833).fb2"          — с годом в скобках
 *   "[Бахтин М.М.] Творчество Франсуа Рабле (1965)" — в квадратных скобках
 *   "Толстой_Л.Н._Война_и_мир_1869.fb2"              — underscore-separator
 *   "1869_Толстой_Л.Н._Война_и_мир.fb2"              — year-first
 *
 * Особенности русских инициалов: одна или две буквы с точкой, могут быть
 * слитно (Л.Н.) или раздельно (Л. Н.). Регулярка `[А-ЯЁ]\.?(?:\s*[А-ЯЁ]\.?)?`
 * покрывает оба варианта.
 */
const RU_INITIAL = "[А-ЯЁ]\\.?(?:[\\s_]*[А-ЯЁ]\\.?)?";
const RU_SURNAME = "[А-ЯЁ][а-яё]+(?:[-‐‑‒][А-ЯЁ][а-яё]+)?";
/* `[\s_]+` between surname and initials — поддержка как пробельного, так и
   underscore-разделителя в одной regex (Толстой Л.Н. = Толстой_Л.Н.). */
const RU_AUTHOR = `${RU_SURNAME}[\\s_]+${RU_INITIAL}`;

const PATTERNS: PatternDef[] = [
  {
    // "Толстой Л.Н. - Война и мир - 1869"  (Russian surname+initials, dash-separated)
    re: new RegExp(`^(${RU_AUTHOR})${DASH.source}(.+?)${DASH.source}(\\d{4})`, "u"),
    map: (m) => ({ author: m[1].trim(), title: m[2].trim(), year: Number(m[3]) }),
  },
  {
    // "Толстой Л.Н. - Война и мир"  (no year in dashes, may have year in parens)
    re: new RegExp(`^(${RU_AUTHOR})${DASH.source}(.+)`, "u"),
    map: (m) => {
      let title = m[2].trim();
      let year: number | undefined;
      const yMatch = title.match(/\((\d{4})\)\s*$/);
      if (yMatch) {
        year = Number(yMatch[1]);
        title = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
      }
      return { author: m[1].trim(), title, year };
    },
  },
  {
    // "Толстой Л.Н. Война и мир (1869)"  (no dash separator, surname-init then space then title)
    re: new RegExp(`^(${RU_AUTHOR})\\s+(.+?)\\s*\\((\\d{4})\\)\\s*$`, "u"),
    map: (m) => ({ author: m[1].trim(), title: m[2].trim(), year: Number(m[3]) }),
  },
  {
    // "[Толстой Л.Н.] Война и мир (1869)"  — в квадратных скобках Russian
    re: new RegExp(`^\\[(${RU_AUTHOR})\\]\\s*(.+?)\\s*\\((\\d{4})\\)`, "u"),
    map: (m) => ({ author: m[1].trim(), title: m[2].trim(), year: Number(m[3]) }),
  },
  {
    // Year-first: "1869 Толстой Л.Н. Война и мир" or "1869_Толстой_Л.Н._Война_и_мир"
    re: new RegExp(`^(\\d{4})[\\s_-]+(${RU_AUTHOR})[\\s_-]+(.+)`, "u"),
    map: (m) => ({
      year: Number(m[1]),
      author: m[2].replace(/_/g, " ").trim(),
      title: m[3].replace(/_/g, " ").trim(),
    }),
  },
  {
    // Underscore-separator (common in dump filesystems): "Толстой_Л.Н._Война_и_мир_1869"
    re: new RegExp(`^(${RU_AUTHOR.replace(/\\s/g, "_")})_(.+?)_(\\d{4})`, "u"),
    map: (m) => ({
      author: m[1].replace(/_/g, " ").trim(),
      title: m[2].replace(/_/g, " ").trim(),
      year: Number(m[3]),
    }),
  },
  {
    // "Author - Title - 2025"  (Latin alphabet - existing original pattern)
    re: new RegExp(`^(.+?)${DASH.source}(.+?)${DASH.source}(\\d{4})`, "u"),
    map: (m) => ({ author: m[1].trim(), title: m[2].trim(), year: Number(m[3]) }),
  },
  {
    // "Author - Title"  (no year in dashes, but year may be in parens at end)
    re: new RegExp(`^(.+?)${DASH.source}(.+)`, "u"),
    map: (m) => {
      let title = m[2].trim();
      let year: number | undefined;
      const yMatch = title.match(/\((\d{4})\)\s*$/);
      if (yMatch) {
        year = Number(yMatch[1]);
        title = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
      }
      return { author: m[1].trim(), title, year };
    },
  },
  {
    // "[Author] Title (Year)"
    re: /^\[(.+?)\]\s*(.+?)\s*\((\d{4})\)/u,
    map: (m) => ({ author: m[1].trim(), title: m[2].trim(), year: Number(m[3]) }),
  },
  {
    // "Title (Year)" -- no author
    re: /^(.+?)\s*\((\d{4})\)\s*$/u,
    map: (m) => ({ title: m[1].trim(), year: Number(m[2]) }),
  },
  {
    // "Title_2nd_Edition_2024" -- common no-author dump naming
    re: /^(.+?)_(\d+\s*(?:st|nd|rd|th)_Edition|Edition_\d+)_(\d{4})$/iu,
    map: (m) => ({
      title: `${m[1].replace(/_/g, " ")} ${m[2].replace(/_/g, " ")}`.trim(),
      year: Number(m[3]),
    }),
  },
  {
    // "Author_Title_Year" (underscore separator)
    re: /^(.+?)_(.+?)_(\d{4})/u,
    map: (m) => ({ author: m[1].trim(), title: m[2].trim(), year: Number(m[3]) }),
  },
];

function parseOneName(name: string): FilenameMeta | null {
  for (const { re, map } of PATTERNS) {
    const m = name.match(re);
    if (m) {
      const meta = map(m);
      if (meta.year !== undefined && (meta.year < 1800 || meta.year > 2100)) {
        meta.year = undefined;
      }
      const ed = name.match(EDITION_RE);
      if (ed) meta.edition = ed[0].trim();
      else {
        const rev = name.match(REVISED_RE);
        if (rev) meta.edition = rev[0].trim();
      }
      return meta;
    }
  }
  return null;
}

function fallbackPlainTitle(name: string): FilenameMeta | null {
  const title = name.replace(/[_\s]+/g, " ").trim();
  if (!/[a-zA-Z\u0400-\u04ff]/.test(title)) return null;
  if (title.split(/\s+/).length < 2) return null;
  return { title };
}

function fieldCount(m: FilenameMeta): number {
  let n = 0;
  if (m.author) n++;
  if (m.title) n++;
  if (m.year !== undefined) n++;
  if (m.edition) n++;
  return n;
}

/**
 * Parse metadata from the file path. Tries both the parent folder name
 * and the file basename; returns the richer result (more fields filled).
 */
export function parseFilename(filePath: string): FilenameMeta | null {
  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);
  const parentDir = path.basename(path.dirname(filePath));

  const fromFile = parseOneName(basename) ?? fallbackPlainTitle(basename);
  const fromDir = parentDir && parentDir !== "." && parentDir !== ".." && !/^bibliary[-_]/i.test(parentDir)
    ? parseOneName(parentDir)
    : null;

  if (!fromFile && !fromDir) return null;
  if (!fromFile) return fromDir;
  if (!fromDir) return fromFile;

  return fieldCount(fromDir) > fieldCount(fromFile) ? fromDir : fromFile;
}
