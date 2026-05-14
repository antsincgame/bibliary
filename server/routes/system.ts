import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { detectHardware } from "../lib/hardware/profiler.js";
import { getDatastore } from "../lib/datastore.js";
import { getVersionInfo } from "../lib/version.js";
import { requireAuth } from "../middleware/auth.js";

const HardwareQuery = z.object({
  force: z.enum(["0", "1", "true", "false"]).optional(),
});

interface ServiceProbeResult {
  online: boolean;
  version?: string;
  url: string;
  message?: string;
}

async function probeStore(): Promise<ServiceProbeResult> {
  const { databases, databaseId } = getDatastore();
  /* The data layer is local SQLite — `databases.get()` runs a `SELECT 1`
   * to confirm the handle is open. There is no remote endpoint to report. */
  try {
    await databases.get(databaseId);
    return { online: true, url: "sqlite", version: "sqlite" };
  } catch (err) {
    return {
      online: false,
      url: "sqlite",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeLmStudio(): Promise<ServiceProbeResult> {
  /* Phase 2b will wire this to the actual LMStudio provider.
     For now we just return a "not configured" placeholder so the UI can
     differentiate between "no LM Studio configured" and "LM Studio down". */
  return { online: false, url: "", message: "not_configured_yet" };
}

export function systemRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/version", (c) => {
    const v = getVersionInfo();
    return c.json({
      version: v.version,
      commit: v.commit,
      builtAt: v.builtAt,
      runtime: `node-${process.versions.node}`,
      isPackaged: false,
    });
  });

  /* Hardware + service probes need an authenticated user — they expose
     environment info that we don't want anonymous probes to enumerate. */
  app.use("/hardware", requireAuth);
  app.use("/probe-services", requireAuth);

  app.get("/hardware", zValidator("query", HardwareQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const q = c.req.valid("query");
    const force = q.force === "1" || q.force === "true";
    const info = await detectHardware({ force });
    return c.json(info);
  });

  app.get("/probe-services", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const [store, lmStudio] = await Promise.all([probeStore(), probeLmStudio()]);
    return c.json({ store, lmStudio });
  });

  return app;
}
