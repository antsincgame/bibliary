/**
 * DomainError — typed error class for domain-layer code that needs to
 * surface a stable error code without the route layer parsing free-form
 * Error.message strings.
 *
 * Usage in lib/*:
 *
 *   throw new DomainError("user_not_found", { status: 404 });
 *   throw new DomainError("cannot_delete_last_admin", { status: 409 });
 *   throw new DomainError("rate_limited", { status: 429, retryAfter: 30 });
 *
 * Usage in routes/*:
 *
 *   try {
 *     await someLibCall();
 *   } catch (err) {
 *     if (err instanceof DomainError) {
 *       throw new HTTPException(err.status, { message: err.code });
 *     }
 *     throw err;
 *   }
 *
 * Or via the central app.onError handler in server/app.ts, which
 * already maps known instances.
 *
 * Why not just HTTPException directly? Because lib/* code shouldn't
 * import from hono — that would couple domain logic to the HTTP
 * framework. DomainError sits one layer below; routes translate it.
 */

export interface DomainErrorOptions {
  /** HTTP status the route layer should translate this to. Defaults to 400. */
  status?: number;
  /** Optional structured details (rendered into JSON body when serialized). */
  details?: Record<string, unknown>;
  /** Underlying cause; preserves stack trace via Error.cause. */
  cause?: unknown;
}

export class DomainError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: string, opts: DomainErrorOptions = {}) {
    super(code, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "DomainError";
    this.code = code;
    this.status = opts.status ?? 400;
    this.details = opts.details;
    /* Preserve stack across V8 + others. */
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, DomainError);
    }
  }

  toJSON(): { error: string; details?: Record<string, unknown> } {
    return this.details
      ? { error: this.code, details: this.details }
      : { error: this.code };
  }
}

/** Type-guard helper for catch blocks. */
export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
