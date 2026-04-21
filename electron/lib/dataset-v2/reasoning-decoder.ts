/**
 * Reasoning Decoder — спасает JSON, который попал в `reasoning_content` поле
 * thinking-моделей вместо `content`.
 *
 * Корневая причина:
 *   LM Studio bug-tracker #1773 / #1698 / #1602: при `response_format=json_schema`
 *   с Qwen3.x reasoning-моделями JSON-Schema constraint применяется к thinking-стриму,
 *   а финальный `content` остаётся пустым. JSON генерируется корректно — он просто
 *   "застревает" в `reasoning_content`.
 *
 * Стратегия:
 *   1. Снять markdown fences (```json ... ```), часто оборачивающие thinking-вывод.
 *   2. Посимвольно (БЕЗ regex с риском catastrophic backtracking) найти все
 *      сбалансированные top-level массивы `[...]` в тексте.
 *   3. Попытаться JSON.parse каждого кандидата от ПОСЛЕДНЕГО к первому
 *      (последний — финальный ответ модели после всех раздумий).
 *   4. Вернуть первый успешно распарсенный — как строку JSON (готовую к
 *      повторному JSON.parse в caller'е).
 *
 * Безопасность: поиск работает за O(n) от длины reasoning, без backtracking.
 * Учитывает строки в кавычках и escape-последовательности — `[` внутри
 * `"hello [world]"` не считается за начало массива.
 */

/**
 * Снимает обрамляющие markdown code fences типа:
 *   ```json
 *   [...]
 *   ```
 * Может быть несколько fence-блоков подряд (модель часто пишет
 * "вот мои размышления, а вот JSON: ```json [...] ```").
 *
 * Возвращает строку без fences. Не валидирует JSON.
 */
function stripMarkdownFences(input: string): string {
  /* Убираем только сами маркеры ```...``` (вместе с языковым тегом),
     оставляя содержимое. Это безопасный посимвольный режим. */
  let result = input;
  /* Простая итеративная замена: ищем "```", если за ним идёт alpha-токен (json/javascript/...) — съедаем до конца строки. */
  let idx = 0;
  const out: string[] = [];
  while (idx < result.length) {
    const fenceStart = result.indexOf("```", idx);
    if (fenceStart === -1) {
      out.push(result.slice(idx));
      break;
    }
    out.push(result.slice(idx, fenceStart));
    /* Найдём конец маркера: либо до newline (если это language tag), либо просто +3. */
    const afterFence = fenceStart + 3;
    const newlineAfter = result.indexOf("\n", afterFence);
    const looksLikeLangTag =
      newlineAfter !== -1 && /^[a-zA-Z0-9]*$/.test(result.slice(afterFence, newlineAfter).trim());
    idx = looksLikeLangTag ? newlineAfter + 1 : afterFence;
  }
  result = out.join("");
  return result;
}

/**
 * Сканирует строку посимвольно, возвращая позиции всех top-level
 * сбалансированных подстрок, обрамлённых заданными символами (`[`/`]` или `{`/`}`).
 *
 * Учитывает:
 *   - двойные кавычки и escape `\"`
 *   - вложенные скобки (counting depth)
 *   - открывающую без пары — игнорируется
 *
 * Сложность O(n), без backtracking.
 */
function findBalanced(input: string, open: string, close: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch !== open) {
      i++;
      continue;
    }
    /* Найден потенциальный старт. Сканируем до сбалансированной закрывающей. */
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let j = i; j < n; j++) {
      const c = input[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (c === "\\") {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          found.push({ start, end: j });
          i = j + 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      /* Незакрытая открывающая — пропускаем и продолжаем дальше с i+1.
         Не пытаемся восстановить — это даст false-positive. */
      i = start + 1;
    }
  }
  return found;
}

/**
 * Общий декодер: находит все сбалансированные блоки, заданные парой символов,
 * и возвращает строку ПОСЛЕДНЕГО валидного JSON (готовую к JSON.parse).
 */
function extractLastBalancedJson(
  reasoning: string | null | undefined,
  open: string,
  close: string,
): string | null {
  if (!reasoning || typeof reasoning !== "string") return null;
  const trimmed = reasoning.trim();
  if (trimmed.length === 0) return null;

  const cleaned = stripMarkdownFences(trimmed);
  const candidates = findBalanced(cleaned, open, close);
  if (candidates.length === 0) return null;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const slice = cleaned.slice(candidates[i].start, candidates[i].end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* Невалидный — пробуем предыдущий кандидат. */
    }
  }
  return null;
}

/**
 * Извлекает строку JSON-МАССИВА из reasoning-текста (для extractor: список концептов).
 *
 * @param reasoning — содержимое поля `reasoning_content` от LM Studio.
 *                   Может быть пустой строкой, undefined-like или содержать
 *                   произвольный thinking-prose с встроенными JSON-фрагментами.
 * @returns строку JSON (готовую для JSON.parse) или null если не нашлось
 *          ни одного валидного массива.
 *
 * Поведение:
 *   - Если несколько валидных массивов — возвращает ПОСЛЕДНИЙ
 *     (финальный ответ модели после всех итераций раздумий).
 *   - Невалидные кандидаты молча пропускаются.
 *   - Никогда не бросает исключений — только возвращает null.
 */
export function extractJsonFromReasoning(reasoning: string | null | undefined): string | null {
  return extractLastBalancedJson(reasoning, "[", "]");
}

/**
 * Извлекает строку JSON-ОБЪЕКТА из reasoning-текста (для judge: один JudgeResult).
 *
 * Возвращает последний валидный объект `{...}`. Игнорирует одиночные `{` без
 * сбалансированной пары и пропускает невалидные кандидаты.
 */
export function extractJsonObjectFromReasoning(reasoning: string | null | undefined): string | null {
  return extractLastBalancedJson(reasoning, "{", "}");
}
