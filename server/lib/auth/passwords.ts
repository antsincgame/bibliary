import bcrypt from "bcryptjs";

import { DomainError } from "../errors.js";

const COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 8) {
    throw new DomainError("password_too_short", { status: 422 });
  }
  if (plaintext.length > 256) {
    throw new DomainError("password_too_long", { status: 422 });
  }
  return bcrypt.hash(plaintext, COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
