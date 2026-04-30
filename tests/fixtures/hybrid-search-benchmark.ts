/**
 * Synthetic benchmark dataset для hybrid retrieval (Bibliary).
 *
 * 50 queries × ground-truth chunk_ids + chunk-corpus.
 * Запросы покрывают типичные сценарии Bibliary:
 *   - Точные термины (RFC, ISBN, версии стандартов) — где BM25 рулит
 *   - Семантические запросы (концепции, идеи) — где dense рулит
 *   - Multilingual ru/en/uk — multilingual E5 + Unicode BM25
 *   - Имена авторов на латинице в кириллическом тексте
 *   - Длинные «вопрос-как-описание» — semantic strength
 *   - Code identifiers (qsort, mergeSort, useState) — exact match
 *
 * Назначение:
 *   1. Detect качество retrieval до/после изменений (recall@5, recall@10).
 *   2. A/B тест dense-only vs hybrid vs hybrid+rerank.
 *   3. Регрессия после миграций embedder/коллекций/RRF параметров.
 *
 * Метрики (вычисляются runner'ом):
 *   - Recall@K  = |retrieved ∩ relevant| / |relevant|  per query, mean
 *   - MRR       = mean(1 / rank_of_first_relevant)
 *   - nDCG@K    = normalized discounted cumulative gain
 *
 * Корпус — ~38 chunks по 7 темам (включая шумовые):
 *   - rfc-7235 (HTTP authorization, 8 chunks)
 *   - tls-1-3 (cryptography, 6 chunks)
 *   - alg-sort (sorting algorithms — Knuth, 8 chunks)
 *   - react-hooks (frontend, 5 chunks)
 *   - linux-fs (filesystems, 4 chunks)
 *   - russian-lit (literature, Достоевский, 4 chunks)
 *   - noise (шум для затруднения retrieval, 3 chunks)
 *
 * Реальные числа подтверждаются `selfCheckBenchmark()` и
 * `tests/hybrid-search-benchmark-self-check.test.ts`.
 */

export interface BenchmarkChunk {
  id: string;
  text: string;
  topic: string;
  /** Кол-во реальных «попаданий» (для проверки покрытия). */
  language: "en" | "ru" | "uk" | "mixed";
}

export interface BenchmarkQuery {
  id: string;
  query: string;
  /** ID chunks которые ДОЛЖНЫ быть в top-K. Минимум 1. */
  relevantChunkIds: string[];
  /** Тип запроса — для группировки в отчёте. */
  queryType: "exact" | "semantic" | "code" | "multilingual" | "name" | "isbn-or-version";
  /** На какой "стиль" поиска делается ставка. */
  expectedWinner: "dense" | "sparse" | "hybrid";
}

/* ─── Корпус (200 chunks) — компактные синтетические passages ──────────── */

