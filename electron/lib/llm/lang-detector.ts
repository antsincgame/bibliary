/**
 * Lang Detector — гибридный детектор языка.
 *
 * Зачем гибридный: Олимпиада показала, что **все LLM (3-9B)** путают
 * украинский с русским — отвечают "ru" даже на чисто украинский текст
 * с символами «і ї є ґ». Для этой роли LLM ненадёжна.
 *
 * Поэтому detectLanguage идёт по двум этапам:
 *   1. Regex-эвристика по уникальным символам:
 *      - украинский: содержит «і ї є ґ»  (2+ вхождения)
 *      - русский:    содержит «ё ы ъ э», но НЕТ «і ї є ґ»
 *      - английский: ≥80% ASCII letters в семпле
 *      - немецкий:   содержит «ä ö ü ß» (3+)
 *   2. LLM fallback (через withModelFallback с ролью lang_detector) —
 *      только для нераспознанных regex'ом случаев.
 *
 * Это обходит главный баг LLM на этой роли при минимальной затрате токенов.
 *
 * Детект работает на семпле ≤2KB начала текста.
 */

export type DetectedLang = "ru" | "uk" | "en" | "de" | "fr" | "es" | "unknown";

export interface DetectResult {
  lang: DetectedLang;
  confidence: number;          /* 0..1 */
  source: "regex" | "llm" | "default";
  details?: string;
}

const SAMPLE_LIMIT = 2048;

/**
 * Чисто-regex детект. Если уверенность ≥0.8 — возвращаем сразу, без LLM.
 * Если ниже — caller может сделать LLM-fallback.
 */
export function detectLanguageByRegex(text: string): DetectResult {
  const sample = text.slice(0, SAMPLE_LIMIT);
  if (sample.trim().length < 4) {
    return { lang: "unknown", confidence: 0, source: "regex", details: "text too short" };
  }

  const lower = sample.toLowerCase();

  /* ─── Украинский: уникальные литеры і ї є ґ ─── */
  const ukUnique = (lower.match(/[іїєґ]/g) ?? []).length;
  /* ─── Русский: уникальные литеры ё ы ъ э ─── */
  const ruUnique = (lower.match(/[ёыъэ]/g) ?? []).length;
  /* ─── Cyrillic общая база ─── */
  const cyrillicTotal = (lower.match(/[\u0400-\u04ff]/g) ?? []).length;
  /* ─── Латинские буквы ─── */
  const latinTotal = (lower.match(/[a-z]/g) ?? []).length;
  /* ─── Немецкие умляуты ─── */
  const deUnique = (lower.match(/[äöüß]/g) ?? []).length;
  /* ─── Французские диакритики ─── */
  const frUnique = (lower.match(/[àâçéèêëîïôûùüÿœæ]/g) ?? []).length;
  /* ─── Испанские диакритики ─── */
  const esUnique = (lower.match(/[áéíóúñ¿¡]/g) ?? []).length;

  /* === Украинский: чёткий маркер === */
  if (ukUnique >= 2 && cyrillicTotal > 20) {
    /* Чем больше уникальных и больше cyrillic — тем выше confidence. */
    const conf = Math.min(0.95, 0.7 + ukUnique / 50 + cyrillicTotal / 5000);
    return {
      lang: "uk",
      confidence: conf,
      source: "regex",
      details: `uk-unique=${ukUnique}, cyrillic=${cyrillicTotal}`,
    };
  }

  /* === Русский: cyrillic + ё/ы/ъ + НЕТ ukUnique === */
  if (ruUnique >= 2 && cyrillicTotal > 20 && ukUnique === 0) {
    const conf = Math.min(0.95, 0.7 + ruUnique / 50 + cyrillicTotal / 5000);
    return {
      lang: "ru",
      confidence: conf,
      source: "regex",
      details: `ru-unique=${ruUnique}, cyrillic=${cyrillicTotal}`,
    };
  }

  /* === Русский: cyrillic, нет украинских уникальных, нет специфики ===
       Менее уверенный путь — но если кириллицы много и нет «і ї є ґ»,
       это, скорее всего, русский. */
  if (cyrillicTotal > 50 && ukUnique === 0) {
    return {
      lang: "ru",
      confidence: 0.75,
      source: "regex",
      details: `cyrillic=${cyrillicTotal}, no-uk-marks`,
    };
  }

  /* === Немецкий === */
  if (deUnique >= 3 && latinTotal > 20) {
    return { lang: "de", confidence: 0.85, source: "regex", details: `de-unique=${deUnique}` };
  }

  /* === Французский === */
  if (frUnique >= 3 && latinTotal > 20) {
    return { lang: "fr", confidence: 0.85, source: "regex", details: `fr-unique=${frUnique}` };
  }

  /* === Испанский === */
  if (esUnique >= 2 && latinTotal > 20) {
    return { lang: "es", confidence: 0.8, source: "regex", details: `es-unique=${esUnique}` };
  }

  /* === Английский: ≥80% ASCII letter среди letter-chars === */
  if (latinTotal > 50) {
    const ratio = latinTotal / Math.max(1, latinTotal + cyrillicTotal);
    if (ratio >= 0.95) {
      return { lang: "en", confidence: 0.9, source: "regex", details: `latin-ratio=${ratio.toFixed(2)}` };
    }
    if (ratio >= 0.8) {
      return { lang: "en", confidence: 0.7, source: "regex", details: `latin-ratio=${ratio.toFixed(2)}` };
    }
  }

  return { lang: "unknown", confidence: 0, source: "regex", details: "no clear markers" };
}

/**
 * Public API: принимает текст, делает regex-детект; если уверенность <0.8
 * и задан LLM-callback, передаёт ему семпл для finalize.
 *
 * Дизайн: не дёргаем LLM по умолчанию (поскольку на этой роли он плохо
 * работает). Если caller настойчив — пусть делает withModelFallback в роли
 * lang_detector и склеивает.
 */
export async function detectLanguage(
  text: string,
  llmCb?: (sample: string) => Promise<DetectedLang | null>,
): Promise<DetectResult> {
  const r = detectLanguageByRegex(text);
  if (r.confidence >= 0.8) return r;

  if (llmCb) {
    try {
      const llmAnswer = await llmCb(text.slice(0, SAMPLE_LIMIT));
      if (llmAnswer && llmAnswer !== "unknown") {
        return {
          lang: llmAnswer,
          confidence: 0.6, /* LLM на этой роли — слабая, доверие умеренное */
          source: "llm",
          details: `regex-confidence=${r.confidence}, llm-vote=${llmAnswer}`,
        };
      }
    } catch {
      /* LLM упал — оставляем regex-результат */
    }
  }
  return r;
}
