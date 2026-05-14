import { ID, Permission, Query, Role } from "../store/query.js";

import { COLLECTIONS, getDatastore, isStoreErrorCode, type RawDoc } from "../datastore.js";

export interface UserDoc {
  $id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  role: "user" | "admin";
  libraryQuotaBytes: number | null;
  createdAt: string;
  lastLoginAt: string | null;
  deactivated: boolean;
}

type RawUserDoc = RawDoc & {
  email: string;
  name?: string;
  passwordHash: string;
  role: "user" | "admin";
  libraryQuotaBytes?: number;
  createdAt: string;
  lastLoginAt?: string;
  deactivated?: boolean;
};

function toUserDoc(raw: RawUserDoc): UserDoc {
  return {
    $id: raw.$id,
    email: raw.email,
    name: raw.name ?? null,
    passwordHash: raw.passwordHash,
    role: raw.role,
    libraryQuotaBytes: raw.libraryQuotaBytes ?? null,
    createdAt: raw.createdAt,
    lastLoginAt: raw.lastLoginAt ?? null,
    deactivated: raw.deactivated ?? false,
  };
}

export async function findUserByEmail(email: string): Promise<UserDoc | null> {
  const { databases, databaseId } = getDatastore();
  const list = await databases.listDocuments<RawUserDoc>(
    databaseId,
    COLLECTIONS.users,
    [Query.equal("email", email.toLowerCase()), Query.limit(1)],
  );
  return list.documents[0] ? toUserDoc(list.documents[0]) : null;
}

export async function findUserById(userId: string): Promise<UserDoc | null> {
  const { databases, databaseId } = getDatastore();
  try {
    const raw = await databases.getDocument<RawUserDoc>(
      databaseId,
      COLLECTIONS.users,
      userId,
    );
    return toUserDoc(raw);
  } catch (err) {
    if (isStoreErrorCode(err, 404)) return null;
    throw err;
  }
}

export async function countUsers(): Promise<number> {
  const { databases, databaseId } = getDatastore();
  const list = await databases.listDocuments(databaseId, COLLECTIONS.users, [
    Query.limit(1),
  ]);
  return list.total;
}

export interface CreateUserInput {
  email: string;
  name: string | null;
  passwordHash: string;
  role: "user" | "admin";
}

export async function createUser(input: CreateUserInput): Promise<UserDoc> {
  const { databases, databaseId } = getDatastore();
  const id = ID.unique();
  const nowIso = new Date().toISOString();
  const doc: Record<string, unknown> = {
    email: input.email.toLowerCase(),
    passwordHash: input.passwordHash,
    role: input.role,
    createdAt: nowIso,
  };
  if (input.name) doc["name"] = input.name;

  const raw = await databases.createDocument<RawUserDoc>(
    databaseId,
    COLLECTIONS.users,
    id,
    doc,
    [
      Permission.read(Role.user(id)),
      Permission.update(Role.user(id)),
      Permission.read(Role.team("admin")),
      Permission.update(Role.team("admin")),
    ],
  );
  return toUserDoc(raw);
}

export async function markUserLoggedIn(userId: string): Promise<void> {
  const { databases, databaseId } = getDatastore();
  await databases.updateDocument(databaseId, COLLECTIONS.users, userId, {
    lastLoginAt: new Date().toISOString(),
  });
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string,
): Promise<void> {
  const { databases, databaseId } = getDatastore();
  await databases.updateDocument(databaseId, COLLECTIONS.users, userId, {
    passwordHash,
  });
}

/**
 * Phase 11a — admin user list. Paginated, sorted by createdAt desc.
 * Returns sanitized records (no passwordHash) ready to send to the
 * admin panel.
 */
export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  deactivated: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  libraryQuotaBytes: number | null;
}

export async function listAllUsers(opts: {
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: AdminUserRow[]; total: number }> {
  const { databases, databaseId } = getDatastore();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const list = await databases.listDocuments<RawUserDoc>(
    databaseId,
    COLLECTIONS.users,
    [Query.orderDesc("createdAt"), Query.limit(limit), Query.offset(offset)],
  );
  const rows = list.documents.map((raw) => {
    const u = toUserDoc(raw);
    return {
      id: u.$id,
      email: u.email,
      name: u.name,
      role: u.role,
      deactivated: u.deactivated,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      libraryQuotaBytes: u.libraryQuotaBytes,
    };
  });
  return { rows, total: list.total };
}

/** Phase 11a — promote a user to admin role. Idempotent. */
export async function setUserRole(
  userId: string,
  role: "user" | "admin",
): Promise<void> {
  const { databases, databaseId } = getDatastore();
  await databases.updateDocument(databaseId, COLLECTIONS.users, userId, { role });
}

/** Phase 11a — soft deactivate. Login refuses; existing sessions invalidated
 * by the caller (admin route) via refresh-token revoke. */
export async function setUserDeactivated(
  userId: string,
  deactivated: boolean,
): Promise<void> {
  const { databases, databaseId } = getDatastore();
  await databases.updateDocument(databaseId, COLLECTIONS.users, userId, {
    deactivated,
  });
}

/** Phase 11a — hard delete user document. Use AFTER burnAllForUser +
 * deleteGraphForUser + refresh-token revoke. */
export async function deleteUserDocument(userId: string): Promise<void> {
  const { databases, databaseId } = getDatastore();
  try {
    await databases.deleteDocument(databaseId, COLLECTIONS.users, userId);
  } catch (err) {
    if (!isStoreErrorCode(err, 404)) throw err;
  }
}

/** Phase 11a — count admins. Used to refuse demoting the last admin. */
export async function countAdmins(): Promise<number> {
  const { databases, databaseId } = getDatastore();
  const list = await databases.listDocuments(databaseId, COLLECTIONS.users, [
    Query.equal("role", "admin"),
    Query.limit(1),
  ]);
  return list.total;
}
