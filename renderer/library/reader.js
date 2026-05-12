// @ts-check
/**
 * Book reader: renders book.md content inside the catalog pane.
 *
 * Flow: catalog row click → openBook(bookId) → fetch markdown via IPC →
 * strip YAML frontmatter → render with marked → display in reader panel.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { fmtWords, fmtQuality } from "./format.js";
import { renderMarkdown } from "../markdown.js";
import { displayBookTitle, displayBookAuthor, displayBookTags } from "./display-meta.js";

/** @type {{ bookId: string; meta: any; html: string; coverDataUrl: string | null } | null} */
let currentBook = null;

/** @type {HTMLElement | null} */
let readerContainer = null;

/** @type {HTMLElement | null} */
let catalogBody = null;

/** @type {((ev: MouseEvent) => void) | null} */
let navInterceptor = null;

/** @type {HTMLElement | null} */
let activeReaderRoot = null;


/**
 * Strip YAML frontmatter (--- ... ---) from markdown text.
 * @param {string} md
 * @returns {string}
 */
function stripFrontmatter(md) {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? md.slice(match[0].length) : md;
}

/**
 * Inline-substitute reference-style image links so they survive even when the
 * body has unbalanced code fences (which cause marked to drop trailing
 * `[img-NNN]: bibliary-asset://…` definitions). After substitution every
 * `![alt][img-NNN]` becomes `![alt](bibliary-asset://…)` which marked parses
 * even inside fenced or paragraph blocks. Definitions are stripped at the end
 * to keep the rendered HTML clean.
 *
 * @param {string} md
 * @returns {string}
 */
function inlineImageRefs(md) {
  const defs = new Map();
  const defRe = /^\[(img-[\w-]+)\]:\s*(\S+)\s*$/gm;
  for (;;) {
    const m = defRe.exec(md);
    if (m === null) break;
    defs.set(m[1], m[2]);
  }
  if (defs.size === 0) return md;
  let out = md.replace(/!\[([^\]]*)\]\[(img-[\w-]+)\]/g, (full, alt, id) => {
    const url = defs.get(id);
    return url ? `![${alt}](${url})` : full;
  });
  out = out.replace(/^\[img-[\w-]+\]:\s*\S+\s*\r?\n?/gm, "");
  out = out.replace(/^<!--\s*Image references[^>]*-->\s*\r?\n?/gm, "");
  return out;
}

/**
 * Wrap a contiguous stack of "Page N" image paragraphs into a collapsible
 * `<details>` block so the reader doesn't open with a wall of full-width
 * PDF/DJVU page screenshots. The cover image stays visible above the fold;
 * the page gallery becomes one collapsed strip the user can expand on
 * demand.
 *
 * Idempotent: if the markdown already contains an explicit
 * `<details class="lib-reader-page-gallery">` block (new md-converter
 * output), this function leaves the HTML untouched. Otherwise (legacy
 * book.md files where each `![Page N][img-XXX]` was emitted as a bare
 * paragraph) we group up to N consecutive `<p><img alt="…Page…">` blocks
 * and replace them in place.
 *
 * @param {string} html
 * @returns {string}
 */
function wrapLegacyPageGallery(html) {
  if (typeof html !== "string" || html.length === 0) return html;

  /* P3 (2026-05-03, user feedback): пользователь явно сказал что превью
     страниц мешает чтению ("зачем превью страниц, текст плохо
     отформатирован"). Полностью убираем гирлянду из reader-а — реальные
     страницы доступны через "Открыть оригинал". Срабатывает и для уже
     обёрнутых <details class="lib-reader-page-gallery">, и для
     legacy-стека голых <p><img alt="Page N">. */

  let out = html.replace(/<details\b[^>]*class="[^"]*lib-reader-page-gallery[^"]*"[^>]*>[\s\S]*?<\/details>/g, "");

  const galleryRe = /(?:<p>\s*<img\b[^>]*\balt="[^"]*Page[^"]*"[^>]*>\s*<\/p>\s*){2,}/g;
  out = out.replace(galleryRe, "");

  return out;
}

