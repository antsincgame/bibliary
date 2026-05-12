/**
 * Root barrel for the web renderer api-client.
 *
 * Установлен в `window.api` как side-effect import — script tag в
 * index.html грузит этот модуль ПЕРЕД router.js, чтобы все callsites
 * `window.api.*` в renderer'е работали без изменений.
 *
 * Surface area матчит legacy Electron preload (`electron/preload.ts`)
 * по shape, но методы идут через fetch(/api/*) с cookie-based auth.
 * Push events (onImportProgress, onEvaluatorEvent, ...) пока stub'ы —
 * Phase 3b добавит Appwrite Realtime adapter.
 */

import { auth } from "./api-client/auth.js";
import { datasets } from "./api-client/datasets.js";
import { library } from "./api-client/library.js";
import { lmstudio } from "./api-client/lmstudio.js";
import { preferences } from "./api-client/preferences.js";
import { scanner } from "./api-client/scanner.js";
import { appMenu, datasetV2, resilience } from "./api-client/stubs.js";
import { system } from "./api-client/system.js";
import { getCollections, vectordb } from "./api-client/vectordb.js";

/** @type {Record<string, unknown>} */
const api = {
  appMenu,
  auth,
  datasets,
  datasetV2,
  getCollections,
  library,
  lmstudio,
  preferences,
  resilience,
  scanner,
  smokeMode: false,
  system,
  vectordb,
};

/* Side-effect set: позволяет renderer-у читать window.api в любой точке
 * после того как script tag загрузился. ES module imports ordered, так
 * что router.js увидит уже инициализированный window.api.
 *
 * В Electron-режиме preload.ts уже выставил window.api (IPC-backed) до
 * любого renderer-скрипта. В этом случае не перезаписываем — IPC mode
 * имеет приоритет (дешевле, native dialogs, push events работают).
 * Detect by presence of `appMenu.onNavigate` plus IPC marker. */
if (!(/** @type {any} */ (window).api)) {
  /** @type {any} */
  (globalThis).api = api;
  /** @type {any} */
  (window).api = api;
}

export default api;
