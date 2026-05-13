import { http } from "./http.js";

/**
 * System probes — read-only health/hardware queries.
 *
 * Hardware info на web-backend ограничено тем что доступно `os.*` модулю
 * Node на хосте контейнера; VRAM/GPU данные могут отсутствовать в
 * docker без `--gpus all`. Renderer должен переживать пустые поля.
 */

export const system = {
  /** @returns {Promise<Record<string, unknown>>} */
  hardware: () => http.get("/api/system/hardware"),

  /** @returns {Promise<Record<string, unknown>>} */
  probeServices: () => http.get("/api/system/probe-services"),

  /** @returns {Promise<{version: string, commit?: string}>} */
  version: () => http.get("/api/system/version"),
};
