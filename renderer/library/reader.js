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
import { renderMarkdown } from "../chat/markdown.js";

/** @type {{ bookId: string; meta: any; html: string; coverDataUrl: string | null } | null} */
let currentBook = null;

/** @type {HTMLElement | null} */
let readerContainer = null;

/** @type {HTMLElement | null} */
let catalogBody = null;

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
 * Extract the embedded cover reference from book.md.
 * Covers are stored by the importer as `[img-cover]: data:image/...`.
 * @param {string} md
 * @returns {string | null}
 */
function extractCoverDataUrl(md) {
  const match = md.match(/^\[img-cover\]:\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\s*$/m);
  return match ? match[1] : null;
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

  catalogBody = root.querySelector(".lib-catalog-body");
  if (catalogBody) catalogBody.style.display = "none";

  const existing = root.querySelector(".lib-reader");
  if (!existing) root.appendChild(readerContainer);

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

    const bodyMd = stripFrontmatter(content.markdown);
    const html = renderMarkdown(bodyMd);
    const coverDataUrl = extractCoverDataUrl(content.markdown);

    currentBook = { bookId, meta, html, coverDataUrl };
    renderReader(root);
  } catch (err) {
    clear(readerContainer);
    readerContainer.appendChild(
      el("div", { class: "lib-reader-error" }, `Error: ${err instanceof Error ? err.message : String(err)}`)
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
  if (catalogBody) {
    catalogBody.style.display = "";
    catalogBody = null;
  }
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

  const header = el("div", { class: "lib-reader-header" }, [
    buildBackButton(root),
    coverDataUrl ? el("img", {
      class: "lib-reader-cover",
      src: coverDataUrl,
      alt: meta.title || "Cover",
    }) : null,
    el("div", { class: "lib-reader-meta" }, [
      el("h1", { class: "lib-reader-title" }, meta.titleEn || meta.title || meta.id),
      meta.author ? el("div", { class: "lib-reader-author" }, meta.author) : null,
      el("div", { class: "lib-reader-info" }, [
        typeof meta.year === "number" ? el("span", { class: "lib-reader-year" }, String(meta.year)) : null,
        meta.domain ? el("span", { class: "lib-reader-domain" }, meta.domain) : null,
        el("span", { class: "lib-reader-words" }, fmtWords(meta.wordCount)),
        q !== null ? el("span", { class: "lib-reader-quality" }, `Quality: ${fmtQuality(q)}`) : null,
        meta.chapterCount ? el("span", { class: "lib-reader-chapters" }, `${meta.chapterCount} ${t("library.reader.chapters")}`) : null,
      ].filter(Boolean)),
      meta.tags && meta.tags.length > 0
        ? el("div", { class: "lib-reader-tags" }, meta.tags.map(
            /** @param {string} tag */ (tag) => el("span", { class: "lib-reader-tag" }, tag)
          ))
        : null,
    ].filter(Boolean)),
  ]);

  const body = el("div", { class: "lib-reader-body", html });

  readerContainer.append(header, body);
}

export function isReaderOpen() {
  return currentBook !== null;
}
