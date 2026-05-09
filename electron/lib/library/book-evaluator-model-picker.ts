/**
 * Authority-выбор модели для Book Evaluator.
 *
 * Скорит модели по тегам curated-models.json + эвристикам имени/размера и
 * выбирает наилучшую среди loaded (или подгружает, если разрешено).
 *
 * Извлечено из `book-evaluator.ts` (Phase 2.3 cross-platform roadmap, 2026-04-30).
 * Декомпозиция: schema → book-evaluator-schema.ts; вызов LLM → book-evaluator.ts;
 * выбор модели → этот файл.
 */

import { listLoaded, listDownloaded, loadModel } from "../../lmstudio-client.js";
import { getModelProfile } from "../dataset-v2/model-profile.js";
import { getModelPool, type ModelPool } from "../llm/model-pool.js";

/* Маркеры thinking-семейств в modelKey -- fallback когда модель НЕ в curated-models.json.
   Qwen3.x/3.5+/3.6+ серии все умеют CoT через `<think>` блоки. */
const THINKING_NAME_MARKERS = ["thinking", "reasoning", "deepseek-r1", "qwq", "r1-distill", "gpt-oss"];
const THINKING_FAMILIES = ["qwen3.5", "qwen3.6", "qwen3.7", "magistral", "glm-4.7", "glm-4.6"];

function isThinkingByName(key: string): boolean {
  const lc = key.toLowerCase();
  if (THINKING_NAME_MARKERS.some((m) => lc.includes(m))) return true;
  return THINKING_FAMILIES.some((m) => lc.includes(m));
}

/* Парсит "35B" / "30B-A3B" / "4B" / "0.6B" в число параметров (миллиарды).
   Для MoE формата `30B-A3B` берёт ПЕРВОЕ число (total params), не active --
   общая ёмкость знаний важнее для эпистемолога, чем активные параметры. */
function parseParamsBillion(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  return m ? parseFloat(m[1]) : 0;
}

function isEmbedder(arch: string | undefined, key: string): boolean {
  const a = (arch ?? "").toLowerCase();
  const k = key.toLowerCase();
  return a.includes("bert") || a.includes("clip") || k.includes("embed") || k.includes("nomic-embed");
}

interface ScoredModel {
  modelKey: string;
  score: number;
  isLoaded: boolean;
  sizeBytes: number;
  reasons: string[];
}

/**
 * Скорит модель по тегам curated-models.json + эвристикам имени/размера.
 *
 * Шкала (выше = лучше для эпистемолога):
 *   flagship          → 1000  (Qwen3.6-35b: проверенный топ)
 *   thinking-heavy    →  500  (нужна CoT для оценки качества)
 *   thinking-light    →  300
 *   tool-capable-coder→  150  (отлично для structured JSON, но менее эрудит)
 *   non-thinking-instruct →  100
 *   small-fast        → -200  (4b -- слишком слабо для эпистемологии)
 *   embedder          → -∞    (отсеиваем)
 *
 * Бонусы:
 *   уже в VRAM        →   +30 (instant)
 *   thinking по имени →   +80 (qwen3.5+ серии без явного тега)
 *   params (B)        →   +N  (35b → +35, 4b → +4) -- linear bias к большим
 *
 * Penalty:
 *   coder-only        →  -50  (специализация мешает общей эрудиции)
 */
async function scoreModel(
  modelKey: string,
  loadedKeys: Set<string>,
  sizeBytes: number,
): Promise<ScoredModel> {
  const reasons: string[] = [];
  let score = 0;

  const profile = await getModelProfile(modelKey);
  const tags = new Set(profile.tags);

  if (tags.has("flagship"))               { score += 1000; reasons.push("flagship+1000"); }
  if (tags.has("thinking-heavy"))         { score +=  500; reasons.push("thinking-heavy+500"); }
  if (tags.has("thinking-light"))         { score +=  300; reasons.push("thinking-light+300"); }
  if (tags.has("tool-capable-coder"))     { score +=  150; reasons.push("tool-capable-coder+150"); }
  if (tags.has("non-thinking-instruct") && score === 0) {
    score += 100; reasons.push("non-thinking-instruct+100");
  }
  if (tags.has("small-fast"))             { score -=  200; reasons.push("small-fast-200"); }
  if (tags.has("code") && !tags.has("flagship") && !tags.has("thinking-heavy")) {
    score -= 50; reasons.push("coder-only-50");
  }

  /* Если модель НЕ в curated -- инфер по имени. */
  if (profile.source === "default-fallback") {
    if (isThinkingByName(modelKey)) { score += 80; reasons.push("thinking-by-name+80"); }
    else                            { score += 20; reasons.push("unknown-llm+20"); }
  }

  /* Linear bias по размеру: 35b → +35, 4b → +4. */
  const paramsB = parseParamsBillion(modelKey);
  if (paramsB > 0) { score += paramsB; reasons.push(`+${paramsB}b-params`); }

  /* Уже в VRAM -- маленький бонус, чтобы при равных предпочесть instant. */
  if (loadedKeys.has(modelKey)) { score += 30; reasons.push("loaded+30"); }

  return { modelKey, score, isLoaded: loadedKeys.has(modelKey), sizeBytes, reasons };
}

