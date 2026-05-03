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
    .filter((h) => h.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);
  if (index.length === 0) return html;
  return html.replace(/<(p|li)([^>]*)>([\s\S]*?)<\/\1>/g, (full, tag, attrs, inner) => {
    if (/<a\b/i.test(inner) || /<h[1-6]\b/i.test(inner)) return full;
    const plain = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    const plainNorm = norm(plain);
    if (plainNorm.length < 4) return full;
    /* Find the longest heading key that the plain text starts with. Avoids
       linkifying body text like "Глава 1 учит читать", which doesn't begin
       with a known heading prefix exactly. */
    const match = index.find((h) => plainNorm.startsWith(h.key));
    if (!match) return full;
    /* Linkify by replacing the original inner with an anchor wrapper around
       the whole inner — simpler than slicing tokens precisely, still gives
       the user a clickable ToC entry that scrolls to the heading. */
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
    /* Add anchor ids to all headings, then linkify ToC paragraphs/list items
       that match a heading prefix. Result: clickable table of contents that
       jumps to the corresponding chapter heading (P2 fix). */
    const withAnchors = addHeadingAnchors(html);
    html = linkifyTocEntries(withAnchors.html, withAnchors.headings);

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

  const toolbar = el("div", { class: "lib-reader-actions-toolbar" }, [
    el("button", {
      class: "lib-btn lib-btn-ghost lib-reader-action",
      type: "button",
      title: t("library.reader.action.openOriginal.tooltip"),
      onclick: async () => {
        const r = await window.api.library.openOriginal(currentBook.bookId);
        if (!r.ok) {
          const { showAlert } = await import("../components/ui-dialog.js");
          await showAlert(t("library.reader.action.openOriginal.failed", { reason: r.reason || "" }));
        }
      },
    }, t("library.reader.action.openOriginal")),
    el("button", {
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
    }, t("library.reader.action.revealInFolder")),
    coverDataUrl ? el("button", {
      class: "lib-btn lib-btn-ghost lib-reader-action",
      type: "button",
      title: t("library.reader.action.saveCover.tooltip"),
      onclick: () => downloadCover(coverDataUrl, shownTitle),
    }, t("library.reader.action.saveCover")) : null,
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

  /* Iter 12 P2.1: «meaningful body» check (Phalanx Risk Mitigation #5).
     Не просто length<200, а wordCount + sentenceCount. */
  const meaningful = isMeaningfulMarkdown(html);
  const body = el("div", { class: "lib-reader-body", html });

  readerContainer.append(header, body);
  /* Показываем баннер при любом "не осмысленном" контенте — независимо от
     наличия обложки. Книги с failed-import часто не имеют ни обложки, ни
     нормального текста (только стаб "Import failed."). */
  if (!meaningful) {
    readerContainer.appendChild(buildEmptyBodyBanner(currentBook.bookId, meta));
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
 */
function buildEmptyBodyBanner(bookId, meta) {
  const status = meta?.status;
  let reasonText = t("library.reader.empty.body");
  if (status === "unsupported") {
    reasonText = t("library.reader.empty.unsupported");
  } else if (status === "failed") {
    const warn = Array.isArray(meta?.warnings) && meta.warnings.length > 0
      ? meta.warnings[0]
      : null;
    reasonText = warn
      ? t("library.reader.empty.failed", { reason: warn })
      : t("library.reader.empty.failedGeneric");
  }

  return el("div", { class: "lib-reader-empty-banner" }, [
    el("div", { class: "lib-reader-empty-banner-text" }, reasonText),
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
  ]);
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
