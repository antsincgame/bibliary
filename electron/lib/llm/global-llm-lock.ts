/**
 * GlobalLlmLock — единая точка координации эксклюзивного доступа к LM Studio.
 *
 * МОТИВАЦИЯ:
 *   Локальный LM Studio — один процесс, один пул VRAM/RAM. Конкурентные
 *   фоновые задачи (импорт, evaluator queue, vision-meta) могут вызвать
 *   OOM или таймауты если не координировать доступ к model handle.
 *
 * АРХИТЕКТУРА:
 *   Lock не блокирует и не сериализует вызовы — это slim probe registry:
 *
 *     1. Подсистемы регистрируют свои probes (`isImportingNow()` etc.) при
 *        bootstrap. Probe возвращает {busy, reason} — синхронно, < 1мс.
 *     2. Любой "тяжёлый" фоновый job перед стартом вызывает `globalLlmLock.isBusy()`.
 *        Если хоть один probe busy — job скипает свой тик и пишет skip-метрику.
 *
 *   Никаких mutex-семантик с acquire/release — у нас не критическая секция
 *   с гонкой за один ресурс, а "вежливый" фоновый воркер, который НЕ
 *   стартует когда LLM уже занята.
 *
 * РАСШИРЯЕМОСТЬ:
 *   Чтобы добавить нового потребителя (vision_queue, dataset-v2-extraction,
 *   forge-eval), достаточно один раз вызвать `registerProbe(label, fn)` —
 *   scheduler автоматически начнёт уважать новый сигнал.
 */

export interface ProbeResult {
  busy: boolean;
  /** Человеко-читаемая причина для лога / UI (опционально). */
  reason?: string;
}

export type Probe = () => ProbeResult;

export interface LockStatus {
  busy: boolean;
  /** Список причин в формате "label: reason" для каждого busy probe. */
  reasons: string[];
  /** Сколько раз scheduler пропускал тик из-за этого lock. */
  skipCount: number;
  /** ISO timestamp последнего скипа или null. */
  lastSkippedAt: string | null;
  /** reasons на момент последнего скипа (для UI диагностики). */
  lastSkipReasons: string[];
  /** Список зарегистрированных probes (для UI). */
  registeredProbes: string[];
}

class GlobalLlmLock {
  private readonly probes = new Map<string, Probe>();
  private skipCount = 0;
  private lastSkippedAt: string | null = null;
  private lastSkipReasons: string[] = [];

  /**
   * Зарегистрировать probe под уникальным label. Возвращает unregister-функцию
   * для тестов / cleanup. Если label уже занят — старый перезаписывается
   * (это намеренно, чтобы тесты могли подменять probe без конфликтов).
   */
  registerProbe(label: string, probe: Probe): () => void {
    this.probes.set(label, probe);
    return () => {
      const cur = this.probes.get(label);
      if (cur === probe) this.probes.delete(label);
    };
  }

  /**
   * Синхронно опросить все probes. Возвращает busy=true если хоть один
   * probe говорит busy. Reasons собираются в формате "label: reason".
   *
   * Контракт: probes должны быть БЫСТРЫМИ (< 1мс) и НЕ делать I/O.
   * Если probe бросает — он считается non-busy (lenient mode), ошибка
   * логируется но не валит scheduler.
   */
  isBusy(): { busy: boolean; reasons: string[] } {
    const reasons: string[] = [];
    for (const [label, probe] of this.probes.entries()) {
      try {
        const r = probe();
        if (r.busy) {
          reasons.push(r.reason ? `${label}: ${r.reason}` : label);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[global-llm-lock] probe "${label}" threw:`, msg);
      }
    }
    return { busy: reasons.length > 0, reasons };
  }

  /**
   * Записать факт скипа. Вызывается scheduler'ом когда `isBusy()` вернул
   * busy и тик был пропущен. Используется для метрик и UI индикатора.
   */
  recordSkip(reasons: string[]): void {
    this.skipCount += 1;
    this.lastSkippedAt = new Date().toISOString();
    this.lastSkipReasons = [...reasons];
  }

  /** Сбросить счётчики (для тестов и UI кнопки "Reset stats"). */
  resetMetrics(): void {
    this.skipCount = 0;
    this.lastSkippedAt = null;
    this.lastSkipReasons = [];
  }

  getStatus(): LockStatus {
    const cur = this.isBusy();
    return {
      busy: cur.busy,
      reasons: cur.reasons,
      skipCount: this.skipCount,
      lastSkippedAt: this.lastSkippedAt,
      lastSkipReasons: [...this.lastSkipReasons],
      registeredProbes: Array.from(this.probes.keys()),
    };
  }

  /** Очистить registry — только для тестов. */
  _resetForTests(): void {
    this.probes.clear();
    this.resetMetrics();
  }
}

export const globalLlmLock = new GlobalLlmLock();