/**
 * Detect a contiguous block of "ToC-like" lines (each looking like
 * `Some Title … 17` or `Глава 1. Foo .... 32`) inside the rendered HTML and
 * replace it with a structured `<nav class="lib-reader-toc">` element with
 * proper dot leaders, a clickable title and a fixed-width page number.
 *
 * Only kicks in when the text was originally laid out as a sequence of
 * paragraphs with dot-leader patterns — this is what most scanned PDF/DJVU
 * tables of contents look like. Markdown tables go through a separate
 * `<td>` linkify pass.
 *
 * @param {string} html
 * @param {{ id: string; text: string; level: number }[]} headings
 * @returns {string}
 */
/** Эвристики для распознавания и структуризации dot-leader ToC блоков. */
const TOC_HEURISTIC_CONFIG = Object.freeze({
  /** Минимальная длина нормализованного ключа заголовка для индексации. */
  minHeadingKeyLength: 4,
  /** Максимальная длина строки, которая ещё может быть ToC-entry. */
  maxLineLength: 220,
  /** Минимум подряд идущих ToC-строк, чтобы считать блок настоящим оглавлением. */
  minConsecutiveTocLines: 4,
  /** Максимум разрядов в номере страницы (защита от ложных совпадений). */
  maxPageDigits: 4,
});

function structureLeaderToc(html, headings) {
  if (typeof html !== "string" || html.length === 0) return html;

  const norm = (s) => String(s || "").toLowerCase()
    .replace(/[\s.,:;!?()«»"'\\/|`-]+/g, " ").trim();
  const headingByKey = new Map();
  for (const h of headings) {
    const key = norm(h.text);
    if (key.length >= TOC_HEURISTIC_CONFIG.minHeadingKeyLength && !headingByKey.has(key)) {
      headingByKey.set(key, h.id);
    }
  }

  /* Patterns:
     Pattern A — dot-leader: "Введение........... 5"  /  "Глава 1 ..... 23"
     Pattern B — gap-page:    "Глава 1. Начало работы 23"  (page = trailing number, title >= 4 chars) */
  const PATTERN_LEADER = new RegExp(
    `^([^\\d][^.\\n]{2,${TOC_HEURISTIC_CONFIG.maxLineLength}}?)\\s*(?:\\.{2,}|·{2,}|…+)\\s*(\\d{1,${TOC_HEURISTIC_CONFIG.maxPageDigits}})\\s*$`
  );
  const PATTERN_GAP = new RegExp(
    `^((?:Глава|Раздел|Часть|Chapter|Section|Part|Appendix|Приложение)\\s+[\\dIVXLCM]+(?:[\\.:]?\\s+[^\\d\\n]{1,${TOC_HEURISTIC_CONFIG.maxLineLength}})?)\\s+(\\d{1,${TOC_HEURISTIC_CONFIG.maxPageDigits}})\\s*$`,
    "i"
  );

  const parseLine = (rawText) => {
    const text = String(rawText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > TOC_HEURISTIC_CONFIG.maxLineLength) return null;
    let m = text.match(PATTERN_LEADER);
    if (m) return { title: m[1].trim(), page: m[2] };
    m = text.match(PATTERN_GAP);
    if (m) return { title: m[1].trim(), page: m[2] };
    return null;
  };

  /* Split HTML into top-level <p> and other-block segments, then group runs
     of consecutive ToC-like <p>'s. */
  const PARA_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  const matches = [];
  for (let m = PARA_RE.exec(html); m !== null; m = PARA_RE.exec(html)) {
    const innerText = m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    matches.push({ start: m.index, end: m.index + m[0].length, full: m[0], text: innerText, parsed: parseLine(innerText) });
  }
  if (matches.length === 0) return html;

  /* Group consecutive parsed paragraphs (separated only by whitespace). */
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c]));

  const replacements = [];
  let i = 0;
  while (i < matches.length) {
    if (!matches[i].parsed) { i++; continue; }
    let j = i;
    while (j + 1 < matches.length && matches[j + 1].parsed) {
      const gap = html.slice(matches[j].end, matches[j + 1].start);
      if (gap.replace(/\s+/g, "") !== "") break;
      j++;
    }
    if (j - i + 1 >= TOC_HEURISTIC_CONFIG.minConsecutiveTocLines) {
      const entries = matches.slice(i, j + 1).map((mm) => {
        const titleHtml = escape(mm.parsed.title);
        const id = headingByKey.get(norm(mm.parsed.title));
        const titleNode = id
          ? `<a class="lib-reader-toc-link" href="#${id}">${titleHtml}</a>`
          : `<span class="lib-reader-toc-title">${titleHtml}</span>`;
        return `<li class="lib-reader-toc-entry">${titleNode}<span class="lib-reader-toc-leader" aria-hidden="true"></span><span class="lib-reader-toc-page">${escape(mm.parsed.page)}</span></li>`;
      }).join("");
      replacements.push({
        start: matches[i].start,
        end: matches[j].end,
        html: `<nav class="lib-reader-toc" aria-label="Содержание"><ol class="lib-reader-toc-list">${entries}</ol></nav>`,
      });
    }
    i = j + 1;
  }
  if (replacements.length === 0) return html;

  let out = "";
  let cursor = 0;
  for (const r of replacements) {
    out += html.slice(cursor, r.start) + r.html;
    cursor = r.end;
  }
  out += html.slice(cursor);
  return out;
}

