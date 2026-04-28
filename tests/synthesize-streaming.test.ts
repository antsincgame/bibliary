/**
 * Streaming synthesizer split — детерминированный hash-bucket распределяет
 * пары между train и val без хранения всех строк в памяти. Это убирает RAM-бомбу
 * при больших коллекциях. Тут проверяется именно эта чистая функция.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { splitBucket } from "../electron/lib/dataset-v2/synthesize.ts";

describe("[synthesize-streaming] splitBucket", () => {
  test("same input always returns same bucket (deterministic)", () => {
    for (let i = 0; i < 100; i++) {
      const a = splitBucket(42, `concept-${i}`, 0, 0.9);
      const b = splitBucket(42, `concept-${i}`, 0, 0.9);
      assert.equal(a, b);
    }
  });

  test("different seed shuffles distribution", () => {
    let differs = 0;
    for (let i = 0; i < 100; i++) {
      const a = splitBucket(42, `concept-${i}`, 0, 0.9);
      const b = splitBucket(7, `concept-${i}`, 0, 0.9);
      if (a !== b) differs++;
    }
    assert.ok(differs > 5, `seed should change at least some buckets, got ${differs}`);
  });

  test("trainRatio=0.9 → ~90% in train at scale", () => {
    let train = 0;
    let val = 0;
    for (let i = 0; i < 5000; i++) {
      const b = splitBucket(42, `c-${i}`, 0, 0.9);
      if (b === "train") train++; else val++;
    }
    const ratio = train / (train + val);
    assert.ok(ratio > 0.85 && ratio < 0.95, `expected ~0.9, got ${ratio.toFixed(3)}`);
  });

  test("trainRatio=1.0 → everything in train", () => {
    for (let i = 0; i < 200; i++) {
      assert.equal(splitBucket(42, `c-${i}`, 0, 1.0), "train");
    }
  });

  test("pairIdx variations land in different buckets sometimes", () => {
    let same = 0;
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const a = splitBucket(42, `c-${i}`, 0, 0.5);
      const b = splitBucket(42, `c-${i}`, 1, 0.5);
      if (a === b) same++; else differ++;
    }
    assert.ok(differ > 30, `pairIdx must influence bucket, got differ=${differ}`);
    assert.ok(same > 30, `should still have collisions, got same=${same}`);
  });
});
