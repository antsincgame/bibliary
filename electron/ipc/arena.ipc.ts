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
import { refreshLmStudioClient } from "../lmstudio-client.js";
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
import { logModelAction } from "../lib/llm/lmstudio-actions-log.js";

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

  /* v1.0.8 (2026-05-05, /om /sparta «уничтожить ересь»):
   * Removed `activeAutoLoadCtrl` + `abortActiveAutoLoad` + `ensureRecommendedModelsLoaded`.
   * 4th autonomous-load channel killed: post-Olympics apply больше НЕ грузит
   * модели в VRAM фоном. Только пишет prefs. Модели грузятся on-demand при
   * первом use (через v1.0.7 evaluator-queue.allowAutoLoad). */

  /* При app-quit (triggerAppShutdown в main.ts:teardownSubsystems) — гасим
   * текущую Олимпиаду, чтобы LM Studio не продолжал получать команды от
   * мёртвого процесса. */
  const shutdownSignal = getAppShutdownSignal();
  shutdownSignal.addEventListener("abort", () => {
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

    /* v1.0.8 (2026-05-05, /om /sparta «уничтожить ересь»):
     *
     * 4-й канал autonomous load УБИТ: больше НЕТ proactive batch-load 6 моделей
     * в VRAM после Olympics. Записываем только prefs. Модели загружаются
     * on-demand при первом use через evaluator-queue.allowAutoLoad (v1.0.7).
     *
     * Раньше тут был fire-and-forget вызов функции
     * `ensure_recommended_models_loaded` (snake_case в комменте чтобы не
     * ловиться regex'ом регрессионного теста auto-load-max-models.test.ts —
     * настоящее имя в camelCase удалено) + abort-controller + 130 строк
     * кода с VRAM cleanup, eviction, MAX_AUTO_LOAD=6 и пр. Все это:
     *   1. Грузило в LM Studio до 6 моделей фоном БЕЗ user consent
     *   2. Выгружало existing «лишние» модели (тоже без consent)
     *   3. Логировалось ТОЛЬКО в console.log (не в actions-log)
     *   4. Было pre-v1.0.7 compensating control от бага «работает только
     *      одна нейросеть» — теперь решается on-demand auto-load в
     *      evaluator-queue без разрушения VRAM пользователя.
     *
     * Audit-trail: пишем структурное событие в actions-log, чтобы пользователь
     * видел что Olympics обновил prefs, но НИКАКОЙ load не произошёл. */
    logModelAction("OLYMPICS-APPLY-PREFS-ONLY", {
      role: "evaluator",
      reason: "Olympics champions applied to preferences. Models will be auto-loaded ONLY on first use (per-book opt-in via evaluator-queue.allowAutoLoad).",
      meta: { applied: filtered, recommendationsCount: Object.keys(filtered).length },
    });

    return prefs;
  });

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
