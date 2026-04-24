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

const PATTERNS: PatternDef[] = [
  {
    // "Author - Title - 2025"
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

  const fromFile = parseOneName(basename);
  const fromDir = parentDir && parentDir !== "." && parentDir !== ".."
    ? parseOneName(parentDir)
    : null;

  if (!fromFile && !fromDir) return null;
  if (!fromFile) return fromDir;
  if (!fromDir) return fromFile;

  return fieldCount(fromDir) >= fieldCount(fromFile) ? fromDir : fromFile;
}
