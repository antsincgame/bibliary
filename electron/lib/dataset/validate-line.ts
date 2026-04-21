/**
 * Валидация одной строки JSONL батча dataset-генератора.
 * Используется и в IPC `dataset:validate-batch`, и (потенциально) в CLI-валидаторе
 * `scripts/validate-batch.ts` — единая точка истины правил.
 */

import {
  ALLOWED_DOMAINS,
  PRINCIPLE_MAX,
  PRINCIPLE_MIN,
  EXPLANATION_MAX,
  EXPLANATION_MIN,
} from "../../mechanicus-prompt.js";

export function validateLine(line: string, validIds: Set<string>): string[] {
  const errors: string[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return ["Invalid JSON"];
  }

  const conversations = parsed.conversations;
  if (!Array.isArray(conversations) || conversations.length !== 3) {
    errors.push("conversations must have 3 messages");
    return errors;
  }
  const roles = conversations.map((c: Record<string, unknown>) => c.from);
  if (roles[0] !== "system" || roles[1] !== "human" || roles[2] !== "gpt") {
    errors.push(`roles must be [system, human, gpt]`);
  }

  const gptValue = (conversations[2] as Record<string, unknown>).value;
  if (typeof gptValue !== "string") {
    errors.push("gpt.value not a string");
    return errors;
  }
  let chunkData: Record<string, unknown>;
  try {
    chunkData = JSON.parse(gptValue) as Record<string, unknown>;
  } catch {
    errors.push("gpt.value not valid JSON");
    return errors;
  }
  const principle = chunkData.principle;
  if (typeof principle !== "string" || principle.length < PRINCIPLE_MIN || principle.length > PRINCIPLE_MAX) {
    errors.push(`principle out of ${PRINCIPLE_MIN}-${PRINCIPLE_MAX} range`);
  }
  const explanation = chunkData.explanation;
  if (typeof explanation !== "string" || explanation.length < EXPLANATION_MIN || explanation.length > EXPLANATION_MAX) {
    errors.push(`explanation out of ${EXPLANATION_MIN}-${EXPLANATION_MAX} range`);
  }
  if (typeof chunkData.domain !== "string" || !ALLOWED_DOMAINS.has(chunkData.domain)) {
    errors.push(`domain invalid`);
  }
  const tags = chunkData.tags;
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10) {
    errors.push("tags must be 1-10 items");
  }
  const meta = parsed.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.source_chunk_id !== "string" || !validIds.has(meta.source_chunk_id)) {
    errors.push("meta.source_chunk_id unknown");
  }
  if (!meta || (meta.type !== "T1" && meta.type !== "T2" && meta.type !== "T3")) {
    errors.push("meta.type must be one of T1|T2|T3");
  }
  return errors;
}
