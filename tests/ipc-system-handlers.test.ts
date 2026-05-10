/**
 * tests/ipc-system-handlers.test.ts
 *
 * Unit-тесты для `validateOpenExternalUrl` — security-критичная функция
 * IPC handler'а `system:open-external`. Защищает от запуска
 * javascript:/file:/chrome:/data: URI через shell.openExternal (что в
 * Electron'е может привести к code execution на стороне ОС).
 *
 * Раньше эта логика жила inline в registerSystemIpc и не была покрыта
 * никакими тестами. Регрессия типа «забыли проверку scheme» или
 * «добавили file:/data: в whitelist по ошибке» проходила бы тихо.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateOpenExternalUrl,
  ALLOWED_OPEN_SCHEMES,
} from "../electron/ipc/handlers/system.handlers.ts";

/* ─── Allowed schemes ─────────────────────────────────────────────── */

test("[ipc/system] validateOpenExternalUrl: accepts http://", () => {
  const r = validateOpenExternalUrl("http://example.com/path");
  assert.equal(r.ok, true);
});

test("[ipc/system] validateOpenExternalUrl: accepts https://", () => {
  const r = validateOpenExternalUrl("https://example.com/some/path?query=1");
  assert.equal(r.ok, true);
});

test("[ipc/system] validateOpenExternalUrl: accepts lmstudio:// (deep-link)", () => {
  const r = validateOpenExternalUrl("lmstudio://download/some-model");
  assert.equal(r.ok, true);
});

test("[ipc/system] ALLOWED_OPEN_SCHEMES = exactly the documented 3", () => {
  /* Регрессия-страж: если кто-то по ошибке добавит file:, javascript: и т.п.,
     этот тест упадёт и потребует ревью изменения. */
  assert.deepEqual(ALLOWED_OPEN_SCHEMES.sort(), ["http:", "https:", "lmstudio:"]);
});

/* ─── Rejected: dangerous schemes (security) ──────────────────────── */

test("[ipc/system] validateOpenExternalUrl: rejects javascript: (XSS-вектор)", () => {
  const r = validateOpenExternalUrl("javascript:alert('xss')");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /scheme not allowed/);
});

test("[ipc/system] validateOpenExternalUrl: rejects vbscript:", () => {
  const r = validateOpenExternalUrl("vbscript:msgbox('xss')");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /scheme not allowed/);
});

test("[ipc/system] validateOpenExternalUrl: rejects file:// (path-traversal вектор)", () => {
  const r = validateOpenExternalUrl("file:///etc/passwd");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /scheme not allowed: file:/);
});

test("[ipc/system] validateOpenExternalUrl: rejects data:text/html", () => {
  const r = validateOpenExternalUrl("data:text/html,<script>alert(1)</script>");
  assert.equal(r.ok, false);
});

test("[ipc/system] validateOpenExternalUrl: rejects chrome://", () => {
  const r = validateOpenExternalUrl("chrome://settings");
  assert.equal(r.ok, false);
});

test("[ipc/system] validateOpenExternalUrl: rejects about:blank", () => {
  const r = validateOpenExternalUrl("about:blank");
  assert.equal(r.ok, false);
});

test("[ipc/system] validateOpenExternalUrl: rejects blob:", () => {
  const r = validateOpenExternalUrl("blob:https://example.com/uuid");
  assert.equal(r.ok, false);
});

test("[ipc/system] validateOpenExternalUrl: rejects ms-windows-store:// (potential RCE)", () => {
  const r = validateOpenExternalUrl("ms-windows-store://pdp/?productid=evil");
  assert.equal(r.ok, false);
});

/* ─── Rejected: invalid input ─────────────────────────────────────── */

test("[ipc/system] validateOpenExternalUrl: rejects empty string", () => {
  const r = validateOpenExternalUrl("");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "url required");
});

test("[ipc/system] validateOpenExternalUrl: rejects non-string types", () => {
  for (const v of [null, undefined, 42, true, {}, [], () => "evil"]) {
    const r = validateOpenExternalUrl(v);
    assert.equal(r.ok, false, `must reject: ${JSON.stringify(v)}`);
    assert.equal(r.reason, "url required");
  }
});

test("[ipc/system] validateOpenExternalUrl: rejects unparseable strings", () => {
  for (const v of ["not a url", "://no-scheme", "http:"]) {
    const r = validateOpenExternalUrl(v);
    assert.equal(r.ok, false, `must reject: ${v}`);
  }
});

/* ─── Adversarial inputs ──────────────────────────────────────────── */

test("[ipc/system] validateOpenExternalUrl: case-sensitive scheme rejection", () => {
  /* URL constructor lower-cases scheme в protocol → "JAVASCRIPT:" станет
     "javascript:" и явно отклонится. Test страхует от bypass через регистр. */
  const r = validateOpenExternalUrl("JAVASCRIPT:alert(1)");
  assert.equal(r.ok, false);
});

test("[ipc/system] validateOpenExternalUrl: trailing whitespace doesn't bypass scheme check", () => {
  /* URL constructor парсит "  javascript:..." как path внутри текущего
     scheme'а — но без base URL это просто invalid. */
  const r = validateOpenExternalUrl(" javascript:alert(1)");
  assert.equal(r.ok, false);
});

test("[ipc/system] validateOpenExternalUrl: doesn't accept scheme inside path", () => {
  /* Атакующий может пытаться подсунуть javascript: внутри https://: 
     "https://evil.com/javascript:alert(1)" — это валидный https URL,
     scheme = "https:", путь содержит "javascript:" но это просто строка
     — НЕ исполняется (shell.openExternal откроет браузер). Поэтому ok. */
  const r = validateOpenExternalUrl("https://evil.com/javascript:alert(1)");
  assert.equal(r.ok, true, "https URL остаётся валидным даже с подозрительными частями в path");
});
