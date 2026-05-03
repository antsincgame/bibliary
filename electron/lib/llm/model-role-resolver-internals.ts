/**
 * Внутренние карты, разделяемые между `model-role-resolver.ts` и
 * `with-model-fallback.ts`. Вынесены, чтобы избежать circular import:
 *   model-role-resolver  → preferences/store  (большой граф)
 *   with-model-fallback  → model-role-resolver (нужен только PREF_KEYS, CAPS)
 */

export type ModelRole =
  | "crystallizer"
  | "vision_meta"
  | "vision_ocr"
  | "vision_illustration"
  | "evaluator"
  | "ukrainian_specialist"
  | "lang_detector"
  | "translator"
  | "layout_assistant";

export type Capability = "vision";

/**
 * Какие capabilities обязательны для роли. Если у кандидата нет всех
 * required caps — он отбрасывается.
 *
 * Этот константный объект **синхронизирован** с `ROLE_REQUIRED_CAPS` в
 * `model-role-resolver.ts`. При добавлении новой роли нужно дополнить ОБА
 * (compile-time TS-проверка по типу `ModelRole` это гарантирует).
 */
export const ROLE_REQUIRED_CAPS_INTERNAL: Record<ModelRole, Capability[]> = {
  crystallizer: [],
  vision_meta: ["vision"],
  vision_ocr: ["vision"],
  vision_illustration: ["vision"],
  evaluator: [],
  ukrainian_specialist: [],
  lang_detector: [],
  translator: [],
  layout_assistant: [],
};
