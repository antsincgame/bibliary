import * as readline from "node:readline";
import { qdrant, COLLECTION_NAME } from "./qdrant.client.js";
import { embedQuery } from "./embed.js";
import "dotenv/config";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const TOP_K = 5;

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const history: Message[] = [];

async function searchConcepts(query: string): Promise<string[]> {
  const vector = await embedQuery(query);
  const results = await qdrant.search(COLLECTION_NAME, {
    vector,
    limit: TOP_K,
    with_payload: true,
  });

  return results
    .filter((r) => r.score > 0.75)
    .map((r) => {
      const p = r.payload as Record<string, unknown>;
      return `[${(r.score * 100).toFixed(1)}%] ${p.explanation}`;
    });
}

async function askLLM(question: string, concepts: string[]): Promise<string> {
  const systemPrompt = concepts.length > 0
    ? `You are an expert copywriter and text editor. You have access to a knowledge base of writing principles from "Пиши, сокращай" book encoded in MECHANICUS format.

RELEVANT CONCEPTS FROM KNOWLEDGE BASE:
---
${concepts.join("\n")}
---

Rules:
- Apply these concepts when answering
- Respond in Russian
- Give practical, actionable advice
- Use examples from the concepts when relevant`
    : `You are an expert copywriter and text editor. No relevant concepts found in the knowledge base for this query. Respond in Russian based on your general knowledge.`;

  history.push({ role: "user", content: question });

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...history,
  ];

  const response = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`LM Studio error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const answer = data.choices[0].message.content;
  history.push({ role: "assistant", content: answer });

  return answer;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  BIBLIARY RAG Chat                       ║");
  console.log("║  Collection: " + COLLECTION_NAME.padEnd(28) + "║");
  console.log("║  Type 'exit' to quit                     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // warm up embedding model
  console.log("Loading embedding model...");
  await embedQuery("test");
  console.log("Ready!\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("close", () => {
    console.log("\nДо встречи!");
    process.exit(0);
  });

  const ask = (): void => {
    rl.question("📝 > ", async (input) => {
      const question = input.trim();

      if (!question || question === "exit") {
        rl.close();
        return;
      }

      try {
        // Step 1: Search relevant concepts
        console.log("\n🔍 Searching knowledge base...");
        const concepts = await searchConcepts(question);
        console.log(`   Found ${concepts.length} relevant concepts\n`);

        // Step 2: Send to LLM with context
        console.log("🤖 Thinking...\n");
        const answer = await askLLM(question, concepts);

        console.log("─".repeat(50));
        console.log(answer);
        console.log("─".repeat(50));
        console.log();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`\n❌ Error: ${msg}\n`);
      }

      ask();
    });
  };

  ask();
}

main().catch((e: unknown) => {
  console.error("Fatal:", e);
  process.exit(1);
});
