/**
 * In-process event bus для push-событий от backend к подписанным
 * SSE-клиентам. Single-instance (один Hono backend pod). Когда поедем
 * на несколько pods — заменить на Redis Pub/Sub или Appwrite Realtime
 * server-side bridge.
 *
 * Контракты:
 *   - publishGlobal: событие видят ВСЕ авторизованные подписчики
 *     (например `resilience:lmstudio-offline`).
 *   - publishUser:   событие видит только владелец-userId (например
 *     `ingest_jobs:update` для книги Alice → только её подписки).
 *   - Subscribers получают события через colback — отписка через
 *     возвращённый unsubscribe function.
 *   - Failures в одном subscriber не должны валить других — каждый
 *     callback в try/catch.
 */

export interface BusEvent {
  channel: string;
  payload: unknown;
}

type EventListener = (event: BusEvent) => void;

interface Subscription {
  id: number;
  userId: string;
  listener: EventListener;
}

let nextSubId = 1;
const subscriptions = new Map<number, Subscription>();

/**
 * Подписаться на события конкретного пользователя.
 *
 * Global events автоматически проходят к любому пользователю.
 * Возвращает unsubscribe function.
 */
export function subscribe(userId: string, listener: EventListener): () => void {
  const id = nextSubId++;
  subscriptions.set(id, { id, userId, listener });
  return () => {
    subscriptions.delete(id);
  };
}

export function publishGlobal(channel: string, payload: unknown): void {
  emit(null, channel, payload);
}

export function publishUser(userId: string, channel: string, payload: unknown): void {
  emit(userId, channel, payload);
}

function emit(userId: string | null, channel: string, payload: unknown): void {
  const event: BusEvent = { channel, payload };
  for (const sub of subscriptions.values()) {
    if (userId !== null && sub.userId !== userId) continue;
    try {
      sub.listener(event);
    } catch (err) {
      /* Один битый subscriber не валит остальных. Лучше потерять
       * push event чем уронить весь bus. */
      console.warn(
        "[event-bus] listener threw:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/* Test helpers — снимают всех subscribers, для изоляции тестов. */
export function _resetEventBusForTesting(): void {
  subscriptions.clear();
  nextSubId = 1;
}

export function _activeSubscriberCount(): number {
  return subscriptions.size;
}
