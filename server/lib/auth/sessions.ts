import { ID, Permission, Query, Role } from "../store/query.js";

import { type Config, loadConfig } from "../../config.js";
import { COLLECTIONS, getDatastore, isStoreErrorCode, type RawDoc } from "../datastore.js";

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
  const { databases, databaseId } = getDatastore();
  let revoked = 0;
  let failed = 0;
  /* Appwrite doesn't support bulk UPDATE; each token must be flipped
   * individually. Parallelize per-page so revoke for a heavy user
   * stays under a few hundred ms instead of N×roundtrip. Page size 100
   * matches Appwrite's listDocuments cap.
   *
   * allSettled (not all) — one transient failure mid-revocation must
   * NOT short-circuit the loop. If even one token survives we leave
   * the user with an active refresh token. Continue past per-doc
   * failures, count them, escalate only at the end if any failed. */
  for (;;) {
    const list = await databases.listDocuments<RawRefreshDoc>(
      databaseId,
      COLLECTIONS.refreshTokens,
      [Query.equal("userId", userId), Query.equal("revoked", false), Query.limit(100)],
    );
    if (list.documents.length === 0) break;
    const results = await Promise.allSettled(
      list.documents.map((doc) => revokeRefreshById(doc.$id)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") revoked += 1;
      else {
        failed += 1;
        console.warn(
          `[sessions] revokeRefreshById failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`,
        );
      }
    }
    if (list.documents.length < 100) break;
  }
  if (failed > 0) {
    /* Throwing surfaces the partial-revoke to the caller (admin route
     * publishes an audit event with what we did manage). Without this
     * the caller would think every token was revoked. */
    throw new Error(`revokeAllForUser: ${revoked} revoked, ${failed} failed`);
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
  const { databases, databaseId } = getDatastore();
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
  const { databases, databaseId } = getDatastore();
  const list = await databases.listDocuments<RawRefreshDoc>(
    databaseId,
    COLLECTIONS.refreshTokens,
    [Query.equal("tokenHash", tokenHash), Query.limit(1)],
  );
  return list.documents[0] ?? null;
}

async function revokeRefreshById(id: string): Promise<void> {
  const { databases, databaseId } = getDatastore();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.refreshTokens, id, {
      revoked: true,
    });
  } catch (err) {
    if (!isStoreErrorCode(err, 404)) throw err;
  }
}
