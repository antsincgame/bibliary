/**
 * tests/renderer-sanitize.test.ts
 *
 * Unit-тесты для pure helpers из renderer/sanitize.js. Эти helpers — основа
 * безопасности reader'а. Любой откат whitelist'а (например, кто-то
 * добавил `style` в TAG_ATTRS «для фичи») ловится тестом.
 *
 * sanitizeHtml() сам тестируется в smoke-spec, потому что использует
 * DOMParser (browser-only API, jsdom не в deps). Здесь — только pure
 * функции.
 *
 * Покрытие:
 *   - isSafeUrl: allow http/https/mailto/bibliary-asset, allow #/relative,
 *     reject javascript/file/data/vbscript/blob/control-chars/unicode-spoofing
 *   - isSafeImageSrc: + data:image/(png|jpeg|gif|webp), reject data:image/svg+xml
 *   - isAllowedAttr: per-tag whitelist + global attrs, reject on*, srcdoc,
 *     style, formaction, любые namespaced attrs (xlink: и т.д.)
 *   - drift-detector: TAG_ALLOWLIST не должен случайно расшириться без
 *     security review (содержит ровно перечисленные теги)
 *   - drift-detector: URL_SCHEME_ALLOWLIST содержит ровно 4 схемы
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeUrl,
  isSafeImageSrc,
  isAllowedAttr,
  TAG_ALLOWLIST,
  URL_SCHEME_ALLOWLIST,
} from "../renderer/sanitize.js";

/* ─── isSafeUrl ────────────────────────────────────────────────────── */

test("[sanitize] isSafeUrl: allows http, https, mailto, bibliary-asset", () => {
  for (const url of [
    "http://example.com/page",
    "https://example.com/",
    "https://lmstudio.ai/docs",
    "mailto:user@example.com",
    "bibliary-asset://sha256/" + "a".repeat(64),
    "bibliary-asset://sha256/abc123",
  ]) {
    assert.equal(isSafeUrl(url), true, `must allow: ${url}`);
  }
});

test("[sanitize] isSafeUrl: allows hash anchors and relative paths", () => {
  assert.equal(isSafeUrl("#section-1"), true);
  assert.equal(isSafeUrl("#"), true);
  assert.equal(isSafeUrl("/static/asset.png"), true);
  assert.equal(isSafeUrl("/some/path"), true);
});

test("[sanitize] isSafeUrl: rejects javascript:, vbscript:, data:, file:, blob:, chrome:, about:", () => {
  for (const url of [
    "javascript:alert(1)",
    "javascript:void(0)",
    "JAVASCRIPT:alert(1)",                    /* uppercase — URL constructor lowercases */
    "  javascript:alert(1)",                  /* leading whitespace */
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "file:///etc/passwd",
    "file://C:/Windows",
    "blob:https://x.com/abc",
    "chrome://settings",
    "about:blank",
    "ms-windows-store://pdp",
    "ftp://server/path",
    "ssh://user@host",
  ]) {
    assert.equal(isSafeUrl(url), false, `must reject: ${JSON.stringify(url)}`);
  }
});

test("[sanitize] isSafeUrl: rejects URLs with control characters / NUL byte", () => {
  for (const url of [
    "https://example.com/\x00path",
    "https://example.com/\npath",
    "https://example.com/\rpath",
    "https://example.com/\tpath",
    "javascript:\x00alert(1)",
    "https://x\x07.com/",                       /* BEL char */
    "https://x.com/\x7f",                       /* DEL */
  ]) {
    assert.equal(isSafeUrl(url), false, `must reject control-chars URL: ${JSON.stringify(url)}`);
  }
});

test("[sanitize] isSafeUrl: rejects empty / non-string / malformed", () => {
  assert.equal(isSafeUrl(""), false, "empty string still goes through URL constructor → returns false");
  assert.equal(isSafeUrl(undefined as unknown as string), false);
  assert.equal(isSafeUrl(null as unknown as string), false);
  assert.equal(isSafeUrl(123 as unknown as string), false);
  assert.equal(isSafeUrl({} as unknown as string), false);
  assert.equal(isSafeUrl([] as unknown as string), false);
});

/* ─── isSafeImageSrc ───────────────────────────────────────────────── */

