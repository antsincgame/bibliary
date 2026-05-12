import type { ChatRequest } from "./provider.js";
import { withProvider } from "./model-resolver.js";

/**
 * Phase Δd — lightweight unit (chapter) summarizer. Plain text out, no
 * schema validation. Reuses the crystallizer role/model — summarization
 * is knowledge synthesis from the same vantage point, and a separate
 * `summarizer` role would force users to assign one more provider
 * before they can crystallize anything.
 *
 * Input: breadcrumb (e.g. "Part II > Chapter 7") + N essences already
 * accepted from this unit's L1 chunks. We summarize the essences, not
 * the raw chunk text — they're pre-filtered through AURA, much higher
 * signal-per-token. If no essences survived AURA in this unit we fall
 * back to the breadcrumb alone (still a usable L2 anchor).
 */

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 400;
const MAX_ESSENCES = 12;
const ESSENCE_TRUNCATE = 240;
const SUMMARY_HARD_CAP = 1200;

const SUMMARIZER_SYSTEM_PROMPT = `You write 2-4 sentence chapter summaries for a knowledge atlas.

Input: a breadcrumb (Part > Chapter > Section) and 1-12 already-extracted
"essences" (compressed insights from the chunks of this chapter).

Output: a single paragraph, English, 2-4 sentences, max 1000 characters.
It must answer: "what does THIS chapter contribute that the others do not?"

Rules:
  - Do NOT restate the breadcrumb.
  - Do NOT list essences mechanically — synthesize the throughline.
  - Be specific. Refuse to generalize ("the chapter discusses…"). If you
    cannot identify a throughline, output the literal string "null".
  - No markdown, no headings, no bullets. Plain paragraph.`;

export interface UnitSummaryInput {
  breadcrumb: string[];
  essences: string[];
}

export interface UnitSummaryResult {
  text: string | null;
  usingFallback: boolean;
  warnings: string[];
}

export async function summarizeUnit(
  userId: string,
  input: UnitSummaryInput,
  opts: { signal?: AbortSignal } = {},
): Promise<UnitSummaryResult> {
  if (input.essences.length === 0) {
    /* No accepted concepts — produce a thin breadcrumb-only anchor so
     * the L2 row still gives KNN something to match on. */
    const title = input.breadcrumb.join(" > ") || "Body";
    return { text: `Chapter: ${title}`, usingFallback: false, warnings: [] };
  }
  return withProvider(userId, "crystallizer", async (provider, model, _id, usingFallback) => {
    const trimmed = input.essences
      .slice(0, MAX_ESSENCES)
      .map((e, i) => `  ${i + 1}. ${e.slice(0, ESSENCE_TRUNCATE)}`)
      .join("\n");
    const breadcrumb = input.breadcrumb.join(" > ") || "Body";
    const userMsg =
      `Breadcrumb: ${breadcrumb}\n\nEssences accepted from this chapter:\n${trimmed}\n\n` +
      `Produce the chapter summary (or the literal string "null" if no throughline).`;
    const request: ChatRequest = {
      model,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      promptCache: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const warnings: string[] = [];
    if (usingFallback) {
      warnings.push(
        "summarizer: using LM Studio fallback — assign crystallizer in Settings",
      );
    }
    try {
      const response = await provider.chat(request);
      const raw = (response.text ?? "").trim();
      if (raw.length === 0 || /^null\s*$/i.test(raw)) {
        return { text: null, usingFallback, warnings };
      }
      /* Strip accidental markdown fences / quotes from sloppy models. */
      const cleaned = raw
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/^```[a-z]*\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim()
        .slice(0, SUMMARY_HARD_CAP);
      return { text: cleaned.length > 0 ? cleaned : null, usingFallback, warnings };
    } catch (err) {
      warnings.push(
        `summarizer: provider.chat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { text: null, usingFallback, warnings };
    }
  });
}