export const BENCHMARK_CORPUS: BenchmarkChunk[] = [
  /* RFC 7235 (HTTP Authorization) — 30 chunks */
  { id: "rfc7235-001", text: "RFC 7235 defines the framework for HTTP authentication, extending the original HTTP/1.1 specification. The 401 Unauthorized response includes a WWW-Authenticate header.", topic: "rfc-7235", language: "en" },
  { id: "rfc7235-002", text: "Authorization header field carries credentials. Format: Authorization: <type> <credentials>. Common types: Basic, Bearer, Digest.", topic: "rfc-7235", language: "en" },
  { id: "rfc7235-003", text: "The Proxy-Authenticate header in 407 response signals that proxy authentication is required, distinct from origin server auth.", topic: "rfc-7235", language: "en" },
  { id: "rfc7235-004", text: "Bearer tokens (RFC 6750) are commonly used in OAuth 2.0 flows. The token itself is opaque to the client.", topic: "rfc-7235", language: "en" },
  { id: "rfc7235-005", text: "RFC 7235 заменяет раздел 4.1 RFC 2616. Авторизация в HTTP теперь описана в отдельном документе для ясности.", topic: "rfc-7235", language: "ru" },
  { id: "rfc7235-006", text: "Digest authentication использует MD5 хеш с nonce, защищая от replay-атак — но MD5 уже считается слабым.", topic: "rfc-7235", language: "ru" },
  { id: "rfc7235-007", text: "The realm parameter in WWW-Authenticate identifies the protection space. A user-agent SHOULD use it to decide which credentials to send.", topic: "rfc-7235", language: "en" },
  { id: "rfc7235-008", text: "Basic authentication передаёт логин и пароль в base64 — это НЕ шифрование. Обязателен HTTPS для безопасности.", topic: "rfc-7235", language: "ru" },

  /* TLS 1.3 — 25 chunks */
  { id: "tls13-001", text: "TLS 1.3 handshake reduces round-trips: 1-RTT for new connections, 0-RTT for resumption. Major improvement over TLS 1.2.", topic: "tls-1-3", language: "en" },
  { id: "tls13-002", text: "TLS 1.3 dropped support for RSA key exchange — only ephemeral DH (DHE/ECDHE) is allowed for forward secrecy.", topic: "tls-1-3", language: "en" },
  { id: "tls13-003", text: "AEAD ciphers in TLS 1.3: AES-GCM, ChaCha20-Poly1305, AES-CCM. CBC modes are deprecated.", topic: "tls-1-3", language: "en" },
  { id: "tls13-004", text: "TLS 1.3 ClientHello содержит supported_versions extension. Без него сервер думает что это TLS 1.2.", topic: "tls-1-3", language: "ru" },
  { id: "tls13-005", text: "0-RTT resumption уязвим к replay attacks — приложение должно валидировать idempotence запросов.", topic: "tls-1-3", language: "ru" },
  { id: "tls13-006", text: "Post-handshake authentication (TLS 1.3 §4.6.2) позволяет клиенту аутентифицироваться после установки соединения.", topic: "tls-1-3", language: "ru" },

  /* Sorting algorithms — Knuth, vol 3 — 30 chunks */
  { id: "sort-001", text: "Quicksort by Hoare (1962) achieves O(n log n) average case but O(n²) worst case on already-sorted input. Pivot selection is critical.", topic: "alg-sort", language: "en" },
  { id: "sort-002", text: "Mergesort guarantees O(n log n) worst case but requires O(n) auxiliary memory. Stable. Good for linked lists.", topic: "alg-sort", language: "en" },
  { id: "sort-003", text: "Кнут описывает qsort vs mergesort в томе 3 «Сортировка и поиск». На малых массивах qsort быстрее из-за cache locality.", topic: "alg-sort", language: "ru" },
  { id: "sort-004", text: "Heapsort: O(n log n) worst case, in-place. Slower than quicksort in practice due to non-sequential memory access.", topic: "alg-sort", language: "en" },
  { id: "sort-005", text: "Алгоритм Кнута-Морриса-Пратта (KMP) — это про подстроку, а не про сортировку. Не путать.", topic: "alg-sort", language: "ru" },
  { id: "sort-006", text: "Tim sort (Python's default) is a hybrid of mergesort and insertion sort, adaptive to existing runs in the data.", topic: "alg-sort", language: "en" },
  { id: "sort-007", text: "Donald Knuth, The Art of Computer Programming, Volume 3: Sorting and Searching, 2nd edition, 1998, ISBN 978-0-201-89685-5.", topic: "alg-sort", language: "en" },
  { id: "sort-008", text: "Сравнение qsort и mergesort: первый быстрее на маленьких массивах из-за константы, второй стабильнее.", topic: "alg-sort", language: "ru" },

  /* React hooks — 25 chunks */
  { id: "react-001", text: "useState returns a tuple [state, setState]. Each call to setState triggers a re-render of the component.", topic: "react-hooks", language: "en" },
  { id: "react-002", text: "useEffect runs after the render is committed to the screen. Use the dependency array to control when it re-runs.", topic: "react-hooks", language: "en" },
  { id: "react-003", text: "useMemo кэширует вычисление, useCallback — функцию. Оба принимают зависимости как второй аргумент.", topic: "react-hooks", language: "ru" },
  { id: "react-004", text: "useReducer is preferable to useState when state logic is complex or when the next state depends on the previous one.", topic: "react-hooks", language: "en" },
  { id: "react-005", text: "Custom hooks must start with the prefix 'use' — это требование ESLint правила react-hooks/rules-of-hooks.", topic: "react-hooks", language: "mixed" },

  /* Linux filesystems — 25 chunks */
  { id: "linuxfs-001", text: "ext4 is the default filesystem on most Linux distributions. Supports up to 1 EB volumes and 16 TB files.", topic: "linux-fs", language: "en" },
  { id: "linuxfs-002", text: "Btrfs (B-tree filesystem) supports snapshots, subvolumes, copy-on-write. Still considered unstable for some workloads.", topic: "linux-fs", language: "en" },
  { id: "linuxfs-003", text: "ZFS на Linux требует отдельного модуля ядра из-за лицензионной несовместимости CDDL и GPL.", topic: "linux-fs", language: "ru" },
  { id: "linuxfs-004", text: "Inode contains file metadata: permissions, owner, timestamps, pointers to data blocks. Each file has exactly one inode.", topic: "linux-fs", language: "en" },

  /* Russian literature — 20 chunks */
  { id: "rulit-001", text: "Достоевский Ф.М. — «Преступление и наказание» (1866). Роман о Раскольникове и его теории «тварь дрожащая или право имею».", topic: "russian-lit", language: "ru" },
  { id: "rulit-002", text: "Толстой Л.Н., «Война и мир» (1869), эпопея в четырёх томах. Действие происходит в эпоху наполеоновских войн.", topic: "russian-lit", language: "ru" },
  { id: "rulit-003", text: "Dostoyevsky's «Crime and Punishment» (Преступление и наказание) is widely translated. Most popular English versions: Garnett, Pevear-Volokhonsky.", topic: "russian-lit", language: "mixed" },
  { id: "rulit-004", text: "Chekhov's short stories. «Дама с собачкой» — about adultery and existential loneliness in late imperial Russia.", topic: "russian-lit", language: "mixed" },

  /* Дополнительные «шумовые» chunks для затруднения retrieval */
  { id: "noise-001", text: "Random text about cooking pasta. Boil water, add salt, cook 8 minutes. Drain and serve with sauce.", topic: "noise", language: "en" },
  { id: "noise-002", text: "Прогноз погоды на завтра: облачно, дожди, температура +5 градусов. Возможен снег ночью.", topic: "noise", language: "ru" },
  { id: "noise-003", text: "Curl recipe: yogurt, lemon juice, kosher salt, mint. Mix and chill for 30 minutes before serving.", topic: "noise", language: "en" },
];

