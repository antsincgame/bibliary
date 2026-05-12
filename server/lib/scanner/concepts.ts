import { getVectorDb, TABLE_CONCEPTS } from "../vectordb/db.js";

export interface DeleteResult {
  pointsDeleted: number;
}

export function deleteFromCollection(
  userId: string,
  collection: string,
  bookId: string,
): DeleteResult {
  const { db } = getVectorDb();
  const result = db
    .prepare(
      `DELETE FROM ${TABLE_CONCEPTS}
       WHERE user_id = ? AND collection_name = ? AND book_id = ?`,
    )
    .run(userId, collection, bookId);
  return { pointsDeleted: Number(result.changes) };
}
