/**
 * concept-loader — единый источник правды для чтения принятых концептов
 * из Chroma. Контракт metadata зафиксирован здесь, чтобы export, synth и любой
 * будущий потребитель не уходили в дрейф между собой.
 *
 * Поля metadata (после Stage 4 пайплайна v2):
 *   essence        — короткая суть концепта (используется как основной "ответ")
 *   cipher         — формула / краткий код знания (опционально)
 *   proof          — обоснование (опционально)
 *   applicability  — где применять (опционально)
 *   chapterContext — для какого тематического узла главы это
 *   domain         — предметная область (всегда есть)
 *   tagsCsv        — `"|tag1|tag2|"` (Chroma не поддерживает array metadata)
 *   bookSourcePath — исходник книги
 *   bookTitle      — название (если установлено)
 *
 * Legacy-совместимость: если попадётся старая точка с `principle/explanation`,
 * она тоже распознаётся (essence ← principle, proof ← explanation).
 *
 * Note: текст чанка (если есть) приходит в Chroma в `documents[]`, не в metadata —
 * для legacy совместимости проверяем оба места.
 */

import { scrollVectors } from "../vectordb/index.js";

/** Размер страницы scroll-запросов (точек за один HTTP) — наследие
 * Chroma; для in-process LanceDB менее критично, но сохраняем чтобы
 * не плодить argument churn. */
const SCROLL_PAGE_SIZE = 256;

export interface AcceptedConcept {
  id: string;
  domain: string;
  essence: string;
  cipher?: string;
  proof?: string;
  applicability?: string;
  chapterContext?: string;
  tags: string[];
  bookSourcePath?: string;
  bookTitle?: string;
}

/**
 * Внутреннее представление точки vectordb — id плюс metadata.
 * Document (текст) не нужен concept-loader'у: всё семантически важное
 * хранится в metadata. Если concept приходит из старой коллекции, где
 * `text` лежал в payload — поднимем его в `essence`.
 */
interface VectorConceptPoint {
  id: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Преобразовать сырую точку vectordb в AcceptedConcept либо вернуть null,
 * если metadata не содержит обязательных полей (essence + domain).
 */
export function parseConceptPoint(point: VectorConceptPoint): AcceptedConcept | null {
  const p = point.metadata ?? {};
  /* essence — основной ключ; principle — legacy-схема Iter 5/6. */
  const essence = String(p.essence ?? p.principle ?? "").trim();
  const domain = String(p.domain ?? "").trim();
  if (!essence || !domain) return null;

  /* tags теперь хранится как `tagsCsv = "|tag1|tag2|"` либо legacy-строка JSON.
     Парсим оба варианта для backward-compat. */
  let tags: string[] = [];
  if (typeof p.tagsCsv === "string" && p.tagsCsv.length > 0) {
    tags = p.tagsCsv.split("|").map((s) => s.trim()).filter(Boolean);
  } else if (typeof p.tagsJson === "string") {
    try {
      const parsed = JSON.parse(p.tagsJson) as unknown;
      if (Array.isArray(parsed)) tags = parsed.map(String).filter(Boolean);
    } catch { /* legacy malformed — leave empty */ }
  } else if (Array.isArray((p as { tags?: unknown }).tags)) {
    tags = ((p as { tags: unknown[] }).tags).map(String).filter(Boolean);
  }

  /* proof — основной; explanation — legacy. */
  const proof = p.proof
    ? String(p.proof)
    : p.explanation
      ? String(p.explanation)
      : undefined;

  const bookTitle = p.bookTitle
    ? String(p.bookTitle)
    : p.book_title
      ? String(p.book_title)
      : undefined;

  return {
    id: String(point.id),
    essence,
    domain,
    cipher: p.cipher ? String(p.cipher) : undefined,
    proof,
    applicability: p.applicability ? String(p.applicability) : undefined,
    chapterContext: p.chapterContext ? String(p.chapterContext) : undefined,
    tags,
    bookSourcePath: p.bookSourcePath ? String(p.bookSourcePath) : undefined,
    bookTitle,
  };
}

export interface IterAcceptedOptions {
  /** Хард-кэп. Default — без лимита. */
  limit?: number;
  /** Размер страницы scroll. Default — SCROLL_PAGE_SIZE (256). */
  pageSize?: number;
  /** Внешний AbortSignal. */
  signal?: AbortSignal;
}

/**
 * Стримит принятые концепты страницами vectordb scroll. Не загружает всё в RAM.
 * Сразу пропускает точки с пустыми обязательными полями.
 */
export async function* iterAcceptedConcepts(
  collection: string,
  options: IterAcceptedOptions = {},
): AsyncGenerator<AcceptedConcept> {
  const { limit, pageSize = SCROLL_PAGE_SIZE, signal } = options;

  let yielded = 0;
  for await (const page of scrollVectors({
    tableName: collection,
    include: ["metadatas"],
    pageSize,
    maxItems: limit ?? 1_000_000,
    signal,
  })) {
    if (signal?.aborted) return;
    const ids = page.ids ?? [];
    const metadatas = page.metadatas ?? [];
    for (let i = 0; i < ids.length; i++) {
      if (signal?.aborted) return;
      const concept = parseConceptPoint({ id: ids[i], metadata: metadatas[i] ?? null });
      if (!concept) continue;
      yield concept;
      yielded++;
      if (limit && yielded >= limit) return;
    }
  }
}