/* ─── 50 запросов ─────────────────────────────────────────────────────── */

export const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  /* === Exact-match queries (BM25 should win) === */
  { id: "q01", query: "RFC 7235", relevantChunkIds: ["rfc7235-001", "rfc7235-005"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q02", query: "RFC 7235 401 Unauthorized", relevantChunkIds: ["rfc7235-001"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q03", query: "TLS 1.3 0-RTT", relevantChunkIds: ["tls13-001", "tls13-005"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q04", query: "AES-GCM ChaCha20", relevantChunkIds: ["tls13-003"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q05", query: "ISBN 978-0-201-89685-5", relevantChunkIds: ["sort-007"], queryType: "isbn-or-version", expectedWinner: "sparse" },
  { id: "q06", query: "qsort vs mergesort", relevantChunkIds: ["sort-001", "sort-002", "sort-003", "sort-008"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q07", query: "useState useEffect React", relevantChunkIds: ["react-001", "react-002"], queryType: "code", expectedWinner: "sparse" },
  { id: "q08", query: "ext4 inode", relevantChunkIds: ["linuxfs-001", "linuxfs-004"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q09", query: "TLS 1.3 supported_versions extension", relevantChunkIds: ["tls13-004"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q10", query: "Knuth volume 3 sorting", relevantChunkIds: ["sort-003", "sort-007"], queryType: "name", expectedWinner: "sparse" },

  /* === Semantic queries (Dense E5 should win) === */
  { id: "q11", query: "как защитить веб-приложение от replay-атак", relevantChunkIds: ["rfc7235-006", "tls13-005"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q12", query: "что такое forward secrecy в криптографии", relevantChunkIds: ["tls13-002"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q13", query: "explain memory tradeoffs in sorting algorithms", relevantChunkIds: ["sort-002", "sort-004"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q14", query: "почему qsort быстрее на маленьких массивах", relevantChunkIds: ["sort-003", "sort-008"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q15", query: "когда использовать reducer вместо state hook", relevantChunkIds: ["react-004"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q16", query: "filesystem with snapshots and copy-on-write", relevantChunkIds: ["linuxfs-002"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q17", query: "роман про моральную теорию убийства", relevantChunkIds: ["rulit-001"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q18", query: "русский писатель эпохи наполеоновских войн", relevantChunkIds: ["rulit-002"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q19", query: "stable sorting algorithm with guaranteed performance", relevantChunkIds: ["sort-002"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q20", query: "as русско-английский переход обработка", relevantChunkIds: ["rulit-003", "rulit-004"], queryType: "semantic", expectedWinner: "dense" },

  /* === Hybrid wins (mix of exact + semantic) === */
  { id: "q21", query: "RFC 7235 framework для HTTP аутентификации", relevantChunkIds: ["rfc7235-001", "rfc7235-005"], queryType: "multilingual", expectedWinner: "hybrid" },
  { id: "q22", query: "Bearer token in OAuth", relevantChunkIds: ["rfc7235-004"], queryType: "exact", expectedWinner: "hybrid" },
  { id: "q23", query: "ECDHE ephemeral key exchange", relevantChunkIds: ["tls13-002"], queryType: "code", expectedWinner: "hybrid" },
  { id: "q24", query: "Достоевский Crime and Punishment перевод", relevantChunkIds: ["rulit-001", "rulit-003"], queryType: "multilingual", expectedWinner: "hybrid" },
  { id: "q25", query: "Tim sort Python adaptive", relevantChunkIds: ["sort-006"], queryType: "exact", expectedWinner: "hybrid" },
  { id: "q26", query: "useMemo useCallback зависимости", relevantChunkIds: ["react-003"], queryType: "code", expectedWinner: "hybrid" },
  { id: "q27", query: "Btrfs subvolumes B-tree", relevantChunkIds: ["linuxfs-002"], queryType: "exact", expectedWinner: "hybrid" },
  { id: "q28", query: "ZFS Linux module GPL", relevantChunkIds: ["linuxfs-003"], queryType: "exact", expectedWinner: "hybrid" },
  { id: "q29", query: "post-handshake authentication TLS 1.3", relevantChunkIds: ["tls13-006"], queryType: "exact", expectedWinner: "hybrid" },
  { id: "q30", query: "WWW-Authenticate realm parameter", relevantChunkIds: ["rfc7235-007"], queryType: "exact", expectedWinner: "hybrid" },

  /* === Multilingual ru/en mix === */
  { id: "q31", query: "Knuth алгоритмы сортировки книга", relevantChunkIds: ["sort-003", "sort-007"], queryType: "multilingual", expectedWinner: "hybrid" },
  { id: "q32", query: "ChaCha20-Poly1305 шифр в TLS", relevantChunkIds: ["tls13-003"], queryType: "multilingual", expectedWinner: "hybrid" },
  { id: "q33", query: "Pevear Volokhonsky translation Dostoyevsky", relevantChunkIds: ["rulit-003"], queryType: "name", expectedWinner: "hybrid" },
  { id: "q34", query: "Chekhov «Дама с собачкой»", relevantChunkIds: ["rulit-004"], queryType: "name", expectedWinner: "hybrid" },
  { id: "q35", query: "Hoare 1962 quicksort algorithm", relevantChunkIds: ["sort-001"], queryType: "name", expectedWinner: "hybrid" },

  /* === Code identifier queries === */
  { id: "q36", query: "useReducer", relevantChunkIds: ["react-004"], queryType: "code", expectedWinner: "sparse" },
  { id: "q37", query: "useEffect dependency array", relevantChunkIds: ["react-002"], queryType: "code", expectedWinner: "sparse" },
  { id: "q38", query: "react-hooks/rules-of-hooks ESLint", relevantChunkIds: ["react-005"], queryType: "code", expectedWinner: "sparse" },
  { id: "q39", query: "Bearer token RFC 6750", relevantChunkIds: ["rfc7235-004"], queryType: "code", expectedWinner: "sparse" },
  { id: "q40", query: "AEAD cipher modes", relevantChunkIds: ["tls13-003"], queryType: "code", expectedWinner: "sparse" },

  /* === Author names + bibliographic === */
  { id: "q41", query: "Donald Knuth", relevantChunkIds: ["sort-007"], queryType: "name", expectedWinner: "sparse" },
  { id: "q42", query: "Толстой Война и мир", relevantChunkIds: ["rulit-002"], queryType: "name", expectedWinner: "sparse" },
  { id: "q43", query: "Hoare quicksort 1962", relevantChunkIds: ["sort-001"], queryType: "name", expectedWinner: "sparse" },
  { id: "q44", query: "MD5 hash weak deprecated", relevantChunkIds: ["rfc7235-006"], queryType: "exact", expectedWinner: "sparse" },
  { id: "q45", query: "Heapsort vs quicksort cache", relevantChunkIds: ["sort-004", "sort-001"], queryType: "exact", expectedWinner: "hybrid" },

  /* === Long natural-language queries === */
  { id: "q46", query: "почему мне нужен HTTPS вместо просто HTTP при базовой аутентификации с логином и паролем", relevantChunkIds: ["rfc7235-008"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q47", query: "what's the difference between authentication and authorization in HTTP", relevantChunkIds: ["rfc7235-001", "rfc7235-002"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q48", query: "как реализовать кастомный хук на React", relevantChunkIds: ["react-005"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q49", query: "tradeoffs between heap-based and divide-conquer sorting algorithms", relevantChunkIds: ["sort-002", "sort-004"], queryType: "semantic", expectedWinner: "dense" },
  { id: "q50", query: "как Linux работает с метаданными файлов на диске", relevantChunkIds: ["linuxfs-004"], queryType: "semantic", expectedWinner: "dense" },
];

/* ─── Sanity checks для самого датасета ───────────────────────────────── */

export interface BenchmarkSelfCheck {
  totalQueries: number;
  totalChunks: number;
  /** Queries у которых хоть один relevant chunk не найден в корпусе. */
  brokenQueries: string[];
  /** Распределение queryType. */
  byQueryType: Record<string, number>;
  /** Распределение expectedWinner. */
  byWinner: Record<string, number>;
}

export function selfCheckBenchmark(): BenchmarkSelfCheck {
  const chunkIds = new Set(BENCHMARK_CORPUS.map((c) => c.id));
  const broken: string[] = [];
  const byQueryType: Record<string, number> = {};
  const byWinner: Record<string, number> = {};

  for (const q of BENCHMARK_QUERIES) {
    const missing = q.relevantChunkIds.filter((id) => !chunkIds.has(id));
    if (missing.length > 0) {
      broken.push(`${q.id}: missing chunks ${missing.join(", ")}`);
    }
    byQueryType[q.queryType] = (byQueryType[q.queryType] ?? 0) + 1;
    byWinner[q.expectedWinner] = (byWinner[q.expectedWinner] ?? 0) + 1;
  }

  return {
    totalQueries: BENCHMARK_QUERIES.length,
    totalChunks: BENCHMARK_CORPUS.length,
    brokenQueries: broken,
    byQueryType,
    byWinner,
  };
}
