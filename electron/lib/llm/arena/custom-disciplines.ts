/**
 * Custom Olympics disciplines — пользовательские тесты, добавляемые из UI.
 *
 * Создан 2026-05-05 (Iter 14.3, приказ Императора). Цель: позволить
 * библиотекарям расширять Olympics своими тестами без правки кода.
 *
 * Архитектура:
 *   1. Метаданные (id, role, name, prompts, expectedAnswer, imageRef)
 *      хранятся в `preferences.customOlympicsDisciplines: CustomDiscipline[]`.
 *   2. Картинки (только для vision-ролей) — отдельные файлы в
 *      `userData/custom-disciplines/{id}.png` (см. `discipline-images.ts`).
 *   3. При запуске Olympics `compileCustomDiscipline()` превращает
 *      `CustomDiscipline` в `Discipline` (контракт `disciplines.ts`),
 *      собирая `score()` из единого безопасного scorer'а `scoreFuzzy`.
 *
 * Безопасность:
 *   - Пользователь НЕ пишет JS-код (никакого eval / new Function).
 *   - Scorer один — fuzzy similarity (Dice coefficient) между ответом
 *     модели и ожидаемым текстом. Подходит для всех 4 ролей:
 *     - vision_ocr / vision_illustration: проверка распознанного текста
 *     - evaluator: проверка JSON-ответа со score+reasoning
 *     - crystallizer: проверка JSON-ответа с фактами/тэгами
 *
 * Ограничения:
 *   - Нет регулярок, нет JSON-схем, нет строгого диапазона числа —
 *     только текстовая близость. Этого достаточно для большинства
 *     ситуаций, и порог 0.5+ обычно отделяет «модель поняла» от
 *     «модель промахнулась».
 */

import { z } from "zod";
import type { Discipline } from "./disciplines.js";
import type { OlympicsRole } from "./olympics-types.js";
import { stripThinkingBlock } from "./disciplines.js";

/**
 * Pure ASCII / cyrillic word-boundary tokenizer. Игнорирует пунктуацию,
 * приводит к нижнему регистру, дропает пустые токены. Используется и для
 * ответа модели, и для ожидаемого текста.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    /* Заменяем всё, что НЕ буква/цифра (Unicode-aware), на пробел. */
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Dice coefficient на множествах токенов: 2 * |A ∩ B| / (|A| + |B|).
 * Возвращает 0..1.
 *
 * Почему Dice а не Jaccard:
 *   - Dice мягче к асимметрии длин (модель часто отвечает короче/длиннее
 *     эталона). Jaccard = (A∩B) / (A∪B) штрафует длину сильнее.
 *   - Для пустых множеств — 0 (конвенция; не NaN).
 */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

/**
 * Безопасный fuzzy scorer для пользовательских тестов.
 *
 * Алгоритм:
 *   1. Снимаем `<think>` блок из ответа (если модель reasoning'овая).
 *   2. Токенизируем ответ и эталон по unicode word-boundary.
 *   3. Считаем Dice coefficient между множествами токенов.
 *   4. Клампим в [0, 1].
 *
 * Возвращает 0..1.
 */
export function scoreFuzzy(answer: string, expected: string): number {
  const cleaned = stripThinkingBlock(answer);
  const aTokens = new Set(tokenize(cleaned));
  const bTokens = new Set(tokenize(expected));
  const score = diceCoefficient(aTokens, bTokens);
  return Math.max(0, Math.min(1, score));
}

/* ─── Schema (Zod) ──────────────────────────────────────────────────────── */

/** Все 4 роли пайплайна, для которых имеют смысл custom-тесты. */
const CustomRoleSchema = z.enum(["crystallizer", "evaluator", "vision_ocr", "vision_illustration"]);

/**
 * Метаданные пользовательской дисциплины. Хранятся в preferences.json.
 * Картинка (для vision-ролей) — отдельный файл, ссылка через `imageRef`.
 */
