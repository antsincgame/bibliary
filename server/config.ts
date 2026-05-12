import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  APPWRITE_ENDPOINT: z.string().url(),
  APPWRITE_PROJECT_ID: z.string().min(1),
  APPWRITE_API_KEY: z.string().min(1),
  APPWRITE_DATABASE_ID: z.string().default("bibliary"),

  JWT_PRIVATE_KEY_PEM: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  BIBLIARY_ENCRYPTION_KEY: z.string().min(32).optional(),
  BIBLIARY_ADMIN_EMAILS: z.string().optional(),
  BIBLIARY_DATA_DIR: z.string().default("./data"),

  COOKIE_SECURE: z.coerce.boolean().default(false),
  COOKIE_DOMAIN: z.string().optional(),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
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
