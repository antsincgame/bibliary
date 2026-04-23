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
 */
function findBalancedJsonObject(text: string): string | null {
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