export const CustomDisciplineSchema = z.object({
  /**
   * Уникальный id, генерируется UI: `custom-{role}-{slug}-{stamp}`.
   * Безопасные символы: a-z, 0-9, дефис, подчёркивание. Префикс `custom-`
   * фиксированный — отделяет от статических id (`crystallizer-rover` и т.п.),
   * чтобы в registry'е custom-discipline никогда не «затирала» статическую.
   */
  id: z.string().min(8).max(120).regex(/^custom-[a-z0-9_-]+$/i, {
    message: "id must start with 'custom-' and contain only [a-z0-9_-]",
  }),
  role: CustomRoleSchema,
  /** Человеко-понятное название теста для UI и для лога Olympics. */
  name: z.string().min(1).max(120),
  /** Опциональное описание сути теста — для UI explain. */
  description: z.string().max(400).optional().default(""),
  /** System prompt — отправляется как первое сообщение. */
  system: z.string().min(1).max(4000),
  /** User prompt / sample — содержит входной текст или контекст. */
  user: z.string().min(1).max(20000),
  /** Ожидаемый ответ модели. Используется для fuzzy-similarity scoring. */
  expectedAnswer: z.string().min(1).max(20000),
  /**
   * Бюджет токенов на ответ. Default 800 — компромисс между evaluator/crystallizer
   * (часто JSON 200-500 токенов) и vision_illustration (1-3 предложения).
   */
  maxTokens: z.number().int().min(64).max(8000).default(800),
  /**
   * Если true — дисциплина НЕ штрафует за время выполнения. Полезно
   * для тестов, где модель должна «подумать» (длинная цепочка reasoning).
   */
  thinkingFriendly: z.boolean().default(false),
  /**
   * Имя файла картинки в `userData/custom-disciplines/{imageRef}`.
   * Обязательно для vision-ролей, должно быть undefined для текстовых.
   * UI и compile проверяют это инвариантно.
   */
  imageRef: z.string().regex(/^[a-z0-9_-]+\.(png|jpg|jpeg|webp)$/i).optional(),
  /** Когда создан (ISO-8601). Заполняется при save. */
  createdAt: z.string().datetime().optional(),
  /** Когда последний раз обновлён (ISO-8601). Заполняется при save. */
  updatedAt: z.string().datetime().optional(),
}).refine(
  (d) => {
    const isVision = d.role === "vision_ocr" || d.role === "vision_illustration";
    return isVision ? !!d.imageRef : !d.imageRef;
  },
  { message: "vision roles require imageRef; text roles must not have imageRef", path: ["imageRef"] }
);

export type CustomDiscipline = z.infer<typeof CustomDisciplineSchema>;

/* ─── Compile ───────────────────────────────────────────────────────────── */

/**
 * Превращает CustomDiscipline в обычный Discipline с safe scorer.
 *
 * Параметр `loadImageDataUrl` инжектируется снаружи (типичный путь —
 * через `discipline-images.ts:loadImageDataUrl`). Это позволяет тестам
 * подменять загрузку без файлового I/O.
 */
export function compileCustomDiscipline(
  custom: CustomDiscipline,
  loadImageDataUrl: (imageRef: string) => string | null = () => null,
): Discipline {
  const isVision = custom.role === "vision_ocr" || custom.role === "vision_illustration";
  const imageUrl = isVision && custom.imageRef ? (loadImageDataUrl(custom.imageRef) ?? undefined) : undefined;
  const expected = custom.expectedAnswer;
  return {
    id: custom.id,
    role: custom.role as OlympicsRole,
    description: custom.description || custom.name,
    system: custom.system,
    user: custom.user,
    score: (answer: string) => scoreFuzzy(answer, expected),
    maxTokens: custom.maxTokens,
    whyImportant: `Custom test «${custom.name}» — fuzzy similarity scoring against expected answer.`,
    imageUrl,
    thinkingFriendly: custom.thinkingFriendly,
  };
}

/* ─── Helpers for UI/IPC ────────────────────────────────────────────────── */

/**
 * Создаёт стабильный id из роли и slug-а имени. Используется UI при создании
 * новой дисциплины: `custom-vision_ocr-pageheader-1737xxx`.
 */
export function generateDisciplineId(role: OlympicsRole, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "test";
  const stamp = Date.now().toString(36);
  return `custom-${role}-${slug}-${stamp}`;
}

/** True если роль требует картинку (vision_*). */
export function roleRequiresImage(role: OlympicsRole): boolean {
  return role === "vision_ocr" || role === "vision_illustration";
}
