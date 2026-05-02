/**
 * Layout pipeline: Tufte-style sidenotes (footnote upgrade).
 *
 * Markdown footnote syntax:
 *   ...текст[^1]...
 *   [^1]: содержимое сноски
 *
 * → Tufte sidenote markup (Iter D, рендер CSS-only через :checked):
 *   текст
 *   <label for="sn-1" class="margin-toggle sidenote-number"></label>
 *   <input type="checkbox" id="sn-1" class="margin-toggle"/>
 *   <span class="sidenote">содержимое</span>
 *
 * CSS (Iter D в styles.css) делает sidenote видимым на полях на широких
 * экранах; на узких — скрывается, появляется по клику на label через
 * :checked селектор. Никакого JS.
 *
 * Идемпотентность: уже преобразованные тексты содержат `<span class="sidenote">`
 * и не имеют [^N] — повторный applySidenotes становится no-op.
 *
 * Безопасность: код-блоки защищены через protectCode перед applySidenotes,
 * так что `console.log("[^1]")` внутри ``` не превратится в sidenote.
 */

/* `[^id]: content` — может занимать одну строку (до конца строки). */
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s*(.+?)\s*$/gm;

/* `[^id]` inline reference. */
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;

/* Безопасный ID для HTML attribute (без диакритики). */
function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Преобразует markdown footnotes в Tufte-style sidenote markup.
 *
 * Шаги:
 *   1. Вырезаем все `[^id]:` defs во временный Map — иначе FOOTNOTE_REF_RE
 *      поймает `[^id]` из defs как inline ref.
 *   2. На «чистом» тексте без defs считаем используемые ID — это и есть
 *      реальные inline refs.
 *   3. Inline refs заменяем на Tufte HTML.
 *   4. Orphan defs (без inline ref) возвращаем в конец как обычный markdown,
 *      чтобы не терять контент книги (safety net для редакторских черновиков
 *      и битых OCR-импортов).
 */
export function applySidenotes(md: string): string {
  if (!md) return md;

  /* Step 1: вырезаем все defs временно — собираем в Map. */
  const allDefs = new Map<string, string>();
  const stripped = md.replace(FOOTNOTE_DEF_RE, (_full, id, content) => {
    allDefs.set(String(id), String(content).trim());
    return ""; // временно убираем
  });

  if (allDefs.size === 0) return md; // нечего обрабатывать

  /* Step 2: теперь в stripped только inline refs (без коллизии с defs). */
  const referenced = new Set<string>();
  for (const m of stripped.matchAll(FOOTNOTE_REF_RE)) {
    referenced.add(String(m[1]));
  }

  /* Если ни один def не ссылается inline — возвращаем оригинал нетронутым.
     Это safety net: orphan defs остаются как markdown-сноски. */
  const usedIds = [...allDefs.keys()].filter((id) => referenced.has(id));
  if (usedIds.length === 0) return md;

  /* Step 3: inline refs → Tufte HTML. */
  const withSidenotes = stripped.replace(FOOTNOTE_REF_RE, (full, id) => {
    const sid = String(id);
    if (!referenced.has(sid)) return full;
    const content = allDefs.get(sid);
    if (!content) return full;
    const safeId = sanitizeId(`sn-${id}`);
    return (
      `<label for="${safeId}" class="margin-toggle sidenote-number"></label>` +
      `<input type="checkbox" id="${safeId}" class="margin-toggle"/>` +
      `<span class="sidenote">${content}</span>`
    );
  });

  /* Step 4: orphan defs возвращаем в конец (сохраняем контент). */
  const orphanLines: string[] = [];
  for (const [id, content] of allDefs) {
    if (!referenced.has(id)) {
      orphanLines.push(`[^${id}]: ${content}`);
    }
  }
  const orphanBlock = orphanLines.length > 0 ? "\n\n" + orphanLines.join("\n") : "";

  /* Step 5: компактируем тройные переносы, оставшиеся от вырезанных defs. */
  const trailing = md.endsWith("\n") ? "\n" : "";
  return (
    withSidenotes.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") +
    orphanBlock +
    trailing
  );
}
