/**
 * Tests для BM25 sparse vectorizer.
 *
 * Покрытие:
 *   1. Tokenization: ru, en, uk, mixed, punctuation
 *   2. Hash determinism: тот же токен → тот же index
 *   3. TF aggregation: дубликаты собираются
 *   4. Edge cases: пустая строка, только пунктуация, очень длинные токены
 *   5. Multilingual: один токен в разных языках имеет разные хеши
 *   6. Cross-language matching: одинаковый токен в query и passage → matching index
 */

import { describe, it, expect } from "vitest";
import {
  tokenizeForBm25,
  hashTokenFnv1a,
  bm25SparseVector,
  bm25SparseQuery,
} from "../electron/lib/qdrant/bm25-sparse.ts";

describe("tokenizeForBm25", () => {
  it("разбивает английский текст по пробелам и пунктуации", () => {
    const t = tokenizeForBm25("Hello, world! This is BM25.");
    expect(t).toEqual(["hello", "world", "this", "is", "bm25"]);
  });

  it("работает с русским текстом (UTF-8)", () => {
    const t = tokenizeForBm25("Это книга про алгоритмы.");
    expect(t).toEqual(["это", "книга", "про", "алгоритмы"]);
  });

  it("работает с украинским (і, ї, є, ґ)", () => {
    const t = tokenizeForBm25("Інформаційна безпека — це сучасна наука.");
    expect(t).toContain("інформаційна");
    expect(t).toContain("сучасна");
  });

  it("сохраняет смешанные ru/en токены раздельно", () => {
    const t = tokenizeForBm25("Книга про RFC 7235 авторизацию");
    expect(t).toEqual(["книга", "про", "rfc", "7235", "авторизацию"]);
  });

  it("игнорирует слишком короткие токены (1 символ)", () => {
    const t = tokenizeForBm25("a is b is c");
    expect(t).toEqual(["is", "is"]); /* "a", "b", "c" — слишком короткие */
  });

  it("игнорирует слишком длинные токены (>64 символа)", () => {
    const huge = "a".repeat(100);
    const t = tokenizeForBm25(`hello ${huge} world`);
    expect(t).toEqual(["hello", "world"]);
  });

  it("пустая строка → пустой массив", () => {
    expect(tokenizeForBm25("")).toEqual([]);
  });

  it("только пунктуация → пустой массив", () => {
    expect(tokenizeForBm25("!!! ??? --- ...")).toEqual([]);
  });

  it("lowercase нормализация", () => {
    const t = tokenizeForBm25("RFC 7235 Authorization");
    expect(t).toEqual(["rfc", "7235", "authorization"]);
  });
});

