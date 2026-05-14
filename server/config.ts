import { z } from "zod";

/**
 * Parse env-var boolean correctly. `z.coerce.boolean()` is BROKEN for
 * env strings: it uses JS's `Boolean()` constructor which returns
 * `true` for any non-empty string. So:
 *   COOKIE_SECURE=false → coerced to TRUE (opposite of intent)
 *   COOKIE_SECURE=0     → coerced to TRUE
 *   COOKIE_SECURE=true  → coerced to TRUE (correct by accident)
 * This helper accepts the common forms explicitly. Anything else
 * yields a Zod error so misspellings ("flase") fail at boot rather
 * than silently flipping behaviour.
 */
const envBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === "boolean") return v;
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
      if (s === "false" || s === "0" || s === "no" || s === "off" || s === "") {
        return false;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected one of: true/false/1/0/yes/no/on/off (got "${v}")`,
      });
      return z.NEVER;
    });

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),

    /* Appwrite connection is .optional() so solo mode (BIBLIARY_SOLO=1)
     * can boot with no BaaS at all — the SQLite shim takes over. The
     * superRefine below promotes the three to required when
     * BIBLIARY_SOLO is off, so multi-user deployments still fail loud
     * at boot rather than 500ing on the first DB call. */
    APPWRITE_ENDPOINT: z.string().url().optional(),
    APPWRITE_PROJECT_ID: z.string().min(1).optional(),
    APPWRITE_API_KEY: z.string().min(1).optional(),
    APPWRITE_DATABASE_ID: z.string().default("bibliary"),

    /* Solo mode: run the whole service on SQLite alone — no Appwrite,
     * no MariaDB, no Redis. `npm start` / one `docker run`. The
     * multi-user Appwrite path stays available when this is off. */
    BIBLIARY_SOLO: envBool(false),
    /* Override the solo document DB path — mainly for tests, which
     * point it at a temp file or ":memory:" for isolation. */
    BIBLIARY_DB_PATH: z.string().optional(),

    /* JWT keys are .optional() in the schema so dev/test can boot
     * without a keypair (smoke tests don't touch /auth). The refine
     * below promotes them to required when NODE_ENV === "production"
     * so we fail at boot rather than 500ing on the first /login. */
    JWT_PRIVATE_KEY_PEM: z.string().min(1).optional(),
    JWT_PUBLIC_KEY_PEM: z.string().min(1).optional(),
    JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

    /* Same story for the AES master key — without it provider secrets
     * cannot encrypt/decrypt; runtime crashes on first /llm/providers
     * POST. Make it required in production. */
    BIBLIARY_ENCRYPTION_KEY: z.string().min(32).optional(),
    BIBLIARY_ADMIN_EMAILS: z.string().optional(),
    BIBLIARY_DATA_DIR: z.string().default("./data"),

    LM_STUDIO_URL: z.string().default("http://localhost:1234"),
    LM_STUDIO_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

    BIBLIARY_VECTORS_DB_PATH: z.string().optional(),
    BIBLIARY_EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

    COOKIE_SECURE: envBool(false),
    COOKIE_DOMAIN: z.string().optional(),
    CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),

    /* Multipart upload size cap. Hono's parseBody() buffers the whole
     * body in RAM, so an unbounded value can OOM a modest-server pod.
     * Default 200 MB covers most books; tune via env if your corpus
     * includes giant scanned PDFs. */
    BIBLIARY_UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(200 * 1024 * 1024),

    /* Phase pre-release: lock down public registration after the first
     * admin is seeded. Set BIBLIARY_REGISTRATION_DISABLED=true to
     * refuse /api/auth/register with 403; existing users keep working. */
    BIBLIARY_REGISTRATION_DISABLED: envBool(false),
  })
  .superRefine((cfg, ctx) => {
    /* Appwrite credentials are required whenever solo mode is OFF —
     * regardless of NODE_ENV, because without them the multi-user
     * backend cannot talk to its database at all. */
    if (!cfg.BIBLIARY_SOLO) {
      for (const key of [
        "APPWRITE_ENDPOINT",
        "APPWRITE_PROJECT_ID",
        "APPWRITE_API_KEY",
      ] as const) {
        if (!cfg[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "required unless BIBLIARY_SOLO=true",
          });
        }
      }
    }

    if (cfg.NODE_ENV !== "production") return;
    if (!cfg.JWT_PRIVATE_KEY_PEM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_PRIVATE_KEY_PEM"],
        message: "required when NODE_ENV=production",
      });
    }
    if (!cfg.JWT_PUBLIC_KEY_PEM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_PUBLIC_KEY_PEM"],
        message: "required when NODE_ENV=production",
      });
    }
    if (!cfg.BIBLIARY_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BIBLIARY_ENCRYPTION_KEY"],
        message: "required when NODE_ENV=production (≥32 chars)",
      });
    }
    if (!cfg.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message:
          "must be true when NODE_ENV=production (refresh tokens are intercepted over plain HTTP)",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[config] Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — drop the cached Config so subsequent loadConfig()
 * calls re-read process.env. Tests that flip env vars at runtime
 * (e.g. BIBLIARY_REGISTRATION_DISABLED) call this to make the
 * change take effect. Never call from production code. */
export function resetConfigForTesting(): void {
  cached = null;
}

export function getAdminEmails(cfg: Config): Set<string> {
  if (!cfg.BIBLIARY_ADMIN_EMAILS) return new Set();
  return new Set(
    cfg.BIBLIARY_ADMIN_EMAILS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function getCorsOrigins(cfg: Config): string[] {
  return cfg.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
}
