/**
 * Barrel re-export для электронной vectordb-сборки.
 *
 * Каждый потребитель импортирует через `from "../vectordb/index.js"` или
 * `from "../vectordb/<submodule>.js"` — оба варианта валидны. Barrel
 * группирует символы для удобства swap'а в Phase 2.
 */

export {
  initVectorDb,
  getDb,
  closeDb,
  getDataPath,
  setDataDirForTesting,
} from "./connection.js";

export {
  ensureCollection,
  listCollections,
  getCollectionInfo,
  collectionExists,
  deleteCollection,
  type EnsureCollectionSpec,
  type EnsureCollectionResult,
  type CollectionInfo,
  type VectorDistance,
  type VectorHnswConfig,
} from "./store.js";

export {
  vectorUpsert,
  vectorUpsertAdaptive,
  vectorDeleteByWhere,
  vectorCount,
  vectorQueryNearest,
  distanceToCosine,
  sanitizeMetadata,
  sanitizeMetadataValue,
  canonicalizeRow,
  whereExact,
  whereAnyOf,
  whereAllOf,
  type VectorPoint,
  type VectorMetadata,
  type VectorScalar,
  type VectorNearestNeighbor,
  type DistanceSpace,
  type DeleteResult,
} from "./points.js";

export {
  scrollVectors,
  collectAllMetadatas,
  type ScrollVectorsOptions,
  type VectorPage,
  type VectorInclude,
} from "./scroll.js";

export {
  chromaWhereToLance,
} from "./filter.js";

export { VECTOR_DIM, SCHEMA_VERSION, METADATA_FIELDS } from "./schema.js";
