import type { BookSection } from "../scanner/parsers/index.js";

const NON_CONTENT_TITLE_RE = /^(contents|table\s+of\s+contents|toc|index|foreword|preface|isbn\b.*|issn\b.*|conventions\s+used\s+in\s+this\s+book|introduction\s+to\s+the\s+\w+\s+edition|bibliography|references|acknowledg(e)?ments|about\s+(the\s+)?(authors?|technical\s+reviewers?|reviewers?)|copyright|credits|содержание|оглавление|краткое\s+содержание|указатель|предисловие|предисловие\s+редакторской\s+группы|литература|список\s+литературы|библиография|благодарности|об\s+авторах?|об\s+авторе|копирайт)$/i;

function normalizeTitle(title: string): string {
  return title
    .replace(/[#*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNonContentSection(section: Pick<BookSection, "title" | "paragraphs">): boolean {
  const title = normalizeTitle(section.title);
  if (!title) return false;
  if (NON_CONTENT_TITLE_RE.test(title)) return true;

  /* Common parser artifact: a TOC line is promoted to a giant chapter title. */
  if (/^(contents|table\s+of\s+contents|содержание|оглавление)\b/i.test(title) && title.length < 80) {
    return true;
  }

  return false;
}
