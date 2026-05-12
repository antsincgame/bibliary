import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { loadConfig } from "../../config.js";

/**
 * AES-256-GCM symmetric encryption for per-user secrets (API keys).
 *
 * Storage format: base64("v1" || iv(12) || authTag(16) || ciphertext).
 * Master key = SHA-256(BIBLIARY_ENCRYPTION_KEY) — env var derive.
 *
 * Threat model: at-rest encryption в Appwrite collection. Защищает от
 * утечки БД-дампа. НЕ защищает от компрометации backend process
 * (где master key в памяти) — для production используй `vault`-style
 * KMS отдельным процессом.
 */

const VERSION_TAG = "v1";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const cfg = loadConfig();
  const raw = cfg.BIBLIARY_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "[secrets] BIBLIARY_ENCRYPTION_KEY env var missing or <32 chars — required for encrypting user API keys",
    );
  }
  /* Derive 256-bit key from env-var via SHA-256 — caller может задать
   * любую passphrase, SHA нормализует длину. Не PBKDF2/scrypt, потому
   * что master key уже high-entropy (admin генерирует через `openssl rand`). */
  cachedKey = createHash("sha256").update(raw).digest();
  return cachedKey;
}

export function _resetSecretsCache(): void {
  cachedKey = null;
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext required (non-empty string)");
  }
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct1 = cipher.update(plaintext, "utf-8");
  const ct2 = cipher.final();
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from(VERSION_TAG), iv, tag, ct1, ct2]);
  return payload.toString("base64");
}

export function decryptSecret(ciphertextB64: string): string {
  if (typeof ciphertextB64 !== "string" || ciphertextB64.length === 0) {
    throw new Error("decryptSecret: ciphertext required");
  }
  const buf = Buffer.from(ciphertextB64, "base64");
  const version = buf.slice(0, 2).toString("utf-8");
  if (version !== VERSION_TAG) {
    throw new Error(`decryptSecret: unknown version tag "${version}"`);
  }
  const iv = buf.slice(2, 2 + IV_LEN);
  const tag = buf.slice(2 + IV_LEN, 2 + IV_LEN + TAG_LEN);
  const ciphertext = buf.slice(2 + IV_LEN + TAG_LEN);

  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt1 = decipher.update(ciphertext);
  const pt2 = decipher.final();
  return Buffer.concat([pt1, pt2]).toString("utf-8");
}

/**
 * Helper: вместо хранения raw key хранится {hint, encrypted}.
 * `hint` — first/last 4 chars, для UI showing «sk-...c7d8» без раскрытия.
 */
export interface SecretWithHint {
  hint: string;
  encrypted: string;
}

export function wrapSecret(plaintext: string): SecretWithHint {
  const len = plaintext.length;
  const hint =
    len <= 8
      ? "•".repeat(len)
      : `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
  return { hint, encrypted: encryptSecret(plaintext) };
}
