// ESLint v9 flat config для renderer/*.js — ловим РЕАЛЬНЫЕ баги, не стиль.
// Покрытие: vanilla JS UI слой (browser context). Electron/TS-сторона — через tsc.

import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "dist-portable/**",
      "out/**",
      "data/**",
      "renderer/marked.umd.js", // vendor (3rd-party, не редактируем)
    ],
  },
  {
    files: ["renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module", // renderer-скрипты грузятся через <script type="module">, используют import/export
      globals: {
        ...globals.browser,
        // preload bridge (electron/preload.ts → contextBridge.exposeInMainWorld("api", …))
        api: "readonly",
        // marked.umd.js устанавливает window.marked
        marked: "readonly",
      },
    },
    rules: {
      // === КРИТИЧНЫЕ (ошибки рантайма) ===
      "no-undef": "error", // ссылки на несуществующие имена — частый источник тихих багов в обработчиках
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-cond-assign": ["error", "always"], // ловит `if (x = 1)` вместо `==`
      "no-fallthrough": "error",
      "no-irregular-whitespace": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-optional-chaining": "error",
      "no-misleading-character-class": "error",
      "no-loss-of-precision": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "getter-return": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-debugger": "error",

      // === ВАЖНЫЕ (предупреждения, не блокирующие) ===
      "no-empty": ["warn", { allowEmptyCatch: false }], // голые catch — наша основная цель
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-unused-expressions": ["warn", { allowShortCircuit: true, allowTernary: true }],

      // === СТИЛЬ — выключено, чтобы не флудить ===
      "no-console": "off",
      "no-prototype-builtins": "off",
      "no-control-regex": "off",
    },
  },
];
