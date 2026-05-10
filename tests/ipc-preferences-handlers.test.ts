/**
 * tests/ipc-preferences-handlers.test.ts
 *
 * Unit-тесты для extract'нутых pure handler-функций из preferences.ipc.ts.
 * До этого теста IPC слой preferences (8 хендлеров) был полностью не
 * покрыт — регрессия типа «забыли вызвать applyRuntimeSideEffects после
 * import-profile» или «sanitize пропускает не-string значения» проходила
 * бы тихо до production.
 *
 * Поскольку handlers разнесены с `ipcMain.handle` calls (см.
 * preferences.handlers.ts), мы можем дергать их напрямую без Electron.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preferencesGetAll,
  preferencesGetDefaults,
  preferencesSet,
  preferencesReset,
  preferencesGetProfile,
  preferencesExportProfile,
  preferencesImportProfile,
  preferencesApplyProfile,
  pickProfile,
  sanitizeImportedProfile,
  PROFILE_KEYS,
  type PreferencesIpcDeps,
} from "../electron/ipc/handlers/preferences.handlers.ts";
import type { Preferences } from "../electron/lib/preferences/store.ts";

/* ─── Test fixtures ───────────────────────────────────────────────── */

/** Минимально-валидный набор preferences для тестов. */
function makePrefs(overrides: Partial<Preferences> = {}): Preferences {
  return {
    /* Базовые — лишь несколько ключей нужны для assertion'ов; остальные
       можно cast'нуть, т.к. тесты не валидируют полную Preferences схему. */
    readerModel: "qwen3-4b",
    extractorModel: "qwen3-4b",
    visionOcrModel: "qwen3-vl",
    ...overrides,
  } as Preferences;
}

interface StubStateOptions {
  initial?: Preferences;
  saveDialogResult?: { canceled: boolean; filePath?: string };
  openDialogResult?: { canceled: boolean; filePaths: string[] };
  readFileResult?: string;
  readFileThrows?: Error;
}

interface StubState {
  prefs: Preferences;
  setPrefsCalls: Array<Partial<Preferences>>;
  applySideEffectsCalls: Preferences[];
  broadcastCalls: Preferences[];
  resetCalls: number;
  writeFileCalls: Array<{ path: string; content: string }>;
  showSaveDialogCalls: number;
  showOpenDialogCalls: number;
  deps: PreferencesIpcDeps;
}

function makeStubDeps(opts: StubStateOptions = {}): StubState {
  const state: StubState = {
    prefs: opts.initial ?? makePrefs(),
    setPrefsCalls: [],
    applySideEffectsCalls: [],
    broadcastCalls: [],
    resetCalls: 0,
    writeFileCalls: [],
    showSaveDialogCalls: 0,
    showOpenDialogCalls: 0,
    deps: {} as PreferencesIpcDeps,
  };
  state.deps = {
    getAllPrefs: async () => state.prefs,
    getDefaults: () => makePrefs({ readerModel: "default-reader" }),
    setPrefs: async (partial) => {
      state.setPrefsCalls.push(partial);
      state.prefs = { ...state.prefs, ...partial };
      return state.prefs;
    },
    resetPrefs: async () => {
      state.resetCalls += 1;
      state.prefs = makePrefs({ readerModel: "default-reader" });
      return state.prefs;
    },
    applyRuntimeSideEffects: (prefs) => {
      state.applySideEffectsCalls.push(prefs);
    },
    broadcast: (prefs) => {
      state.broadcastCalls.push(prefs);
    },
    showSaveDialog: async () => {
      state.showSaveDialogCalls += 1;
      return opts.saveDialogResult ?? { canceled: false, filePath: "/tmp/export.json" };
    },
    showOpenDialog: async () => {
      state.showOpenDialogCalls += 1;
      return opts.openDialogResult ?? { canceled: false, filePaths: ["/tmp/import.json"] };
    },
    writeFile: async (path, content) => {
      state.writeFileCalls.push({ path, content });
    },
    readFile: async () => {
      if (opts.readFileThrows) throw opts.readFileThrows;
      return opts.readFileResult ?? "{}";
    },
  };
  return state;
}