describe("hashTokenFnv1a", () => {
  it("детерминирован: один токен → один хеш", () => {
    const h1 = hashTokenFnv1a("test");
    const h2 = hashTokenFnv1a("test");
    expect(h1).toBe(h2);
  });

  it("разные токены → разные хеши", () => {
    expect(hashTokenFnv1a("foo")).not.toBe(hashTokenFnv1a("bar"));
    expect(hashTokenFnv1a("книга")).not.toBe(hashTokenFnv1a("bookbook"));
  });

  it("возвращает unsigned int (>=0)", () => {
    for (const tok of ["a", "test", "русский", "test123", "x".repeat(60)]) {
      const h = hashTokenFnv1a(tok);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("UTF-8 токены работают (не падает)", () => {
    expect(() => hashTokenFnv1a("ук")).not.toThrow();
    expect(() => hashTokenFnv1a("中文")).not.toThrow();
    expect(() => hashTokenFnv1a("الكتاب")).not.toThrow();
  });
});

describe("bm25SparseVector — TF aggregation", () => {
  it("дубликаты слова → инкремент value", () => {
    const v = bm25SparseVector("test test test other");
    /* indices/values имеют по 2 элемента: "test" (3 раза), "other" (1 раз). */
    expect(v.indices.length).toBe(2);
    expect(v.values.length).toBe(2);
    /* Найти позицию "test" по hash. */
    const testIdx = hashTokenFnv1a("test");
    const otherIdx = hashTokenFnv1a("other");
    const testPos = v.indices.indexOf(testIdx);
    const otherPos = v.indices.indexOf(otherIdx);
    expect(testPos).not.toBe(-1);
    expect(otherPos).not.toBe(-1);
    expect(v.values[testPos]).toBe(3);
    expect(v.values[otherPos]).toBe(1);
  });

  it("пустой текст → пустой sparse vector", () => {
    const v = bm25SparseVector("");
    expect(v.indices).toEqual([]);
    expect(v.values).toEqual([]);
  });

  it("indices и values имеют одинаковую длину", () => {
    const v = bm25SparseVector("hello world test of bm25 algorithm");
    expect(v.indices.length).toBe(v.values.length);
    expect(v.indices.length).toBeGreaterThan(0);
  });
});

describe("bm25SparseQuery vs bm25SparseVector", () => {
  it("одинаковые токены в query и passage → совпадающие indices (cross-matching)", () => {
    /* Это критическое свойство для retrieval: если query содержит токен X
       и passage содержит токен X, их sparse vectors должны иметь
       один и тот же index. Иначе scoring не сработает. */
    const query = bm25SparseQuery("RFC 7235 authorization");
    const passage = bm25SparseVector("This document explains RFC 7235 authorization headers.");

    /* Найти "rfc" в обоих. */
    const rfcHash = hashTokenFnv1a("rfc");
    expect(query.indices).toContain(rfcHash);
    expect(passage.indices).toContain(rfcHash);

    /* Найти "7235" — числовой токен. */
    const numHash = hashTokenFnv1a("7235");
    expect(query.indices).toContain(numHash);
    expect(passage.indices).toContain(numHash);

    /* Найти "authorization". */
    const authHash = hashTokenFnv1a("authorization");
    expect(query.indices).toContain(authHash);
    expect(passage.indices).toContain(authHash);
  });

  it("multilingual cross-matching: ru токен в обоих", () => {
    const query = bm25SparseQuery("найти книги про алгоритмы");
    const passage = bm25SparseVector("Книги про алгоритмы — это классика computer science.");

    const algorithmsHash = hashTokenFnv1a("алгоритмы");
    expect(query.indices).toContain(algorithmsHash);
    expect(passage.indices).toContain(algorithmsHash);
  });

  it("разные языки одного слова имеют разные хеши", () => {
    /* "book" (en) и "книга" (ru) — разные токены, разные хеши. */
    expect(hashTokenFnv1a("book")).not.toBe(hashTokenFnv1a("книга"));
  });
});

describe("bm25SparseVector — real-world Bibliary scenarios", () => {
  it("ISBN запрос: '978-5-7502' разбит на 2 токена, но '7502' попадает", () => {
    const v = bm25SparseVector("ISBN 978-5-7502-0123-4 published in 2020");
    /* Дефис разделяет, цифры остаются. */
    expect(v.indices).toContain(hashTokenFnv1a("isbn"));
    expect(v.indices).toContain(hashTokenFnv1a("978"));
    expect(v.indices).toContain(hashTokenFnv1a("7502"));
  });

  it("technical version: 'TLS 1.3' разбит на 'tls' и '1', '3'", () => {
    const v = bm25SparseVector("TLS 1.3 handshake protocol");
    expect(v.indices).toContain(hashTokenFnv1a("tls"));
    expect(v.indices).toContain(hashTokenFnv1a("handshake"));
    expect(v.indices).toContain(hashTokenFnv1a("protocol"));
    /* "1" и "3" короче 2 символов → отсутствуют. Это OK для multi-digit
       версий (TLS 1.3, HTTP/2 — точное совпадение по числу будет редким). */
  });

  it("имя автора на латинице в кириллическом контексте", () => {
    const v = bm25SparseVector("Книга «Алгоритмы», автор Knuth, 1968 год");
    expect(v.indices).toContain(hashTokenFnv1a("knuth"));
    expect(v.indices).toContain(hashTokenFnv1a("1968"));
    expect(v.indices).toContain(hashTokenFnv1a("алгоритмы"));
  });
});