/**
 * Slugify a heading text for use as anchor id. Keeps unicode letters and
 * digits (Russian chapter titles like "Глава 1" → "глава-1"), lowercases
 * everything, collapses whitespace and punctuation to single hyphens.
 *
 * @param {string} text
 * @returns {string}
 */
function slugifyHeading(text) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\s.,:;!?()«»"'\\/|`]+/gu, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "section";
}

/**
 * Inject anchor ids into all heading tags so that ToC lines like
 * "Глава 1. Пишем и тестируем приложение на Python… 32" can later be linked
 * via `<a href="#глава-1-...">Глава 1</a>`. Idempotent: an existing id is
 * preserved as-is. Generates uniqueness suffixes on collision.
 *
 * @param {string} html
 * @returns {{ html: string; headings: { id: string; text: string; level: number }[] }}
 */
function addHeadingAnchors(html) {
  /** @type {{ id: string; text: string; level: number }[]} */
  const headings = [];
  const used = new Set();
  const out = html.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (full, level, attrs, inner) => {
    const existingIdMatch = (attrs || "").match(/\bid\s*=\s*"([^"]+)"/);
    let id = existingIdMatch ? existingIdMatch[1] : slugifyHeading(inner);
    if (!existingIdMatch) {
      let candidate = id;
      let i = 2;
      while (used.has(candidate)) candidate = `${id}-${i++}`;
      id = candidate;
    }
    used.add(id);
    const plainText = String(inner).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    headings.push({ id, text: plainText, level: Number(level) });
    if (existingIdMatch) return full;
    const newAttrs = (attrs || "") + ` id="${id}"`;
    return `<h${level}${newAttrs}>${inner}</h${level}>`;
  });
  return { html: out, headings };
}

/**
 * Linkify table-of-contents entries inside the rendered HTML. Finds paragraphs
 * (or list items) whose text starts with a chapter-like prefix that matches one
 * of the document headings, and wraps the matching prefix in a smooth-scroll
 * anchor. Conservative: only rewrites text nodes that aren't already inside an
 * anchor or heading tag, and only links the prefix portion (page numbers,
 * leaders and tail text remain plain).
 *
 * @param {string} html
 * @param {{ id: string; text: string; level: number }[]} headings
 * @returns {string}
 */
function linkifyTocEntries(html, headings) {
  if (headings.length === 0) return html;
  /* Index headings by normalized prefix tokens so a ToC line that prefixes
     the heading text (typical scanned ToCs include trailing dot leaders and
     page numbers) can still find its target. */
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s.,:;!?()«»"'\\/|`-]+/g, " ").trim();
  /** @type {{ id: string; key: string; level: number }[]} */
  const index = headings
    .map((h) => ({ id: h.id, key: norm(h.text), level: h.level }))
    .filter((h) => h.key.length >= TOC_HEURISTIC_CONFIG.minHeadingKeyLength)
    .sort((a, b) => b.key.length - a.key.length);
  if (index.length === 0) return html;
  return html.replace(/<(p|li|td|th)([^>]*)>([\s\S]*?)<\/\1>/g, (full, tag, attrs, inner) => {
    if (/<a\b/i.test(inner) || /<h[1-6]\b/i.test(inner)) return full;
    /* P3 фикс (2026-05-03): пропускаем «параграфы»-картинки, summary блоков,
       пустые-короткие — иначе родится мусорная ссылка типа «Превью страниц»
       которая ведёт в никуда (user feedback скрина 4). */
    if (/<img\b/i.test(inner)) return full;
    if (/<summary\b/i.test(inner)) return full;
    const plain = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    const plainNorm = norm(plain);
    if (plainNorm.length < TOC_HEURISTIC_CONFIG.minHeadingKeyLength) return full;
    /* Слишком длинные параграфы — почти наверняка обычный текст книги,
       а не ToC-строка; ставить ссылку на весь абзац визуально вредно. */
    if (plain.length > TOC_HEURISTIC_CONFIG.maxLineLength) return full;
    const match = index.find((h) => plainNorm.startsWith(h.key));
    if (!match) return full;
    return `<${tag}${attrs}><a class="lib-reader-toc-link" href="#${match.id}">${inner}</a></${tag}>`;
  });
}

