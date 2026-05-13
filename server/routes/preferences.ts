import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import {
  getPreferenceDefaults,
  getPreferences,
  resetPreferences,
  setPreferences,
} from "../lib/preferences/store.js";
import { requireAuth } from "../middleware/auth.js";

const PatchBody = z.record(z.string(), z.unknown());

export function preferencesRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const prefs = await getPreferences(user.sub);
    return c.json(prefs);
  });

  app.get("/defaults", (c) => c.json(getPreferenceDefaults()));

  app.patch("/", zValidator("json", PatchBody), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const body = c.req.valid("json");
    const merged = await setPreferences(user.sub, body);
    return c.json(merged);
  });

  app.post("/reset", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const defaults = await resetPreferences(user.sub);
    return c.json(defaults);
  });

  app.get("/profile", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const prefs = await getPreferences(user.sub);
    return c.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      preferences: prefs,
    });
  });

  return app;
}