/**
 * Опции выбора модели для evaluator.
 *
 * `preferred` и `fallbacks` приходят из preferences (Settings → Models →
 * Evaluator + CSV fallbacks). Когда юзер выбрал конкретную модель, мы ОБЯЗАНЫ
 * её использовать, не подменяя на «самую мощную» по эвристическому скорингу.
 *
 * `allowAutoLoad` управляет агрессивной догрузкой моделей с диска. По
 * умолчанию ВЫКЛЮЧЕНА: загрузка второй большой LLM (gpuOffload=max) поверх
 * уже занятой VRAM в момент импорта тысячи файлов уже однажды повесила
 * Windows. Включается явно только в e2e-сценариях, где free VRAM проверена.
 */
export interface PickEvaluatorModelOptions {
  /** Явно выбранная пользователем модель (preferences.evaluatorModel). */
  preferred?: string;
  /** CSV-fallbacks (preferences.evaluatorModelFallbacks, уже распарсенный). */
  fallbacks?: string[];
  /**
   * Разрешить вызов `loadModel(...)` если ни один кандидат не загружен.
   * Default: false. Опасно при импорте — может вытолкнуть текущую модель
   * из VRAM или вызвать swap-thrashing вплоть до freeze ОС.
   */
  allowAutoLoad?: boolean;
  /**
   * Разрешить smart-fallback: если preferred + CSV fallbacks не подходят,
   * выбрать топ из УЖЕ ЗАГРУЖЕННЫХ LLM по скорингу. Default: true.
   *
   * Off для строгого режима (юзер выбрал конкретную модель — никаких
   * подмен «втихую»). При off возвращается null если preferred не loaded.
   */
  allowAnyLoadedFallback?: boolean;
  /** DI hook для тестов — подменить `listLoaded()`. */
  listLoadedImpl?: typeof listLoaded;
  /** DI hook для тестов — подменить `listDownloaded()`. */
  listDownloadedImpl?: typeof listDownloaded;
  /**
   * DI hook для тестов — подменить `loadModel()`. Если передан явно — используется
   * **вместо** ModelPool (старое поведение, для backward compat существующих тестов).
   * В проде `loadModelImpl` undefined, и evaluator идёт через `pool.acquire()`,
   * который учитывает VRAM capacity и делит модель между потребителями.
   */
  loadModelImpl?: typeof loadModel;
  /** DI hook для тестов — подменить ModelPool. Дефолт — `getModelPool()` singleton. */
  pool?: ModelPool;
}

/**
 * Выбор модели для эвалюации книги.
 *
 * Порядок приоритетов:
 *   1. `opts.preferred` (если в loaded) — выбор пользователя сильнее любой эвристики.
 *   2. Любая модель из `opts.fallbacks` (если в loaded).
 *   3. Скоринг loaded-моделей (curated tags + heuristics) — топ-1.
 *   4. Только если `allowAutoLoad === true`: скоринг loaded ∪ downloaded
 *      и `loadModel` топа (старое поведение). По умолчанию выключено.
 *
 * Контракт: никогда не throw — при любой ошибке возвращает `null`, чтобы
 * evaluator-queue корректно пометил книгу как «no LLM».
 */
