// @ts-check
/**
 * Лейблы и иконки для UI Olympics.
 *
 * Намеренно **русские** атмосферные строки: страница Олимпиады стилизована под
 * древнегреческий нарратив. Если потребуется английская локаль — переписать
 * на ключи `models.olympics.role.*` / `models.olympics.discipline.*`.
 *
 * Извлечено из `models-page.js` (Phase 2.4 cross-platform roadmap, 2026-04-30).
 */

/**
 * Роли для чекбоксов «какие роли тестировать в Олимпиаде».
 * **Должно совпадать с `PIPELINE_ROLES`** (`models-page-internals.js`).
 * MVP v1.0: 4 роли (crystallizer, evaluator, vision_ocr, vision_illustration).
 */
export const ALL_ROLES = [
  { role: "crystallizer",         label: "💎 Кристаллизатор" },
  { role: "evaluator",            label: "📚 Оценщик" },
  { role: "vision_ocr",           label: "🖨️ Vision: OCR страниц" },
  { role: "vision_illustration",  label: "🖼️ Vision: иллюстрации" },
];

/**
 * Литературные названия для ролей (для табов).
 * `judge` и legacy `vision` удалены 2026-05-01 (Иt 8А): нет production-callers.
 */
export const ROLE_HUMAN_LABEL = {
  crystallizer:         { icon: "💎", title: "Кристаллизатор знаний", subtitle: "извлечение фактов и связей" },
  evaluator:            { icon: "📚", title: "Литературный критик", subtitle: "оценка качества книги" },
  vision_ocr:           { icon: "🖨️", title: "Распознаватель текста", subtitle: "OCR сканированных страниц" },
  vision_illustration:  { icon: "🖼️", title: "Иллюстратор",         subtitle: "описание картинок" },
};

/**
 * Литературные названия дисциплин: short — короткий заголовок таба-вкладки;
 * long — полное название для содержимого аккордеона.
 *
 * Стиль: «спортивная номинация древней Греции в современной обработке».
 */
export const DISCIPLINE_HUMAN = {
  /* — Кристаллизатор — */
  "crystallizer-rover":              { short: "Марсоход",          long: "Извлечение фактов о миссии Curiosity" },
  "crystallizer-production-delta":   { short: "Боевая схема",      long: "Извлечение DeltaKnowledge точно по продакшн-схеме (essence + cipher + relations)" },
  "crystallizer-ru-mendeleev":       { short: "Менделеев",         long: "Извлечение знаний из русскоязычного текста (периодический закон)" },

  /* — Оценщик — */
  "evaluator-clrs":                  { short: "CLRS",              long: "Оценка эталона CLRS — должна быть высокой (8-10)" },
  "evaluator-noise":                 { short: "Шум",               long: "Оценка мусорного фрагмента — должна быть низкой (0-2)" },

  /* — Зрение — */
  "vision_ocr-print-simple":         { short: "Строка текста",     long: "Распознавание одной строки чёткого печатного текста" },
  "vision_ocr-print-two-lines":      { short: "Две строки",        long: "Распознавание двух строк печатного текста" },
  "vision_ocr-print-numbers":        { short: "Числа",             long: "Распознавание строки с числами и символами" },
  "vision_ocr-blank-control":        { short: "Пустой контроль",   long: "Контрольная проверка: пустая картинка → NO_TEXT" },
  "vision_illustration-with-context":{ short: "С контекстом",      long: "Описание иллюстрации с привязкой к теме главы (для RAG-индекса)" },
};

export function disciplineHuman(id) {
  return DISCIPLINE_HUMAN[id] || { short: id, long: id };
}

export function roleHuman(role) {
  return ROLE_HUMAN_LABEL[role] || { icon: "🤖", title: role, subtitle: "" };
}

/** Человекочитаемое имя pref-ключа для UI. */
export function prefKeyLabel(k) {
  const MAP = {
    extractorModel:           "Кристаллизатор",
    evaluatorModel:           "Оценщик книг",
    visionModelKey:           "Vision (OCR / иллюстрации)",
  };
  return MAP[k] ?? k;
}

/** Иконка роли для UI. */
export function roleIcon(prefKey) {
  const MAP = {
    extractorModel:           "💎",
    evaluatorModel:           "📚",
    visionModelKey:           "👁️",
  };
  return MAP[prefKey] ?? "🤖";
}

/** Заголовок карточки рекомендации по Olympics-роли.
 *  Используется в `models-page-olympics-report.js` (раньше: `prefKeyLabel(agg.prefKey)`,
 *  что давало 3 одинаковых "Vision (обложки / OCR / иллюстрации)" заголовка).
 *  Решение от 2026-04-30: показывать имя роли (3 разных vision-блока), а
 *  под ним sub-label куда применится. */
export function aggregateRoleTitle(role) {
  return roleHuman(role).title;
}

/** Sub-label "Применится к: <prefKey>" -- объясняет что vision-роли мапятся в одну
 *  pref `visionModelKey` (видеть это нужно в карточках рекомендаций). */
export function aggregateApplyHint(prefKey) {
  if (prefKey === "visionModelKey") {
    return "→ visionModelKey (общая для vision_ocr и vision_illustration)";
  }
  return `→ ${prefKey}`;
}