test("[sanitize] isSafeImageSrc: allows data:image/png, jpeg, gif, webp", () => {
  for (const url of [
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/jpeg;base64,/9j/4AAQ=",
    "data:image/gif;base64,R0lGODlh=",
    "data:image/webp;base64,UklGRl4=",
    "DATA:IMAGE/PNG;BASE64,XXX",                /* case-insensitive */
  ]) {
    assert.equal(isSafeImageSrc(url), true, `must allow image data URI: ${url.slice(0, 50)}`);
  }
});

test("[sanitize] isSafeImageSrc: REJECTS data:image/svg+xml (XSS vector)", () => {
  /* SVG может содержать <script> и onload=. Запрет жёсткий. */
  for (const url of [
    "data:image/svg+xml;base64,PHN2Zw==",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "data:image/svg+xml;utf8,<svg/onload=alert(1)>",
  ]) {
    assert.equal(isSafeImageSrc(url), false, `SVG data URI must be rejected: ${url.slice(0, 50)}`);
  }
});

test("[sanitize] isSafeImageSrc: rejects data:text/html (XSS) и неизвестные media types", () => {
  for (const url of [
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:application/javascript,alert(1)",
    "data:image/x-icon;base64,xxx",             /* x-icon не в whitelist */
    "data:image/bmp;base64,xxx",                /* BMP не в whitelist */
  ]) {
    assert.equal(isSafeImageSrc(url), false, `must reject: ${url.slice(0, 50)}`);
  }
});

test("[sanitize] isSafeImageSrc: для не-data URL делегирует в isSafeUrl", () => {
  assert.equal(isSafeImageSrc("https://example.com/img.png"), true);
  assert.equal(isSafeImageSrc("bibliary-asset://sha256/" + "a".repeat(64)), true);
  assert.equal(isSafeImageSrc("javascript:alert(1)"), false);
  assert.equal(isSafeImageSrc("file:///etc/passwd"), false);
});

/* ─── isAllowedAttr ────────────────────────────────────────────────── */

test("[sanitize] isAllowedAttr: global attrs (id/class/title/lang/dir/aria-*) разрешены на любом теге", () => {
  for (const tag of ["a", "div", "p", "img", "h1"]) {
    for (const attr of ["id", "class", "title", "lang", "dir", "role", "tabindex",
                         "aria-label", "aria-hidden", "aria-describedby"]) {
      assert.equal(isAllowedAttr(tag, attr), true,
        `${attr} must be allowed on <${tag}>`);
    }
  }
});

test("[sanitize] isAllowedAttr: per-tag attrs работают только на своих тегах", () => {
  /* href на <a> → ok, на <div> → нет. */
  assert.equal(isAllowedAttr("a", "href"), true);
  assert.equal(isAllowedAttr("div", "href"), false);
  /* src на <img> → ok, на <a> → нет. */
  assert.equal(isAllowedAttr("img", "src"), true);
  assert.equal(isAllowedAttr("a", "src"), false);
  /* colspan на <td>/<th> → ok, на <p> → нет. */
  assert.equal(isAllowedAttr("td", "colspan"), true);
  assert.equal(isAllowedAttr("th", "colspan"), true);
  assert.equal(isAllowedAttr("p", "colspan"), false);
  /* open на <details> → ok, на <div> → нет. */
  assert.equal(isAllowedAttr("details", "open"), true);
  assert.equal(isAllowedAttr("div", "open"), false);
});

test("[sanitize] isAllowedAttr: ВСЕ on* атрибуты безусловно запрещены", () => {
  /* Полный спектр event handler'ов — ни один не должен пройти. */
  for (const attr of [
    "onclick", "onerror", "onload", "onmouseover", "onmouseout", "onfocus",
    "onblur", "onsubmit", "onchange", "oninput", "onkeydown", "onkeyup",
    "onkeypress", "onpointerdown", "onpointerup", "onanimationstart",
    "ontransitionend", "ontoggle", "onbeforeunload",
    /* nonsense на* — стартует с "on", регексп должен его бросить. */
    "onfoobar",
    "onx",
    "on",
    "onabort", "oncanplay", "ondrag", "ondrop",
  ]) {
    for (const tag of ["a", "img", "div", "details", "p", "span"]) {
      assert.equal(isAllowedAttr(tag, attr), false,
        `event handler ${attr} must be rejected on <${tag}>`);
    }
  }
});

