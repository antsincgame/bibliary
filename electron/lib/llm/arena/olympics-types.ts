/**
 * Типы и интерфейсы Олимпиады моделей.
 *
 * Извлечено из `olympics.ts` (Phase 2.2 cross-platform roadmap, 2026-04-30)
 * для уменьшения god-файла. Поведение не меняется: типы выкладываются через
 * barrel `olympics.ts` для backward-compat.
 */

/**
 * Весовые категории моделей. Оценка по числовому маркеру в имени
 * («3b» / «9b» / «27b» / …). Если маркера нет — модель попадает в `unknown`.
 *
 *   XS  ≤ 1B      —  тестовые крошки (qwen3-0.6b)
 *   S   1-5B      —  бытовые роли (extractor / translator / lang-detect)
 *   M   5-12B     —  стандарт качества (evaluator / code-summary)
 *   L   12-30B    —  тяжёлая генерация / vision-meta
 *   XL  30B+      —  full-power (только когда железо позволяет)
 */
export type WeightClass = "xs" | "s" | "m" | "l" | "xl" | "unknown";

/**
 * Все роли пайплайна Bibliary, для которых есть смысл калибровать модель.
 * Список синхронизирован с PIPELINE_ROLES в renderer/models/models-page.js
 * и pref-ключами в preferences-store.
 */
export type OlympicsRole =
  | "crystallizer"
  | "evaluator"
  | "translator"
  | "lang_detector"
  | "ukrainian_specialist"
  /** @deprecated — used only by `vision-describe-shapes`; новые роли: vision_meta / vision_ocr / vision_illustration */
  | "vision"
  | "vision_meta"
  | "vision_ocr"
  | "vision_illustration"
  | "layout_assistant";

export interface OlympicsOptions {
  /** Адрес LM Studio. По умолчанию http://localhost:1234. */
  lmsUrl?: string;
  /** Явный список моделей. Если не задан — авто-выбор лёгких моделей. */
  models?: string[];
  /** Идентификаторы дисциплин для прогона. По умолчанию — все. */
  disciplines?: string[];
  /** Максимум моделей при авто-выборе. Default 6. */
  maxModels?: number;
  /** Таймаут на одну дисциплину для одной модели. Default 90 сек. */
  perDisciplineTimeoutMs?: number;
  /**
   * Фильтр по весовой категории. По умолчанию `["s","m"]` — стандарт
   * качества для большинства ролей. Передай `["s","m","l"]` если железо
   * позволяет (16GB+ VRAM).
   */
  weightClasses?: WeightClass[];
  /** Тестировать ВСЕ доступные модели (игнорирует weightClasses + maxModels). */
  testAll?: boolean;
  /** Фильтр по ролям — запускать только дисциплины этих ролей. Пустой = все. */
  roles?: OlympicsRole[];
  /**
   * Если true — каждая модель грузится с per-role load config
   * (см. role-load-config.ts) и tested with per-role inference defaults
   * (temperature/topP). False = legacy (2048 ctx, FA=true, temp=0.2/0.6).
   *
   * Backward-compat: дефолт false. Включается prefs.olympicsRoleLoadConfigEnabled
   * через arena.ipc.ts.
   */
  roleLoadConfigEnabled?: boolean;
  /**
   * Если true — load/unload идут через TypeScript SDK (`@lmstudio/sdk`),
   * что позволяет передать gpu.ratio/keepModelInMemory/tryMmap/flashAttention.
   * При любой ошибке SDK runtime откатывается на REST с предупреждением.
   * Default false — REST путь (стабильнее, mock-able в тестах).
   *
   * Имеет смысл включать вместе с roleLoadConfigEnabled, иначе SDK получит
   * только дефолтный {ctx=2048, FA=true} — преимущества над REST не будет.
   */
  useLmsSDK?: boolean;
  /** Прогресс-каллбэк. */
  onProgress?: (e: OlympicsEvent) => void;
  /** Abort. */
  signal?: AbortSignal;
}

