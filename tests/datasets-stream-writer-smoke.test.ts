/**
 * Phase 8d — streaming JSONL writer smoke. Real temp file I/O,
 * проверяем что lines пишутся, byte count корректен, cleanup
 * освобождает temp dir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

import { openTempJsonlWriter } from "../server/lib/datasets/stream-writer.ts";

describe("openTempJsonlWriter", () => {
  it("write 3 lines → file содержит 3 JSONL строки", async () => {
    const writer = await openTempJsonlWriter("test.jsonl");
    try {
      await writer.writeLine(JSON.stringify({ id: 1, name: "alpha" }));
      await writer.writeLine(JSON.stringify({ id: 2, name: "beta" }));
      await writer.writeLine(JSON.stringify({ id: 3, name: "gamma" }));
      const { path, bytes } = await writer.finish();
      assert.ok(existsSync(path));
      const text = await readFile(path, "utf-8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 3);
      assert.equal(JSON.parse(lines[0]).id, 1);
      assert.equal(JSON.parse(lines[2]).name, "gamma");
      const stats = await stat(path);
      assert.equal(stats.size, bytes);
    } finally {
      await writer.cleanup();
    }
  });

  it("empty write → empty file (0 bytes)", async () => {
    const writer = await openTempJsonlWriter("empty.jsonl");
    try {
      const { path, bytes } = await writer.finish();
      assert.ok(existsSync(path));
      assert.equal(bytes, 0);
      const text = await readFile(path, "utf-8");
      assert.equal(text, "");
    } finally {
      await writer.cleanup();
    }
  });

  it("cleanup() removes temp dir", async () => {
    const writer = await openTempJsonlWriter("removeme.jsonl");
    await writer.writeLine('{"x":1}');
    const { path } = await writer.finish();
    assert.ok(existsSync(path), "file exists before cleanup");
    await writer.cleanup();
    assert.ok(!existsSync(path), "file removed after cleanup");
  });

  it("large write (1000 lines) — file size matches accumulated bytes", async () => {
    const writer = await openTempJsonlWriter("large.jsonl");
    try {
      for (let i = 0; i < 1000; i++) {
        await writer.writeLine(JSON.stringify({ idx: i, payload: "x".repeat(100) }));
      }
      const { path, bytes } = await writer.finish();
      const stats = await stat(path);
      assert.equal(stats.size, bytes);
      assert.ok(bytes > 100_000, "1000 lines × ~120 bytes should be >100K");
    } finally {
      await writer.cleanup();
    }
  });

  it("JSONL: каждая строка — valid JSON после parse", async () => {
    const writer = await openTempJsonlWriter("validate.jsonl");
    try {
      await writer.writeLine(JSON.stringify({ a: "value with \\n escape" }));
      await writer.writeLine(JSON.stringify({ unicode: "тест 日本語" }));
      const { path } = await writer.finish();
      const text = await readFile(path, "utf-8");
      const lines = text.split("\n").filter(Boolean);
      assert.equal(JSON.parse(lines[0]).a, "value with \\n escape");
      assert.equal(JSON.parse(lines[1]).unicode, "тест 日本語");
    } finally {
      await writer.cleanup();
    }
  });
});
