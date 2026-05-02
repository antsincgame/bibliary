/**
 * Unit-тесты Versator layout pipeline.
 *
 * Покрывают:
 *  - typograf: «ёлочки», em-dash, NBSP;
 *  - callouts: маркер → HTML, идемпотентность;
 *  - definitions: <dfn>, защита от коротких слов;
 *  - drop caps: пропуск blockquote/image/list (тактическое замечание #1);
 *  - sidenotes: footnote → Tufte markup;
 *  - katex: try/catch для битых формул (тактическое замечание #3);
 *  - protect-code: code blocks не трогаются;
 *  - applyLayout: full pipeline + идемпотентность.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTypograf } from "../electron/lib/library/layout-typograf.js";
import { applyCallouts } from "../electron/lib/library/layout-callouts.js";
import { applyDefinitions } from "../electron/lib/library/layout-definitions.js";
import { applyDropcaps } from "../electron/lib/library/layout-dropcaps.js";
import { applySidenotes } from "../electron/lib/library/layout-sidenotes.js";
import { applyKatex } from "../electron/lib/library/layout-katex.js";
import {
  protectCode,
  hasCodePlaceholder,
} from "../electron/lib/library/layout-protect-code.js";
import {
  applyLayout,
  shouldRenderMath,
  LAYOUT_VERSION,
} from "../electron/lib/library/layout-pipeline.js";

/* ───── typograf ───── */

test("typograf: меняет двойные кавычки на «ёлочки» (RU)", () => {
  const out = applyTypograf('Он сказал "привет".', "ru");
  assert.match(out, /«привет»/, `expected ёлочки, got: ${out}`);
});

test("typograf: ставит em-dash между словами", () => {
  const out = applyTypograf("Это - правильно.", "ru");
  assert.match(out, /\s—\s/, `expected em-dash, got: ${out}`);
});

test("typograf: возвращает пустую строку без падения", () => {
  assert.equal(applyTypograf(""), "");
});

/* ───── callouts ───── */

