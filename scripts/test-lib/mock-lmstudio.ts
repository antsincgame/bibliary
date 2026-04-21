/**
 * Mock LM Studio HTTP server для тестов.
 * Поднимается на свободном порту (по умолчанию 11434, чтобы не конфликтовать с реальным 1234).
 *
 * Поддерживает:
 *  - GET /v1/models — возвращает заданный ответ или таймаут
 *  - POST /v1/chat/completions — возвращает заданную строку (можно настроить per-phase)
 *  - mock.setHealthy(false) — все запросы виснут до timeout
 *  - mock.setLatencyMs(ms)  — добавляет задержку перед ответом
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export interface MockResponseFn {
  (body: { model: string; messages: Array<{ role: string; content: string }> }): {
    content: string;
    delayMs?: number;
  };
}

export interface MockOptions {
  port?: number;
  modelId?: string;
  responseFn?: MockResponseFn;
}

export class MockLMStudio {
  private server: Server | null = null;
  private port: number;
  private modelId: string;
  private healthy = true;
  private latencyMs = 0;
  private responseFn: MockResponseFn;
  private requestLog: Array<{ url: string; ts: number }> = [];

  constructor(opts: MockOptions = {}) {
    this.port = opts.port ?? 11434;
    this.modelId = opts.modelId ?? "mock-model";
    this.responseFn =
      opts.responseFn ??
      (() => ({ content: "mock-response" }));
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.on("error", reject);
      this.server.listen(this.port, () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.port = actualPort;
        resolve(actualPort);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
      this.server = null;
    });
  }

  url(): string {
    return `http://localhost:${this.port}`;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  setLatencyMs(ms: number): void {
    this.latencyMs = ms;
  }

  setResponseFn(fn: MockResponseFn): void {
    this.responseFn = fn;
  }

  getRequestLog(): ReadonlyArray<{ url: string; ts: number }> {
    return this.requestLog;
  }

  resetLog(): void {
    this.requestLog = [];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requestLog.push({ url: req.url ?? "", ts: Date.now() });

    if (!this.healthy) {
      // зависаем до закрытия клиента
      return;
    }

    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      this.respondJson(res, 200, { object: "list", data: [{ id: this.modelId, object: "model" }] });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: { model: string; messages: Array<{ role: string; content: string }> };
      try {
        parsed = JSON.parse(body);
      } catch {
        this.respondJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const { content, delayMs } = this.responseFn(parsed);
      if (delayMs && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      this.respondJson(res, 200, {
        id: `mock-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: this.modelId,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
      return;
    }

    this.respondJson(res, 404, { error: "not found" });
  }

  private respondJson(res: ServerResponse, status: number, value: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  }
}
