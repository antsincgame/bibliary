import { QdrantClient } from "@qdrant/js-client-rest";
import "dotenv/config";

export const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
});

export const COLLECTION_NAME = process.env.QDRANT_COLLECTION ?? "concepts";
