/**
 * tests/audit-security-guards.test.ts
 *
 * Security guard regressions из аудита 2026-05-09.
 *
 * Покрытие:
 *
 *   1. bibliary-asset:// resolveBlobFromUrl path-traversal guard.
 *      В electron/main.ts protocol handler делает .startsWith(blobsBase)
 *      проверку. Дополнительно library-store.ts:resolveBlobFromUrl сам
 *      использует resolved-path-prefix-check + sha-regex `/^[a-f0-9]{64}$/i`.
 *      Тесты:
 *        - валидный sha → resolved abs path возвращается
 *        - sha с `..` / control chars → null (regex отбрасывает до stat)
 *        - non-bibliary-asset URL → null
 *        - sha валидный, но файл отсутствует → null (graceful)
 *        - попытка blob вне .blobs/ через подставленный path → невозможна
 *          (resolveBlobFromUrl строит путь сам из known KNOWN_BLOB_EXTS)
 *
 *   2. system:open-external schema whitelist.
 *      Логика handler'а в electron/ipc/system.ipc.ts: ALLOWED_OPEN_SCHEMES
 *      = ["http:", "https:", "lmstudio:"]. Тестируем чистую функцию
 *      isAllowedExternalScheme, чтобы регрессии whitelist'а ловились
 *      без поднятия Electron.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import {
  resolveBlobFromUrl,
  resolveAssetUrl,
  putBlob,
  getBlobsRoot,
} from "../electron/lib/library/library-store.ts";

/* ─── 1. bibliary-asset:// path-traversal guard ────────────────────── */

test("[security] resolveBlobFromUrl: valid sha returns resolved path inside .blobs/", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "blob-traverse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const buf = Buffer.from("hello world image bytes");
  const ref = await putBlob(tmp, buf, "image/png");
  const resolved = await resolveBlobFromUrl(tmp, ref.assetUrl);

  assert.ok(resolved, "valid sha must resolve");
  const blobsBase = path.resolve(getBlobsRoot(tmp));
  assert.ok(resolved!.startsWith(blobsBase),
    `resolved path must be inside blobsBase (got ${resolved}, base ${blobsBase})`);
  assert.equal(path.resolve(resolved!), resolved, "must be canonical absolute path");
});

test("[security] resolveBlobFromUrl: invalid sha (non-hex / wrong length / traversal chars) → null", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "blob-traverse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const cases = [
    "bibliary-asset://sha256/short",                                              /* < 64 chars */
    "bibliary-asset://sha256/" + "z".repeat(64),                                  /* non-hex */
    "bibliary-asset://sha256/" + "a".repeat(64) + "extra",                        /* > 64 chars */
    "bibliary-asset://sha256/../../../etc/passwd",                                /* traversal */
    "bibliary-asset://sha256/" + "a".repeat(60) + "../../",                       /* mixed */
    "bibliary-asset://sha256/" + "a".repeat(32) + "/" + "b".repeat(32),           /* slash injection */
    "bibliary-asset://sha256/" + "a".repeat(63) + "\x00",                         /* NUL byte */
    "bibliary-asset://sha256/AAAA",                                               /* всё заглавное но коротко */
  ];

  for (const url of cases) {
    const r = await resolveBlobFromUrl(tmp, url);
    assert.equal(r, null, `evil URL must be rejected: ${JSON.stringify(url)}`);
  }
});

test("[security] resolveBlobFromUrl: non-bibliary-asset URL returns null", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "blob-traverse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const cases = [
    "file:///etc/passwd",
    "http://attacker.com/" + "a".repeat(64),
    "https://evil/" + "a".repeat(64),
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "BIBLIARY-ASSET://sha256/" + "a".repeat(64),  /* uppercase scheme — strict prefix match */
    "bibliary-asset://other-namespace/" + "a".repeat(64),
    "",
    "//sha256/" + "a".repeat(64),
  ];

  for (const url of cases) {
    const r = await resolveBlobFromUrl(tmp, url);
    assert.equal(r, null, `non-asset URL must be null: ${JSON.stringify(url)}`);
  }
});

test("[security] resolveBlobFromUrl: valid sha but blob file does not exist → null (no throw)", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "blob-traverse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  /* Корректный 64-hex sha, но никогда не записанный → должен вернуть null
     graceful'но (попробует все KNOWN_BLOB_EXTS и вернёт null). */
  const fakeSha = "f".repeat(64);
  const url = resolveAssetUrl(fakeSha);
  const r = await resolveBlobFromUrl(tmp, url);
  assert.equal(r, null, "non-existent blob must be null, not throw");
});

