/**
 * scripts/test-agent-memory-live.ts — LIVE E2E для всей B6+B7 цепочки.
 *
 * НИКАКИХ MOCK. Использует реально работающий локальный embedder
 * (@xenova/transformers, multilingual-e5-small) и реальный Qdrant по адресу
 * QDRANT_URL. LM Studio для этого теста НЕ нужен — мы проверяем именно
 * embed → upsert → search контракт.
 *
 * Сценарии:
 *   M1 — probe: Qdrant жив (если нет — graceful skip без exit-1)
 *   M2 — rememberTurn: один turn успешно ингестится в bibliary_memory
 *   M3 — recallMemory: повторно достаёт его по семантическому запросу
 *   M4 — shouldRemember filter: короткие/error turn'ы НЕ ингестятся
 *   M5 — searchHelp: если bibliary_help уже построен — поиск возвращает hits
 *
 * Запуск:    npx tsx scripts/test-agent-memory-live.ts
 * ENV:
 *   QDRANT_URL  (default http://localhost:6333)
 *   QDRANT_API_KEY (optional)
 *   KEEP_TEST_DATA=1 — не удалять созданные точки после теста
 */

import {
  rememberTurn,
  recallMemory,
  MEMORY_COLLECTION,
} from "../electron/lib/help-kb/memory.js";
import {
  searchHelp,
  HELP_KB_COLLECTION,
  buildHelpKb,
} from "../electron/lib/help-kb/index.js";
import { QDRANT_URL, QDRANT_API_KEY } from "../electron/lib/qdrant/http-client.js";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
const createdIds: string[] = [];

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${label.padEnd(72, ".")} `);
  try {
    await fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(`${label}: ${msg}`);
  }
}

function skip(label: string, reason: string): void {
  console.log(`  ${label.padEnd(72, ".")} ${COLOR.yellow}SKIP${COLOR.reset}`);
  console.log(`      ${COLOR.dim}${reason}${COLOR.reset}`);
  skipped++;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
  return h;
}

async function probeQdrant(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await fetch(`${QDRANT_URL}/collections`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function helpKbExists(): Promise<boolean> {
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${HELP_KB_COLLECTION}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const d = (await r.json()) as { result?: { points_count?: number } };
    return (d.result?.points_count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function deletePoint(collection: string, ts: string): Promise<void> {
  /* Удаляем по фильтру payload.ts чтобы не зависеть от знания id */
  await fetch(`${QDRANT_URL}/collections/${collection}/points/delete?wait=true`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      filter: { must: [{ key: "ts", match: { value: ts } }] },
    }),
  }).catch(() => { /* best-effort cleanup */ });
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary Agent Memory — LIVE B6+B7 test ==${COLOR.reset}`);
  console.log(`Qdrant: ${QDRANT_URL}\n`);

  const probe = await probeQdrant();
  if (!probe.ok) {
    console.log(
      `${COLOR.yellow}Qdrant недоступен (${probe.reason}). Все memory/help-тесты skipped.${COLOR.reset}`,
    );
    console.log(
      `${COLOR.dim}Чтобы запустить полностью: docker run -p 6333:6333 qdrant/qdrant${COLOR.reset}\n`,
    );
    process.exit(0);
  }

  /* Уникальный маркер сессии чтобы тесты разных запусков не пересекались */
  const sessionMark = `live-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userMessage = `[${sessionMark}] Что такое YaRN и зачем он нужен в дообучении больших языковых моделей?`;
  const assistantAnswer = `[${sessionMark}] YaRN (Yet another RoPE extensioN) — алгоритм расширения контекстного окна `
    + `LLM путём масштабирования RoPE-частот. Позволяет работать с контекстами 32k+ без полного дообучения.`;
  const ts1 = new Date().toISOString();

  await step("M2 — rememberTurn успешно ингестит валидную пару", async () => {
    const res = await rememberTurn({ ts: ts1, userMessage, assistantAnswer });
    if (!res.ok) throw new Error(`upsert failed: ${res.reason ?? "?"}`);
    createdIds.push(ts1);
  });

  /* Qdrant с wait=false — даём 1.5 сек на видимость точки */
  await new Promise((r) => setTimeout(r, 1500));

  await step("M3 — recallMemory находит сохранённый turn по семантическому запросу", async () => {
    const hits = await recallMemory(`${sessionMark} расширение контекста YaRN`, {
      limit: 10,
      scoreThreshold: 0.3,
    });
    const found = hits.find((h) => h.userMessage.includes(sessionMark));
    if (!found) {
      const top = hits.slice(0, 3).map((h) => `score=${h.score.toFixed(3)} u=«${h.userMessage.slice(0, 60)}»`).join("\n        ");
      throw new Error(`session-marked entry not in top-${hits.length}\n      ${top || "(пусто)"}`);
    }
    if (found.score < 0.4) {
      throw new Error(`score слишком низкий: ${found.score.toFixed(3)} (ожидали ≥ 0.4)`);
    }
    if (!found.assistantAnswer.includes("YaRN")) {
      throw new Error(`payload.assistantAnswer повреждён: «${found.assistantAnswer.slice(0, 80)}»`);
    }
    console.log(`        ${COLOR.dim}top score=${found.score.toFixed(3)}, hits=${hits.length}${COLOR.reset}`);
  });

  await step("M4 — shouldRemember фильтрует короткие сообщения (НЕ должно создаться)", async () => {
    const ts = new Date().toISOString();
    const res = await rememberTurn({ ts, userMessage: "hi", assistantAnswer: "hello" });
    if (res.ok) {
      throw new Error("rememberTurn должен был отказаться (filter), но вернул ok=true");
    }
    if (res.reason !== "filtered") {
      throw new Error(`ожидали reason=filtered, получили: ${res.reason}`);
    }
  });

  await step("M4b — shouldRemember фильтрует ответы-ошибки", async () => {
    const ts = new Date().toISOString();
    const res = await rememberTurn({
      ts,
      userMessage: "Длинный валидный вопрос пользователя?".repeat(2),
      assistantAnswer: "⚠ Что-то пошло не так очень-очень плохо при выполнении.",
    });
    if (res.ok) throw new Error("error-prefixed answer должен был быть отфильтрован");
    if (res.reason !== "filtered") throw new Error(`reason: ${res.reason}`);
  });

  /* M5 — search_help: если bibliary_help пуст — авто-билд (унесёт ~2 сек),
     это убирает ручной шаг 'npm run build:help-kb' для CI и для разработчика
     который запускает live test первый раз. SKIP_HELP_KB_AUTO_BUILD=1
     отключает автобилд если нужно отладить пустое состояние. */
  let helpReady = await helpKbExists();
  if (!helpReady && !process.env.SKIP_HELP_KB_AUTO_BUILD) {
    process.stdout.write(`  ${COLOR.dim}M5 prep: коллекция ${HELP_KB_COLLECTION} пуста, авто-билд help-kb...${COLOR.reset}\n`);
    try {
      const result = await buildHelpKb({});
      console.log(
        `  ${COLOR.dim}help-kb готов: ${result.embedded}/${result.totalChunks} chunks за ${result.durationMs}ms${COLOR.reset}`,
      );
      helpReady = result.upserted > 0;
    } catch (e) {
      console.log(
        `  ${COLOR.yellow}help-kb auto-build failed: ${e instanceof Error ? e.message : String(e)}${COLOR.reset}`,
      );
    }
  }
  if (!helpReady) {
    skip(
      "M5 — searchHelp возвращает релевантные hits",
      `коллекция ${HELP_KB_COLLECTION} пуста. Запусти 'npm run build:help-kb' заранее или убери SKIP_HELP_KB_AUTO_BUILD.`,
    );
  } else {
    await step("M5 — searchHelp возвращает релевантные hits по теме fine-tuning", async () => {
      const hits = await searchHelp("как запустить дообучение модели", {
        limit: 5,
        scoreThreshold: 0.3,
      });
      if (hits.length === 0) {
        throw new Error("0 hits для базового вопроса о fine-tuning — низкий recall");
      }
      const top = hits[0];
      if (top.score < 0.4) {
        throw new Error(`top score слишком низкий: ${top.score.toFixed(3)}`);
      }
      if (!top.text || top.text.length < 20) {
        throw new Error(`payload.text повреждён: «${top.text.slice(0, 40)}»`);
      }
      console.log(
        `        ${COLOR.dim}top: ${top.docTitle} » ${top.heading} (score=${top.score.toFixed(3)})${COLOR.reset}`,
      );
    });
  }

  /* Cleanup */
  if (!process.env.KEEP_TEST_DATA) {
    for (const ts of createdIds) {
      await deletePoint(MEMORY_COLLECTION, ts);
    }
    if (createdIds.length > 0) {
      console.log(`\n  ${COLOR.dim}cleanup: удалено ${createdIds.length} тестовых точек из ${MEMORY_COLLECTION}${COLOR.reset}`);
    }
  } else {
    console.log(`\n  ${COLOR.dim}KEEP_TEST_DATA=1 — точки оставлены для ручной инспекции${COLOR.reset}`);
  }

  console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
  console.log(`Passed:  ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Failed:  ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  console.log(`Skipped: ${COLOR.yellow}${skipped}${COLOR.reset}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
