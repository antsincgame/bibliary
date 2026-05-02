/**
 * Versator — Bibliary scientific layout pipeline.
 *
 * Build-time трансформация book.md body в премиальный научный markdown:
 *   - smart typography (typograf): «ёлочки», em-dashes, NBSP;
 *   - callouts: "Внимание:" → стилизованный HTML-блок;
 *   - definitions: "Энтропия — это X" → <dfn>Энтропия</dfn>;
 *   - sidenotes: markdown footnotes → Tufte-style margin notes;
 *   - drop caps: первая буква первой главы → <span class="dropcap">;
 *   - math: $...$ и $$...$$ через локальный KaTeX (опционально, по флагу).
 *
 * Все трансформации:
 *   - **pure JS**, без LLM, без сетевых вызовов;
 *   - **fail-soft** — при ошибке отдаётся исходный фрагмент;
 *   - **idempotent** — повторный запуск даёт стабильный результат.
 *
 * Code blocks (```...``` и `inline code`) защищены через placeholder
 * pattern (layout-protect-code.ts) и недоступны для модификаций.
 *
 * Запуск: после `buildBody(...)` в md-converter.ts перед сборкой
 * финального markdown с frontmatter и image refs.
 */
import { applyTypograf } from "./layout-typograf.js";
import { applyCallouts } from "./layout-callouts.js";
import { applyDefinitions } from "./layout-definitions.js";
import { applyDropcaps } from "./layout-dropcaps.js";
import { applyKatex } from "./layout-katex.js";
import { applySidenotes } from "./layout-sidenotes.js";
import { protectCode } from "./layout-protect-code.js";

/**
 * Версия layout-схемы. Записывается в frontmatter как `layoutVersion: N`.
 * Существующие book.md без этого поля считаются legacy и не получают
 * повторной вёрстки (обратная совместимость).
 *
 * Bump версии при изменении CSS-классов / структуры HTML, чтобы
 * пользователь мог запустить re-render через UI ("Переверстать каталог").
 */
export const LAYOUT_VERSION = 1;

export interface LayoutOptions {
  /** Язык для typograf-правил. По умолчанию "ru" (включает en-US). */
  lang?: "ru" | "en";
  /** Включить KaTeX рендер $...$ блоков. По умолчанию false. */
  renderMath?: boolean;
}

export interface LayoutResult {
  md: string;
  version: typeof LAYOUT_VERSION;
}

/**
 * Авто-детект необходимости math-рендера: ищем хотя бы одну формулу
 * вида `$x^2$` или `$$...$$` в тексте. Простая эвристика, не дорогая
 * (один regex.test на всё body).
 *
 * Не считаем за формулу одиночный $ (например цена «$5») — нужен
 * парный закрывающий $ на той же строке.
 */
export function shouldRenderMath(md: string): boolean {
  if (!md) return false;
  /* Ищем `$...$` где между долларами хотя бы один символ, не \n, не пробел. */
  return /\$[^\s$][^$\n]*\$/.test(md) || /\$\$[\s\S]+?\$\$/.test(md);
}

/**
 * Главный entrypoint Versator.
 *
 * @param md — markdown body (без YAML frontmatter и image refs)
 * @param opts — язык и флаги
 * @returns обогащённый markdown + версия схемы
 */
export function applyLayout(md: string, opts: LayoutOptions = {}): LayoutResult {
  if (!md || md.length === 0) {
    return { md, version: LAYOUT_VERSION };
  }

  const lang = opts.lang ?? "ru";

  /* Защита code blocks: typograf/dropcaps/etc их не должны трогать. */
  const { md: protectedMd, restore } = protectCode(md);

  let out = protectedMd;

  /* Порядок важен и обоснован уроком тестов:
     1. typograf ПЕРВЫМ — пока ещё чистый markdown без HTML-вкраплений.
        Если сделать typograf после callouts, он добавляет NBSP внутрь
        атрибутов вроде `class="lib-reader-callout lib-reader-callout-warning"`,
        ломая CSS-селекторы. Чистый markdown typograf обрабатывает идеально
        и идемпотентно.
     2. callouts/definitions/sidenotes — добавляют HTML-вкрапления.
     3. dropcaps — после, чтобы callout-блок не получил dropcap.
     4. katex — последним, чтобы маркеры $...$ внутри callout body
        корректно отрендерились. */
  out = applyTypograf(out, lang);
  out = applyCallouts(out);
  out = applyDefinitions(out);
  out = applySidenotes(out);
  out = applyDropcaps(out);

  if (opts.renderMath === true) {
    out = applyKatex(out);
  }

  return { md: restore(out), version: LAYOUT_VERSION };
}