/**
 * Extract the embedded cover reference from book.md.
 * Supports both legacy Base64 data URIs and new CAS asset URLs.
 * @param {string} md
 * @returns {string | null}
 */
function extractCoverDataUrl(md) {
  const casMatch = md.match(/^\[img-cover\]:\s*(bibliary-asset:\/\/sha256\/[a-f0-9]{64})\s*$/m);
  if (casMatch) return casMatch[1];
  const b64Match = md.match(/^\[img-cover\]:\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\s*$/m);
  return b64Match ? b64Match[1] : null;
}

/**
 * Open a book in the reader panel.
 * @param {string} bookId
 * @param {HTMLElement} root - the catalog pane root
 */
export async function openBook(bookId, root) {
  if (!readerContainer) {
    readerContainer = el("div", { class: "lib-reader" });
  }

  root.classList.add("lib-reader-open");
  /* В режиме reader скрываем вкладки библиотеки (см. styles.css). */
  document.body.classList.add("lib-reader-active");
  activeReaderRoot = root;
  catalogBody = root.querySelector(".lib-catalog-body");
  if (catalogBody) catalogBody.style.display = "none";

  const existing = root.querySelector(".lib-reader");
  if (!existing) root.appendChild(readerContainer);

  /* P6 фикс навигации (2026-05-03): пользователь жаловался, что когда книга
     открыта, клик по табам «Импорт / Каталог / Поиск / Коллекции» или по
     иконке в sidebar не «срабатывает». Реальная причина — switchTab
     закрывает reader, но юзер видит, как pane исчезает, и думает что клик
     не сработал; иногда reader перекрывает табы скроллом. Решение:
     перехватываем любой клик по навигации в capture-фазе, СНАЧАЛА явно
     закрываем reader, потом даём клику дойти до родного обработчика. */
  installNavInterceptor(root);

  clear(readerContainer);
  readerContainer.appendChild(
    el("div", { class: "lib-reader-loading" }, t("library.reader.loading"))
  );

  try {
    const [meta, content] = await Promise.all([
      window.api.library.getBook(bookId),
      window.api.library.readBookMd(bookId),
    ]);

    if (!content || !meta) {
      clear(readerContainer);
      readerContainer.appendChild(
        el("div", { class: "lib-reader-error" }, t("library.reader.notFound"))
      );
      readerContainer.appendChild(buildBackButton(root));
      return;
    }

    let bodyMd = stripFrontmatter(content.markdown);
    const coverDataUrl = extractCoverDataUrl(content.markdown);
    if (coverDataUrl) {
      bodyMd = bodyMd.replace(/^!\[[^\]]*\]\[img-cover\]\s*\r?\n?/gm, "");
      bodyMd = bodyMd.replace(/^\[img-cover\]:\s*\S+\s*\r?\n?/gm, "");
    }
    /* Inline image refs BEFORE marked.parse: large books frequently contain
       unbalanced ```code fences``` from PDF/Marker output, which causes marked
       to drop trailing reference definitions and leave images as plain
       `![Page 2][img-001]` text. Inlining keeps every image visible. */
    bodyMd = inlineImageRefs(bodyMd);
    let html = renderMarkdown(bodyMd);
    /* Collapse the page-gallery block (legacy book.md before md-converter
       wrapping was added) so the reader opens to text, not 12 full-width
       page screenshots. */
    html = wrapLegacyPageGallery(html);
    /* Add anchor ids to all headings, then linkify ToC paragraphs/list items
       that match a heading prefix. Result: clickable table of contents that
       jumps to the corresponding chapter heading (P2 fix).
       P4 (2026-05-03): дополнительно конвертируем сплошные блоки строк
       вида "Title……… 17" в структурный <nav class="lib-reader-toc"> с
       dot leaders, чтобы оглавление выглядело как настоящее оглавление
       книги, а не дамп. */
    const withAnchors = addHeadingAnchors(html);
    html = structureLeaderToc(withAnchors.html, withAnchors.headings);
    html = linkifyTocEntries(html, withAnchors.headings);

    currentBook = { bookId, meta, html, coverDataUrl };
    renderReader(root);
  } catch (err) {
    clear(readerContainer);
    readerContainer.appendChild(
      el("div", { class: "lib-reader-error" }, t("library.reader.error", {
        msg: err instanceof Error ? err.message : String(err),
      }))
    );
    readerContainer.appendChild(buildBackButton(root));
  }
}

