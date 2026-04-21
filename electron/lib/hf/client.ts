/**
 * HuggingFace client — минимальный MVP без зависимостей.
 *
 * Поддерживается:
 *   - Безопасное хранение токена через Electron safeStorage (OS keychain)
 *   - Поиск моделей через публичное HF API (без auth)
 *   - Открытие AutoTrain Space с pre-filled параметрами через shell.openExternal
 *   - Открытие Colab с pre-loaded notebook через GitHub gist URL
 *
 * Намеренно НЕ поддерживается на этом уровне:
 *   - Скачивание GGUF — требует HF resolver и multi-GB streaming.
 *     Закрывается в Phase 4 (Cloud Bridge Pro) через `@huggingface/hub`.
 *   - Upload датасета — требует authenticated PUT.
 *     Закрывается там же. В текущей фазе пользователь делает upload
 *     вручную через web-UI HuggingFace — это часть осознанного MVP-контракта.
 *
 * Принцип: ноль сторонних SDK для MVP-стабильности. Расширение — отдельная
 * фаза с явным контрактом на streaming / progress / abort.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { safeStorage } from "electron";

const HF_API = "https://huggingface.co/api";
const TOKEN_FILE_NAME = ".hf-token.enc";
/**
 * Default timeout for unauthenticated HF API calls. The huggingface.co
 * gateway can be slow during peak; without a hard cap an IPC channel
 * could hang the renderer waiting for a hf:search-models or hf:model-info
 * response.
 */
const HF_FETCH_TIMEOUT_MS = 10_000;

let cachedToken: string | null = null;

/**
 * fetch() that always honours an AbortController-backed timeout.
 * Use everywhere we hit the public HF API. Throws a clean Error with
 * "HF timeout" prefix so the caller can distinguish from HTTP errors.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = HF_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(`HF timeout ${timeoutMs}ms`), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token management
// ─────────────────────────────────────────────────────────────────────────────

function tokenPath(dataDir: string): string {
  return path.join(dataDir, TOKEN_FILE_NAME);
}

export async function saveHfToken(dataDir: string, token: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS keychain (safeStorage) is not available. Token would be stored in plaintext — refusing."
    );
  }
  const encrypted = safeStorage.encryptString(token);
  await fs.writeFile(tokenPath(dataDir), encrypted);
  cachedToken = token;
}

export async function loadHfToken(dataDir: string): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    const buf = await fs.readFile(tokenPath(dataDir));
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(buf);
    cachedToken = token;
    return token;
  } catch {
    return null;
  }
}

export async function clearHfToken(dataDir: string): Promise<void> {
  cachedToken = null;
  try {
    await fs.unlink(tokenPath(dataDir));
  } catch {
    /* ignore */
  }
}

export async function hasHfToken(dataDir: string): Promise<boolean> {
  try {
    await fs.access(tokenPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public model search (без auth)
// ─────────────────────────────────────────────────────────────────────────────

export interface HfModelSummary {
  id: string;
  pipeline_tag?: string;
  downloads?: number;
  likes?: number;
  modelId?: string;
  tags?: string[];
}

export async function searchModels(query: string, limit = 20): Promise<HfModelSummary[]> {
  const url = `${HF_API}/models?search=${encodeURIComponent(query)}&limit=${limit}&sort=downloads&direction=-1`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    throw new Error(`HF search failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as HfModelSummary[];
  return data;
}

export async function getModelInfo(repoId: string): Promise<unknown> {
  const url = `${HF_API}/models/${encodeURIComponent(repoId)}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    throw new Error(`HF model info failed: ${resp.status}`);
  }
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// External URL builders — мы открываем web-UI вместо API-вызовов в MVP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL Colab notebook, загруженного из GitHub Gist. Для MVP — placeholder URL,
 * пользователь сам загружает .ipynb из bundle вручную. В Phase 4 — auto upload
 * to gist + auto open.
 */
export function buildColabUrl(): string {
  return "https://colab.research.google.com/";
}

/**
 * URL HuggingFace AutoTrain. Pre-fill через query params не поддерживается официально,
 * поэтому открываем главную страницу AutoTrain — пользователь загружает yaml вручную.
 */
export function buildAutoTrainUrl(): string {
  return "https://huggingface.co/autotrain";
}

export function buildModelPageUrl(repoId: string): string {
  return `https://huggingface.co/${encodeURIComponent(repoId)}`;
}
