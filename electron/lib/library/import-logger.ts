/**
 * Import Logger — централизованный лог процесса импорта.
 *
 * Контракт:
 *   1. КАЖДОЕ событие импорта (старт, файл-обнаружен, файл-успех, файл-ошибка,
 *      предупреждение парсера, завершение) → одна JSON-строка в `data/logs/import-{ts}.jsonl`.
 *   2. Те же события эмитятся через EventEmitter, чтобы IPC-bridge мог
 *      пробросить их в renderer real-time.
 *   3. Rolling buffer (последние 500 записей) для UI «открой и увидь что было».
 *   4. Персист через append-only — даже если приложение упало посреди импорта,
 *      файл лога не теряется (fsync на каждой записи был бы дорогой; используем
 *      буферизованную запись с flush на завершении импорта и periodic flush).
 *
 * Это НЕ замена `console.log`. Это структурированный аудит для расследования.
 */

import { promises as fs } from "fs";
import { EventEmitter } from "events";
import * as path from "path";
import * as os from "os";

export type ImportLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Категории событий. Renderer фильтрует/группирует по category, а не по тексту.
 * Любое новое событие импорта → новая category, не переопределение существующей.
 */
export type ImportLogCategory =
  | "import.start"
  | "import.complete"
  | "import.cancel"
  | "import.crash" /* Импорт оборвался (приложение закрыто, OOM, etc) */
  | "scan.discovered"
  | "scan.complete"
  | "file.start"
  | "file.added"
  | "file.duplicate"
  | "file.skipped"
  | "file.failed"
  | "file.warning"
  | "archive.start"
  | "archive.failed"
  | "archive.warning"
  | "vision.start"
  | "vision.success"
  | "vision.failed"
  | "vision.illustration" /* Прогресс/ошибки worker'а иллюстраций (Semantic Triage). */
  | "evaluator.queued"
  | "evaluator.started"
  | "evaluator.done"
  | "evaluator.failed"
  | "evaluator.skipped"
  | "evaluator.paused"
  | "evaluator.resumed"
  | "evaluator.idle"
  | "model.collision" /* Diagnostic: одна модель LM Studio шарится несколькими ролями. */
  | "system.info"
  | "system.warn"
  | "system.error";

export interface ImportLogEntry {
  /** ISO-8601 timestamp с миллисекундами. */
  ts: string;
  /** UUID текущего импорта (тот же, что в IPC importId). */
  importId: string;
  level: ImportLogLevel;
  category: ImportLogCategory;
  /** Human-readable однострочное сообщение. */
  message: string;
  /** Опциональный путь файла, к которому относится событие. */
  file?: string;
  /** Опциональная произвольная структура для деталей (stack, parsed flags). */
  details?: Record<string, unknown>;
  /** Длительность операции в мс, если применимо. */
  durationMs?: number;
}

/**
 * Размер rolling-буфера в памяти. Когда юзер открывает import pane, видит
 * последние N событий. Дальше идёт streaming.
 */
const RING_BUFFER_SIZE = 500;

/**
 * Сколько записей держать в write-буфере до flush. Импорт большой папки на 50k
 * книг даст много warning'ов; периодический flush защищает от потери данных
 * при краше приложения.
 */
const WRITE_FLUSH_THRESHOLD = 32;
const WRITE_FLUSH_INTERVAL_MS = 1500;

class ImportLogger {
  private readonly ee = new EventEmitter();
  private readonly ring: ImportLogEntry[] = [];
  private sessionSeq = 0;
  private writeBuffer: string[] = [];
  private logFile: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private writeInProgress: Promise<void> = Promise.resolve();
  private active = false;

