import { readFileSync } from "node:fs";

const ALLOWED_DOMAINS = new Set(["ui", "web", "mobile", "ux", "perf", "arch", "copy", "seo", "research"]);
const SOURCE_PATH = "data/finetune/source-chunks.json";

interface SourceChunk {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

interface ValidationError {
  line: number;
  field: string;
  message: string;
}

function validate(batchPath: string): void {
  const sourceChunks = JSON.parse(readFileSync(SOURCE_PATH, "utf8")) as SourceChunk[];
  const validChunkIds = new Set(sourceChunks.map((c) => c.id));

  const raw = readFileSync(batchPath, "utf8").trim();
  const lines = raw.split("\n");

  const errors: ValidationError[] = [];
  let validCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      errors.push({ line: lineNum, field: "json", message: "Invalid JSON" });
      continue;
    }

    const conversations = parsed.conversations;
    if (!Array.isArray(conversations)) {
      errors.push({ line: lineNum, field: "conversations", message: "Missing or not an array" });
      continue;
    }

    if (conversations.length !== 3) {
      errors.push({
        line: lineNum,
        field: "conversations",
        message: `Expected 3 messages, got ${conversations.length}`,
      });
      continue;
    }

    const roles = conversations.map((c: Record<string, unknown>) => c.from);
    if (roles[0] !== "system" || roles[1] !== "human" || roles[2] !== "gpt") {
      errors.push({
        line: lineNum,
        field: "conversations.from",
        message: `Expected [system, human, gpt], got [${roles.join(", ")}]`,
      });
      continue;
    }

    const humanValue = (conversations[1] as Record<string, unknown>).value;
    if (typeof humanValue !== "string" || humanValue.trim().length < 5) {
      errors.push({ line: lineNum, field: "human.value", message: "Empty or too short" });
    }

    const gptValue = (conversations[2] as Record<string, unknown>).value;
    if (typeof gptValue !== "string") {
      errors.push({ line: lineNum, field: "gpt.value", message: "Not a string" });
      continue;
    }

    let chunkData: Record<string, unknown>;
    try {
      chunkData = JSON.parse(gptValue) as Record<string, unknown>;
    } catch {
      errors.push({ line: lineNum, field: "gpt.value", message: "Not valid JSON" });
      continue;
    }

    const principle = chunkData.principle;
    if (typeof principle !== "string") {
      errors.push({ line: lineNum, field: "principle", message: "Missing or not a string" });
    } else if (principle.length < 3 || principle.length > 300) {
      errors.push({
        line: lineNum,
        field: "principle",
        message: `Length ${principle.length} outside 3-300 range`,
      });
    }

    const explanation = chunkData.explanation;
    if (typeof explanation !== "string") {
      errors.push({ line: lineNum, field: "explanation", message: "Missing or not a string" });
    } else if (explanation.length < 10 || explanation.length > 2000) {
      errors.push({
        line: lineNum,
        field: "explanation",
        message: `Length ${explanation.length} outside 10-2000 range`,
      });
    }

    const domain = chunkData.domain;
    if (typeof domain !== "string" || !ALLOWED_DOMAINS.has(domain)) {
      errors.push({
        line: lineNum,
        field: "domain",
        message: `Invalid domain: "${domain}"`,
      });
    }

    const tags = chunkData.tags;
    if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10) {
      errors.push({
        line: lineNum,
        field: "tags",
        message: `Expected 1-10 tags, got ${Array.isArray(tags) ? tags.length : "non-array"}`,
      });
    }

    const meta = parsed.meta as Record<string, unknown> | undefined;
    if (!meta) {
      errors.push({ line: lineNum, field: "meta", message: "Missing meta object" });
    } else {
      const chunkId = meta.source_chunk_id;
      if (typeof chunkId !== "string" || !validChunkIds.has(chunkId)) {
        errors.push({
          line: lineNum,
          field: "meta.source_chunk_id",
          message: `Unknown chunk ID: "${chunkId}"`,
        });
      }

      const type = meta.type;
      if (typeof type !== "string" || !["T1", "T2", "T3"].includes(type)) {
        errors.push({
          line: lineNum,
          field: "meta.type",
          message: `Invalid type: "${type}"`,
        });
      }
    }

    const lineErrors = errors.filter((e) => e.line === lineNum);
    if (lineErrors.length === 0) {
      validCount++;
    }
  }

  console.log(`\nValidation: ${batchPath}`);
  console.log(`${"─".repeat(50)}`);
  console.log(`Total lines: ${lines.length}`);
  console.log(`Valid: ${validCount}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors:`);
    for (const err of errors) {
      console.log(`  Line ${err.line} [${err.field}]: ${err.message}`);
    }
    process.exit(1);
  }

  console.log(`\nAll examples valid.`);
}

const batchPath = process.argv[2];
if (!batchPath) {
  console.error("Usage: npm run validate-batch -- <path-to-batch.jsonl>");
  console.error("Example: npm run validate-batch -- data/finetune/batches/batch-001.jsonl");
  process.exit(1);
}

validate(batchPath);