/* ─── Pure helpers (pickProfile / sanitizeImportedProfile) ─────────── */

test("[ipc/preferences] pickProfile: extracts only PROFILE_KEYS from full prefs", () => {
  const prefs = makePrefs({ readerModel: "r", extractorModel: "e", visionOcrModel: "v" });
  const profile = pickProfile(prefs);
  assert.deepEqual(Object.keys(profile).sort(), [...PROFILE_KEYS].sort());
  assert.equal(profile.readerModel, "r");
});

test("[ipc/preferences] pickProfile: skips empty-string / undefined fields", () => {
  const prefs = makePrefs({ readerModel: "", extractorModel: "real", visionOcrModel: undefined as unknown as string });
  const profile = pickProfile(prefs);
  /* "" пропускается → нет readerModel; undefined тоже пропускается. */
  assert.equal(profile.readerModel, undefined);
  assert.equal(profile.extractorModel, "real");
  assert.equal(profile.visionOcrModel, undefined);
});

test("[ipc/preferences] sanitizeImportedProfile: accepts both {profile:{}} and flat shapes", () => {
  /* Старый формат — плоский. */
  const flat = sanitizeImportedProfile({ readerModel: "x", extractorModel: "y" });
  assert.equal(flat.readerModel, "x");
  assert.equal(flat.extractorModel, "y");
  /* Новый формат — обёрнутый. */
  const wrapped = sanitizeImportedProfile({ profile: { readerModel: "p", visionOcrModel: "v" } });
  assert.equal(wrapped.readerModel, "p");
  assert.equal(wrapped.visionOcrModel, "v");
});

test("[ipc/preferences] sanitizeImportedProfile: rejects non-string values and unknown keys", () => {
  const result = sanitizeImportedProfile({
    readerModel: 123, /* number → отвергается */
    extractorModel: null, /* null → отвергается */
    visionOcrModel: "valid",
    randomUnknownField: "should not appear",
  });
  assert.equal(result.readerModel, undefined, "number rejected");
  assert.equal(result.extractorModel, undefined, "null rejected");
  assert.equal(result.visionOcrModel, "valid");
  assert.ok(!("randomUnknownField" in result), "unknown keys filtered");
});

test("[ipc/preferences] sanitizeImportedProfile: returns empty object for garbage input", () => {
  assert.deepEqual(sanitizeImportedProfile(null), {});
  assert.deepEqual(sanitizeImportedProfile(undefined), {});
  assert.deepEqual(sanitizeImportedProfile("string"), {});
  assert.deepEqual(sanitizeImportedProfile(42), {});
});

/* ─── preferencesGetAll / GetDefaults / Reset ────────────────────── */

test("[ipc/preferences] preferencesGetAll returns current state from deps", async () => {
  const state = makeStubDeps({ initial: makePrefs({ readerModel: "custom" }) });
  const result = await preferencesGetAll(state.deps);
  assert.equal(result.readerModel, "custom");
});

test("[ipc/preferences] preferencesGetDefaults returns DEFAULTS shape", () => {
  const state = makeStubDeps();
  const result = preferencesGetDefaults(state.deps);
  assert.equal(result.readerModel, "default-reader");
});

test("[ipc/preferences] preferencesReset → calls reset + applySideEffects + broadcast in order", async () => {
  const state = makeStubDeps({ initial: makePrefs({ readerModel: "before-reset" }) });
  const result = await preferencesReset(state.deps);
  assert.equal(state.resetCalls, 1);
  assert.equal(state.applySideEffectsCalls.length, 1);
  assert.equal(state.broadcastCalls.length, 1);
  assert.equal(result.readerModel, "default-reader");
  /* applyRuntimeSideEffects получил уже обновлённый объект. */
  assert.equal(state.applySideEffectsCalls[0].readerModel, "default-reader");
});