export type OlympicsEvent =
  | { type: "olympics.start"; models: string[]; disciplines: string[] }
  | {
      type: "olympics.discipline.start";
      discipline: string;
      role: string;
      /** Описание для technical log (whyImportant из disciplines.ts). */
      whyImportant?: string;
      /** thinkingFriendly флаг: позволяет UI показать «🧠 thinking-friendly». */
      thinkingFriendly?: boolean;
      /** Базовый бюджет токенов: помогает технарю оценить стоимость. */
      maxTokens?: number;
    }
  | {
      type: "olympics.model.done";
      discipline: string;
      role?: string;
      model: string;
      score: number;
      durationMs: number;
      /** Полные метрики токенизации (для научно-технического лога). */
      tokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      /** Сэмпл ответа (первые 240 символов) — для отладки на лету. */
      sample?: string;
      ok: boolean;
      error?: string;
    }
  | { type: "olympics.discipline.done"; discipline: string; champion: string | null }
  | { type: "olympics.done"; durationMs: number }
  | { type: "olympics.log"; level: string; message: string; ctx?: Record<string, unknown> }
  | { type: "olympics.model.loading"; model: string }
  | { type: "olympics.model.loaded"; model: string; loadTimeMs: number }
  | { type: "olympics.model.unloaded"; model: string }
  | { type: "olympics.model.load_failed"; model: string; reason: string }
  | { type: "olympics.vram_guard"; action: string; estimatedGB: number; limitGB: number };

export interface OlympicsModelResult {
  model: string;
  weightClass: WeightClass;
  score: number;
  durationMs: number;
  ok: boolean;
  tokens: number;
  sample: string;
  error?: string;
  /** Pareto-метрика: score за единицу времени. score=1 за 5s → efficiency=200. */
  efficiency: number;
}

export interface OlympicsMatchResult {
  discipline: string;
  modelA: string;
  modelB: string;
  scoreA: number;
  scoreB: number;
  winner: string | null;
  draw: boolean;
}

export interface OlympicsDisciplineResult {
  discipline: string;
  role: OlympicsRole;
  description: string;
  perModel: OlympicsModelResult[];
  matches: OlympicsMatchResult[];
  /** Кто набрал больше всего score. */
  champion: string | null;
  /**
   * ОПТИМАЛЬНАЯ модель = best efficiency среди тех, кто набрал не менее 70%
   * от score чемпиона. Это «не сильнейшая, а та, что нужна на практике».
   */
  optimum: string | null;
  /**
   * Дисциплина оптимизирована для thinking-моделей (efficiency не штрафует за время).
   * Используется UI для отображения thinking-friendly бейджа.
   */
  thinkingFriendly?: boolean;
}

/**
 * Агрегат для одной РОЛИ по нескольким её дисциплинам — основа выбора модели.
 * Для каждой модели усредняются результаты по всем дисциплинам этой роли.
 */
export interface OlympicsRoleAggregate {
  role: OlympicsRole;
  prefKey: string;
  disciplines: string[];
  /** Усреднённые показатели каждой модели по всем дисциплинам этой роли. */
  perModel: Array<{
    model: string;
    avgScore: number;        // 0..1
    minScore: number;        // 0..1 — худшее из дисциплин (показывает стабильность)
    avgDurationMs: number;
    avgEfficiency: number;
    coverage: number;        // 0..1 — доля дисциплин где score > 0.3
    okCount: number;
    totalCount: number;
  }>;
  /** Лучшая по avgScore (стабильное качество во всех дисциплинах). */
  champion: string | null;
  /** Лучшая по efficiency среди acceptable (avgScore ≥ 70% от champion). */
  optimum: string | null;
  /** Текстовое объяснение почему именно эта модель — для UI. */
  championReason: string | null;
  optimumReason: string | null;
}

/**
 * @deprecated Iter 14.2 (2026-05-04): «Медальный зачёт» удалён из UI и из
 * `OlympicsReport.medals` тоже удалено. Тип оставлен на один релиз для
 * обратной совместимости — старые сохранённые отчёты могут содержать поле
 * `medals`. Не используется новой логикой; будет полностью удалён в 0.12.
 */
export interface OlympicsMedalRow {
  model: string;
  gold: number;
  silver: number;
  bronze: number;
  totalScore: number;
  totalDurationMs: number;
}

/**
 * Причина выбора модели для роли — показывается в UI рядом с рекомендацией.
 * Содержит человекочитаемое объяснение откуда взялся оптимум/чемпион.
 */