test("[sanitize] isAllowedAttr: srcdoc, formaction, style безусловно запрещены", () => {
  for (const attr of ["srcdoc", "formaction", "style"]) {
    for (const tag of ["a", "img", "div", "p", "iframe", "form"]) {
      assert.equal(isAllowedAttr(tag, attr), false,
        `${attr} must be rejected on <${tag}>`);
    }
  }
});

test("[sanitize] isAllowedAttr: namespaced атрибуты (xlink:, xml:base, и т.д.) запрещены", () => {
  /* xml:lang — единственное явное исключение (legitimate i18n). */
  assert.equal(isAllowedAttr("p", "xml:lang"), true);
  /* Остальные — нет. */
  for (const attr of [
    "xlink:href",                /* SVG XSS vector */
    "xml:base",
    "xmlns",
    "xmlns:xlink",
    "ns:custom",
  ]) {
    assert.equal(isAllowedAttr("a", attr), false,
      `namespaced attr ${attr} must be rejected`);
  }
});

test("[sanitize] isAllowedAttr: неизвестные кастомные атрибуты (data-*, custom-*) запрещены если не в whitelist", () => {
  /* data-* НЕ в global allowlist. Тест документирует это решение —
     если когда-нибудь захотим разрешить, явно в global. */
  assert.equal(isAllowedAttr("div", "data-book-id"), false);
  assert.equal(isAllowedAttr("a", "data-clipboard"), false);
  /* Какие-то фантазии. */
  assert.equal(isAllowedAttr("a", "ping"), false,
    "ping (used for pings on link clicks) must be rejected");
  assert.equal(isAllowedAttr("a", "download"), false,
    "download attr могла бы заставить скачать вредоносный файл — rejected");
});

/* ─── Drift detectors ──────────────────────────────────────────────── */

test("[sanitize] TAG_ALLOWLIST: drift detector — точный список разрешённых тегов", () => {
  /* Любое расширение списка должно сопровождаться security review И явным
     обновлением этого теста, иначе CI красный. */
  const expected = new Set([
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
  /* Сравниваем как multisets. */
  const actual = new Set(TAG_ALLOWLIST);
  assert.equal(actual.size, expected.size,
    `TAG_ALLOWLIST drift: actual ${actual.size} tags vs expected ${expected.size}. ` +
    `Любое расширение списка требует security review и обновления этого теста.`);
  for (const tag of expected) {
    assert.ok(actual.has(tag), `expected tag missing: ${tag}`);
  }
  for (const tag of actual) {
    assert.ok(expected.has(tag), `unexpected tag added: ${tag} — security review required`);
  }
});

test("[sanitize] TAG_ALLOWLIST: запрещённые теги действительно не в списке", () => {
  /* Документируем что эти теги ОТСУТСТВУЮТ — если кто-то добавит, тест red. */
  for (const tag of [
    "script", "iframe", "object", "embed", "form", "input", "button",
    "textarea", "select", "option", "meta", "link", "base", "style",
    "svg", "math",                              /* допускают вложенный <script> */
    "frame", "frameset", "applet",              /* legacy XSS vectors */
    "audio", "video", "source", "track",        /* media — не нужны в reader, могут autoplay */
    "canvas",                                   /* fingerprinting / interactive */
    "marquee", "blink",                         /* obsolete но всё ещё работают */
  ]) {
    assert.equal(TAG_ALLOWLIST.has(tag), false,
      `${tag} must NOT be in TAG_ALLOWLIST (security)`);
  }
});

test("[sanitize] URL_SCHEME_ALLOWLIST: drift detector — exactly 4 schemes", () => {
  assert.deepEqual(
    [...URL_SCHEME_ALLOWLIST].sort(),
    ["bibliary-asset:", "http:", "https:", "mailto:"].sort(),
    "URL_SCHEME_ALLOWLIST drift — добавление новой схемы (особенно file:, " +
    "data:, blob:) ТРЕБУЕТ обновления isSafeUrl() и security review.",
  );
});