/* ─── preferencesSet ──────────────────────────────────────────────── */

test("[ipc/preferences] preferencesSet: valid partial → persists + applySideEffects + broadcast", async () => {
  const state = makeStubDeps();
  const partial = { extractorModel: "new-model" };
  const result = await preferencesSet(state.deps, partial);
  assert.equal(state.setPrefsCalls.length, 1);
  assert.deepEqual(state.setPrefsCalls[0], partial);
  assert.equal(state.applySideEffectsCalls.length, 1);
  assert.equal(state.broadcastCalls.length, 1);
  assert.equal(result.extractorModel, "new-model");
});

test("[ipc/preferences] preferencesSet: rejects null / non-object / undefined", async () => {
  const state = makeStubDeps();
  await assert.rejects(
    () => preferencesSet(state.deps, null),
    /Invalid preferences payload/,
    "null payload",
  );
  await assert.rejects(
    () => preferencesSet(state.deps, "not-an-object"),
    /Invalid preferences payload/,
    "string payload",
  );
  await assert.rejects(
    () => preferencesSet(state.deps, undefined),
    /Invalid preferences payload/,
    "undefined payload",
  );
  /* Никаких side-effects не должно случиться при rejected payload. */
  assert.equal(state.setPrefsCalls.length, 0);
  assert.equal(state.applySideEffectsCalls.length, 0);
});

/* ─── preferencesGetProfile / ExportProfile ────────────────────── */

