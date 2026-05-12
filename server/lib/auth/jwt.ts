import { randomBytes, createHash } from "node:crypto";

import { type JWTPayload, SignJWT, importPKCS8, importSPKI, jwtVerify, type KeyLike } from "jose";

import { type Config, loadConfig } from "../../config.js";
import { DomainError } from "../errors.js";

const ALG = "RS256";
const ISSUER = "bibliary";
const AUDIENCE = "bibliary-web";

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: "user" | "admin";
}

let cachedKeys: { privateKey: KeyLike; publicKey: KeyLike } | null = null;

async function loadKeys(cfg: Config): Promise<{ privateKey: KeyLike; publicKey: KeyLike }> {
  if (cachedKeys) return cachedKeys;
  if (!cfg.JWT_PRIVATE_KEY_PEM || !cfg.JWT_PUBLIC_KEY_PEM) {
    throw new Error(
      "JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM env vars are required to sign/verify tokens.",
    );
  }
  /* Allow .env files to encode newlines as literal `\n` sequences. */
  const privatePem = cfg.JWT_PRIVATE_KEY_PEM.replace(/\\n/g, "\n");
  const publicPem = cfg.JWT_PUBLIC_KEY_PEM.replace(/\\n/g, "\n");
  cachedKeys = {
    privateKey: await importPKCS8(privatePem, ALG),
    publicKey: await importSPKI(publicPem, ALG),
  };
  return cachedKeys;
}

export function resetJwtKeysForTesting(): void {
  cachedKeys = null;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  cfg: Config = loadConfig(),
): Promise<string> {
  const { privateKey } = await loadKeys(cfg);
  return new SignJWT(claims as unknown as JWTPayload)
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${cfg.JWT_ACCESS_TTL_SEC}s`)
    .setJti(generateJti())
    .sign(privateKey);
}

export async function verifyAccessToken(
  token: string,
  cfg: Config = loadConfig(),
): Promise<AccessTokenClaims> {
  const { publicKey } = await loadKeys(cfg);
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (
    typeof payload.sub !== "string" ||
    typeof payload["email"] !== "string" ||
    typeof payload["role"] !== "string"
  ) {
    throw new DomainError("invalid_token_claims", { status: 401 });
  }
  const role = payload["role"];
  if (role !== "user" && role !== "admin") {
    throw new DomainError("invalid_token_role", { status: 401 });
  }
  return {
    sub: payload.sub,
    email: payload["email"] as string,
    role,
  };
}

/**
 * Refresh tokens are NOT JWTs — they're random opaque bearer secrets,
 * because we want server-side revocation (single DB row flip). The
 * stored hash is a SHA-256 of the secret (bcrypt is overkill for
 * high-entropy random data and would dominate refresh latency).
 */
export interface RefreshTokenPair {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateRefreshToken(cfg: Config = loadConfig()): RefreshTokenPair {
  const token = randomBytes(48).toString("base64url");
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + cfg.JWT_REFRESH_TTL_SEC * 1000);
  return { token, tokenHash, expiresAt };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateJti(): string {
  return randomBytes(12).toString("base64url");
}