/**
 * Close the reader and return to catalog.
 * @param {HTMLElement} root
 */
export function closeReader(root) {
  currentBook = null;
  const reader = root.querySelector(".lib-reader");
  if (reader) reader.remove();
  readerContainer = null;
  root.classList.remove("lib-reader-open");
  document.body.classList.remove("lib-reader-active");
  activeReaderRoot = null;
  uninstallNavInterceptor();
  if (catalogBody) {
    catalogBody.style.display = "";
    catalogBody = null;
  }
}

/**
 * Install a single document-level click interceptor (capture phase) that
 * auto-closes the reader whenever the user activates any global navigation
 * element — sidebar route icons or top-level library tabs. Without this the
 * reader visually overlays the catalog pane and the user perceives clicks
 * as broken: tab switches the pane but the just-closed reader is still in
 * the DOM tree of the previously-active pane.
 *
 * @param {HTMLElement} _root
 */
function installNavInterceptor(_root) {
  if (navInterceptor) return;
  navInterceptor = (ev) => {
    if (!activeReaderRoot) return;
    const target = /** @type {HTMLElement|null} */ (ev.target);
    if (!target) return;
    const trigger = target.closest(".sidebar-icon, .lib-tab");
    if (!trigger) return;
    closeReader(activeReaderRoot);
  };
  document.addEventListener("click", navInterceptor, true);
}

function uninstallNavInterceptor() {
  if (!navInterceptor) return;
  document.removeEventListener("click", navInterceptor, true);
  navInterceptor = null;
}

/** @param {HTMLElement} root */
function buildBackButton(root) {
  return el("button", {
    class: "lib-btn lib-reader-back",
    type: "button",
    onclick: () => closeReader(root),
  }, t("library.reader.back"));
}