test("callouts: «Внимание:» → div.lib-reader-callout-warning", () => {
  const md = "Внимание: горячая поверхность.";
  const out = applyCallouts(md);
  assert.match(out, /class="lib-reader-callout lib-reader-callout-warning"/);
  assert.match(out, /lib-reader-callout-label">Внимание</);
  assert.match(out, /горячая поверхность/);
});

test("callouts: «Совет:» → tip", () => {
  const out = applyCallouts("Совет: пейте воду.");
  assert.match(out, /lib-reader-callout-tip/);
});

test("callouts: «Note:» → note (английский)", () => {
  const out = applyCallouts("Note: this is important.");
  assert.match(out, /lib-reader-callout-note/);
});

test("callouts: идемпотентность — уже HTML не трогаем", () => {
  const md = '<div class="lib-reader-callout">old</div>';
  assert.equal(applyCallouts(md), md);
});

test("callouts: обычный параграф без маркера остаётся неизменным", () => {
  const md = "Это обычный текст без callout-маркера.";
  assert.equal(applyCallouts(md), md);
});

/* ───── definitions ───── */

test("definitions: «X — это Y» → <dfn>X</dfn>", () => {
  const out = applyDefinitions("Энтропия — это мера неопределённости.");
  assert.match(out, /<dfn class="lib-reader-dfn">Энтропия<\/dfn>/);
});

test("definitions: пропускает короткие местоимения (Я / Это / It)", () => {
  assert.equal(
    applyDefinitions("Я — это сложный субъект."),
    "Я — это сложный субъект.",
  );
  assert.equal(
    applyDefinitions("Это — это рекурсивное."),
    "Это — это рекурсивное.",
  );
  assert.equal(applyDefinitions("It — is good."), "It — is good.");
});

test("definitions: не срабатывает в blockquote / list / heading", () => {
  assert.equal(
    applyDefinitions("> Энтропия — это термин."),
    "> Энтропия — это термин.",
  );
  assert.equal(
    applyDefinitions("# Энтропия — это глава"),
    "# Энтропия — это глава",
  );
});

/* ───── drop caps (тактическое замечание #1) ───── */

test("dropcaps: первая буква первого ТЕКСТОВОГО параграфа", () => {
  const md = `## Глава 1\n\nДело было вечером.`;
  const out = applyDropcaps(md);
  assert.match(out, /<span class="lib-reader-dropcap">Д<\/span>ело был/);
});

test("dropcaps: пропускает blockquote после заголовка (эпиграф)", () => {
  const md = `## Глава\n\n> Это эпиграф автора.\n\nОбычный текст начала главы.`;
  const out = applyDropcaps(md);
  /* Drop-cap должен попасть на «Обычный», не на «Это». */
  assert.match(out, /<span class="lib-reader-dropcap">О<\/span>бычный/);
  assert.doesNotMatch(out, /<span class="lib-reader-dropcap">Э<\/span>то эпиграф/);
});

test("dropcaps: пропускает image (![]) после заголовка", () => {
  const md = `## Глава\n\n![cover](url)\n\nТекст после картинки.`;
  const out = applyDropcaps(md);
  assert.match(out, /<span class="lib-reader-dropcap">Т<\/span>екст/);
  assert.doesNotMatch(out, /<span class="lib-reader-dropcap">!/);
});

test("dropcaps: пропускает list/table", () => {
  const md = `## Глава\n\n* пункт 1\n* пункт 2\n\nПосле списка.`;
  const out = applyDropcaps(md);
  assert.match(out, /<span class="lib-reader-dropcap">П<\/span>осле/);
});

test("dropcaps: только один drop-cap на главу", () => {
  const md = `## Глава\n\nПервый абзац.\n\nВторой абзац.`;
  const out = applyDropcaps(md);
  const matches = out.match(/lib-reader-dropcap/g);
  assert.equal(matches?.length, 1);
});

test("dropcaps: идемпотентность", () => {
  const md = `## Глава\n\nТекст.`;
  const once = applyDropcaps(md);
  const twice = applyDropcaps(once);
  assert.equal(once, twice);
});

/* ───── sidenotes ───── */

test("sidenotes: markdown footnote → Tufte sidenote markup", () => {
  const md = "Текст со ссылкой[^1].\n\n[^1]: содержимое сноски";
  const out = applySidenotes(md);
  assert.match(out, /<label for="sn-1"/);
  assert.match(out, /<input type="checkbox" id="sn-1"/);
  assert.match(out, /<span class="sidenote">содержимое сноски<\/span>/);
  assert.doesNotMatch(out, /\[\^1\]:/, "footnote def должна быть удалена");
});

test("sidenotes: без footnotes возвращает оригинал", () => {
  const md = "Просто текст без сносок.";
  assert.equal(applySidenotes(md), md);
});

test("sidenotes: безопасный sanitize ID", () => {
  const md = 'Текст[^a/b].\n\n[^a/b]: содержимое';
  const out = applySidenotes(md);
  assert.match(out, /id="sn-a_b"/);
});

test("sidenotes: orphan def (без inline ref) сохраняется как markdown", () => {
  /* Регрессия: ранее orphan defs терялись при applySidenotes. */
  const md = "Просто текст без сносок.\n\n[^orphan]: забытое определение";
  const out = applySidenotes(md);
  /* Без inline-ref applySidenotes должен вернуть md как есть. */
  assert.match(out, /\[\^orphan\]:\s*забытое определение/);
  assert.doesNotMatch(out, /<span class="sidenote">/);
});

test("sidenotes: смесь — used def превращается, orphan def остаётся", () => {
  const md =
    "Ссылка[^used] и больше ничего.\n\n" +
    "[^used]: используется\n" +
    "[^orphan]: не используется";
  const out = applySidenotes(md);
  /* used → sidenote */
  assert.match(out, /<span class="sidenote">используется<\/span>/);
  /* orphan сохранён как markdown */
  assert.match(out, /\[\^orphan\]:\s*не используется/);
});

/* ───── katex (тактическое замечание #3) ───── */

test("katex: $x^2$ → KaTeX HTML", () => {
  const out = applyKatex("Формула: $x^2$.");
  assert.match(out, /class="katex"/);
  assert.match(out, /<span class="katex-html"/);
});

test("katex: $$ display $$ → katex-display", () => {
  const out = applyKatex("$$\\int_0^1 x\\,dx$$");
  assert.match(out, /class="katex-display"/);
});

test("katex: битая формула возвращается как сырой $...$ (graceful)", () => {
  const broken = "Формула: $\\unknown_macro_xyz_$.";
  const out = applyKatex(broken);
  /* На ParseError мы возвращаем СЫРОЙ ввод. */
  assert.match(out, /\$\\unknown_macro_xyz_\$/);
});

test("katex: одиночный $ (цена) не превращается в формулу", () => {
  const out = applyKatex("Цена $5.");
  assert.equal(out, "Цена $5.");
});

/* ───── protect-code ───── */

test("protectCode: fenced ```code``` восстанавливается точно", () => {
  const md = "Текст\n\n```js\nconst x = 1;\n```\n\nЕщё.";
  const { md: protectedMd, restore } = protectCode(md);
  assert.ok(hasCodePlaceholder(protectedMd));
  assert.equal(restore(protectedMd), md);
});

test("protectCode: inline `code` восстанавливается", () => {
  const md = "Используйте `console.log` для отладки.";
  const { md: protectedMd, restore } = protectCode(md);
  assert.ok(hasCodePlaceholder(protectedMd));
  assert.equal(restore(protectedMd), md);
});

test("protectCode: typograf не трогает код", () => {
  const md = 'console.log("hello - world")';
  const codeBlock = `\`\`\`js\n${md}\n\`\`\``;
  const fullMd = `Описание - простое.\n\n${codeBlock}`;
  const out = applyLayout(fullMd);
  /* Внутри code-блока должны остаться оригинальные кавычки и дефис. */
  assert.match(out.md, /console\.log\("hello - world"\)/);
  /* А снаружи — em-dash. */
  assert.match(out.md, /Описание\s—\sпростое/);
});

/* ───── applyLayout (full pipeline) ───── */

test("applyLayout: пустая строка → пустая строка", () => {
  const r = applyLayout("");
  assert.equal(r.md, "");
  assert.equal(r.version, LAYOUT_VERSION);
});

test("applyLayout: полный pipeline на реалистичном примере", () => {
  const md = `## Глава 1. Введение

Энтропия — это мера хаоса.

Внимание: формулы обычно сложные.

Текст со сноской[^1].

[^1]: дополнительное пояснение`;

  const r = applyLayout(md, { lang: "ru" });

  /* drop cap на первой букве первого текстового параграфа. */
  assert.match(r.md, /<span class="lib-reader-dropcap">/);
  /* dfn для определения. */
  assert.match(r.md, /<dfn class="lib-reader-dfn">Энтропия<\/dfn>/);
  /* callout warning. */
  assert.match(r.md, /lib-reader-callout-warning/);
  /* sidenote. */
  assert.match(r.md, /<span class="sidenote">дополнительное пояснение<\/span>/);
  /* version. */
  assert.equal(r.version, LAYOUT_VERSION);
});

test("applyLayout: идемпотентность — повторный запуск стабилен", () => {
  const md = `## Глава\n\nПростой текст параграфа.\n\nВнимание: важная мысль.`;
  const once = applyLayout(md, { lang: "ru" }).md;
  const twice = applyLayout(once, { lang: "ru" }).md;
  /* Допускаем ОДНУ небольшую разницу в кавычках при повторе typograf,
     но drop-cap, callout, dfn должны сохраниться без удвоения. */
  assert.equal(
    (twice.match(/lib-reader-dropcap/g) ?? []).length,
    (once.match(/lib-reader-dropcap/g) ?? []).length,
  );
  assert.equal(
    (twice.match(/lib-reader-callout-warning/g) ?? []).length,
    (once.match(/lib-reader-callout-warning/g) ?? []).length,
  );
});

test("shouldRenderMath: детектит формулы и пропускает их отсутствие", () => {
  assert.equal(shouldRenderMath("Это $x^2$ формула."), true);
  assert.equal(shouldRenderMath("Это $$\\int x dx$$ формула."), true);
  assert.equal(shouldRenderMath("Без формул."), false);
  assert.equal(shouldRenderMath("Цена $5"), false);
  assert.equal(shouldRenderMath(""), false);
});

test("applyLayout: math рендер только при renderMath: true", () => {
  const md = "Формула $x^2$.";
  const off = applyLayout(md, { renderMath: false }).md;
  assert.match(off, /\$x\^2\$/, "без флага формула не рендерится");

  const on = applyLayout(md, { renderMath: true }).md;
  assert.match(on, /class="katex"/, "с флагом формула рендерится");
});
