/**
 * Role Collision Detector — диагностика "одна модель на все роли".
 *
 * МОТИВАЦИЯ (диагноз 2026-05-05):
 *   В LM Studio часто загружена одна LLM (24GB VRAM ограничивает).
 *   Bibliary разделяет роли (evaluator / vision_meta / vision_ocr /
 *   vision_illustration / crystallizer / layout_assistant / translator)
 *   через preferences, но если в prefs они совпадают — все запросы
 *   идут на ОДНУ модель параллельно. Это вызывает каскадные
 *   empty-responses и "ролевая модель не работает".
 *
 *   Per-modelKey mutex (model-inference-lock) сериализует запросы,
 *   но не лечит проблему "все яйца в одной корзине". Юзер должен
 *   ВИДЕТЬ что у него происходит.
 *
 * ЧТО ДЕЛАЕТ:
 *   Возвращает structured snapshot ролей и предупреждение если
 *   обнаружена коллизия. Пишется в `import.start` лог как `details`
 *   и `warnings` — пользователь видит в Import Logger.
 */

export interface RoleSnapshot {
  /** Роль → modelKey из prefs (пусто = auto-pick). */
  roles: {
    evaluator: string;
    visionMeta: string;
    visionOcr: string;
    visionIllustration: string;
    crystallizer: string;
    layoutAssistant: string;
    translator: string;
  };
  /** Группы коллизий (одна модель — N разных ролей). */
  collisions: Array<{ modelKey: string; roles: string[] }>;
  /** Высокоуровневое предупреждение для UI/лога (или null). */
  warning: string | null;
}

/**
 * Подмножество prefs которое нам нужно. Принимаем object loose-typed,
 * чтобы не тащить весь PreferencesSchema (циклы импортов).
 */
export interface RolePrefsLike {
  evaluatorModel?: string;
  visionModelKey?: string; /* shared by vision_meta / vision_ocr / vision_illustration */
  extractorModel?: string; /* crystallizer */
  layoutAssistantModel?: string;
  translatorModel?: string;
}

const EMPTY = "(auto-pick)";

/**
 * Построить snapshot ролей и обнаружить коллизии. Pure function — легко
 * тестировать, без I/O.
 */
export function detectRoleCollisions(prefs: RolePrefsLike): RoleSnapshot {
  const norm = (s: string | undefined): string => (s?.trim() ?? "");
  const visionKey = norm(prefs.visionModelKey);

  const roles = {
    evaluator: norm(prefs.evaluatorModel) || EMPTY,
    visionMeta: visionKey || EMPTY,
    visionOcr: visionKey || EMPTY,
    visionIllustration: visionKey || EMPTY,
    crystallizer: norm(prefs.extractorModel) || EMPTY,
    layoutAssistant: norm(prefs.layoutAssistantModel) || EMPTY,
    translator: norm(prefs.translatorModel) || EMPTY,
  };

  /* Группируем по реальному (не auto-pick) modelKey. */
  const byModel = new Map<string, string[]>();
  for (const [roleName, modelKey] of Object.entries(roles)) {
    if (modelKey === EMPTY) continue;
    const list = byModel.get(modelKey) ?? [];
    list.push(roleName);
    byModel.set(modelKey, list);
  }

  const collisions: Array<{ modelKey: string; roles: string[] }> = [];
  for (const [modelKey, roleList] of byModel.entries()) {
    /* vision-meta / vision-ocr / vision-illustration делят visionModelKey
       НАМЕРЕННО — не считаем это коллизией. Считаем только когда vision
       ещё и evaluator/crystallizer/layout/translator на одной модели. */
    const nonVisionRoles = roleList.filter((r) => !r.startsWith("vision"));
    const hasVision = roleList.some((r) => r.startsWith("vision"));
    /* Коллизия = >=2 разных НЕ-vision ролей ИЛИ vision + любая не-vision. */
    if (nonVisionRoles.length >= 2 || (hasVision && nonVisionRoles.length >= 1)) {
      collisions.push({ modelKey, roles: roleList });
    }
  }

  let warning: string | null = null;
  if (collisions.length > 0) {
    const parts = collisions.map(
      (c) => `"${c.modelKey}" обслуживает ${c.roles.length} ролей: ${c.roles.join(", ")}`,
    );
    warning =
      "Role collision detected: " +
      parts.join("; ") +
      ". При параллельной нагрузке LM Studio может возвращать пустые ответы. " +
      "Загрузите отдельные модели в LM Studio или укажите разные modelKey в Settings → Models.";
  }

  return { roles, collisions, warning };
}
