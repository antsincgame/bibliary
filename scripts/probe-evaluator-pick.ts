/**
 * Diagnostic: показывает рейтинг кандидатов на роль evaluator-модели.
 *
 * Запуск: `npx tsx scripts/probe-evaluator-pick.ts`
 *
 * НЕ грузит модель -- только скорит и печатает таблицу. Используется для
 * подтверждения что `pickEvaluatorModel()` правильно отдаёт приоритет
 * жирной thinking-модели (например qwen/qwen3.6-35b-a3b), а не мелкой 4b.
 */

import { listLoaded, listDownloaded } from "../server/lib/scanner/_vendor/lmstudio-client.js";
import { getModelProfile } from "../electron/lib/dataset-v2/model-profile.js";

const THINKING_NAME_MARKERS = ["thinking", "reasoning", "deepseek-r1", "qwq", "r1-distill", "gpt-oss"];
const THINKING_FAMILIES = ["qwen3.5", "qwen3.6", "qwen3.7", "magistral", "glm-4.7", "glm-4.6"];

function isThinkingByName(key: string): boolean {
  const lc = key.toLowerCase();
  if (THINKING_NAME_MARKERS.some((m) => lc.includes(m))) return true;
  return THINKING_FAMILIES.some((m) => lc.includes(m));
}

function parseParamsBillion(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  return m ? parseFloat(m[1]) : 0;
}

function isEmbedder(arch: string | undefined, key: string): boolean {
  const a = (arch ?? "").toLowerCase();
  const k = key.toLowerCase();
  return a.includes("bert") || a.includes("clip") || k.includes("embed") || k.includes("nomic-embed");
}

async function scoreOne(key: string, loadedKeys: Set<string>, sizeBytes: number) {
  const reasons: string[] = [];
  let score = 0;
  const profile = await getModelProfile(key);
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
  if (profile.source === "default-fallback") {
    if (isThinkingByName(key)) { score += 80; reasons.push("thinking-by-name+80"); }
    else                       { score += 20; reasons.push("unknown-llm+20"); }
  }
  const paramsB = parseParamsBillion(key);
  if (paramsB > 0) { score += paramsB; reasons.push(`+${paramsB}b-params`); }
  if (loadedKeys.has(key)) { score += 30; reasons.push("loaded+30"); }
  return { key, score, isLoaded: loadedKeys.has(key), sizeBytes, reasons };
}

async function main() {
  console.log("Probing LM Studio model pool...\n");
  const [loaded, downloaded] = await Promise.all([listLoaded(), listDownloaded()]);
  const loadedKeys = new Set(loaded.map((m) => m.modelKey));

  const candidates = new Map<string, { sizeBytes: number; arch?: string }>();
  for (const m of loaded) candidates.set(m.modelKey, { sizeBytes: 0 });
  for (const m of downloaded) {
    const prev = candidates.get(m.modelKey);
    candidates.set(m.modelKey, { sizeBytes: m.sizeBytes ?? prev?.sizeBytes ?? 0, arch: m.architecture });
  }

  const llmKeys = [...candidates.entries()]
    .filter(([key, info]) => !isEmbedder(info.arch, key))
    .map(([key, info]) => ({ key, sizeBytes: info.sizeBytes }));

  console.log(`Total candidates: ${candidates.size} | LLMs (after embedder filter): ${llmKeys.length}\n`);

  const scored = await Promise.all(llmKeys.map((c) => scoreOne(c.key, loadedKeys, c.sizeBytes)));
  scored.sort((a, b) => b.score - a.score || b.sizeBytes - a.sizeBytes);

  const fmtSize = (b: number) => b > 0 ? `${(b / 1024 / 1024 / 1024).toFixed(1)} GB` : "—";
  const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);

  console.log(pad("RANK", 5) + pad("SCORE", 7) + pad("LD", 4) + pad("SIZE", 9) + pad("MODEL_KEY", 50) + "REASONS");
  console.log("─".repeat(140));
  scored.forEach((s, i) => {
    const rank = String(i + 1);
    const ld = s.isLoaded ? "✓" : " ";
    console.log(
      pad(rank, 5) +
      pad(String(s.score), 7) +
      pad(ld, 4) +
      pad(fmtSize(s.sizeBytes), 9) +
      pad(s.key, 50) +
      s.reasons.join(" "),
    );
  });

  console.log(`\n→ pickEvaluatorModel() will select: ${scored[0]?.key ?? "(none)"}`);
  if (scored[0] && !scored[0].isLoaded) {
    console.log(`  (will autoload via WS SDK with TTL 15min)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
