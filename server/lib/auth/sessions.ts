import { ID, Permission, Query, Role } from "node-appwrite";

import { type Config, loadConfig } from "../../config.js";
import { COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";

import {
  type AccessTokenClaims,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "./jwt.js";

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  accessTtlSec: number;
}

type RawRefreshDoc = RawDoc & {
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revoked: boolean;
  userAgent?: string;
  createdAt: string;
};

export async function createSession(
  claims: AccessTokenClaims,
  opts: { userAgent?: string } = {},
  cfg: Config = loadConfig(),
): Promise<SessionTokens> {
  const accessToken = await signAccessToken(claims, cfg);
  const refresh = generateRefreshToken(cfg);
  await storeRefreshToken({
    userId: claims.sub,
    tokenHash: refresh.tokenHash,
    expiresAt: refresh.expiresAt,
    userAgent: opts.userAgent,
  });
  return {
    accessToken,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
    accessTtlSec: cfg.JWT_ACCESS_TTL_SEC,
  };
}

export async function rotateSession(
  refreshToken: string,
  buildClaims: (userId: string) => Promise<AccessTokenClaims | null>,
  opts: { userAgent?: string } = {},
  cfg: Config = loadConfig(),
): Promise<SessionTokens | null> {
  const tokenHash = hashRefreshToken(refreshToken);
  const existing = await findRefreshByHash(tokenHash);
  if (!existing) return null;
  if (existing.revoked) return null;
  if (new Date(existing.expiresAt).getTime() <= Date.now()) return null;

  const claims = await buildClaims(existing.userId);
  if (!claims) return null;

  await revokeRefreshById(existing.$id);

  return createSession(claims, opts, cfg);
}

export async function revokeRefreshByToken(refreshToken: string): Promise<boolean> {
  const tokenHash = hashRefreshToken(refreshToken);
  const existing = await findRefreshByHash(tokenHash);
  if (!existing) return false;
  await revokeRefreshById(existing.$id);
  return true;
}

export async function revokeAllForUser(userId: string): Promise<number> {
  const { databases, databaseId } = getAppwrite();
  let revoked = 0;
  /* Appwrite doesn't support bulk UPDATE; each token must be flipped
   * individually. Parallelize per-page so revoke for a heavy user
   * stays under a few hundred ms instead of N×roundtrip. Page size 100
   * matches Appwrite's listDocuments cap. */
  for (;;) {
    const list = await databases.listDocuments<RawRefreshDoc>(
      databaseId,
      COLLECTIONS.refreshTokens,
      [Query.equal("userId", userId), Query.equal("revoked", false), Query.limit(100)],
    );
    if (list.documents.length === 0) break;
    await Promise.all(list.documents.map((doc) => revokeRefreshById(doc.$id)));
    revoked += list.documents.length;
    if (list.documents.length < 100) break;
  }
  return revoked;
}

interface StoreRefreshInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string;
}

async function storeRefreshToken(input: StoreRefreshInput): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  const doc: Record<string, unknown> = {
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt.toISOString(),
    revoked: false,
    createdAt: new Date().toISOString(),
  };
  if (input.userAgent) doc["userAgent"] = input.userAgent.slice(0, 500);
  await databases.createDocument(
    databaseId,
    COLLECTIONS.refreshTokens,
    ID.unique(),
    doc,
    [
      Permission.read(Role.user(input.userId)),
      Permission.update(Role.user(input.userId)),
      Permission.delete(Role.user(input.userId)),
    ],
  );
}

async function findRefreshByHash(tokenHash: string): Promise<RawRefreshDoc | null> {
  const { databases, databaseId } = getAppwrite();
  const list = await databases.listDocuments<RawRefreshDoc>(
    databaseId,
    COLLECTIONS.refreshTokens,
    [Query.equal("tokenHash", tokenHash), Query.limit(1)],
  );
  return list.documents[0] ?? null;
}

async function revokeRefreshById(id: string): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.refreshTokens, id, {
      revoked: true,
    });
  } catch (err) {
    if (!isAppwriteCode(err, 404)) throw err;
  }
}
