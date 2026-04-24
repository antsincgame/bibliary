/**
 * Near-duplicate detector — soft-check для книг с разным SHA, но фактически
 * одной и той же книгой в другом формате/издании.
 *
 * Кейс: одна и та же книга лежит в библиотеке как `book.pdf` и `book.epub`.
 * SHA-256 у файлов разный (SHA дедуп их не поймает), но это та же работа.
 * Мы НЕ автомёрджим — слишком рискованно для библиотеки на 50k. Только
 * добавляем warning в meta при импорте, чтобы пользователь увидел кандидата
 * и сам решил удалить.
 *
 * Контракт ключа: `lower(normalize(title)) | lower(normalize(author)) | chapterCount`.
 * Используется английская версия (titleEn/authorEn) если есть, иначе оригинал.
 * Слишком короткие/пустые ключи (title < 4 символов после нормализации) —
 * пропускаются: ложноположительные совпадения опаснее пропуска.
 */

import { openCacheDb } from "./cache-db.js";
import type { BookCatalogMeta } from "./types.js";

type NearDupMetaInput = Pick<
  BookCatalogMeta,
  "title" | "author" | "titleEn" | "authorEn" | "chapterCount"
>;

const MIN_NORMALIZED_TITLE_LEN = 4;

/** Нормализует строку: NFKD, lowercase, только латиница/кириллица/цифры. */
function normalizeText(s: string | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, "");
}

/**
 * Строит ключ near-dup. Возвращает null если ключ слишком короткий и
 * непригоден для сравнения (избегаем ложных срабатываний на коротких заголовках).
 */
export function makeNearDupKey(meta: NearDupMetaInput): string | null {
  const titleSource = meta.titleEn?.trim() || meta.title?.trim() || "";
  const titleNorm = normalizeText(titleSource);
  if (titleNorm.length < MIN_NORMALIZED_TITLE_LEN) return null;

  const authorSource = meta.authorEn?.trim() || meta.author?.trim() || "";
  const authorNorm = normalizeText(authorSource);

  const chapters = Number.isFinite(meta.chapterCount) ? meta.chapterCount : 0;

  return `${titleNorm}|${authorNorm}|${chapters}`;
}

/**
 * Singleton-кэш near-dup ключей. Bootstrap'ится один раз из SQLite,
 * поддерживается в актуальном состоянии через `register` после каждого
 * успешного импорта. Без SQL-индекса (Фаза 1 не трогает схему).
 *
 * Лимит памяти: ~80 байт на запись × 50k = 4 МБ. Приемлемо.
 */
let cache: Map<string, string> | null = null;

interface SeedRow {
  id: string;
  title: string;
  title_en: string | null;
  author: string | null;
  author_en: string | null;
  chapter_count: number;
}

function ensureLoaded(): Map<string, string> {
  if (cache) return cache;
  const db = openCacheDb();
  const rows = db
    .prepare(
      "SELECT id, title, title_en, author, author_en, chapter_count FROM books",
    )
    .all() as SeedRow[];
  cache = new Map<string, string>();
  for (const r of rows) {
    const key = makeNearDupKey({
      title: r.title,
      titleEn: r.title_en ?? undefined,
      author: r.author ?? undefined,
      authorEn: r.author_en ?? undefined,
      chapterCount: r.chapter_count,
    });
    if (!key) continue;
    /* Первый победитель — следующие совпадения окажутся near-dup'ами
       против него. Это ровно то поведение, которое мы хотим в отчёте. */
    if (!cache.has(key)) cache.set(key, r.id);
  }
  return cache;
}

/** Возвращает id уже-известного near-duplicate или null. */
export function findNearDuplicate(meta: NearDupMetaInput): string | null {
  const key = makeNearDupKey(meta);
  if (!key) return null;
  const map = ensureLoaded();
  return map.get(key) ?? null;
}

/** Регистрирует только что импортированную книгу в кэше. Идемпотентно. */
export function registerForNearDup(meta: NearDupMetaInput, bookId: string): void {
  const key = makeNearDupKey(meta);
  if (!key) return;
  const map = ensureLoaded();
  if (!map.has(key)) map.set(key, bookId);
}

/**
 * Удаляет книгу из near-dup кэша. Вызывается при `deleteBook` чтобы
 * следующий импорт похожей книги не получил ложный warning «near-duplicate
 * of {несуществующий-id}». Идемпотентно: если ключа нет — no-op.
 */
export function unregisterFromNearDup(meta: NearDupMetaInput): void {
  const key = makeNearDupKey(meta);
  if (!key) return;
  if (!cache) return; /* кэш ещё не загружен — нечего удалять */
  cache.delete(key);
}

/**
 * Полный сброс кэша. Вызывается после `pruneMissing` / `rebuildFromFs`
 * (массовые операции, после которых cache stale). Также используется в
 * тестах для изоляции между sandbox'ами.
 */
export function resetNearDupCache(): void {
  cache = null;
}

/** @deprecated используйте `resetNearDupCache`. Оставлено для совместимости. */
export const _resetNearDupCache = resetNearDupCache;
