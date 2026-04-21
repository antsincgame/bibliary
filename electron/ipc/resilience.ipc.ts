import { ipcMain } from "electron";
import { coordinator, telemetry, type TelemetryEvent } from "../lib/resilience/index.js";

export function registerResilienceIpc(): void {
  ipcMain.handle(
    "resilience:scan-unfinished",
    async (): Promise<Array<{ pipeline: string; id: string; snapshot: unknown }>> => {
      return coordinator.scanUnfinished();
    }
  );

  ipcMain.handle(
    "resilience:telemetry-tail",
    async (_e, n: number): Promise<TelemetryEvent[]> => {
      const safeN = typeof n === "number" && n > 0 ? Math.min(n, 1000) : 100;
      return telemetry.tail(safeN);
    }
  );
}
