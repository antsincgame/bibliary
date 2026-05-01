/**
 * Text-Meta Extractor — AI fallback для библиографических метаданных.
 *
 * Когда: ISBN online lookup провалился (нет интернета / Open Library и Google
 * Books не нашли запись), а на обложке vision-meta тоже не дал результат
 * (или vision-модели нет). Тогда последний шанс — спросить crystallizer
 * модель: "посмотри на первые страницы книги и достань title/author/year".
 *
 * Контракт:
 *   - Никогда не throw — на ошибке возвращает null + warnings.
 *   - Использует роль "crystallizer" из настроек "Модели" (никаких облаков).
 *   - Очень короткий промпт (~3 КБ текста), max_tokens 400.
 *   - Hard timeout 15 секунд, чтобы не блокировать импорт.
 */

import { getLmStudioUrl } from "../endpoints/index.js";
import { modelRoleResolver } from "../llm/model-role-resolver.js";
import { getImportScheduler } from "./import-task-scheduler.js";

export interface TextMeta {
  title?: string;
  author?: string;
  year?: number;
  language?: string;
  publisher?: string;
}

export interface TextMetaResult {
  ok: boolean;
  meta?: TextMeta;
  model?: string;
  error?: string;
  warnings: string[];
}

const SYSTEM_PROMPT = `You are a librarian extracting bibliographic metadata from the first pages of a book.

Return a strict JSON object with these fields (omit fields you can't find):
- title: book title in original language (no series prefix, no "Volume X")
- author: full author name (first author only if multiple)
- year: 4-digit publication year (number, not string)
- language: ISO 639-1 code (en, ru, uk, de, fr, es, ...)
- publisher: publisher name if explicitly mentioned

Rules:
- Return ONLY a JSON object, no prose, no markdown code fences.
- Use null or omit field if you cannot determine it confidently.
- Don't guess year from copyright page if unclear.
- Don't invent authors.`;

export async function extractTextMetaFromBookText(
  bookTextSample: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TextMetaResult> {
  const warnings: string[] = [];
  if (!bookTextSample || bookTextSample.length < 80) {
    return { ok: false, error: "text sample too short", warnings };
  }

  /* Резолвим crystallizer модель (та же что для извлечения знаний). */
  let modelKey: string;
  try {
    const resolved = await modelRoleResolver.resolve("crystallizer");
    if (!resolved?.modelKey) {
      return { ok: false, error: "no crystallizer model loaded in LM Studio", warnings };
    }
    modelKey = resolved.modelKey;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `role resolver failed: ${msg}`, warnings };
  }

  const sample = bookTextSample.slice(0, 3000);
  const userText = `First pages of a book:\n\n${sample}\n\n---\nExtract bibliographic metadata as JSON.`;

  const baseUrl = await getLmStudioUrl();
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const ctrl = new AbortController();
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort("external");
    else externalSignal.addEventListener("abort", () => ctrl.abort("external"), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);

  try {
    /* Иt 8В.MAIN.1.3: scheduler observability — text-meta-extractor (роль
       crystallizer) идёт через medium lane. Crystallizer = text-only inference,
       3KB sample, max_tokens=400 — короткий запрос (обычно <10s), но всё ещё
       расходует одну medium-модель (8..16 GB), поэтому конкурирует с
       evaluator. medium concurrency=3 даёт умеренный параллелизм без OOM. */
    return await getImportScheduler().enqueue("medium", async () => {
      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelKey,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userText },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return { ok: false, error: `LM Studio HTTP ${resp.status}: ${errText.slice(0, 200)}`, warnings, model: modelKey };
      }
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = (data.choices?.[0]?.message?.content ?? "").trim();
      if (!content) return { ok: false, error: "empty response from LLM", warnings, model: modelKey };

      const parsed = parseMetaJson(content);
      if (!parsed) {
        return { ok: false, error: "failed to parse JSON response", warnings, model: modelKey };
      }
      return { ok: true, meta: parsed, warnings, model: modelKey };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ctrl.signal.aborted && ctrl.signal.reason === "timeout") {
      return { ok: false, error: `LLM timeout after ${timeoutMs}ms`, warnings, model: modelKey };
    }
    return { ok: false, error: msg, warnings, model: modelKey };
  } finally {
    clearTimeout(timer);
  }
}

function parseMetaJson(raw: string): TextMeta | null {
  /* Sometimes LLM wraps in ```json ... ``` despite response_format. */
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const meta: TextMeta = {};
  if (typeof obj.title === "string" && obj.title.trim()) meta.title = obj.title.trim();
  if (typeof obj.author === "string" && obj.author.trim()) meta.author = obj.author.trim();
  if (typeof obj.year === "number" && Number.isFinite(obj.year) && obj.year > 1000 && obj.year < 2100) {
    meta.year = Math.floor(obj.year);
  } else if (typeof obj.year === "string") {
    const n = parseInt(obj.year.trim(), 10);
    if (Number.isFinite(n) && n > 1000 && n < 2100) meta.year = n;
  }
  if (typeof obj.language === "string" && /^[a-z]{2,3}$/i.test(obj.language.trim())) {
    meta.language = obj.language.trim().toLowerCase();
  }
  if (typeof obj.publisher === "string" && obj.publisher.trim()) meta.publisher = obj.publisher.trim();
  return Object.keys(meta).length > 0 ? meta : null;
}
