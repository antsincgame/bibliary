/**
 * Безопасная обёртка над `edgeparse` — Rust-native PDF→Markdown движок.
 *
 * edgeparse работает через NAPI-RS addon и принимает путь к файлу
 * (не буфер). Преимущества над pdfjs-dist:
 *   - XY-Cut++ reading order — корректный порядок в multi-column layout
 *   - Таблицы: border и cluster detection
 *   - 40+ pages/sec на современном CPU
 *   - Markdown/JSON/HTML/text output из коробки
 *
 * Проблема npm: optionalDependency `edgeparse-win32-x64-msvc` часто не
 * инсталлируется как отдельный пакет — бинарь лежит внутри основного
 * edgeparse/npm/. Поэтому если стандартный require падает — загружаем
 * .node напрямую из известного пути.
 */

import * as path from "path";

export interface EdgeParseOptions {
  format?: "markdown" | "json" | "html" | "text";
  pages?: number[];
  password?: string;
  readingOrder?: "xycut" | "default";
  tableMethod?: "border" | "cluster";
  imageOutput?: "embedded" | "external" | "none";
}

interface EdgeParseModule {
  convert(inputPath: string, options?: EdgeParseOptions): string;
  version(): string;
}

let _cached: { module: EdgeParseModule | null; reason?: string } | null = null;

export async function loadEdgeParse(): Promise<EdgeParseModule | null> {
  if (_cached) return _cached.module;
  try {
    const mod = (await import("edgeparse")) as unknown as EdgeParseModule;
    if (typeof mod?.convert !== "function") {
      _cached = { module: null, reason: "edgeparse loaded but convert() missing" };
      return null;
    }
    _cached = { module: mod };
    return mod;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    /* npm не установил optional native dep — попробуем загрузить .node
       напрямую из edgeparse/npm/ директории */
    try {
      const pkgDir = path.dirname(require.resolve("edgeparse/package.json"));
      const platformKey = `${process.platform}-${process.arch}`;
      const addonMap: Record<string, string> = {
        "win32-x64": "edgeparse-node.win32-x64-msvc.node",
        "linux-x64": "edgeparse-node.linux-x64-gnu.node",
      };
      const filename = addonMap[platformKey];
      if (!filename) {
        _cached = { module: null, reason: `edgeparse: unsupported platform ${platformKey}` };
        return null;
      }
      const addonPath = path.join(pkgDir, "npm", filename);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require(addonPath);
      if (typeof native?.convert !== "function") {
        _cached = { module: null, reason: "edgeparse native loaded but convert() missing" };
        return null;
      }
      const wrapper: EdgeParseModule = {
        convert(inputPath: string, options?: EdgeParseOptions): string {
          return native.convert(inputPath, options ? {
            format: options.format,
            pages: options.pages,
            password: options.password,
            reading_order: options.readingOrder,
            table_method: options.tableMethod,
            image_output: options.imageOutput,
          } : undefined);
        },
        version(): string {
          return typeof native.version === "function" ? native.version() : "unknown";
        },
      };
      _cached = { module: wrapper };
      return wrapper;
    } catch (directErr) {
      const directReason = directErr instanceof Error ? directErr.message : String(directErr);
      _cached = { module: null, reason: `edgeparse: ${reason}; direct load: ${directReason}` };
      return null;
    }
  }
}

export function getEdgeParseLoadError(): string | null {
  return _cached?.reason ?? null;
}

export function _resetEdgeParseCacheForTests(): void {
  _cached = null;
}
