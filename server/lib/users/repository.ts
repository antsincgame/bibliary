import { ID, Permission, Query, Role } from "node-appwrite";

import { COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";

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
  const { databases, databaseId } = getAppwrite();
  const list = await databases.listDocuments<RawUserDoc>(
    databaseId,
    COLLECTIONS.users,
    [Query.equal("email", email.toLowerCase()), Query.limit(1)],
  );
  return list.documents[0] ? toUserDoc(list.documents[0]) : null;
}

export async function findUserById(userId: string): Promise<UserDoc | null> {
  const { databases, databaseId } = getAppwrite();
  try {
    const raw = await databases.getDocument<RawUserDoc>(
      databaseId,
      COLLECTIONS.users,
      userId,
    );
    return toUserDoc(raw);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }
}

export async function countUsers(): Promise<number> {
  const { databases, databaseId } = getAppwrite();
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
  const { databases, databaseId } = getAppwrite();
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
  const { databases, databaseId } = getAppwrite();
  await databases.updateDocument(databaseId, COLLECTIONS.users, userId, {
    lastLoginAt: new Date().toISOString(),
  });
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string,
): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  await databases.updateDocument(databaseId, COLLECTIONS.users, userId, {
    passwordHash,
  });
}
