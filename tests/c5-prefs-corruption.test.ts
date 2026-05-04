/**
 * C5 regression — повреждённый preferences.json не должен молча
 * сбрасываться к defaults. Ожидаемое поведение:
 *   1. Битый файл переименовывается в `preferences.json.corrupted-<ts>`
 *   2. Дефолты восстанавливаются (юзер не теряет работоспособность app)
 *   3. takePrefsCorruptionEvent() возвращает событие с backupPath + reason
 *   4. console.error печатает диагностику
 *
 * До 14.4 readOverrides() имел `catch { return {}; }` — corrupted JSON
 * молча терялся, юзер видел сброс настроек без объяснения.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  FsPreferencesStore,
  takePrefsCorruptionEvent,
  DEFAULTS,
} from "../electron/lib/preferences/store.ts";

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-prefs-test-"));
}

test("C5: corrupted preferences.json (invalid JSON) → quarantine + signal event + defaults", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "preferences.json");

  /* Записываем заведомо битый JSON. */
  await fs.writeFile(file, "{ this is not valid JSON at all", "utf8");

  takePrefsCorruptionEvent(); /* очистка от предыдущих тестов */

  const store = new FsPreferencesStore(dir);
  await store.ensureDefaults();

  /* 1. Original битый файл переименован в .corrupted-<ts> */
  const entries = await fs.readdir(dir);
  const corruptedBackup = entries.find((e) => e.startsWith("preferences.json.corrupted-"));
  assert.ok(
    corruptedBackup,
    `Бэкап `.corrupted-<ts>` должен существовать. Found: ${entries.join(", ")}`,
  );

  /* 2. Свежий preferences.json создан с дефолтами. */
  const fresh = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(fresh.version, 1);
  assert.deepEqual(fresh.prefs, {});

  /* 3. Сигнал захвачен. */
  const ev = takePrefsCorruptionEvent();
  assert.ok(ev, "takePrefsCorruptionEvent должен вернуть событие");
  assert.ok(ev.backupPath?.endsWith(corruptedBackup), `backupPath = ${ev.backupPath}`);
  assert.ok(ev.reason.length > 0, "Reason не должен быть пустым");
  assert.ok(ev.detectedAt > 0, "detectedAt должен быть UNIX ms");

  /* 4. После take события — null (одноразовое потребление). */
  assert.equal(takePrefsCorruptionEvent(), null);

  /* 5. getAll возвращает дефолты — пользователь работоспособен. */
  const prefs = await store.getAll();
  assert.equal(prefs.searchScoreThreshold, DEFAULTS.searchScoreThreshold);
  assert.equal(prefs.ocrEnabled, DEFAULTS.ocrEnabled);

  await fs.rm(dir, { recursive: true, force: true });
});

test("C5: schema-mismatch (валидный JSON, но поле неправильного типа) → тоже quarantine", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "preferences.json");

  /* Валидный JSON, но не соответствует Zod-схеме. */
  await fs.writeFile(file, JSON.stringify({ version: 999, prefs: { ocrEnabled: "not-a-boolean" } }), "utf8");

  takePrefsCorruptionEvent();

  const store = new FsPreferencesStore(dir);
  await store.ensureDefaults();

  const entries = await fs.readdir(dir);
  const corruptedBackup = entries.find((e) => e.startsWith("preferences.json.corrupted-"));
  assert.ok(corruptedBackup, "Schema-mismatch тоже должен карантиниться");

  const ev = takePrefsCorruptionEvent();
  assert.ok(ev, "Schema-mismatch должен сигналить");

  await fs.rm(dir, { recursive: true, force: true });
});

test("C5: валидный preferences.json не вызывает corruption-сигнал", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "preferences.json");

  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, prefs: { ocrEnabled: false } }),
    "utf8",
  );

  takePrefsCorruptionEvent();

  const store = new FsPreferencesStore(dir);
  await store.ensureDefaults();

  /* Файл НЕ переименован — он валиден. */
  const entries = await fs.readdir(dir);
  const corruptedBackup = entries.find((e) => e.startsWith("preferences.json.corrupted-"));
  assert.equal(corruptedBackup, undefined, "Валидный файл не должен карантиниться");

  /* Никакого события. */
  assert.equal(takePrefsCorruptionEvent(), null);

  /* Override применился. */
  const prefs = await store.getAll();
  assert.equal(prefs.ocrEnabled, false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("C5: ENOENT (файл не существует) — НЕ событие повреждения, just first run", async () => {
  const dir = await makeTempDir();
  takePrefsCorruptionEvent();

  const store = new FsPreferencesStore(dir);
  await store.ensureDefaults();

  /* Файл создан с дефолтами, никакого .corrupted нет. */
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries.sort(), ["preferences.json"]);
  assert.equal(takePrefsCorruptionEvent(), null);

  await fs.rm(dir, { recursive: true, force: true });
});