/** @param {HTMLElement} root */
function renderReader(root) {
  if (!readerContainer || !currentBook) return;
  clear(readerContainer);

  const { meta, html, coverDataUrl } = currentBook;
  const q = typeof meta.qualityScore === "number" ? meta.qualityScore : null;
  const shownTitle = displayBookTitle(meta);
  const shownAuthor = displayBookAuthor(meta);
  const shownTags = displayBookTags(meta);

  /* Iter 12 P2.1: clickable cover (lightbox) + actions toolbar. */
  const coverImg = coverDataUrl ? el("img", {
    class: "lib-reader-cover lib-reader-cover-clickable",
    src: coverDataUrl,
    alt: shownTitle || t("library.reader.coverAlt"),
    title: t("library.reader.cover.clickHint"),
    onclick: () => openCoverLightbox(coverDataUrl, shownTitle),
  }) : null;

  /* Web-mode: openOriginal / revealInFolder заменяем на browser download
   * через /api/library/books/:id/original (existing route). Electron-mode
   * сохраняет native file-system actions. */
  const isWebMode = /** @type {any} */ (window.api).runtime === "web";
  const openOriginalBtn = el("button", {
    class: "lib-btn lib-btn-ghost lib-reader-action",
    type: "button",
    title: t("library.reader.action.openOriginal.tooltip"),
    onclick: async () => {
      if (isWebMode) {
        const url = `/api/library/books/${encodeURIComponent(currentBook.bookId)}/original`;
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      const r = await window.api.library.openOriginal(currentBook.bookId);
      if (!r.ok) {
        const { showAlert } = await import("../components/ui-dialog.js");
        await showAlert(t("library.reader.action.openOriginal.failed", { reason: r.reason || "" }));
      }
    },
  }, t("library.reader.action.openOriginal"));

  const revealBtn = isWebMode
    ? null
    : el("button", {
      class: "lib-btn lib-btn-ghost lib-reader-action",
      type: "button",
      title: t("library.reader.action.revealInFolder.tooltip"),
      onclick: async () => {
        const r = await window.api.library.revealInFolder(currentBook.bookId);
        if (!r.ok) {
          const { showAlert } = await import("../components/ui-dialog.js");
          await showAlert(t("library.reader.action.revealInFolder.failed", { reason: r.reason || "" }));
        }
      },
    }, t("library.reader.action.revealInFolder"));

  const toolbar = el("div", { class: "lib-reader-actions-toolbar" }, [
    openOriginalBtn,
    revealBtn,
    coverDataUrl ? el("button", {
      class: "lib-btn lib-btn-ghost lib-reader-action",
      type: "button",
      title: t("library.reader.action.saveCover.tooltip"),
      onclick: () => downloadCover(coverDataUrl, shownTitle),
    }, t("library.reader.action.saveCover")) : null,
    /* P6 (2026-05-03, user feedback "Кнопки Сжечь — нету"): destructive
       action рядом с обычными — visually distinct (danger styling), guarded
       by confirm dialog. IPC уже есть: window.api.library.deleteBook. */
    el("button", {
      class: "lib-btn lib-btn-ghost lib-reader-action lib-reader-action-burn",
      type: "button",
      title: t("library.reader.action.burn.tooltip"),
      onclick: async () => {
        const { showConfirm, showAlert } = await import("../components/ui-dialog.js");
        const ok = await showConfirm(
          t("library.reader.action.burn.confirm", { title: shownTitle || t("library.reader.action.burn.thisBook") }),
          { okText: t("library.reader.action.burn.ok"), title: t("library.reader.action.burn.title") },
        );
        if (!ok) return;
        try {
          const { STATE } = await import("./state.js");
          const activeCollection = STATE.targetCollection || STATE.collection || undefined;
          const r = await window.api.library.deleteBook(currentBook.bookId, true, activeCollection);
          if (!r || r.ok === false) {
            await showAlert(t("library.reader.action.burn.failed", { reason: r?.reason || "" }));
            return;
          }
          closeReader(root);
          /* Refresh catalog so the deleted row disappears from the list. */
          const { renderCatalog } = await import("./catalog.js");
          await renderCatalog(root);
        } catch (e) {
          await showAlert(t("library.reader.action.burn.failed", { reason: e instanceof Error ? e.message : String(e) }));
        }
      },
    }, t("library.reader.action.burn")),
  ].filter(Boolean));

  const header = el("div", { class: "lib-reader-header" }, [
    buildBackButton(root),
    coverImg,
    el("div", { class: "lib-reader-meta" }, [
      el("h1", { class: "lib-reader-title" }, shownTitle),
      shownAuthor
        ? el("div", { class: "lib-reader-author" }, shownAuthor)
        : null,
      el("div", { class: "lib-reader-info" }, [
        typeof meta.year === "number" ? el("span", { class: "lib-reader-year" }, String(meta.year)) : null,
        meta.domain ? el("span", { class: "lib-reader-domain" }, meta.domain) : null,
        el("span", { class: "lib-reader-words" }, fmtWords(meta.wordCount)),
        q !== null ? el("span", { class: "lib-reader-quality" }, t("library.reader.quality", { value: fmtQuality(q) })) : null,
        meta.chapterCount ? el("span", { class: "lib-reader-chapters" }, `${meta.chapterCount} ${t("library.reader.chapters")}`) : null,
      ].filter(Boolean)),
      shownTags.length > 0
        ? el("div", { class: "lib-reader-tags" }, shownTags.map(
            /** @param {string} tag */ (tag) => el("span", { class: "lib-reader-tag" }, tag)
          ))
        : null,
      toolbar,
    ].filter(Boolean)),
  ]);

  /* Theme switcher: dark / light / sepia (Perplexity research 2026-05-03).
     Light bg + dark text improves comprehension in well-lit rooms (Buchner &
     Baumgartner 2007, Piepenbrock et al. 2013). Dark mode reduces dry eye
     symptoms for night reading. Sepia (warm tint) reduces blue-light fatigue.
     The toggle applies a data-attribute to .lib-reader-body, CSS handles
     the palette swap via custom properties. Preference is stored in
     sessionStorage so it persists across book switches within one session. */
  const themeSwitcher = buildReaderThemeSwitcher();

  /* Iter 12 P2.1: «meaningful body» check (Phalanx Risk Mitigation #5).
     Не просто length<200, а wordCount + sentenceCount. */
  const meaningful = isMeaningfulMarkdown(html);
  const body = el("div", { class: "lib-reader-body", html });
  const savedTheme = getReaderTheme();
  if (savedTheme && savedTheme !== "dark") body.dataset.theme = savedTheme;

  readerContainer.append(header, themeSwitcher, body);
  /* Показываем баннер при любом "не осмысленном" контенте — независимо от
     наличия обложки. Книги с failed-import часто не имеют ни обложки, ни
     нормального текста (только стаб "Import failed."). */
  if (!meaningful) {
    readerContainer.appendChild(buildEmptyBodyBanner(currentBook.bookId, meta, root));
  }

}

/**
 * Phalanx Risk Mitigation #5 (Google review): не просто length, а смысл.
 * Считаем words и sentences после strip markdown syntax.
 * @param {string} html
 * @returns {boolean}
 */
function isMeaningfulMarkdown(html) {
  if (typeof html !== "string") return false;
  const stripped = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .trim();
  const words = stripped.split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 50) return false;
  const sentences = stripped.split(/[.!?]\s+/).filter((s) => s.trim().length > 5);
  if (sentences.length < 3) return false;
  return true;
}

