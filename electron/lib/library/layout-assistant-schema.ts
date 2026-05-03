/**
 * Layout Assistant — Zod-схема ответа модели + safe parser с JSON repair.
 *
 * Контракт: модель НЕ переписывает текст, она только аннотирует проблемы
 * (заголовки без `##`, мусорные строки, dot-leader ToC). Постпроцессор
 * применяет патчи детерминированно (см. `applyLayoutAnnotations` в
 * `layout-assistant.ts`).
 *
 * Risk 3 fix (см. план): малые модели (1.5B параметров) ломают JSON в
 * 30-40% случаев. Поэтому перед `z.parse()` прогоняем raw output через
 * `jsonrepair`, а если и это не помогло — пытаемся достать хотя бы
 * `headings` через regex (partial extraction).
 */

import { z } from "zod";
import { jsonrepair } from "jsonrepair";

/** Уровень заголовка: 1 = `#`, 2 = `##`, 3 = `###`. */
export const HeadingLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const HeadingAnnotationSchema = z.object({
  /** 1-indexed номер строки в документе/чанке. */
  line: z.number().int().positive(),
  /** Уровень заголовка (1..3). */
  level: HeadingLevelSchema,
  /** Точный текст заголовка БЕЗ markdown-префиксов. */
  text: z.string().min(1),
});

/** Лимиты на размеры массивов — Bug 16 fix: без ограничений модель могла
 *  вернуть тысячи записей (DoS / OOM / многоминутный patching). */
const ANNOTATION_LIMITS = {
  /** Максимум заголовков в одном чанке (7K символов = ~200 параграфов). */
  maxHeadings: 300,
  /** Максимум junk-строк в одном чанке. */
  maxJunkLines: 500,
} as const;

/** Полная схема аннотаций. Все массивы default to [] чтобы модель
 *  могла опускать поля если ничего не нашла.
 *
 * Bug 11 fix: toc_block удалён из схемы — он мерджился но никогда не
 * применялся в `applyLayoutAnnotations`. Честный контракт: только то,
 * что реально влияет на book.md. Dot-leader ToC структуризация делается
 * в renderer/library/reader.js `structureLeaderToc` на этапе рендера.
 */
export const LayoutAnnotationsSchema = z.object({
  headings: z.array(HeadingAnnotationSchema).max(ANNOTATION_LIMITS.maxHeadings).default([]),
  junk_lines: z.array(z.number().int().positive()).max(ANNOTATION_LIMITS.maxJunkLines).default([]),
});

export type LayoutAnnotations = z.infer<typeof LayoutAnnotationsSchema>;
export type HeadingAnnotation = z.infer<typeof HeadingAnnotationSchema>;

/** Маркер версии в frontmatter — защита от двойной обработки книги. */
export const LAYOUT_ASSISTANT_MARKER = "<!-- layout-assistant: v1 -->";

/** Пустой scaffold для промпта — модель должна заполнять массивы и не писать
 *  текст вокруг. Bug 11 fix: toc_block удалён из контракта. */
export const LAYOUT_EMPTY_SCAFFOLD = JSON.stringify(
  { headings: [], junk_lines: [] },
  null,
  2,
);

/**
 * Извлекает первую `{...}` подстроку из произвольного текста. Используется
 * когда модель добавила пролог типа "Here is the JSON:" перед ответом.
 *
 * Поиск балансом скобок (учитывает строки/escape) — простой regex `/\{.*?\}/`
 * не справился бы с вложенными объектами.
 */
export function extractJsonSubstring(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  /* Несбалансированные скобки — возвращаем как есть, jsonrepair починит. */
  return raw.slice(start);
}

/**
 * Partial extraction fallback: если ничего не парсится, пытаемся достать
 * хотя бы массив headings через regex. Это даёт минимально полезный
 * результат — заголовки разметятся, мусор останется (но книга уже лучше
 * чем без вмешательства).
 */
export function extractPartialAnnotations(raw: string): LayoutAnnotations | null {
  const headings: HeadingAnnotation[] = [];
  const headingRegex = /"line"\s*:\s*(\d+)\s*,\s*"level"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(raw)) !== null) {
    const line = Number(m[1]);
    const level = Number(m[2]);
    const text = m[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (line > 0 && (level === 1 || level === 2 || level === 3) && text.length > 0) {
      headings.push({ line, level: level as 1 | 2 | 3, text });
    }
  }
  const junkLines: number[] = [];
  const junkMatch = raw.match(/"junk_lines"\s*:\s*\[([^\]]*)\]/);
  if (junkMatch) {
    const nums = junkMatch[1].match(/\d+/g) ?? [];
    for (const n of nums) {
      const num = Number(n);
      if (num > 0) junkLines.push(num);
    }
  }
  if (headings.length === 0 && junkLines.length === 0) return null;
  return { headings, junk_lines: junkLines };
}

/**
 * Главный entry-point парсинга. Никогда не throw — возвращает `null` если
 * совсем ничего не удалось извлечь. Caller (queue) тогда помечает книгу
 * как `layout-skipped` и продолжает работу.
 *
 * Цепочка попыток:
 *   1. Извлечь JSON-подстроку (на случай пролога).
 *   2. `jsonrepair` (чинит trailing commas, missing brackets, comments).
 *   3. `z.parse()` — строгая валидация.
 *   4. Fallback: `extractPartialAnnotations` через regex.
 */
export function safeParseAnnotations(raw: string): LayoutAnnotations | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const candidate = extractJsonSubstring(raw) ?? raw;
  try {
    const repaired = jsonrepair(candidate);
    const parsed = JSON.parse(repaired);
    return LayoutAnnotationsSchema.parse(parsed);
  } catch {
    return extractPartialAnnotations(raw);
  }
}
