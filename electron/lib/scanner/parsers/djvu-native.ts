/**
 * Native DjVu parser — pure-JS adapter поверх RussCoder/djvu.js v0.5.4.
 *
 * Iter 14.4 (2026-05-04, /imperor): замена внешнего DjVuLibre CLI
 * (djvutxt.exe / djvused.exe / ddjvu.exe) на нативный JavaScript-парсер
 * от Russian Coder (https://github.com/RussCoder/djvujs, GPL v2).
 *
 * Почему меняем:
 *   - DjVuLibre CLI требует vendor binaries 4 MB на каждой платформе
 *     (отдельные скачивания для win32-x64, linux-x64, darwin-arm64).
 *   - Watchdog #297 (infinite loop в RLE decoder) — некоторые DjVu файлы
 *     зависают djvutxt навсегда; pure-JS импл не страдает этой багой.
 *   - Цепочка spawn → pipe → parse — медленнее и хрупче чем in-process
 *     ArrayBuffer + sync API.
 *   - Bundle 544 KB универсален для всех платформ.
 *
 * Архитектура:
 *   1. djvu.js bundle (IIFE, 544 KB) лежит в `vendor/djvu/djvu.js`.
 *   2. При первом обращении загружается в `vm` sandbox с минимальными
 *      shim'ами (performance, addEventListener no-op, navigator).
 *   3. Sandbox singleton — один загрузка на процесс. DjVu.Document создаётся
 *      на каждый файл (легко по памяти — 12 ms для 8 MB книги).
 *   4. Sync API: doc.pages.length, doc.getPage(N) → Promise<Page>,
 *      page.getText() → string. Async getPage не блокирует event loop —
 *      lazy decoding по запросу страницы.
 *
 * Контракт совпадает с `djvu-cli.ts` чтобы Strangler Fig переключение
 * было прозрачным:
 *   - getDjvuPageCount(filePath, signal) → number
 *   - runDjvutxt(filePath, signal) → string (весь документ)
 *   - runDjvutxtPage(filePath, pageIndex, signal) → string (одна страница)
 *
 * Что НЕ покрывается этим адаптером (пока остаётся в CLI):
 *   - runDdjvu (DjVu page → TIFF) — вернёт ImageData, нужно конвертировать
 *     в PNG/TIFF через sharp; следующая итерация.
 *   - runDdjvuToPdf (DjVu → PDF) — pure-JS render медленнее, отдельный фикс.
 */

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { performance } from "node:perf_hooks";
import * as telemetry from "../../resilience/telemetry.js";

interface DjVuPage {
  getText(): string;
}

interface DjVuDocument {
  pages: { length: number };
  getPage(pageNumber: number): Promise<DjVuPage>;
}

interface DjVuLib {
  Document: new (buffer: ArrayBuffer) => DjVuDocument;
}

interface DjVuSandbox {
  DjVu: DjVuLib;
}

let cachedSandbox: DjVuSandbox | null = null;
let cachedBundlePath: string | null = null;

/**
 * Найти bundle djvu.js. В dev — `vendor/djvu/djvu.js` относительно cwd.
 * В packaged Electron — `process.resourcesPath/vendor/djvu/djvu.js`.
 */
function resolveBundlePath(): string {
  if (cachedBundlePath) return cachedBundlePath;

  const candidates: string[] = [];
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "vendor", "djvu", "djvu.js"));
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "vendor", "djvu", "djvu.js"));
  }
  for (const p of candidates) {
    if (fsSync.existsSync(p)) {
      cachedBundlePath = p;
      return p;
    }
  }
  throw new Error(
    `djvu.js bundle not found. Expected at one of:\n  ${candidates.join("\n  ")}`,
  );
}

/**
 * Загрузить djvu.js в vm sandbox. Singleton — повторные вызовы возвращают
 * закэшированный sandbox.
 *
 * Bundle — IIFE который добавляет глобальный `DjVu` объект в `self`. Мы
 * подставляем sandbox как self/window/globalThis и предоставляем минимальные
 * shim'ы для browser-only API:
 *   - addEventListener/removeEventListener — no-op (Web Worker bootstrap)
 *   - performance — Node node:perf_hooks
 *   - navigator/location — минимальные заглушки
 */