/**
 * @param {string} bookId
 * @param {any} [meta]
 * @param {Element} [root]
 */
function buildEmptyBodyBanner(bookId, meta, root) {
  const status = meta?.status;
  const warnings = Array.isArray(meta?.warnings) ? meta.warnings : [];
  let reasonText = t("library.reader.empty.body");
  if (status === "unsupported") {
    reasonText = t("library.reader.empty.unsupported");
  } else if (status === "failed") {
    const warn = warnings.length > 0 ? warnings[0] : null;
    reasonText = warn
      ? t("library.reader.empty.failed", { reason: warn })
      : t("library.reader.empty.failedGeneric");
  }

  /* v1.0.2: surface diagnostic so user knows WHY parsing failed (incomplete
     torrent, missing DjVuLibre, DRM, etc.). Show top 3 warnings; full list
     is in book.md frontmatter. */
  const diagBlock = warnings.length > 0
    ? el("details", { class: "lib-reader-empty-diagnostic" }, [
        el("summary", {}, t("library.reader.empty.diagnosticSummary")),
        el("ul", { class: "lib-reader-empty-diagnostic-list" },
          warnings.slice(0, 5).map((w) => el("li", {}, String(w))),
        ),
      ])
    : null;

  const children = [el("div", { class: "lib-reader-empty-banner-text" }, reasonText)];
  if (diagBlock) children.push(diagBlock);

  const actions = el("div", { class: "lib-reader-empty-banner-actions" }, [
    el("button", {
      class: "lib-btn lib-btn-primary",
      type: "button",
      onclick: async () => {
        const r = await window.api.library.openOriginal(bookId);
        if (!r.ok) {
          const { showAlert } = await import("../components/ui-dialog.js");
          await showAlert(t("library.reader.action.openOriginal.failed", { reason: r.reason || "" }));
        }
      },
    }, t("library.reader.empty.openOriginal")),
    el("button", {
      class: "lib-btn lib-btn-ghost lib-reader-action-burn",
      type: "button",
      onclick: async () => {
        const { showConfirm, showAlert } = await import("../components/ui-dialog.js");
        const ok = await showConfirm(
          t("library.reader.empty.deleteConfirm", { title: meta?.title || "" }),
        );
        if (!ok) return;
        try {
          const { STATE } = await import("./state.js");
          const activeCollection = STATE.targetCollection || STATE.collection || undefined;
          const result = await window.api.library.deleteBook(bookId, true, activeCollection);
          if (result && result.ok !== false) {
            if (root) closeReader(root);
            const { renderCatalog } = await import("./catalog.js");
            if (root) await renderCatalog(root);
          } else {
            await showAlert(t("library.reader.empty.deleteFailed", { reason: result?.reason || "" }));
          }
        } catch (e) {
          await showAlert(t("library.reader.empty.deleteFailed", { reason: e instanceof Error ? e.message : String(e) }));
        }
      },
    }, t("library.reader.empty.deleteFromCatalog")),
  ]);
  children.push(actions);

  return el("div", { class: "lib-reader-empty-banner" }, children);
}

