// @ts-check

const SAFE_MD_TAGS = [
  "p", "br", "hr", "strong", "em", "b", "i", "u", "s", "del", "ins",
  "code", "pre", "blockquote", "kbd", "mark", "small", "sub", "sup",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "a", "img", "span", "div",
];
const SAFE_MD_ATTRS = ["href", "title", "alt", "src", "class", "lang", "id", "target", "rel"];

/** @param {string} md */
export function renderMarkdown(md) {
  let html;
  if (typeof window.marked !== "undefined" && window.marked.parse) {
    html = window.marked.parse(md, { breaks: true });
  } else {
    return md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }
  if (typeof window.DOMPurify !== "undefined" && window.DOMPurify.sanitize) {
    return window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: SAFE_MD_TAGS,
      ALLOWED_ATTR: SAFE_MD_ATTRS,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
      FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
    });
  }
  console.warn("[chat] DOMPurify not loaded — falling back to escaped text");
  return md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
