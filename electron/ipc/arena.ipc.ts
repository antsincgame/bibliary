/**
 * Olympics IPC — model calibration tournament for local LM Studio models.
 *
 * Историческая заметка: модуль раньше назывался Arena (Shadow Arena с Elo-рейтингом),
 * но в Apr 2026 Shadow Arena была удалена в пользу Олимпиады (детерминированной,
 * управляемой пользователем, с явным lifecycle для безопасности RAM/VRAM).
 *
 * IPC-каналы оставлены с префиксом `arena:*` для backward-compat с preload.ts —
 * переименование channel'ов даёт нулевой выигрыш, но ломает рендерер. Имя файла
 * можно переименовать в olympics.ipc.ts, если в проекте больше нигде не нужен `arena:`.
 */

import { BrowserWindow, ipcMain } from "electron";
import { promises as fs } from "fs";
import * as path from "path";
import { getPreferencesStore, type Preferences } from "../lib/preferences/store.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";
import { runOlympics, type OlympicsReport, type OlympicsRole } from "../lib/llm/arena/olympics.js";
import { refreshLmStudioClient, listLoaded, loadModel } from "../lmstudio-client.js";
import { getAppShutdownSignal } from "../lib/app-lifecycle.js";
import {
  CustomDisciplineSchema,
  type CustomDiscipline,
} from "../lib/llm/arena/custom-disciplines.js";
import {
  saveDisciplineImage,
  loadDisciplineImageDataUrl,
  deleteDisciplineImage,
} from "../lib/llm/arena/discipline-images.js";

function getOlympicsReportPath(): string {
  const dataDir = process.env.BIBLIARY_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "olympics-report.json");
}

async function persistOlympicsReport(report: OlympicsReport): Promise<void> {
  try {
    const p = getOlympicsReportPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(report, null, 2), "utf-8");
  } catch (err) {
    console.warn("[arena] failed to persist Olympics report:", err);
  }
}

/**
 * Iter 14.3 (2026-05-04): partial-progress persistence.
 *
 * До этого фикса отчёт сохранялся ТОЛЬКО после полного `runOlympics`
 * — если приложение упало, пользователь нажал «Очистить кэш», или
 * `applyOlympicsRecommendations` бросил ошибку — все результаты
 * пропадали, и пользователь видел «обнуление» Олимпиады.
 *
 * Теперь сохраняем JSONL-стрим per-model результатов:
 *   data/olympics-progress.jsonl
 * Каждая строка = JSON с полем `discipline`, `model`, `score`, etc.
 * При старте новой Олимпиады — truncate. При краше — UI может
 * прочитать этот файл и показать частичные результаты.
 */
function getOlympicsProgressPath(): string {
  const dataDir = process.env.BIBLIARY_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "olympics-progress.jsonl");
}

async function truncateOlympicsProgress(): Promise<void> {
  try {
    const p = getOlympicsProgressPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "", "utf-8");
  } catch (err) {
    console.warn("[arena] failed to truncate progress JSONL:", err);
  }
}

