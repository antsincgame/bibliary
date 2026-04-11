import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_NAME = "Xenova/multilingual-e5-small";
export const VECTOR_SIZE = 384;

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    console.log(`Loading model ${MODEL_NAME}...`);
    extractor = await pipeline("feature-extraction", MODEL_NAME);
    console.log("Model loaded.");
  }
  return extractor;
}

async function embed(text: string): Promise<number[]> {
  const model = await getExtractor();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedPassage(text: string): Promise<number[]> {
  return embed(`passage: ${text}`);
}

export async function embedQuery(text: string): Promise<number[]> {
  return embed(`query: ${text}`);
}
