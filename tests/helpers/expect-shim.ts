/**
 * Минимальный `expect`-shim поверх node:assert.
 *
 * Назначение: позволить нескольким legacy-тестам, написанным под vitest API,
 * выполняться через `node --test` без реальной зависимости на vitest.
 *
 * Поддерживаемые matchers:
 *   .toBe(v)
 *   .toEqual(v)
 *   .toBeDefined() / .toBeUndefined()
 *   .toContain(item)
 *   .toBeGreaterThan(n) / .toBeGreaterThanOrEqual(n)
 *   .toBeLessThan(n)    / .toBeLessThanOrEqual(n)
 *   .not (отрицание для большинства matcher'ов выше)
 *   expect(promise).rejects.toThrow(regex|Error|string)
 *   expect(promise).resolves.toBeUndefined()
 */

import assert from "node:assert/strict";

interface BaseMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toContain(item: unknown): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
}

interface Matchers extends BaseMatchers {
  not: BaseMatchers;
  rejects: AsyncMatchers;
  resolves: AsyncMatchers;
}

interface AsyncMatchers {
  toThrow(matcher?: RegExp | string | (new (...args: never[]) => Error)): Promise<void>;
  toBeUndefined(): Promise<void>;
  toBeDefined(): Promise<void>;
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
}

function buildBase(actual: unknown, negate: boolean): BaseMatchers {
  const fail = (msg: string): never => {
    throw new assert.AssertionError({ message: msg, actual, stackStartFn: fail });
  };

  return {
    toBe(expected: unknown): void {
      if (negate) {
        if (Object.is(actual, expected)) fail(`Expected ${String(actual)} NOT to be ${String(expected)}`);
      } else {
        if (!Object.is(actual, expected)) fail(`Expected ${String(actual)} to be ${String(expected)}`);
      }
    },
    toEqual(expected: unknown): void {
      try {
        assert.deepStrictEqual(actual, expected);
        if (negate) fail(`Expected NOT to equal but values were deep-equal`);
      } catch (e) {
        if (!negate) throw e;
      }
    },
    toBeDefined(): void {
      const isUndef = actual === undefined;
      if (negate ? !isUndef : isUndef) {
        fail(negate ? `Expected to be undefined` : `Expected not to be undefined`);
      }
    },
    toBeUndefined(): void {
      const isUndef = actual === undefined;
      if (negate ? isUndef : !isUndef) {
        fail(negate ? `Expected NOT to be undefined` : `Expected to be undefined, got ${String(actual)}`);
      }
    },
    toContain(item: unknown): void {
      let has = false;
      if (typeof actual === "string") {
        has = actual.includes(String(item));
      } else if (Array.isArray(actual)) {
        has = actual.some((v) => Object.is(v, item) || (item !== null && typeof item === "object" && JSON.stringify(v) === JSON.stringify(item)));
      } else if (actual && typeof (actual as { includes?: unknown }).includes === "function") {
        has = (actual as { includes: (v: unknown) => boolean }).includes(item);
      } else {
        fail(`Cannot run toContain on non-iterable: ${String(actual)}`);
      }
      if (negate ? has : !has) {
        fail(negate ? `Expected NOT to contain ${String(item)}` : `Expected to contain ${String(item)}`);
      }
    },
    toBeGreaterThan(n: number): void {
      const ok = typeof actual === "number" && actual > n;
      if (negate ? ok : !ok) fail(`Expected ${String(actual)} ${negate ? "NOT " : ""}> ${n}`);
    },
    toBeGreaterThanOrEqual(n: number): void {
      const ok = typeof actual === "number" && actual >= n;
      if (negate ? ok : !ok) fail(`Expected ${String(actual)} ${negate ? "NOT " : ""}>= ${n}`);
    },
    toBeLessThan(n: number): void {
      const ok = typeof actual === "number" && actual < n;
      if (negate ? ok : !ok) fail(`Expected ${String(actual)} ${negate ? "NOT " : ""}< ${n}`);
    },
    toBeLessThanOrEqual(n: number): void {
      const ok = typeof actual === "number" && actual <= n;
      if (negate ? ok : !ok) fail(`Expected ${String(actual)} ${negate ? "NOT " : ""}<= ${n}`);
    },
  };
}

function buildAsync(promiseLike: unknown, mode: "rejects" | "resolves"): AsyncMatchers {
  async function settle(): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
    try {
      const value = await (promiseLike as Promise<unknown>);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error };
    }
  }

  return {
    async toThrow(matcher) {
      const out = await settle();
      if (mode === "rejects") {
        if (out.ok) throw new assert.AssertionError({ message: `Expected promise to reject` });
        if (matcher !== undefined) {
          const err = out.error;
          const msg = err instanceof Error ? err.message : String(err);
          if (matcher instanceof RegExp) {
            if (!matcher.test(msg)) throw new assert.AssertionError({ message: `Expected error to match ${matcher} but got: ${msg}` });
          } else if (typeof matcher === "string") {
            if (!msg.includes(matcher)) throw new assert.AssertionError({ message: `Expected error to contain "${matcher}" but got: ${msg}` });
          } else if (typeof matcher === "function") {
            if (!(err instanceof matcher)) throw new assert.AssertionError({ message: `Expected error to be instance of ${matcher.name}` });
          }
        }
      } else {
        if (!out.ok) throw new assert.AssertionError({ message: `Expected promise to resolve, but it threw` });
      }
    },
    async toBeUndefined() {
      const out = await settle();
      if (mode === "resolves") {
        if (!out.ok) throw new assert.AssertionError({ message: `Expected promise to resolve` });
        if (out.value !== undefined) throw new assert.AssertionError({ message: `Expected resolved value to be undefined`, actual: out.value });
      } else {
        if (out.ok) throw new assert.AssertionError({ message: `Expected promise to reject` });
      }
    },
    async toBeDefined() {
      const out = await settle();
      if (mode === "resolves") {
        if (!out.ok) throw new assert.AssertionError({ message: `Expected promise to resolve` });
        if (out.value === undefined) throw new assert.AssertionError({ message: `Expected resolved value to be defined` });
      } else {
        if (out.ok) throw new assert.AssertionError({ message: `Expected promise to reject` });
      }
    },
    async toBe(expected: unknown) {
      const out = await settle();
      if (mode === "resolves") {
        if (!out.ok) throw new assert.AssertionError({ message: `Expected promise to resolve` });
        if (!Object.is(out.value, expected)) {
          throw new assert.AssertionError({ message: `Expected resolved value to be ${String(expected)}`, actual: out.value, expected });
        }
      } else {
        if (out.ok) throw new assert.AssertionError({ message: `Expected promise to reject` });
      }
    },
    async toEqual(expected: unknown) {
      const out = await settle();
      if (mode === "resolves") {
        if (!out.ok) throw new assert.AssertionError({ message: `Expected promise to resolve` });
        assert.deepStrictEqual(out.value, expected);
      } else {
        if (out.ok) throw new assert.AssertionError({ message: `Expected promise to reject` });
      }
    },
  };
}

export function expect(actual: unknown): Matchers {
  const positive = buildBase(actual, false);
  const negative = buildBase(actual, true);
  return {
    ...positive,
    not: negative,
    get rejects() {
      return buildAsync(actual, "rejects");
    },
    get resolves() {
      return buildAsync(actual, "resolves");
    },
  };
}
