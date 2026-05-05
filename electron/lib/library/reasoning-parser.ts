/**
 * Reasoning parser — безопасное извлечение <think> и JSON из ответа LLM.
 *
 * Современные thinking-модели (DeepSeek-R1, QwQ, Qwen3-thinking, GPT-OSS, Claude
 * с extended thinking) пишут CoT в `<think>...</think>`. После закрывающего
 * тега идёт основной ответ. Наш контракт: основной ответ -- строгий JSON без
 * preamble и postscript.
 *
 * Парсер:
 *   1. Извлекает текст между ПЕРВЫМ <think> и ПЕРВЫМ </think>
 *   2. Берёт всё после </think> как payload
 *   3. Если <think> отсутствует -- весь ответ payload
 *   4. В payload ищет первый `{`, парсит сбалансированный JSON-объект
 *   5. Если JSON не валиден -- возвращает null + warning, а не throw
 *
 * Никогда не падает: всегда возвращает структурированный результат с warnings.
 */

export interface ParsedReasoningResponse<T = unknown> {
  /** Содержимое <think> блока (trimmed). null если блок отсутствует. */
  reasoning: string | null;
  /** Распарсенный JSON-объект (с обрезанным CoT). null если JSON битый. */
  json: T | null;
  /** Сырая строка после </think>, использованная для парсинга JSON (для дебага). */
  payload: string;
  /** Накопленные предупреждения (malformed JSON, missing closing tag, и т.п.). */
  warnings: string[];
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Извлекает thinking-блок и payload из сырого ответа модели. */
function splitThinkingBlock(raw: string, warnings: string[]): { reasoning: string | null; payload: string } {
  const openIdx = raw.indexOf(THINK_OPEN);
  if (openIdx === -1) {
    return { reasoning: null, payload: raw };
  }
  const closeIdx = raw.indexOf(THINK_CLOSE, openIdx + THINK_OPEN.length);
  if (closeIdx === -1) {
    /* Незакрытый <think>: считаем что ответ обрезался посередине рассуждений.
       Возвращаем всё как reasoning, payload пустой -- JSON парсер выдаст null. */
    warnings.push("reasoning-parser: unclosed <think> tag (response truncated?)");
    return { reasoning: raw.slice(openIdx + THINK_OPEN.length).trim(), payload: "" };
  }
  const reasoning = raw.slice(openIdx + THINK_OPEN.length, closeIdx).trim();
  const payload = raw.slice(closeIdx + THINK_CLOSE.length).trim();
  return { reasoning: reasoning.length > 0 ? reasoning : null, payload };
}

/**
 * Находит первый сбалансированный JSON-объект `{...}` в строке. Учитывает
 * вложенность фигурных скобок и игнорирует скобки внутри строковых литералов.
 * Возвращает текст объекта или null если не найден.
 *
 * v1.0.10 (2026-05-06): экспортируется для использования в Olympics scorer'ах
 * (electron/lib/llm/arena/disciplines.ts). Раньше был локальным — это
 * привело к появлению дублирующего парсера в арене с наивным regex
 * `^[^{[]*`, который ломался на CoT-prose у думающих моделей (gpt-oss,
 * qwen3.5-35b-a3b, qwen3.6-27b и т.п.) — см. CHANGELOG v1.0.10.
 */
export function findBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * v1.0.10 (2026-05-06): срезает PROSE-style "thinking" префиксы у моделей,
 * которые НЕ используют `<think>` теги, но всё равно пишут CoT в `content`
 * перед финальным JSON. Реальные кейсы из Olympics-логов:
 *
 *   - "Thinking Process: 1. **Analyze the Request:** ..." (gpt-oss-20b)
 *   - "Here's a thinking process: 1. ..." (qwen/qwen3.6-27b)
 *   - "First, I need to extract ..." (qwen3-4b-qwen3.6-plus-reasoning-distilled)
 *   - "Okay, let's see. The user is asking ..." (qwen3-0.6b)
 *   - "Let me analyze this passage ..." (qwen3-4b-qwen3.6)
 *
 * Стратегия: ищем ПОСЛЕДНИЙ сбалансированный `{...}` в строке. Если найден —
 * возвращаем хвост от него. Если префикс — известный prose-маркер CoT, но
 * JSON отсутствует — возвращаем пустую строку (модель не дописала ответ).
 *
 * НЕ путать со `<think>` тегами — те обрабатываются `parseReasoningResponse`.
 * Эта функция дополняет splitThinkingBlock для моделей БЕЗ тегов.
 */
const PROSE_REASONING_PREFIXES = [
  /^thinking process:/i,
  /^here'?s? a? thinking process:/i,
  /^first,?\s+i\s+(need|will|should|have)\s+to/i,
  /^first,?\s+let\s+(me|us|'?s)/i,
  /^okay,?\s+(let'?s|so)/i,
  /^let\s+me\s+(analyze|think|extract|evaluate|consider|look)/i,
  /^let'?s\s+(analyze|think|extract|evaluate|consider|look)/i,
  /^хорошо,?\s+(давайте|мне\s+нужно|нужно)/i,
  /^analysis:/i,
  /^step\s*1[:.]/i,
];

export function stripProseReasoning(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  const trimmed = raw.trim();
  if (!PROSE_REASONING_PREFIXES.some((rx) => rx.test(trimmed))) return raw;
  /* Для prose-CoT модели final JSON всегда в КОНЦЕ ответа. Сканируем все
   * top-level `{` и берём ПОСЛЕДНИЙ, который парсится валидно. */
  return findLastValidJsonObject(trimmed) ?? "";
}

/**
 * Сканирует все позиции `{` в строке (top-level, вне строковых литералов)
 * и возвращает текст ПОСЛЕДНЕГО сбалансированного объекта, который
 * успешно парсится через `JSON.parse`. Если ни один не парсится —
 * возвращает первый сбалансированный (даже если invalid JSON.parse — пусть
 * caller разбирается). null если `{` вообще нет.
 *
 * Используется для CoT-prose сценариев, где модель пишет "пример: {...}"
 * в начале и реальный JSON-ответ в конце.
 */
export function findLastValidJsonObject(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  /* Собираем все top-level позиции `{` (вне строковых литералов). */
  const positions: number[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) positions.push(i);
      depth += 1;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  if (positions.length === 0) return null;
  /* Идём с конца — у prose-CoT финальный JSON в хвосте. */
  let firstBalanced: string | null = null;
  for (let k = positions.length - 1; k >= 0; k--) {
    const candidate = findBalancedJsonObject(text.slice(positions[k]));
    if (!candidate) continue;
    if (firstBalanced === null) firstBalanced = candidate;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* пробуем следующий слева */
    }
  }
  return firstBalanced;
}

/**
 * Главный entry-point: разбирает ответ thinking-LLM на reasoning + JSON.
 *
 * Никогда не выбрасывает исключение -- невалидный ввод даёт `json: null`
 * + warning. Это позволяет пайплайну корректно отметить книгу как `failed`
 * и двинуться дальше, не обрушив очередь.
 */
export function parseReasoningResponse<T = unknown>(raw: string): ParsedReasoningResponse<T> {
  const warnings: string[] = [];
  if (typeof raw !== "string" || raw.length === 0) {
    return { reasoning: null, json: null, payload: "", warnings: ["reasoning-parser: empty input"] };
  }

  const { reasoning, payload } = splitThinkingBlock(raw, warnings);
  const objText = findBalancedJsonObject(payload);
  if (objText === null) {
    warnings.push("reasoning-parser: no balanced JSON object found in payload");
    return { reasoning, json: null, payload, warnings };
  }
  try {
    const json = JSON.parse(objText) as T;
    return { reasoning, json, payload, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`reasoning-parser: JSON.parse failed: ${msg}`);
    return { reasoning, json: null, payload, warnings };
  }
}
