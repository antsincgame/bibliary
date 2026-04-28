/**
 * arXiv (export.arxiv.org/api/query) — научные статьи. Atom-XML.
 * License обычно arXiv-perpetual, но почти все статьи публикуются под
 * CC-BY/CC-BY-NC и доступны для распространения. Чтобы не врать — ставим
 * "open-access" (white-listed).
 *
 * Rate limit: arXiv просит ≥3 секунды между запросами при batch-режиме.
 */

import { XMLParser } from "fast-xml-parser";
import { USER_AGENT, type BookCandidate, type BookSource, type SearchOptions } from "../types.js";

const ENDPOINT = "https://export.arxiv.org/api/query";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function getYearFromArxivDate(s: string): number | undefined {
  const m = s.match(/^(\d{4})/);
  if (!m) return undefined;
  return Number(m[1]);
}

/**
 * Снять LaTeX-разметку из строки, чтобы пользователь не видел
 * `$_{c}(2930)$` или `\\bar{B}^{0}` в карточках поиска.
 *
 * Стратегия: для inline `$...$` оставляем содержимое, но без обвязки `$`
 * и без управляющих команд. Грубая, но работает для заголовков arXiv.
 */
function stripLatex(input: string): string {
  if (!input) return input;
  let s = input;
  /* убираем \begin{...} \end{...} */
  s = s.replace(/\\(?:begin|end)\{[^}]*\}/g, " ");
  /* раскрываем $...$ — внутри убираем обёртки и слэш-команды */
  s = s.replace(/\$([^$]+)\$/g, (_m, body) => {
    let inner = String(body);
    /* \mathrm{X} \mathbf{X} \text{X} \mathcal{X} → X */
    inner = inner.replace(/\\(?:mathrm|mathbf|mathcal|mathit|mathsf|text|operatorname)\s*\{([^}]*)\}/g, "$1");
    /* \frac{a}{b} → a/b */
    inner = inner.replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, "$1/$2");
    /* убираем оставшиеся слэш-команды без аргумента (\to, \alpha, \bar и т.п.) */
    inner = inner.replace(/\\[a-zA-Z]+\*?/g, " ");
    /* раскрываем простые подстроки: ^{...} → ..., _{...} → ... */
    inner = inner.replace(/[\^_]\{([^{}]*)\}/g, "$1");
    /* одиночные ^x, _x → x */
    inner = inner.replace(/[\^_]([\w+\-])/g, "$1");
    /* убираем оставшиеся фигурные скобки */
    inner = inner.replace(/[{}]/g, " ");
    return inner;
  });
  /* schwa за пределами $...$: убрать остаточные \cmd */
  s = s.replace(/\\[a-zA-Z]+\*?/g, " ");
  s = s.replace(/[{}]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function search(opts: SearchOptions): Promise<BookCandidate[]> {
  const params = new URLSearchParams();
  params.set("search_query", `all:${opts.query}`);
  params.set("start", "0");
  params.set("max_results", String(opts.perSourceLimit ?? 10));
  params.set("sortBy", "relevance");
  params.set("sortOrder", "descending");

  const resp = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`arxiv ${resp.status}`);
  const text = await resp.text();
  const parsed = xmlParser.parse(text) as Record<string, unknown>;
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (!feed) return [];
  const entries = asArray(feed.entry) as Array<Record<string, unknown>>;

  return entries.map((entry) => {
    const idUrl = String(entry.id ?? "");
    const arxivId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    const rawTitle = String(entry.title ?? "").replace(/\s+/g, " ").trim();
    const title = stripLatex(rawTitle);
    const authorsNode = asArray(entry.author) as Array<Record<string, unknown>>;
    const authors = authorsNode.map((a) => String(a.name ?? "")).filter(Boolean);
    const published = String(entry.published ?? "");

    const rawSummary = typeof entry.summary === "string"
      ? entry.summary.replace(/\s+/g, " ")
      : "";

    return {
      id: arxivId,
      sourceTag: "arxiv" as const,
      title,
      authors,
      language: "en",
      year: getYearFromArxivDate(published),
      formats: [
        { format: "pdf" as const, url: `https://arxiv.org/pdf/${arxivId}.pdf` },
      ],
      license: "open-access" as const,
      webPageUrl: idUrl,
      description: rawSummary ? stripLatex(rawSummary).slice(0, 500) : undefined,
    };
  });
}

export const arxivSource: BookSource = { tag: "arxiv", search };