test("[ipc/preferences] preferencesGetProfile: returns whitelisted profile + schema metadata", async () => {
  const state = makeStubDeps({
    initial: makePrefs({ readerModel: "r1", extractorModel: "e1", visionOcrModel: "v1" }),
  });
  const profile = await preferencesGetProfile(state.deps);
  assert.equal(profile.schema, "bibliary.profile/v1");
  assert.equal(profile.app.name, "Bibliary");
  assert.match(profile.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(profile.profile, { readerModel: "r1", extractorModel: "e1", visionOcrModel: "v1" });
});

test("[ipc/preferences] preferencesExportProfile: happy path writes JSON and returns path", async () => {
  const state = makeStubDeps({ saveDialogResult: { canceled: false, filePath: "/tmp/x.json" } });
  const result = await preferencesExportProfile(state.deps);
  assert.equal(result.path, "/tmp/x.json");
  assert.equal(state.showSaveDialogCalls, 1);
  assert.equal(state.writeFileCalls.length, 1);
  /* Записан валидный JSON со схемой. */
  const written = JSON.parse(state.writeFileCalls[0].content);
  assert.equal(written.schema, "bibliary.profile/v1");
});

test("[ipc/preferences] preferencesExportProfile: cancel → no write, returns null", async () => {
  const state = makeStubDeps({ saveDialogResult: { canceled: true, filePath: undefined } });
  const result = await preferencesExportProfile(state.deps);
  assert.equal(result.path, null);
  assert.equal(state.writeFileCalls.length, 0);
});

test("[ipc/preferences] preferencesExportProfile: missing showSaveDialog dep → throws", async () => {
  const state = makeStubDeps();
  const broken: PreferencesIpcDeps = { ...state.deps, showSaveDialog: undefined };
  await assert.rejects(() => preferencesExportProfile(broken), /requires showSaveDialog/);
});

/* ─── preferencesImportProfile ────────────────────────────────────── */

test("[ipc/preferences] preferencesImportProfile: happy path applies profile + broadcast", async () => {
  const validProfile = JSON.stringify({
    schema: "bibliary.profile/v1",
    profile: { readerModel: "imported-r", extractorModel: "imported-e", visionOcrModel: "imported-v" },
  });
  const state = makeStubDeps({
    openDialogResult: { canceled: false, filePaths: ["/tmp/in.json"] },
    readFileResult: validProfile,
  });
  const result = await preferencesImportProfile(state.deps);
  assert.equal(result.path, "/tmp/in.json");
  assert.deepEqual(result.appliedKeys.sort(), [...PROFILE_KEYS].sort());
  assert.equal(state.setPrefsCalls.length, 1);
  assert.equal(state.applySideEffectsCalls.length, 1);
  assert.equal(state.broadcastCalls.length, 1);
});

test("[ipc/preferences] preferencesImportProfile: cancel dialog → returns null path with empty applied", async () => {
  const state = makeStubDeps({ openDialogResult: { canceled: true, filePaths: [] } });
  const result = await preferencesImportProfile(state.deps);
  assert.equal(result.path, null);
  assert.deepEqual(result.appliedKeys, []);
  assert.equal(state.setPrefsCalls.length, 0, "no side-effects on cancel");
});

test("[ipc/preferences] preferencesImportProfile: file with NO valid profile keys → throws", async () => {
  const state = makeStubDeps({
    openDialogResult: { canceled: false, filePaths: ["/tmp/bad.json"] },
    readFileResult: JSON.stringify({ totally: "unrelated", profile: {} }),
  });
  await assert.rejects(
    () => preferencesImportProfile(state.deps),
    /не содержит валидных полей профиля/i,
  );
  /* Failure path не должен мутировать состояние. */
  assert.equal(state.setPrefsCalls.length, 0);
});

test("[ipc/preferences] preferencesImportProfile: file read error → wraps in friendly message", async () => {
  const state = makeStubDeps({
    openDialogResult: { canceled: false, filePaths: ["/tmp/missing.json"] },
    readFileThrows: new Error("ENOENT"),
  });
  await assert.rejects(
    () => preferencesImportProfile(state.deps),
    /Не удалось прочитать файл профиля/,
  );
});

test("[ipc/preferences] preferencesImportProfile: invalid JSON → wraps in friendly message", async () => {
  const state = makeStubDeps({
    openDialogResult: { canceled: false, filePaths: ["/tmp/broken.json"] },
    readFileResult: "{ not valid json",
  });
  await assert.rejects(
    () => preferencesImportProfile(state.deps),
    /Не удалось прочитать файл профиля/,
  );
});

/* ─── preferencesApplyProfile ─────────────────────────────────────── */

test("[ipc/preferences] preferencesApplyProfile: applies plain object profile", async () => {
  const state = makeStubDeps();
  const result = await preferencesApplyProfile(state.deps, {
    readerModel: "a",
    extractorModel: "b",
  });
  assert.deepEqual(result.appliedKeys.sort(), ["extractorModel", "readerModel"]);
  assert.equal(state.setPrefsCalls.length, 1);
  assert.equal(state.broadcastCalls.length, 1);
});

test("[ipc/preferences] preferencesApplyProfile: empty / invalid payload → throws", async () => {
  const state = makeStubDeps();
  await assert.rejects(
    () => preferencesApplyProfile(state.deps, {}),
    /не содержит валидных полей/i,
  );
  await assert.rejects(
    () => preferencesApplyProfile(state.deps, null),
    /не содержит валидных полей/i,
  );
  await assert.rejects(
    () => preferencesApplyProfile(state.deps, { totally: "garbage" }),
    /не содержит валидных полей/i,
  );
  /* Failure не должен мутировать. */
  assert.equal(state.setPrefsCalls.length, 0);
  assert.equal(state.applySideEffectsCalls.length, 0);
});

test("[ipc/preferences] preferencesApplyProfile: handles wrapped {profile:{...}} format", async () => {
  const state = makeStubDeps();
  const result = await preferencesApplyProfile(state.deps, {
    schema: "bibliary.profile/v1",
    profile: { visionOcrModel: "v" },
  });
  assert.deepEqual(result.appliedKeys, ["visionOcrModel"]);
});
