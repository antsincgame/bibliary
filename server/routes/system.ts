import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { detectHardware } from "../lib/hardware/profiler.js";
import { getAppwrite } from "../lib/appwrite.js";
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

async function probeAppwrite(): Promise<ServiceProbeResult> {
  const { databases, databaseId, client } = getAppwrite();
  const endpoint =
    typeof (client as unknown as { config?: { endpoint?: string } }).config?.endpoint === "string"
      ? (client as unknown as { config: { endpoint: string } }).config.endpoint
      : "";
  try {
    await databases.get(databaseId);
    return { online: true, url: endpoint, version: "appwrite" };
  } catch (err) {
    return {
      online: false,
      url: endpoint,
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
    const [appwrite, lmStudio] = await Promise.all([probeAppwrite(), probeLmStudio()]);
    return c.json({ appwrite, lmStudio });
  });

  return app;
}
