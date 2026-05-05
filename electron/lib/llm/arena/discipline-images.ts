/**
 * Файловое хранилище картинок для пользовательских дисциплин Олимпиады.
 *
 * Создан 2026-05-05 (Iter 14.3, custom Olympics editor).
 *
 * Решение «split storage» (приказ Императора):
 *   - Метаданные (промпты, expected) — в preferences.json
 *   - Картинки — отдельные файлы в `userData/custom-disciplines/`
 *
 * Причины:
 *   - Картинка ~10-100 KB base64 в JSON раздула бы preferences.json до
 *     мегабайт за десяток тестов.
 *   - Atomic write всего файла на каждое сохранение становится дорогим.
 *   - Бэкапы preferences легче (текстовый JSON остаётся текстовым).
 *
 * Безопасность:
 *   - Принимаем только PNG/JPG/JPEG/WEBP, max 5 MB.
 *   - Имена файлов санитизируются: `^custom-{role}-{slug}-{ts}\.{ext}$`.
 *   - Никаких path-traversal: ./ ../ запрещены, директория жёстко
 *     прибита к userData/custom-disciplines/.
 */

import { promises as fs, readFileSync } from "fs";
import * as path from "path";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
/* Совпадает с regex в CustomDisciplineSchema.imageRef */
const IMAGE_REF_RE = /^[a-z0-9_-]+\.(png|jpg|jpeg|webp)$/i;

let _imagesDirOverride: string | null = null;

/**
 * userData / data dir для картинок. По умолчанию:
 *   - Production: app.getPath('userData')/custom-disciplines/
 *   - Dev / tests: process.cwd()/data/custom-disciplines/
 *
 * IPC слой (arena.ipc.ts) при инициализации может явно задать путь
 * через `setDisciplineImagesDir(app.getPath('userData') + '/custom-disciplines')`.
 * Без этого fallback'аем на `BIBLIARY_DATA_DIR` env (как Olympics report).
 */
export function setDisciplineImagesDir(dir: string): void {
  _imagesDirOverride = dir;
}

export function getDisciplineImagesDir(): string {
  if (_imagesDirOverride) return _imagesDirOverride;
  const dataDir = process.env.BIBLIARY_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "custom-disciplines");
}

/**
 * Безопасно превращает имя картинки в абсолютный путь внутри images dir.
 * Throw'ает если imageRef не проходит regex (защита от path traversal).
 */
function resolveImagePath(imageRef: string): string {
  if (!IMAGE_REF_RE.test(imageRef)) {
    throw new Error(`invalid imageRef: "${imageRef}" — must match ${IMAGE_REF_RE}`);
  }
  return path.join(getDisciplineImagesDir(), imageRef);
}

/**
 * Сохраняет PNG/JPG/JPEG/WEBP base64 в файл и возвращает имя файла
 * (для записи в `CustomDiscipline.imageRef`).
 *
 * @param disciplineId id дисциплины (для генерации имени)
 * @param base64 чистая base64-строка БЕЗ префикса `data:image/...;base64,`
 *               (UI должен вырезать префикс перед отправкой)
 * @param ext расширение без точки (`png`/`jpg`/`jpeg`/`webp`)
 */
export async function saveDisciplineImage(
  disciplineId: string,
  base64: string,
  ext: string,
): Promise<string> {
  const e = ext.toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(e)) {
    throw new Error(`unsupported image extension: "${ext}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`);
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0) throw new Error("empty image data");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${buf.length} bytes (max ${MAX_IMAGE_BYTES})`);
  }
  /* discipline id уже валидирован при save через IPC (regex
     `^custom-[a-z_]+-[a-z0-9]+$/i`), но дополнительно фильтруем */
  const safeId = disciplineId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safeId) throw new Error(`invalid disciplineId for image: "${disciplineId}"`);
  const imageRef = `${safeId}.${e}`;
  const fullPath = resolveImagePath(imageRef);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buf);
  return imageRef;
}

/**
 * Загружает картинку как data-URL для inline-передачи в LLM (LM Studio
 * API ожидает `image_url: "data:image/png;base64,..."`).
 *
 * Возвращает null если файл отсутствует — caller (compileCustomDiscipline)
 * сделает дисциплину текстовой; Olympics покажет warn в логе.
 */
export function loadDisciplineImageDataUrlSync(imageRef: string): string | null {
  /* Sync вариант для compileCustomDiscipline (она вызывается во время
     runOlympics в not-async map контексте). Файлы маленькие (<5MB),
     блокировка eventloop приемлема. Если нужно async — есть отдельная
     loadDisciplineImageDataUrl ниже. */
  try {
    if (!IMAGE_REF_RE.test(imageRef)) return null;
    const fullPath = resolveImagePath(imageRef);
    const buf = readFileSync(fullPath);
    const ext = imageRef.slice(imageRef.lastIndexOf(".") + 1).toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Async-вариант для preview в UI (через IPC). */
export async function loadDisciplineImageDataUrl(imageRef: string): Promise<string | null> {
  try {
    if (!IMAGE_REF_RE.test(imageRef)) return null;
    const fullPath = resolveImagePath(imageRef);
    const buf = await fs.readFile(fullPath);
    const ext = imageRef.slice(imageRef.lastIndexOf(".") + 1).toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Удаляет картинку (best-effort). Не throw'ит если файла уже нет. */
export async function deleteDisciplineImage(imageRef: string | undefined): Promise<void> {
  if (!imageRef) return;
  try {
    const fullPath = resolveImagePath(imageRef);
    await fs.unlink(fullPath);
  } catch {
    /* missing or already deleted — noop */
  }
}