async function appendOlympicsProgress(record: Record<string, unknown>): Promise<void> {
  try {
    const p = getOlympicsProgressPath();
    await fs.appendFile(p, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    console.warn("[arena] failed to append progress record:", err);
  }
}

async function loadPersistedOlympicsReport(): Promise<OlympicsReport | null> {
  try {
    const raw = await fs.readFile(getOlympicsReportPath(), "utf-8");
    return JSON.parse(raw) as OlympicsReport;
  } catch {
    return null;
  }
}

export function registerArenaIpc(): void {
  function broadcastPreferencesChanged(prefs: Preferences): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("preferences:changed", prefs);
      }
    }
  }

  /* Lock-status — нужен Олимпиаде для UI индикатора «LM Studio занята». */
  ipcMain.handle("arena:get-lock-status", async () => {
    return globalLlmLock.getStatus();
  });

  /* ─── Олимпиада: реальный турнир локальных моделей через LM Studio ─── */

  let activeOlympicsCtrl: AbortController | null = null;
  /**
   * Iter 14.3 (2026-05-04, /imperor): отдельный AbortController для
   * фонового auto-load после applyOlympicsRecommendations.
   * Раньше auto-load запускался fire-and-forget без отмены — при выходе
   * из приложения или повторной Олимпиаде старая загрузка моделей
   * продолжала держать LM Studio занятым (зомби-процесс симптомы).
   */
  let activeAutoLoadCtrl: AbortController | null = null;
  function abortActiveAutoLoad(reason: string): void {
    if (activeAutoLoadCtrl) {
      console.log(`[arena] aborting active auto-load: ${reason}`);
      activeAutoLoadCtrl.abort();
      activeAutoLoadCtrl = null;
    }
  }

  /* При app-quit (triggerAppShutdown в main.ts:teardownSubsystems) — гасим
   * любую активную фоновую загрузку моделей и текущую Олимпиаду, чтобы LM
   * Studio не продолжал получать команды от мёртвого процесса. */
  const shutdownSignal = getAppShutdownSignal();
  shutdownSignal.addEventListener("abort", () => {
    abortActiveAutoLoad("app-shutdown");
    if (activeOlympicsCtrl) {
      console.log("[arena] aborting active Olympics: app-shutdown");
      activeOlympicsCtrl.abort();
      activeOlympicsCtrl = null;
    }
  }, { once: true });

  ipcMain.handle("arena:run-olympics", async (e, payload: unknown): Promise<OlympicsReport> => {
    if (activeOlympicsCtrl) {
      throw new Error("Олимпиада уже идёт. Подожди или нажми «Отмена».");
    }
    const lock = globalLlmLock.isBusy();
    if (lock.busy) {
      globalLlmLock.recordSkip(lock.reasons);
      throw new Error(`LM Studio сейчас занята: ${lock.reasons.join("; ")}. Останови импорт/оценку и запусти Олимпиаду снова.`);
    }
    const args = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const ctrl = new AbortController();
    activeOlympicsCtrl = ctrl;
    const unregisterOlympicsProbe = globalLlmLock.registerProbe("olympics", () => ({
      busy: true,
      reason: "Olympics model calibration is running",
    }));

    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (channel: string, data: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    };

    /* Iter 14.3 — обнуляем JSONL-progress перед стартом, чтобы UI после
     * краша видел только текущий прогон. */
    await truncateOlympicsProgress();
    await appendOlympicsProgress({
      type: "olympics.start",
      ts: new Date().toISOString(),
      requestedModels: Array.isArray(args.models) ? args.models : null,
      requestedDisciplines: Array.isArray(args.disciplines) ? args.disciplines : null,
      testAll: args.testAll === true,
    });

    try {
      const report = await runOlympics({
        models: Array.isArray(args.models) ? (args.models as string[]) : undefined,
        disciplines: Array.isArray(args.disciplines) ? (args.disciplines as string[]) : undefined,
        testAll: args.testAll === true,
        roles: Array.isArray(args.roles) ? (args.roles as OlympicsRole[]) : undefined,
        signal: ctrl.signal,
        onProgress: (ev) => {
          send("arena:olympics-progress", ev);
          /* Стримим только «крупные» события (model.done / discipline.done /
           * load_failed) в jsonl. Низкоуровневые logs/loading опускаем — они
           * нужны только для live UI, не для restore. fire-and-forget. */
          if (ev.type === "olympics.model.done"
              || ev.type === "olympics.discipline.done"
              || ev.type === "olympics.model.load_failed"
              || ev.type === "olympics.vram_guard") {
            void appendOlympicsProgress({ ...ev, ts: new Date().toISOString() });
          }
        },
      });
      if (ctrl.signal.aborted) {
        throw new Error("Olympics aborted by user");
      }
      /* CRITICAL Iter 14.3: persist ДО возврата в renderer.
       * Раньше persist был void (fire-and-forget), и если auto-apply падал —
       * fs.writeFile мог не успеть до краша process. Теперь awaited. */
      await persistOlympicsReport(report);
      await appendOlympicsProgress({
        type: "olympics.persisted",
        ts: new Date().toISOString(),
        modelsRun: report.models.length,
        disciplineCount: report.disciplineCount,
        recommendations: report.recommendationsByScore,
      });
      return report;
    } finally {
      unregisterOlympicsProbe();
      activeOlympicsCtrl = null;
    }
  });

  ipcMain.handle("arena:cancel-olympics", async (): Promise<boolean> => {
    if (!activeOlympicsCtrl) return false;
    activeOlympicsCtrl.abort();
    return true;
  });

  ipcMain.handle("arena:clear-olympics-cache", async () => {
    const { clearOlympicsCache } = await import("../lib/llm/arena/olympics.js");
    clearOlympicsCache();
    try { await fs.unlink(getOlympicsReportPath()); } catch { /* file may not exist */ }
    return { ok: true };
  });

  ipcMain.handle("arena:get-last-report", async (): Promise<OlympicsReport | null> => {
    return loadPersistedOlympicsReport();
  });

  ipcMain.handle("arena:apply-olympics-recommendations", async (_e, payload: unknown): Promise<Preferences> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("apply-olympics-recommendations: ожидается объект {recommendations}");
    }
    const recs = (payload as { recommendations?: Record<string, string> }).recommendations;
    if (!recs || typeof recs !== "object") throw new Error("recommendations отсутствуют");

    /* Whitelist: только эти ключи разрешено применять (MVP v1.0 -- 4 роли). */
    const ALLOWED = new Set([
      "extractorModel",
      "evaluatorModel",
      "visionModelKey",
    ]);
    const filtered: Partial<Preferences> = {};
    for (const [k, v] of Object.entries(recs)) {
      if (ALLOWED.has(k) && typeof v === "string" && v.trim().length > 0) {
        (filtered as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(filtered).length === 0) {
      throw new Error("Нет валидных рекомендаций для применения");
    }
    console.log("[arena/apply-recommendations] applying:", JSON.stringify(filtered));
    await appendOlympicsProgress({
      type: "apply-recommendations",
      ts: new Date().toISOString(),
      filtered,
    });

    await getPreferencesStore().set(filtered);
    modelRoleResolver.invalidate();
    refreshLmStudioClient();
    const prefs = await getPreferencesStore().getAll();
    broadcastPreferencesChanged(prefs);

    /* Iter 14.3 — отменяем предыдущий auto-load (если был) и запускаем новый
     * с фрешным AbortController. registerProbe в globalLlmLock — чтобы UI
     * корректно показывал «LM Studio занята: arena auto-load» во время
     * фонового переключения, а другие IPC (импорт, evaluator) ждали. */
    abortActiveAutoLoad("new apply-recommendations request");
    const autoLoadCtrl = new AbortController();
    activeAutoLoadCtrl = autoLoadCtrl;
    const unregisterAutoLoadProbe = globalLlmLock.registerProbe("arena.auto-load", () => ({
      busy: !autoLoadCtrl.signal.aborted,
      reason: "Arena: switching to recommended models",
    }));

    /* ── Auto-load recommended models into LM Studio ──
     * Olympics только записывает prefs, но если модели не загружены — весь
     * production pipeline (vision, evaluator, crystallizer) видит null при
     * resolveModelForRole и skip'ает задачи. Здесь мы загружаем unique модели
     * из рекомендаций, которых ещё нет в LM Studio loaded list.
     *
     * Стратегия VRAM: загружаем последовательно, не более 2 уникальных
     * моделей (primary = extractorModel, secondary = visionModelKey).
     * Остальные роли часто разделяют одну из этих двух моделей.
     * Если модель уже загружена — пропускаем. Ошибка load — не фатальна. */
    void ensureRecommendedModelsLoaded(filtered, autoLoadCtrl.signal)
      .catch((err) => {
        if (autoLoadCtrl.signal.aborted) {
          console.log("[arena] auto-load aborted (expected)");
        } else {
          console.warn("[arena] auto-load after apply failed (non-fatal):", err);
        }
      })
      .finally(() => {
        unregisterAutoLoadProbe();
        if (activeAutoLoadCtrl === autoLoadCtrl) activeAutoLoadCtrl = null;
      });

    return prefs;
  });

  async function ensureRecommendedModelsLoaded(
    recs: Partial<Preferences>,
    signal?: AbortSignal,
  ): Promise<void> {
    const PRIORITY_KEYS = ["extractorModel", "visionModelKey", "evaluatorModel"] as const;
    /* Build PRIORITY-ORDERED list, не Set: первые 2 — гарантированно
     * extractorModel/visionModelKey/evaluatorModel (если заданы), остальные —
     * вспомогательные роли. Раньше Set дедуплицировал но порядок
     * insertion-зависимый: если evaluator оказался впереди extractor по
     * `Object.entries`, то slice(0,2) мог дать [evaluator, vision] вместо
     * [extractor, vision]. */
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const pk of PRIORITY_KEYS) {
      const val = (recs as Record<string, unknown>)[pk];
      if (typeof val === "string" && val.trim().length > 0 && !seen.has(val.trim())) {
        const k = val.trim();
        orderedKeys.push(k);
        seen.add(k);
      }
    }
    for (const [, val] of Object.entries(recs)) {
      if (typeof val === "string" && val.trim().length > 0 && !seen.has(val.trim())) {
        const k = val.trim();
        orderedKeys.push(k);
        seen.add(k);
      }
    }
    if (orderedKeys.length === 0) return;
    if (signal?.aborted) {
      console.log("[arena/auto-load] aborted before listLoaded");
      return;
    }

    let loaded: Array<{ modelKey: string }>;
    try {
      loaded = await listLoaded();
    } catch {
      return;
    }
    if (signal?.aborted) {
      console.log("[arena/auto-load] aborted after listLoaded");
      return;
    }
    const alreadyLoaded = new Set(loaded.map((m) => m.modelKey));
    const toLoad = orderedKeys.filter((k) => !alreadyLoaded.has(k));
    if (toLoad.length === 0) return;

    /* Iter 14.5 (2026-05-04, день рождения user): MAX_AUTO_LOAD 2 → 6.
     *
     * Корень бага «работает только одна нейросеть»: после Олимпиады юзер
     * получает champion-set из 6-8 уникальных моделей (по одной на роль:
     * crystallizer / vision_meta / evaluator / layout_assistant /
     * lang_detector / translator / ukrainian_specialist). Старый лимит 2
     * означал что 4-6 ролей оставались БЕЗ загруженной модели → resolver
     * выдавал null → fallback на единственную случайно загруженную модель,
     * которая часто не подходит по capability (например, не-vision модель
     * на роль vision_ocr). Результат — пайплайн «не работает».
     *
     * 6 моделей × ~3-5GB Q4_K_M = 18-30GB VRAM. На современных RTX 4080/90
     * (16-24GB) часть модели идёт offload в RAM; LM Studio handles это сам.
     * Если железа не хватает — load просто упадёт graceful (см. catch
     * ниже), и юзер увидит в логе какие именно модели не влезли.
     *
     * env BIBLIARY_MAX_AUTO_LOAD=N override для power-users. */
    const envOverride = process.env.BIBLIARY_MAX_AUTO_LOAD
      ? Math.max(1, Math.min(12, Number(process.env.BIBLIARY_MAX_AUTO_LOAD) | 0))
      : null;
    const MAX_AUTO_LOAD = envOverride ?? 6;
    const selected = toLoad.slice(0, MAX_AUTO_LOAD);
    const skipped = toLoad.slice(MAX_AUTO_LOAD);
    const targetSet = new Set(selected);
    if (skipped.length > 0) {
      console.warn(
        `[arena/auto-load] BIBLIARY_MAX_AUTO_LOAD=${MAX_AUTO_LOAD} reached, ` +
          `skipping ${skipped.length} model(s): ${skipped.join(", ")}. ` +
          `These roles will fall back to existing loaded models. ` +
          `Increase via env BIBLIARY_MAX_AUTO_LOAD if you have spare VRAM.`,
      );
    }

    /* VRAM safety: если в LM Studio УЖЕ загружено много моделей (≥3) и среди
     * них есть НЕ-recommended — выгружаем "лишние" перед загрузкой новых.
     * Иначе риск OOM/freeze: 2 новые × gpuOffload=max поверх 3+ старых
     * на 8GB VRAM = практически гарантированный hang LM Studio.
     *
     * Правило: оставляем те loaded модели, которые ЕСТЬ в orderedKeys
     * (юзер их явно рекомендовал), всё остальное выгружаем. Это безопасный
     * "garbage collect" перед заездом новых рекомендаций. */
    const VRAM_PRESSURE_THRESHOLD = 3;
    if (loaded.length >= VRAM_PRESSURE_THRESHOLD) {
      const recommendedSet = new Set(orderedKeys);
      const toEvict = loaded
        .map((m) => m.modelKey)
        .filter((k) => !recommendedSet.has(k) && !targetSet.has(k));
      if (toEvict.length > 0) {
        console.log(`[arena] VRAM cleanup: ${loaded.length} loaded, evicting ${toEvict.length} non-recommended: ${toEvict.join(", ")}`);
        const { unloadModel } = await import("../lmstudio-client.js");
        for (const evictKey of toEvict) {
          if (signal?.aborted) {
            console.log("[arena/auto-load] aborted during VRAM cleanup");
            return;
          }
          try {
            await unloadModel(evictKey);
            console.log(`[arena] VRAM cleanup OK: "${evictKey}" unloaded`);
          } catch (err) {
            console.warn(`[arena] VRAM cleanup "${evictKey}" failed (non-fatal):`, err);
          }
        }
      }
    }

    console.log(`[arena] auto-load: attempting ${selected.length} models: ${selected.join(", ")}`);
    for (const modelKey of selected) {
      if (signal?.aborted) {
        console.log(`[arena/auto-load] aborted before loading "${modelKey}"`);
        return;
      }
      try {
        await loadModel(modelKey, { gpuOffload: "max" });
        console.log(`[arena] auto-load OK: "${modelKey}"`);
      } catch (err) {
        console.warn(`[arena] auto-load "${modelKey}" failed:`, err);
      }
    }
    console.log("[arena] auto-load: completed");
  }

  /* ─── Custom Olympics disciplines (Iter 14.3 / 2026-05-05) ─── */

  /**
   * Список пользовательских дисциплин — для Settings UI.
   * Возвращает то, что лежит в preferences без compile (UI отображает
   * сами поля без вычислений score). Невалидные записи отфильтровываются.
   */
  ipcMain.handle("arena:list-custom-disciplines", async (): Promise<CustomDiscipline[]> => {
    const prefs = await getPreferencesStore().getAll();
    const raw = prefs.customOlympicsDisciplines as unknown[];
    if (!Array.isArray(raw)) return [];
    const out: CustomDiscipline[] = [];
    for (const item of raw) {
      const parsed = CustomDisciplineSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  });

  /**
   * Создаёт или обновляет пользовательскую дисциплину. Картинка (для
   * vision-ролей) передаётся отдельным IPC `arena:save-discipline-image`
   * ДО save-custom-discipline, и uploaded imageRef кладётся в payload.
   *
   * Валидация:
   *   - CustomDisciplineSchema (включая cross-field refine: vision требует
   *     imageRef, текстовые роли — нет)
   *   - id уникален в пределах пользовательских (статические дисциплины
   *     получают приоритет в registry'е, но сохранение их id запрещено
   *     отдельно — UI не должен такое предлагать).
   */
  ipcMain.handle("arena:save-custom-discipline", async (_e, payload: unknown): Promise<CustomDiscipline> => {
    const parsed = CustomDisciplineSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`invalid CustomDiscipline payload: ${parsed.error.message}`);
    }
    const incoming = parsed.data;
    const now = new Date().toISOString();
    const existing = (await getPreferencesStore().getAll()).customOlympicsDisciplines as CustomDiscipline[] | undefined;
    const list = Array.isArray(existing) ? [...existing] : [];
    if (list.length >= 200 && !list.some((d) => d.id === incoming.id)) {
      throw new Error("Достигнут лимит пользовательских дисциплин (200). Удалите ненужные перед созданием новых.");
    }
    const idx = list.findIndex((d) => d.id === incoming.id);
    const previous = idx >= 0 ? list[idx]! : null;

    /* Orphan-cleanup картинок при update:
       1. role-switch (vision → text): старая картинка осталась orphan,
          новый imageRef = undefined — нужно удалить файл.
       2. замена картинки (другой imageRef, например смена расширения
          .png → .jpg): старый файл нужно удалить, новый уже сохранён
          через arena:save-discipline-image. */
    if (previous?.imageRef && previous.imageRef !== incoming.imageRef) {
      await deleteDisciplineImage(previous.imageRef);
    }

    const next: CustomDiscipline = {
      ...incoming,
      createdAt: previous ? (previous.createdAt ?? now) : now,
      updatedAt: now,
    };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    await getPreferencesStore().set({ customOlympicsDisciplines: list });
    return next;
  });

  /**
   * Удаляет дисциплину по id и (best-effort) её картинку.
   */
  ipcMain.handle("arena:delete-custom-discipline", async (_e, payload: unknown): Promise<{ ok: boolean; deleted: boolean }> => {
    const id = (payload && typeof payload === "object" ? (payload as { id?: unknown }).id : undefined);
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("delete-custom-discipline: ожидается {id: string}");
    }
    const existing = (await getPreferencesStore().getAll()).customOlympicsDisciplines as CustomDiscipline[] | undefined;
    if (!Array.isArray(existing)) return { ok: true, deleted: false };
    const target = existing.find((d) => d.id === id);
    if (!target) return { ok: true, deleted: false };
    const next = existing.filter((d) => d.id !== id);
    await getPreferencesStore().set({ customOlympicsDisciplines: next });
    if (target.imageRef) await deleteDisciplineImage(target.imageRef);
    return { ok: true, deleted: true };
  });

  /**
   * Сохраняет картинку для дисциплины. UI вызывает ДО save-custom-discipline
   * и кладёт возвращённый imageRef в payload.
   *
   * Принимает `{ disciplineId, base64, ext }` где base64 — без префикса
   * `data:image/...;base64,`. Возвращает `{ imageRef }`.
   */
  ipcMain.handle("arena:save-discipline-image", async (_e, payload: unknown): Promise<{ imageRef: string }> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("save-discipline-image: ожидается {disciplineId, base64, ext}");
    }
    const { disciplineId, base64, ext } = payload as { disciplineId?: unknown; base64?: unknown; ext?: unknown };
    if (typeof disciplineId !== "string" || typeof base64 !== "string" || typeof ext !== "string") {
      throw new Error("save-discipline-image: invalid types");
    }
    const imageRef = await saveDisciplineImage(disciplineId, base64, ext);
    return { imageRef };
  });

  /**
   * Загружает картинку как data-URL для preview в UI.
   */
  ipcMain.handle("arena:get-discipline-image", async (_e, payload: unknown): Promise<{ dataUrl: string | null }> => {
    const imageRef = (payload && typeof payload === "object" ? (payload as { imageRef?: unknown }).imageRef : undefined);
    if (typeof imageRef !== "string" || imageRef.length === 0) {
      return { dataUrl: null };
    }
    const dataUrl = await loadDisciplineImageDataUrl(imageRef);
    return { dataUrl };
  });
}
