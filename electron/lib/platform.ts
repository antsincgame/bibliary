/**
 * Helpers для путей в `vendor/` и имен исполняемых файлов.
 *
 * Соглашение каталогов:
 *   vendor/<package>/win32-x64/
 */

/**
 * Директория `win32-x64` для бандленых vendor-binary.
 */
export function platformVendorDir(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

/**
 * Дополняет имя исполняемого файла нужным расширением для текущей ОС.
 * Win → `.exe`, остальные → без суффикса.
 */
export function platformExeName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * Список кандидатных директорий: текущая платформа + legacy `win32-x64`
 * (на случай если ранее был bundled только Win-набор и пользователь
 * положил туда свои бинари вручную).
 */
export function platformVendorDirsWithLegacy(): string[] {
  const cur = platformVendorDir();
  /* legacy: до Phase 4 vendor/djvulibre/ имел только win32-x64. На Win
     legacy === current — возвращаем один элемент. */
  return cur === "win32-x64" ? [cur] : [cur, "win32-x64"];
}