  /**
   * Resolve каталог логов с учётом BIBLIARY_DATA_DIR / fallback.
   * Не использует userData (см. `paths.ts` — пользователь хочет всё в папке проекта).
   */
  private resolveLogsDir(): string {
    const fromEnv = process.env.BIBLIARY_DATA_DIR?.trim();
    if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv, "logs");
    /* Поднимаемся к корню проекта (где package.json), как paths.ts. */
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = path.join(dir, "package.json");
        if (require("fs").existsSync(pkg)) return path.join(dir, "data", "logs");
      } catch {
        /* tolerate */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.join(process.cwd(), "data", "logs");
  }

  /**
   * Открывает новый лог-файл. Один файл на одну сессию импорта (importFolder
   * или importFiles). Возвращает путь файла для отображения в UI.
   */
  async startSession(importId: string): Promise<string> {
    if (this.active) {
      /* Прежняя сессия не была закрыта (краш или забытый close) — flush'им и закрываем. */
      await this.flush(true);
      await this.endSession({ status: "abandoned" });
    }
    const dir = this.resolveLogsDir();
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionSeq += 1;
    const seq = String(this.sessionSeq).padStart(4, "0");
    this.logFile = path.join(dir, `import-${ts}-${seq}-${importId.slice(0, 8)}.jsonl`);
    this.ring.length = 0;
    this.writeBuffer = [];
    this.active = true;
    /* Первая строка — заголовок сессии (системные данные для расследования). */
    await this.write({
      level: "info",
      category: "import.start",
      importId,
      message: `Import session started`,
      details: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cpus: os.cpus().length,
        logFile: this.logFile,
      },
    });
    this.scheduleFlush();
    return this.logFile;
  }

  /**
   * Запись события. Идемпотентна на отсутствие сессии — если startSession
   * не был вызван, событие попадает в ring (UI), но не на диск.
   */
  async write(entry: Omit<ImportLogEntry, "ts">): Promise<void> {
    const full: ImportLogEntry = {
      ts: new Date().toISOString(),
      ...entry,
    };
    this.ring.push(full);
    if (this.ring.length > RING_BUFFER_SIZE) this.ring.shift();
    this.ee.emit("log", full);

    if (this.logFile) {
      this.writeBuffer.push(JSON.stringify(full));
      if (this.writeBuffer.length >= WRITE_FLUSH_THRESHOLD) {
        await this.flush();
      }
    }
  }

  /**
   * Принудительный flush. `sync=true` ждёт завершения записи; иначе fire-and-forget.
   * Используется и периодически (timer), и в `endSession` для гарантированного слива.
   */
  async flush(sync = false): Promise<void> {
    if (!this.logFile || this.writeBuffer.length === 0) return;
    const chunk = this.writeBuffer.join("\n") + "\n";
    this.writeBuffer = [];
    const file = this.logFile;
    const op = fs.appendFile(file, chunk, { encoding: "utf-8" }).catch((err) => {
      /* Лог-запись не должна валить импорт. Пишем в stderr для трейса. */
      console.error(`[import-logger] appendFile failed for ${file}:`, err);
    });
    this.writeInProgress = this.writeInProgress.then(() => op);
    if (sync) await this.writeInProgress;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => { /* tolerate */ });
    }, WRITE_FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /**
   * Закрытие сессии: финальный flush + остановка таймера. Вызывается всегда,
   * даже если импорт завершился ошибкой — иначе следующий startSession
   * увидит висящий active=true.
   */
  async endSession(payload: { status: "ok" | "failed" | "cancelled" | "abandoned"; summary?: Record<string, unknown> }): Promise<void> {
    if (!this.active) return;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    /* Не-emit'им finalize-событие как отдельную запись (конец сессии описывается
       последним import.complete от caller'а), чтобы лог-файл оставался простым
       чанком событий без metadata-вложенностей. */
    void payload;
    await this.flush(true);
    await this.writeInProgress;
    this.active = false;
    this.logFile = null;
  }

  /** Snapshot текущего ring-буфера для UI «при открытии вкладки покажи прошлое». */
  snapshot(): ImportLogEntry[] {
    return [...this.ring];
  }

  /**
   * Полная очистка: удаляет ВСЕ .jsonl файлы из каталога логов + ring buffer.
   * Возвращает число удалённых файлов.
   */
  async clearAll(): Promise<number> {
    this.ring.length = 0;
    this.writeBuffer = [];
    const dir = this.resolveLogsDir();
    let removed = 0;
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (f.endsWith(".jsonl") && f.startsWith("import-")) {
          try {
            await fs.unlink(path.join(dir, f));
            removed++;
          } catch { /* skip locked / missing files */ }
        }
      }
    } catch { /* logs dir doesn't exist — nothing to clear */ }
    return removed;
  }

  /**
   * Загружает записи последних сессий с диска в ring-буфер.
   * Вызывается при первом обращении к snapshot когда ring пуст (app restart).
   * Читает до 3 последних .jsonl файлов, берёт не более RING_BUFFER_SIZE записей.
   * Идемпотентно: если ring уже заполнен — no-op.
   */
  async loadLastDiskSession(): Promise<void> {
    if (this.ring.length > 0) return;
    const dir = this.resolveLogsDir();
    try {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        return; /* logs dir doesn't exist yet */
      }
      const jsonlFiles = files
        .filter((f) => f.endsWith(".jsonl") && f.startsWith("import-"))
        .sort()
        .reverse()
        .slice(0, 3);

      const entries: ImportLogEntry[] = [];
      for (const file of [...jsonlFiles].reverse()) {
        let content: string;
        try {
          content = await fs.readFile(path.join(dir, file), "utf-8");
        } catch {
          continue;
        }
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed) as ImportLogEntry);
          } catch {
            /* skip malformed lines */
          }
        }
      }
      const slice = entries.slice(-RING_BUFFER_SIZE);
      for (const e of slice) this.ring.push(e);
    } catch {
      /* tolerate: log restore is best-effort */
    }
  }

  /** Подписка на новые события. Возвращает функцию отписки. */
  subscribe(listener: (entry: ImportLogEntry) => void): () => void {
    this.ee.on("log", listener);
    return () => this.ee.off("log", listener);
  }

  /** Текущий путь активного лог-файла (null если сессии нет). */
  currentLogFile(): string | null {
    return this.logFile;
  }
}

/* Singleton: один логгер на процесс. Imports могут быть последовательны (одна
   IPC-сессия за раз для library:import-*), поэтому singleton — корректно. */
const logger = new ImportLogger();

export function getImportLogger(): ImportLogger {
  return logger;
}

/** Тестовый helper: новый logger с изолированным state. */
export function _createImportLoggerForTests(): ImportLogger {
  return new ImportLogger();
}