function loadSandbox(): DjVuSandbox {
  if (cachedSandbox) return cachedSandbox;

  const bundlePath = resolveBundlePath();
  const bundleSource = fsSync.readFileSync(bundlePath, "utf-8");
  const tStart = Date.now();

  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL: globalThis.URL,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    ArrayBuffer: globalThis.ArrayBuffer,
    Uint8Array: globalThis.Uint8Array,
    Uint16Array: globalThis.Uint16Array,
    Uint32Array: globalThis.Uint32Array,
    Int8Array: globalThis.Int8Array,
    Int16Array: globalThis.Int16Array,
    Int32Array: globalThis.Int32Array,
    Float32Array: globalThis.Float32Array,
    Float64Array: globalThis.Float64Array,
    DataView: globalThis.DataView,
    Promise: globalThis.Promise,
    queueMicrotask: globalThis.queueMicrotask,
    performance,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    postMessage: () => undefined,
    importScripts: () => undefined,
    location: { href: "file:///djvu", origin: "file://", pathname: "/djvu", protocol: "file:" },
    navigator: { userAgent: "node-bibliary" },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  try {
    vm.runInContext(bundleSource, sandbox, { filename: "djvu.js" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load djvu.js bundle: ${msg}`);
  }

  if (!sandbox.DjVu) {
    throw new Error("djvu.js bundle loaded but DjVu global not found in sandbox");
  }

  telemetry.logEvent({
    type: "djvu.native.bundle_loaded",
    bundlePath,
    bundleBytes: bundleSource.length,
    loadMs: Date.now() - tStart,
  });

  cachedSandbox = sandbox as unknown as DjVuSandbox;
  return cachedSandbox;
}

/**
 * Открыть .djvu файл и вернуть Document. На каждый вызов создаётся новый
 * Document (поскольку чтение файла — единственная тяжёлая часть, ~12 ms
 * для 8 MB).
 */
async function openDocument(filePath: string, signal?: AbortSignal): Promise<DjVuDocument> {
  if (signal?.aborted) throw new Error("aborted");
  const buffer = await fs.readFile(filePath);
  if (signal?.aborted) throw new Error("aborted");
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const { DjVu } = loadSandbox();
  return new DjVu.Document(arrayBuffer);
}

export async function getDjvuPageCountNative(filePath: string, signal?: AbortSignal): Promise<number> {
  const doc = await openDocument(filePath, signal);
  const pageCount = doc.pages?.length ?? 0;
  if (!Number.isFinite(pageCount) || pageCount <= 0) return 1;
  return pageCount;
}

/**
 * Извлечь весь текст из DjVu (аналог `djvutxt <file>` без аргументов).
 * Страницы разделяются `\n\n`. Если страница не имеет текстового слоя,
 * возвращается пустая строка для неё.
 */
export async function runDjvutxtNative(filePath: string, signal?: AbortSignal): Promise<string> {
  const doc = await openDocument(filePath, signal);
  const pageCount = doc.pages?.length ?? 0;
  if (pageCount === 0) return "";

  const parts: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const page = await doc.getPage(i + 1); /* 1-based */
      const text = page?.getText ? page.getText() : "";
      if (text && text.length > 0) parts.push(text);
    } catch (err) {
      /* Single-page failure is non-fatal — продолжаем со следующей. */
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.logEvent({
        type: "djvu.native.page_error",
        filePath: path.basename(filePath),
        pageNumber: i + 1,
        error: msg.slice(0, 200),
      });
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Извлечь текст одной страницы (аналог `djvutxt --page=N <file>`).
 * pageIndex 0-based (как в `djvu-cli.ts`).
 */
export async function runDjvutxtPageNative(
  filePath: string,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<string> {
  const doc = await openDocument(filePath, signal);
  const pageCount = doc.pages?.length ?? 0;
  if (pageIndex < 0 || pageIndex >= pageCount) return "";
  if (signal?.aborted) throw new Error("aborted");
  try {
    const page = await doc.getPage(pageIndex + 1);
    return page?.getText ? page.getText().trim() : "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`djvu native getPage(${pageIndex + 1}) failed: ${msg}`);
  }
}

/**
 * Сбросить sandbox (для тестов, если нужно перезагрузить bundle).
 * В production не используется.
 */
export function _resetDjvuNativeSandbox(): void {
  cachedSandbox = null;
  cachedBundlePath = null;
}

/**
 * Проверить доступность native парсера. Используется в Strangler Fig пути
 * `djvu-cli.ts` чтобы решить — native или CLI fallback.
 */
export function isDjvuNativeAvailable(): boolean {
  try {
    resolveBundlePath();
    return true;
  } catch {
    return false;
  }
}
