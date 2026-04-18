import { EmbeddingModel, FlagEmbedding } from "fastembed";

export const VECTOR_SIZE = 384;
const CACHE_DIR = "/tmp/fastembed-models";

let model: FlagEmbedding | null = null;

async function getModel(): Promise<FlagEmbedding> {
  if (!model) {
    console.log("Loading model AllMiniLML6V2 (384-dim)...");
    model = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2,
      cacheDir: CACHE_DIR,
    });
    console.log("Model loaded.");
  }
  return model;
}

async function embed(text: string): Promise<number[]> {
  const m = await getModel();
  for await (const batch of m.embed([text], 1)) {
    return Array.from(batch[0]);
  }
  throw new Error("No embedding returned");
}

export async function embedPassage(text: string): Promise<number[]> {
  return embed(text);
}

export async function embedQuery(text: string): Promise<number[]> {
  return embed(text);
}
