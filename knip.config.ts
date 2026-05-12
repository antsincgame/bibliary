import type { KnipConfig } from "knip";

/**
 * Иt 8Д.3 — knip static analysis.
 *
 * Цель: найти мёртвый код, неиспользуемые экспорты и зависимости БЕЗ
 * runtime тестов типа "role-resolver-singularity" (быстрее в 100x,
 * 0 false positives при правильной конфигурации, IDE-feedback).
 *
 * Конфигурация под Electron+TS+vanilla-renderer:
 *   - entry: главные точки входа (electron/main.ts, electron/preload.ts,
 *     все scripts/*.ts которые вызываются из npm scripts, тесты)
 *   - project: что анализировать
 *   - ignore: автогенерация и data
 *   - ignoreExportsUsedInFile: helpful для IPC public API surface
 *
 * Запуск: `npm run dead-code` или `npx knip --no-progress`.
 *
 * False-positives: поскольку у нас много `await import(...)` динамических
 * импортов, опции `ignoreDependencies` и `ignoreExportsUsedInFile` нужны
 * для смягчения. См. https://knip.dev/reference/configuration
 */
const config: KnipConfig = {
  entry: [
    /* Hono server entry + Vite renderer entry (web mode). */
    "server/main.ts",
    "vite.config.ts",
    "renderer/api-client.js",
    "renderer/router.js",

    /* Electron legacy (до Phase 13). */
    "electron/main.ts",
    "electron/preload.ts",

    /* Worker thread — загружается через `new Worker(__dirname/pdf-worker.js)`
       из pdf-worker-host.ts, knip не видит динамическую path-резолюцию. */
    "electron/lib/scanner/parsers/pdf-worker.ts",

    /* Scripts вызываемые из package.json (test:e2e:*, dataset:*, и т.д.) */
    "scripts/*.ts",
    "scripts/*.cjs",

    /* Все тесты */
    "tests/**/*.test.ts",
    "tests/smoke/*.test.ts",
  ],

  ignoreDependencies: [
    /* 7z-bin / 7zip-bin резолвятся динамически:
       `for (const pkg of ["7z-bin", "7zip-bin"]) require(pkg)` —
       knip видит только литерал require(), не итерацию. */
    "7z-bin",
    "7zip-bin",
    /* `marked` импортируется в renderer/markdown.js через прямой path
       `../node_modules/marked/lib/marked.esm.js` (renderer не TS, не в project). */
    "marked",
    /* `esbuild` требуется только в scripts/bench-djvu.cjs — manual benchmark,
       не в CI. Доступен транзитивно через electron-builder и др. */
    "esbuild",
    /* False positives — knip не видит transitively-used server deps когда
       imports проходят через barrels или type-only refs: */
    "@hono/zod-validator", // server/routes/*.ts
    "bcryptjs",            // server/lib/auth/passwords.ts
    "jose",                // server/lib/auth/jwt.ts
    "openai",              // server/lib/llm/providers/openai.ts
    "sqlite-vec",          // server/lib/vectordb/db.ts (loaded as SQLite extension)
    "@anthropic-ai/sdk",   // server/lib/llm/providers/anthropic.ts
  ],

  project: [
    "server/**/*.ts",
    "shared/**/*.ts",
    "renderer/**/*.js",
    "electron/**/*.ts",
    "scripts/**/*.{ts,cjs}",
    "tests/**/*.ts",
  ],

  /* knip автоматически уважает .gitignore — глобальные ignore-патерны
     не нужны для папок типа dist-electron/data. Оставляем только
     специфичные исключения которые не покрыты gitignore. */

  /* Сглаживание для IPC и dynamic-import-only модулей. */
  ignoreExportsUsedInFile: true,

  /* Тонкие настройки rules — начинаем мягко, ужесточим после Servitor cleanup
     который разберёт текущие 27 unused exports + 1 unused file (pdf-worker.ts)
     + 3 unused deps (7z-bin/7zip-bin/marked). См. Roadmap пост-релиз. */
  rules: {
    files: "warn",
    dependencies: "warn",
    devDependencies: "warn",
    unlisted: "warn",
    binaries: "warn",
    unresolved: "error",
    exports: "warn",
    types: "warn",
    nsExports: "warn",
    nsTypes: "warn",
    duplicates: "warn",
    enumMembers: "warn",
  },
};

export default config;