export async function pickEvaluatorModel(
  opts: PickEvaluatorModelOptions = {},
): Promise<string | null> {
  try {
    return await pickEvaluatorModelUnsafe(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[book-evaluator] pickEvaluatorModel:", msg);
    return null;
  }
}

async function pickEvaluatorModelUnsafe(
  opts: PickEvaluatorModelOptions,
): Promise<string | null> {
  const allowAutoLoad = opts.allowAutoLoad === true;
  const listLoadedFn = opts.listLoadedImpl ?? listLoaded;
  const listDownloadedFn = opts.listDownloadedImpl ?? listDownloaded;
  /* loadModelFn ВСЕГДА должна быть вызываемой (для обратной совместимости тестов).
     Если caller передал loadModelImpl явно — используем его (legacy DI hook).
     Иначе — proxy через ModelPool: pool.acquire() c немедленным release(),
     потому что book-evaluator не удерживает модель эксклюзивно — caller ходит
     к chat сразу после pick. Pool всё равно учтёт modelKey как loaded
     с refCount=0 и не выгрузит, пока новый acquire с capacity-overflow
     не попросит место. */
  const loadModelFn: typeof loadModel = opts.loadModelImpl ?? (
    async (key, loadOpts) => {
      const pool = opts.pool ?? getModelPool();
      const handle = await pool.acquire(key, {
        ttlSec: loadOpts?.ttlSec,
        gpuOffload: loadOpts?.gpuOffload,
        contextLength: loadOpts?.contextLength,
        role: "evaluator",
      });
      handle.release();
      return { modelKey: handle.modelKey, identifier: handle.identifier };
    }
  );

  const loaded = await listLoadedFn();
  const loadedKeys = new Set(loaded.map((m) => m.modelKey));

  /* 1. Явно выбранная пользователем модель. */
  const preferred = opts.preferred?.trim();
  if (preferred && loadedKeys.has(preferred)) {
    return preferred;
  }

  /* 2. CSV fallbacks. Берём первый, который реально в loaded. */
  for (const candidate of opts.fallbacks ?? []) {
    const trimmed = candidate.trim();
    if (trimmed && loadedKeys.has(trimmed)) {
      return trimmed;
    }
  }

  /* 2.5 Smart-fallback gate: если юзер выбрал конкретную модель, но она не
     загружена, И опция allowAnyLoadedFallback=false — НЕ подменяем втихую.
     Возвращаем null чтобы caller пометил книгу с понятным warning'ом. */
  const allowAnyLoadedFallback = opts.allowAnyLoadedFallback !== false;
  if (preferred && !allowAnyLoadedFallback && !allowAutoLoad) {
    return null;
  }

  /* 2.6 Preferred задан + allowAutoLoad=true: ПЫТАЕМСЯ ЗАГРУЗИТЬ ИМЕННО
     preferred через model-pool. Юзерский выбор > эвристика скоринга.
     Без этой ветки: если в VRAM уже сидит ДРУГАЯ модель (например, более
     "жирная" qwen3.6-27b с тегом flagship), скоринг ниже подменяет
     preferred на этот загруженный топ — пользователь выбирал gpt-oss-20b
     в Settings, а evaluator незаметно использует qwen3.6-27b.

     При неудаче загрузки (нет на диске, OOM, отказ pool) — падаем
     в скоринг как last-resort fallback. */
  if (preferred && allowAutoLoad) {
    try {
      const handle = await loadModelFn(preferred, { ttlSec: 900, gpuOffload: "max" });
      return handle.modelKey;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[book-evaluator] failed to load preferred "${preferred}": ${msg} — falling through to scoring`);
    }
  }

  /* Дальше — авто-выбор. Ограничиваемся только loaded моделями, если
     allowAutoLoad=false: НИКАКОЙ незаметной догрузки чужих моделей. */
  const downloaded = allowAutoLoad ? await listDownloadedFn() : [];

  const candidates = new Map<string, { sizeBytes: number; arch?: string }>();
  for (const m of loaded) candidates.set(m.modelKey, { sizeBytes: 0 });
  for (const m of downloaded) {
    const prev = candidates.get(m.modelKey);
    candidates.set(m.modelKey, { sizeBytes: m.sizeBytes ?? prev?.sizeBytes ?? 0, arch: m.architecture });
  }

  const llmKeys = [...candidates.entries()]
    .filter(([key, info]) => !isEmbedder(info.arch, key))
    .map(([key, info]) => ({ key, sizeBytes: info.sizeBytes }));

  if (llmKeys.length === 0) return null;

  const scored = await Promise.all(
    llmKeys.map((c) => scoreModel(c.key, loadedKeys, c.sizeBytes)),
  );
  scored.sort((a, b) => b.score - a.score || b.sizeBytes - a.sizeBytes);

  const top = scored[0];
  if (!top) return null;

  if (top.isLoaded) return top.modelKey;

  /* Не загружено и auto-load запрещён — отказ. Лучше пустой результат и
     явный warning «no evaluator model loaded», чем скрытая догрузка
     35b-модели поверх уже занятой VRAM. */
  if (!allowAutoLoad) return null;

  /* Старое поведение для e2e: WS-загрузка топа с TTL 15 мин, gpuOffload=max. */
  try {
    const handle = await loadModelFn(top.modelKey, { ttlSec: 900, gpuOffload: "max" });
    return handle.modelKey;
  } catch {
    for (const alt of scored.slice(1, 4)) {
      if (alt.isLoaded) return alt.modelKey;
      try {
        const handle = await loadModelFn(alt.modelKey, { ttlSec: 900, gpuOffload: "max" });
        return handle.modelKey;
      } catch { /* try next */ }
    }
    return null;
  }
}
