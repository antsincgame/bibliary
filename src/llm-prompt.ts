import { qdrant, COLLECTION_NAME } from "./qdrant.client.js";
import "dotenv/config";

async function promptLLM(): Promise<void> {
  const { points } = await qdrant.scroll(COLLECTION_NAME, { limit: 100 });

  const concepts = points
    .map((p) => p.payload.explanation)
    .join("\n");

  const prompt = `You are an expert copywriter analyzing foundational writing principles from a Russian book "Пиши, сокращай" (Write, Shorten).

Below are core concepts in MECHANICUS format (a concise encoding language). Your task:

1. Understand each principle deeply
2. Generate practical, real-world examples in Russian
3. Create a mini-guide showing how to apply them together

CONCEPTS:
---
${concepts}
---

OUTPUT FORMAT:
1. Краткое описание каждого принципа (2-3 предложения на русском)
2. 2-3 практических примера применения в реальных ситуациях
3. Как они работают вместе в едином процессе написания
4. Частые ошибки при нарушении этих принципов

Start systematically analyzing all concepts.`;

  console.log("Sending to LM Studio...\n");
  console.log("Concepts loaded:", points.length);
  console.log("Prompt length:", prompt.length, "chars\n");

  try {
    const response = await fetch("http://localhost:1234/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-model",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      console.error(`LM Studio error: ${response.status}`);
      const text = await response.text();
      console.error(text);
      process.exit(1);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const result = data.choices[0].message.content;

    console.log("=== LLM RESPONSE ===\n");
    console.log(result);
  } catch (e) {
    console.error("Failed to connect to LM Studio at http://localhost:1234");
    console.error("Is it running? Check: http://localhost:1234/health");
    process.exit(1);
  }
}

promptLLM().catch((e: unknown) => {
  console.error("Error:", e);
  process.exit(1);
});