export interface OlympicsRoleReason {
  /** pref-key роли (extractorModel / evaluatorModel / visionModelKey / ...) */
  prefKey: string;
  /** Лучшая дисциплина, где выбрана optimum-модель */
  optimumDiscipline?: string;
  /** Модель-оптимум и краткое объяснение (score, efficiency) */
  optimumModel?: string;
  optimumReason?: string;
  /** Лучшая дисциплина, где выбран champion */
  championDiscipline?: string;
  optimumScore?: number;
  championModel?: string;
  championScore?: number;
  championReason?: string;
}

/** Per-model capability snapshot from LM Studio v1 API — shown in UI. */
export interface OlympicsModelCapabilities {
  vision: boolean;
  reasoning: boolean;
  toolUse: boolean;
  architecture: string;
  paramsString: string | null;
  sizeBytes: number;
  maxContextLength: number;
  format: string;
  loaded: boolean;
}

export interface OlympicsReport {
  generatedAt: string;
  lmsUrl: string;
  models: string[];
  /** Карта model → весовая категория (для UI и анализа). */
  modelWeightClass: Record<string, WeightClass>;
  /** Rich model capabilities from LM Studio v1 API — for UI display. */
  modelCapabilities: Record<string, OlympicsModelCapabilities>;
  disciplines: OlympicsDisciplineResult[];
  /**
   * Агрегаты по ролям — основа рекомендаций. Каждая роль здесь
   * собирает все свои дисциплины и усредняет per-model результаты.
   */
  roleAggregates: OlympicsRoleAggregate[];
  /**
   * @deprecated Iter 14.2 (2026-05-04): «Медальный зачёт» удалён.
   * Поле больше не заполняется; оставлено optional для обратной совместимости
   * со старыми сохранёнными `olympics-report.json`.
   */
  medals?: OlympicsMedalRow[];
  /**
   * Bradley-Terry MLE scores (am-ELO, ICML 2025) — latent quality
   * estimated from pairwise match outcomes. More stable than raw averages.
   * Values normalized to [0, 1].
   */
  btScores: Record<string, number>;
  /**
   * Авто-рекомендации: ключ — pref-name (extractorModel/evaluatorModel/visionModelKey/...),
   * значение — modelKey. По умолчанию это OPTIMUM, а не CHAMPION.
   */
  recommendations: Record<string, string>;
  /** Pure-CHAMPION-рекомендации (победившие по score любой ценой). */
  recommendationsByScore: Record<string, string>;
  /** Причины выбора для каждой роли — объяснение в UI. */
  roleReasons: OlympicsRoleReason[];
  /**
   * Иt 8Д.2 (transparent recommendation): информация про vision-агрегацию.
   * Все 3 vision-роли (vision_meta/vision_ocr/vision_illustration) маппятся
   * в один visionModelKey. Это поле объясняет в UI почему именно эта модель
   * стала рекомендацией — чтобы пользователь не путался видя 3 разные
   * per-role optimum в карточках но один visionModelKey в Settings.
   * null если vision-роли не участвовали в Olympics.
   */
  visionAggregateInfo?: {
    modelKey: string;
    reason: string;
    strategy: "best_avg" | "fallback_last_write";
  } | null;
  /**
   * Предупреждения: мало моделей, нет чемпиона и т.д.
   * Показываются в UI под кнопкой и в результатах.
   */
  warnings: string[];
  /** Сколько моделей доступно в LM Studio до фильтрации (для UX «скачай больше»). */
  availableModelCount: number;
  /** Сколько дисциплин запущено (для UI и i18n-сабтайтла). */
  disciplineCount: number;
  totalDurationMs: number;
  /** EcoTune-style auto-tune suggestions per role (see olympics-auto-tune.ts). */
  autoTuneSuggestions?: Array<{
    role: string;
    prefKey: string;
    suggestedTemperature: number;
    suggestedMaxTokens: number;
    suggestedTopP: number;
    confidence: "high" | "medium" | "low";
    rationale: string;
  }>;
  /** Probe phase stats (only if Lightning mode with probe). */
  probeStats?: {
    totalProbed: number;
    eliminated: number;
    cutoff: number;
    scores: Record<string, number>;
  };
  /** Adaptive elimination stats. */
  adaptiveElimination?: {
    skippedDisciplines: number;
  };
}