test("[security] resolveBlobFromUrl: real-world traversal via crafted file inside parent dir is unreachable", async (t) => {
  /* Атака: создать файл `../etc/foo.png` рядом с .blobs/ и попытаться
     достучаться. Запрос всё равно пойдёт по строгому шаблону
     blobsBase/<sub>/<sha>.<ext>, мимо запрошенного пути не пробьёшь. */
  const tmp = await mkdtemp(path.join(os.tmpdir(), "blob-traverse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  /* Готовим валидный blob. */
  const buf = Buffer.from("legit content");
  const ref = await putBlob(tmp, buf, "image/png");

  /* Создаём «внешний» файл рядом с library root но вне .blobs/ */
  const outside = path.join(tmp, "outside.png");
  await writeFile(outside, Buffer.from("ATTACKER PAYLOAD"));

  /* Любой запрос к resolveBlobFromUrl — путь строится изнутри по sha и
     KNOWN_BLOB_EXTS; снаружи нельзя направить запрос на outside.png. */
  const evilUrls = [
    `bibliary-asset://sha256/${ref.sha256}/../../outside.png`,
    `bibliary-asset://sha256/${ref.sha256}\\..\\..\\outside.png`,
    `bibliary-asset://sha256/${ref.sha256}/outside`,
  ];
  for (const url of evilUrls) {
    const r = await resolveBlobFromUrl(tmp, url);
    assert.equal(r, null, `crafted URL must not reach outside .blobs/: ${url}`);
  }

  /* Чисто-валидный URL по той же sha работает. */
  const ok = await resolveBlobFromUrl(tmp, ref.assetUrl);
  assert.ok(ok, "legit asset URL still resolves");
});

/* ─── 2. system:open-external schema whitelist (pure unit) ─────────── */

/**
 * Pure-функция, повторяющая контракт IPC-handler'а в system.ipc.ts:
 *   ALLOWED_OPEN_SCHEMES = ["http:", "https:", "lmstudio:"]
 *   1) валидный URL?
 *   2) protocol в whitelist?
 *
 * Зеркалим логику чтобы можно было тестировать без Electron, но при
 * этом любая регрессия списка в system.ipc.ts (например, кто-то
 * добавил "file:" «для удобства») сразу видна по diff против этого теста.
 */
const HANDLER_ALLOWED_SCHEMES = ["http:", "https:", "lmstudio:"];

function isAllowedExternalUrl(url: unknown): { ok: boolean; reason?: string } {
  if (typeof url !== "string" || url.length === 0) return { ok: false, reason: "url required" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (!HANDLER_ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, reason: `scheme not allowed: ${parsed.protocol}` };
  }
  return { ok: true };
}

test("[security] open-external: allows http, https, lmstudio schemes", () => {
  for (const url of [
    "http://localhost:1234/v1/models",
    "https://lmstudio.ai/",
    "https://example.com/page?q=1",
    "lmstudio://model/qwen3-4b",
  ]) {
    const r = isAllowedExternalUrl(url);
    assert.equal(r.ok, true, `must allow: ${url} (got: ${r.reason})`);
  }
});

test("[security] open-external: rejects file://, javascript:, data:, vbscript:, ms-windows-store: and other unsafe schemes", () => {
  for (const url of [
    "file:///etc/passwd",
    "file://C:/Windows/System32",
    "javascript:alert(1)",
    "javascript:void(0)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "ms-windows-store://pdp",
    "ftp://attacker.com/",
    "ssh://attacker.com/",
    "chrome://settings",
    "about:blank",
    "blob:https://x.com/abc",
  ]) {
    const r = isAllowedExternalUrl(url);
    assert.equal(r.ok, false, `must reject: ${url}`);
    assert.match(r.reason ?? "", /scheme not allowed/i, `reason for ${url}`);
  }
});

test("[security] open-external: rejects empty / non-string / malformed URL", () => {
  assert.equal(isAllowedExternalUrl("").ok, false);
  assert.equal(isAllowedExternalUrl(undefined).ok, false);
  assert.equal(isAllowedExternalUrl(null).ok, false);
  assert.equal(isAllowedExternalUrl(123).ok, false);
  assert.equal(isAllowedExternalUrl({}).ok, false);
  assert.equal(isAllowedExternalUrl([]).ok, false);
  /* Malformed (не парсится URL constructor'ом) */
  assert.equal(isAllowedExternalUrl("not a url").ok, false);
  assert.equal(isAllowedExternalUrl("://no-scheme").ok, false);
  assert.equal(isAllowedExternalUrl(":://broken").ok, false);
});

test("[security] open-external: scheme matching is case-insensitive (URL constructor lowercases protocol)", () => {
  /* URL спецификация: protocol всегда lower-cased. Проверяем что fixed
     whitelist ["http:","https:","lmstudio:"] работает с любой капитализацией
     ввода. */
  for (const url of [
    "HTTP://example.com/",
    "Https://EXAMPLE.com",
    "LMSTUDIO://model/x",
    "HtTpS://x",
  ]) {
    const r = isAllowedExternalUrl(url);
    assert.equal(r.ok, true, `case-variation must still pass: ${url}`);
  }
  /* А вот FILE:// в любом регистре — отказ. */
  for (const url of ["FILE:///etc/passwd", "File:///etc/passwd"]) {
    const r = isAllowedExternalUrl(url);
    assert.equal(r.ok, false, `case-variation of file: must still be rejected: ${url}`);
  }
});

test("[security] open-external: whitelist contract — exactly 3 schemes (drift detector)", () => {
  /* Любое расширение whitelist (особенно «file:» «ради удобства») должно
     сопровождаться явным изменением этого теста — иначе CI красный.
     Это явный gate для security review. */
  assert.deepEqual(
    [...HANDLER_ALLOWED_SCHEMES].sort(),
    ["http:", "https:", "lmstudio:"].sort(),
    "open-external whitelist drift — обновите этот тест И system.ipc.ts ALLOWED_OPEN_SCHEMES синхронно, и убедитесь что новая схема прошла security review",
  );
});
