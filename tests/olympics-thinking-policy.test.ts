/**
 * Olympics — thinking-friendly policy.
 *
 * Политика (см. docs/audits/2026-04-29-olympics-role-arena-audit.md и таблицу
 * "Thinking нужен?" в обсуждении):
 *
 *   crystallizer (delta-extractor) → ДА критично  (extraction = CoT даёт +8-12%)
 *   evaluator                       → ДА          (взвешивание факторов)
 *   lang_detector                   → НЕТ         (тривиальная классификация)
 *   translator                      → ЧАСТИЧНО   (для технических — да; не enforced)
 *   ukrainian_specialist            → НЕТ         (генерация, не reasoning)
 *   vision (любая)                  → НЕТ         (perception, не reasoning)
 *
 * Иt 8А (library-fortress, 2026-05-01): роль `judge` удалена из ModelRole /
 * OlympicsRole; раньше она была в FORBID_THINKING.
 *
 * Тест ловит регрессии: например, кто-то добавил новую crystallizer-дисциплину
 * и забыл `thinkingFriendly: true` → efficiency её пенализит за «медленный ответ»,
 * хотя там модель должна думать.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OLYMPICS_DISCIPLINES } from "../electron/lib/llm/arena/olympics.ts";

/** Роли, для которых каждая дисциплина ОБЯЗАНА быть thinking-friendly. */
const ROLES_REQUIRE_THINKING = new Set([
  "crystallizer",
  "evaluator",
]);

/** Роли, для которых thinking ЗАПРЕЩЁН (overthink, лишние расходы). */
const ROLES_FORBID_THINKING = new Set([
  "lang_detector",
  "ukrainian_specialist",
  "vision",
  "vision_meta",
  "vision_ocr",
  "vision_illustration",
]);

/** Исключения: роль обычно требует thinking, но конкретная дисциплина — нет.
 *  Сюда добавлять только с обоснованием в комментарии. */
const REQUIRE_EXCEPTIONS = new Set<string>([
  "html-extract",  /* парсинг тэгов — не reasoning */
]);

test("thinking-policy: каждая дисциплина crystallizer/evaluator помечена thinkingFriendly: true", () => {
  const violators: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (!ROLES_REQUIRE_THINKING.has(d.role)) continue;
    if (REQUIRE_EXCEPTIONS.has(d.id)) continue;
    if (d.thinkingFriendly !== true) {
      violators.push(`${d.id} (role=${d.role})`);
    }
  }
  assert.deepEqual(
    violators,
    [],
    `Эти дисциплины обязаны иметь thinkingFriendly: true, иначе efficiency пенализит ` +
    `thinking-модели за время рассуждения:\n  - ${violators.join("\n  - ")}\n` +
    `Если хотите сделать исключение — добавьте id в REQUIRE_EXCEPTIONS с обоснованием.`,
  );
});

test("thinking-policy: lang_detector/ukrainian/vision НЕ должны быть thinkingFriendly", () => {
  const violators: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (!ROLES_FORBID_THINKING.has(d.role)) continue;
    if (d.thinkingFriendly === true) {
      violators.push(`${d.id} (role=${d.role})`);
    }
  }
  assert.deepEqual(
    violators,
    [],
    `Эти роли не выигрывают от thinking — для них thinkingFriendly: true даёт ложный ` +
    `сигнал «медленные модели тоже норм». Уберите флаг:\n  - ${violators.join("\n  - ")}`,
  );
});

test("thinking-policy: каждая роль имеет хотя бы одну дисциплину", () => {
  const rolesPresent = new Set(OLYMPICS_DISCIPLINES.map((d) => d.role));
  /* judge удалён из ModelRole / OlympicsRole в Иt 8А (library-fortress,
   * 2026-05-01) — больше не в списке требуемых ролей. delta-extractor уже
   * давно заменил отдельный judge-шаг. */
  const requiredRoles = [
    "crystallizer", "evaluator", "translator",
    "lang_detector", "ukrainian_specialist",
    "vision_meta", "vision_ocr", "vision_illustration",
  ];
  for (const role of requiredRoles) {
    assert.ok(
      rolesPresent.has(role as never),
      `Роль "${role}" не имеет ни одной дисциплины — Олимпиада не сможет её калибровать`,
    );
  }
});

test("thinking-policy: id уникальны", () => {
  const ids = OLYMPICS_DISCIPLINES.map((d) => d.id);
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) dups.push(id);
    seen.add(id);
  }
  assert.deepEqual(dups, [], `Дубликаты id дисциплин: ${dups.join(", ")}`);
});

test("thinking-policy: каждая дисциплина имеет description и system prompt", () => {
  const broken: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (!d.description || d.description.length < 5) broken.push(`${d.id}: missing description`);
    if (!d.system || d.system.length < 5) broken.push(`${d.id}: missing system prompt`);
    if (!d.user || d.user.length < 5) broken.push(`${d.id}: missing user prompt`);
    if (typeof d.maxTokens !== "number" || d.maxTokens < 1) broken.push(`${d.id}: invalid maxTokens`);
    if (typeof d.score !== "function") broken.push(`${d.id}: missing scorer`);
  }
  assert.deepEqual(broken, [], `Невалидные дисциплины:\n  - ${broken.join("\n  - ")}`);
});

test("thinking-policy: vision-дисциплины имеют imageUrl", () => {
  const visionRoles = new Set(["vision", "vision_meta", "vision_ocr", "vision_illustration"]);
  const broken: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (!visionRoles.has(d.role)) continue;
    if (!d.imageUrl || !d.imageUrl.startsWith("data:image/")) {
      broken.push(`${d.id}: imageUrl missing or not data-URI`);
    }
  }
  assert.deepEqual(broken, [], `Vision без картинки:\n  - ${broken.join("\n  - ")}`);
});
