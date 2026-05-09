/**
 * Тесты для electron/lib/llm/lmstudio-http-probe.ts.
 *
 * Покрывает:
 *  1. Успешный probe (mock HTTP server отвечает 200 + список моделей).
 *  2. Невалидный URL → kind=invalid_url.
 *  3. ECONNREFUSED → kind=refused.
 *  4. HTTP 404 → kind=http со statusCode.
 *  5. Таймаут → kind=timeout.
 *  6. Контракт типов: ok=true имеет latencyMs+resolvedUrl, ok=false — message+kind.
 *
 * НЕ тестирует:
 *  - IPv6→IPv4 fallback (требует реальный bind на ::1, что хрупко в CI).
 *  - DNS errors (требует отдельный network namespace).
 *  Эти ветки покрыты unit-логикой classifyError() через явные code-string проверки.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { probeLmStudioUrl } from "../electron/lib/llm/lmstudio-http-probe.js";

interface MockServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<MockServerHandle> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    /* 127.0.0.1 явно — никаких ::1 неожиданностей. */
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      const close = (): Promise<void> =>
        new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
      resolve({ url, close });
    });
  });
}

test("probeLmStudioUrl: успешный probe возвращает ok с latencyMs и modelsCount", async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "qwen3-4b", object: "model" },
          { id: "qwen3.6-35b", object: "model" },
          { id: "vision-model", object: "model" },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await probeLmStudioUrl(mock.url, { timeoutMs: 3_000 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.status, 200);
      assert.equal(r.modelsCount, 3);
      assert.equal(r.resolvedUrl, mock.url);
      assert.ok(typeof r.latencyMs === "number" && r.latencyMs >= 0);
    }
  } finally {
    await mock.close();
  }
});

test("probeLmStudioUrl: пустая строка → kind=invalid_url", async () => {
  const r = await probeLmStudioUrl("", { timeoutMs: 1_000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "invalid_url");
    assert.match(r.message, /empty|unsupported/i);
  }
});

test("probeLmStudioUrl: невалидная схема → kind=invalid_url", async () => {
  const r = await probeLmStudioUrl("ws://localhost:1234", { timeoutMs: 1_000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "invalid_url");
  }
});

test("probeLmStudioUrl: некорректный URL → kind=invalid_url", async () => {
  const r = await probeLmStudioUrl("not-a-url at all", { timeoutMs: 1_000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "invalid_url");
  }
});

test("probeLmStudioUrl: HTTP 404 → kind=http со statusCode", async () => {
  const mock = await startMockServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  try {
    const r = await probeLmStudioUrl(mock.url, { timeoutMs: 3_000 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "http");
      assert.equal(r.statusCode, 404);
      assert.equal(r.resolvedUrl, mock.url);
    }
  } finally {
    await mock.close();
  }
});

test("probeLmStudioUrl: ECONNREFUSED (закрытый порт) → kind=refused", async () => {
  /* Открываем сервер только чтобы взять свободный порт, потом закрываем. */
  const mock = await startMockServer((_r, res) => res.end());
  const url = mock.url;
  await mock.close();
  /* IPv4 fallback OFF — иначе fallback на 127.0.0.1 (тот же самый адрес) даст ту же ошибку. */
  const r = await probeLmStudioUrl(url, { timeoutMs: 3_000, ipv4Fallback: false });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "refused");
    assert.equal(r.errorCode, "ECONNREFUSED");
  }
});

test("probeLmStudioUrl: таймаут на медленный сервер → kind=timeout", async () => {
  /* Сервер принимает соединение, но никогда не отвечает. */
  const mock = await startMockServer((_req, _res) => {
    /* deliberate hang */
  });
  try {
    const r = await probeLmStudioUrl(mock.url, { timeoutMs: 250, ipv4Fallback: false });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "timeout");
    }
  } finally {
    await mock.close();
  }
});

test("probeLmStudioUrl: trailing slashes удаляются (пробуем /)", async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  try {
    const r = await probeLmStudioUrl(`${mock.url}//`, { timeoutMs: 3_000 });
    assert.equal(r.ok, true);
    if (r.ok) {
      /* normalizeUrl убирает все trailing slashes */
      assert.equal(r.resolvedUrl, mock.url);
      assert.equal(r.modelsCount, 0);
    }
  } finally {
    await mock.close();
  }
});

test("probeLmStudioUrl: сервер с unparseable JSON всё равно ok (modelsCount undefined)", async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json at all");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await probeLmStudioUrl(mock.url, { timeoutMs: 3_000 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.status, 200);
      assert.equal(r.modelsCount, undefined);
    }
  } finally {
    await mock.close();
  }
});