/* ── Reader theme switcher ──────────────────────────────────────────── */

const READER_THEMES = /** @type {const} */ (["dark", "light", "sepia"]);
const READER_THEME_LABELS = { dark: "Dark", light: "Light", sepia: "Sepia" };
const READER_THEME_KEY = "bibliary_reader_theme";

/** @returns {string} */
function getReaderTheme() {
  try { return sessionStorage.getItem(READER_THEME_KEY) || "dark"; } catch { return "dark"; }
}

/** @param {string} theme */
function setReaderTheme(theme) {
  try { sessionStorage.setItem(READER_THEME_KEY, theme); } catch { /* private mode */ }
}

function buildReaderThemeSwitcher() {
  const current = getReaderTheme();
  const buttons = READER_THEMES.map((theme) => {
    const btn = el("button", {
      class: `lib-btn lib-btn-ghost lib-reader-theme-btn${theme === current ? " lib-reader-theme-btn-active" : ""}`,
      type: "button",
      "data-theme": theme,
      title: READER_THEME_LABELS[theme],
      onclick: () => {
        const body = readerContainer?.querySelector(".lib-reader-body");
        if (body) {
          if (theme === "dark") {
            delete /** @type {HTMLElement} */ (body).dataset.theme;
          } else {
            /** @type {HTMLElement} */ (body).dataset.theme = theme;
          }
        }
        setReaderTheme(theme);
        container.querySelectorAll(".lib-reader-theme-btn").forEach((b) => {
          b.classList.toggle("lib-reader-theme-btn-active", /** @type {HTMLElement} */ (b).dataset.theme === theme);
        });
      },
    }, READER_THEME_LABELS[theme]);
    return btn;
  });
  const container = el("div", { class: "lib-reader-theme-switcher" }, buttons);
  return container;
}

/** @param {string} src @param {string} alt */
function openCoverLightbox(src, alt) {
  /* Keydown listener добавляется один раз и снимается при ЛЮБОМ способе
     закрытия — через кнопку, backdrop, или Escape. */
  /** @type {((ev: KeyboardEvent) => void)|null} */
  let onKey = null;

  const close = () => {
    lightbox.remove();
    if (onKey) {
      document.removeEventListener("keydown", onKey);
      onKey = null;
    }
  };

  const lightbox = el("div", {
    class: "lib-reader-lightbox",
    role: "dialog",
    "aria-modal": "true",
    onclick: (ev) => {
      if (ev.target === ev.currentTarget) close();
    },
  }, [
    el("img", { class: "lib-reader-lightbox-img", src, alt: alt || "" }),
    el("button", {
      class: "lib-reader-lightbox-close",
      type: "button",
      "aria-label": t("library.reader.cover.close"),
      onclick: () => close(),
    }, "×"),
  ]);
  document.body.appendChild(lightbox);

  onKey = (ev) => {
    if (ev.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
}

/** @param {string} src @param {string} title */
async function downloadCover(src, title) {
  const safeTitle = String(title || "cover").replace(/[/\\?%*:|"<>]/g, "_");
  if (src.startsWith("data:image/")) {
    const m = src.match(/^data:image\/([a-zA-Z0-9.+-]+);/);
    const ext = m ? m[1].replace("svg+xml", "svg") : "img";
    const a = document.createElement("a");
    a.href = src;
    a.download = `${safeTitle}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  /* bibliary-asset:// — fetch to get blob with correct MIME type. */
  try {
    const resp = await fetch(src);
    const blob = await resp.blob();
    const mime = blob.type || "";
    const ext = mime.includes("svg") ? "svg"
      : mime.includes("png") ? "png"
      : mime.includes("jpeg") || mime.includes("jpg") ? "jpg"
      : mime.includes("webp") ? "webp" : "img";
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeTitle}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  } catch {
    const a = document.createElement("a");
    a.href = src;
    a.download = `${safeTitle}.img`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export function isReaderOpen() {
  return currentBook !== null;
}
