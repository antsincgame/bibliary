import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { wrapSecret } from "../lib/crypto/secrets.js";
import {
  getPreferences,
  setPreferences,
} from "../lib/preferences/store.js";
import { getProvider, invalidateProvider, listConfiguredProviders } from "../lib/llm/registry.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Routes для управления per-user LLM provider configuration:
 *   - GET  /api/llm/providers              → which configured, без ключей
 *   - PUT  /api/llm/providers/:id/secret   → save encrypted API key
 *   - DELETE /api/llm/providers/:id/secret → forget API key
 *   - POST /api/llm/providers/:id/test     → live ping (listAvailable)
 *   - GET  /api/llm/providers/:id/models   → cached model list
 *   - GET  /api/llm/assignments            → role → {provider, model}
 *   - PUT  /api/llm/assignments            → bulk set assignments
 *
 * Keys никогда не отдаются обратно — только hint ("sk-...c7d8").
 */

const ProviderIdSchema = z.enum(["lmstudio", "anthropic", "openai"]);
const SetSecretBody = z.object({
  apiKey: z.string().min(8).max(500),
});

const AssignmentsBody = z.object({
  /** Map role name → { provider, model }. */
  assignments: z.record(
    z.string(),
    z.object({
      provider: ProviderIdSchema,
      model: z.string().min(1).max(200),
    }),
  ),
});

export function llmRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/providers", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const list = await listConfiguredProviders(user.sub);
    return c.json(list);
  });

  app.put(
    "/providers/:id/secret",
    zValidator("param", z.object({ id: ProviderIdSchema })),
    zValidator("json", SetSecretBody),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { id } = c.req.valid("param");
      if (id === "lmstudio") {
        throw new HTTPException(400, {
          message: "lmstudio has no per-user secret (global admin URL)",
        });
      }
      const { apiKey } = c.req.valid("json");
      const wrapped = wrapSecret(apiKey);

      const prefs = await getPreferences(user.sub);
      const existing =
        (prefs as Record<string, unknown>)["providerSecretsEncrypted"] ?? {};
      const merged = {
        ...(existing as Record<string, unknown>),
        [id]: wrapped,
      };
      await setPreferences(user.sub, { providerSecretsEncrypted: merged });
      invalidateProvider(user.sub, id);
      return c.json({ ok: true, providerId: id, hint: wrapped.hint });
    },
  );

  app.delete(
    "/providers/:id/secret",
    zValidator("param", z.object({ id: ProviderIdSchema })),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { id } = c.req.valid("param");
      if (id === "lmstudio") {
        throw new HTTPException(400, {
          message: "lmstudio has no per-user secret",
        });
      }
      const prefs = await getPreferences(user.sub);
      const existing = ((prefs as Record<string, unknown>)["providerSecretsEncrypted"] ?? {}) as Record<string, unknown>;
      delete existing[id];
      await setPreferences(user.sub, { providerSecretsEncrypted: existing });
      invalidateProvider(user.sub, id);
      return c.json({ ok: true, providerId: id });
    },
  );

  app.post(
    "/providers/:id/test",
    zValidator("param", z.object({ id: ProviderIdSchema })),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { id } = c.req.valid("param");
      try {
        const provider = await getProvider(user.sub, id);
        const models = await provider.listAvailable();
        return c.json({
          ok: true,
          providerId: id,
          modelsCount: models.length,
          sampleModels: models.slice(0, 5).map((m) => m.modelId),
        });
      } catch (err) {
        return c.json(
          {
            ok: false,
            providerId: id,
            error: err instanceof Error ? err.message : String(err),
          },
          /* 200 чтобы UI мог различить «не сконфигурирован» от 401/500. */
          200,
        );
      }
    },
  );

  app.get(
    "/providers/:id/models",
    zValidator("param", z.object({ id: ProviderIdSchema })),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { id } = c.req.valid("param");
      const provider = await getProvider(user.sub, id);
      const models = await provider.listAvailable();
      return c.json(models);
    },
  );

  app.get("/assignments", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const prefs = await getPreferences(user.sub);
    const assignments =
      (prefs as Record<string, unknown>)["providerAssignments"] ?? {};
    return c.json(assignments);
  });

  app.put("/assignments", zValidator("json", AssignmentsBody), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const { assignments } = c.req.valid("json");
    await setPreferences(user.sub, { providerAssignments: assignments });
    /* После смены assignments invalidate всего user cache — провайдер
     * мог измениться, новый chat() пойдёт через свежий instance. */
    invalidateProvider(user.sub);
    return c.json({ ok: true, assignments });
  });

  return app;
}
