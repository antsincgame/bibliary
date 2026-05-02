/**
 * Layout pipeline: callout detection.
 *
 * Узнаёт научные/технические маркеры в начале параграфа:
 *   "Внимание: текст"
 *   "> Note: text"   (markdown blockquote prefix допустим)
 *   "Совет: ..."
 *
 * Превращает их в стилизованные HTML-блоки:
 *   <div class="lib-reader-callout lib-reader-callout-warning">
 *     <div class="lib-reader-callout-label">Внимание</div>
 *     <div class="lib-reader-callout-body">текст</div>
 *   </div>
 *
 * CSS-стили (Iter C) дают цветной левый бордер + иконку через ::before.
 *
 * Идемпотентность: уже обёрнутые блоки начинаются с `<div class=`,
 * мы их пропускаем (см. trimmed.startsWith("<")).
 */

const CALLOUT_FIRST_LINE_RE =
  /^(\s*>?\s*)(Внимание|Важно|Совет|Замечание|Предупреждение|Note|Warning|Tip|Important|Caution|Danger)\s*:\s*(.*)$/i;

/* Маркер → CSS-класс (4 базовых типа). */
const TYPE_MAP: Record<string, "note" | "tip" | "warning" | "important"> = {
  внимание: "warning",
  предупреждение: "warning",
  warning: "warning",
  caution: "warning",
  danger: "warning",
  важно: "important",
  important: "important",
  совет: "tip",
  tip: "tip",
  замечание: "note",
  note: "note",
};

/* Локализованный label для UI (Iter C добавит icons через ::before). */
const LABEL_MAP: Record<string, string> = {
  внимание: "Внимание",
  предупреждение: "Внимание",
  важно: "Важно",
  совет: "Совет",
  замечание: "Замечание",
  note: "Note",
  warning: "Warning",
  tip: "Tip",
  important: "Important",
  caution: "Caution",
  danger: "Danger",
};

/**
 * Преобразует callout-параграфы в HTML.
 *
 * Работает на уровне «блоков» (split по \n\n+), что соответствует
 * markdown-параграфам. Внутри блока распознаётся первая строка как
 * callout-маркер, остальные строки идут в body.
 */
export function applyCallouts(md: string): string {
  if (!md) return md;

  const blocks = md.split(/\n{2,}/);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const trimmed = block.trimStart();
    /* Уже HTML — не трогаем (идемпотентность). */
    if (trimmed.startsWith("<")) continue;

    const lines = trimmed.split("\n");
    const m = CALLOUT_FIRST_LINE_RE.exec(lines[0]);
    if (!m) continue;

    const markerKey = m[2].toLowerCase();
    const cls = TYPE_MAP[markerKey] ?? "note";
    const label = LABEL_MAP[markerKey] ?? m[2];
    const firstContent = m[3].trim();
    /* Многострочный callout: остальные строки могут идти как `> ...`
       (blockquote-style) или просто продолжаться. Снимаем `> ` префикс. */
    const restLines = lines.slice(1).map((l) => l.replace(/^\s*>\s?/, ""));
    const restText = restLines.join("\n").trim();
    const body = [firstContent, restText].filter(Boolean).join("\n\n");

    blocks[i] =
      `<div class="lib-reader-callout lib-reader-callout-${cls}">` +
      `<div class="lib-reader-callout-label">${label}</div>` +
      `<div class="lib-reader-callout-body">\n\n${body}\n\n</div>` +
      `</div>`;
  }
  return blocks.join("\n\n");
}
