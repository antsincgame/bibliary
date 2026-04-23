/**
 * Library paths — единое место получения корня библиотеки.
 *
 * Контракт: библиотека всегда живёт внутри `data/library/` относительно
 * корня проекта. Корень определяется одним из:
 *   1. ENV `BIBLIARY_LIBRARY_ROOT` -- абсолютный путь, для CI и smoke-тестов
 *   2. ENV `BIBLIARY_DATA_DIR` + `/library` -- если приложение запущено
 *      в портативном режиме с явно заданной data-директорией
 *   3. `<projectRoot>/data/library/` -- дефолт для dev-среды
 *
 * НЕ использовать ОС user-data (`app.getPath('userData')`): пользователь
 * хочет видеть свою библиотеку в папке проекта (требование).
 */

import { promises as fs, existsSync } from "fs";
import * as path from "path";

let cachedRoot: string | null = null;

/** Поднимается от текущего файла до корня проекта (где лежит package.json). */
function projectRoot(): string {
  /* tsconfig.electron.json компилирует под CommonJS -> __dirname доступен.
     Структура в dev (tsx): electron/lib/library/paths.ts.
     Структура в prod:      dist-electron/electron/lib/library/paths.js.
     Ищем package.json как маркер корня. */
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Возвращает абсолютный путь к корню библиотеки. Создаёт директорию если её нет. */
export async function getLibraryRoot(): Promise<string> {
  if (cachedRoot !== null) return cachedRoot;
  const root = resolveLibraryRoot();
  await fs.mkdir(root, { recursive: true });
  cachedRoot = root;
  return root;
}

/** Sync вариант: возвращает путь без создания директории (для unit-тестов и логов). */
export function resolveLibraryRoot(): string {
  const fromEnv = process.env.BIBLIARY_LIBRARY_ROOT?.trim();
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  const dataDir = process.env.BIBLIARY_DATA_DIR?.trim();
  if (dataDir && dataDir.length > 0) return path.resolve(dataDir, "library");
  return path.join(projectRoot(), "data", "library");
}

/** Возвращает абсолютный путь к директории конкретной книги. */
export function getBookDir(libraryRoot: string, slug: string): string {
  if (!/^[a-z0-9_-]+$/i.test(slug)) {
    throw new Error(`getBookDir: invalid slug "${slug}" (must match [a-z0-9_-])`);
  }
  return path.join(libraryRoot, slug);
}

/** Очищает кэш корня (только для тестов, чтобы переключать ENV в run-time). */
export function _resetLibraryRootCache(): void {
  cachedRoot = null;
}
