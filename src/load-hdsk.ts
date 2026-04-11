import { readFileSync } from "node:fs";
import { v5 as uuidv5 } from "uuid";
import { qdrant, COLLECTION_NAME } from "./qdrant.client.js";
import { embedPassage } from "./embed.js";

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const DOMAIN_MAP: Record<string, string> = {
  U: "ui",
  X: "ux",
  W: "web",
  M: "mobile",
  A: "arch",
  P: "perf",
};

interface ParsedLine {
  domain: string;
  tags: string[];
  hdsk: string;
}

function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const pipeIdx = trimmed.indexOf("|");
  if (pipeIdx === -1) return null;

  const meta = trimmed.slice(0, pipeIdx);
  const hdsk = trimmed.slice(pipeIdx + 1);

  const dotIdx = meta.indexOf(".");
  const domainCode = dotIdx === -1 ? meta : meta.slice(0, dotIdx);
  const tagsRaw = dotIdx === -1 ? "" : meta.slice(dotIdx + 1);

  const domain = DOMAIN_MAP[domainCode] ?? domainCode.toLowerCase();
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : [];

  return { domain, tags, hdsk };
}

function conceptId(hdsk: string): string {
  return uuidv5(hdsk.toLowerCase().trim(), NAMESPACE);
}

async function loadHdsk(filePath: string): Promise<void> {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const parsed = lines.map(parseLine).filter((p): p is ParsedLine => p !== null);

  if (parsed.length === 0) {
    console.error("No valid lines found.");
    process.exit(1);
  }

  console.log(`Parsed ${parsed.length} concepts from ${filePath}`);

  for (let i = 0; i < parsed.length; i++) {
    const { domain, tags, hdsk } = parsed[i];
    const id = conceptId(hdsk);

    console.log(`[${i + 1}/${parsed.length}] ${hdsk}`);
    const vector = await embedPassage(hdsk);

    await qdrant.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id,
        vector,
        payload: { hdsk, domain, tags },
      }],
    });
  }

  console.log(`Done. ${parsed.length} concepts loaded.`);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx src/load-hdsk.ts <path-to-file.hdsk>");
  process.exit(1);
}

loadHdsk(filePath).catch((e: unknown) => {
  console.error("Load failed:", e);
  process.exit(1);
});
