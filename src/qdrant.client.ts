/**
 * Legacy CLI Qdrant клиент. Используется только из `src/*` и `scripts/*`
 * ETL-скриптов (init-collection, load, search, find-duplicates и т.д.).
 *
 * ⚠️  ВНИМАНИЕ — этот модуль вызывает `dotenv.config()` при импорте,
 * чтобы CLI-скрипты "просто работали" с `.env`. Это может неявно
 * подменить `process.env.QDRANT_COLLECTION` для всего процесса.
 *
 * НЕ ИМПОРТИРУЙТЕ этот файл из:
 *   - Electron main/preload (там собственный Qdrant-клиент через `fetch`,
 *     `electron/ipc-handlers.ts`).
 *   - Из новых утилит, которые целятся в собственную коллекцию — используйте
 *     `makeQdrantClient({ collection: "..." })` или передавайте имя явно.
 *
 * Прецедент: E2E RAG-скрипт случайно перезаписывал боевую коллекцию `apps`,
 * потому что `init-collection.ts` импортировал `COLLECTION_NAME` из этого
 * модуля и брал значение из `.env`. См. audit `OMNISSIAH` от 2026-04-20.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import * as dotenv from "dotenv";

dotenv.config();

export interface QdrantClientFactoryOptions {
  url?: string;
  apiKey?: string;
  collection?: string;
}

/**
 * Явный factory для нового кода. Параметры имеют приоритет над `process.env`,
 * fallback на defaults. Не имеет сайд-эффектов на глобальный `process.env`.
 */
export function makeQdrantClient(opts: QdrantClientFactoryOptions = {}): {
  client: QdrantClient;
  collection: string;
} {
  const url = opts.url ?? process.env.QDRANT_URL ?? "http://localhost:6333";
  const apiKey = opts.apiKey ?? process.env.QDRANT_API_KEY;
  const collection = opts.collection ?? process.env.QDRANT_COLLECTION ?? "concepts";
  return {
    client: new QdrantClient({ url, ...(apiKey ? { apiKey } : {}) }),
    collection,
  };
}

/** @deprecated Используйте `makeQdrantClient()` для нового кода. */
export const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
});

/** @deprecated Используйте `makeQdrantClient({collection: "..."}).collection`. */
export const COLLECTION_NAME: string = process.env.QDRANT_COLLECTION ?? "concepts";
