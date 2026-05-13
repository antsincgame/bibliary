/**
 * Server-Sent Events adapter — single EventSource open в `/api/events`,
 * демультиплексирует по `event:` каналу в per-channel callbacks.
 *
 * Connection life-cycle:
 *   - Lazy connect: открывается на первом subscribe().
 *   - Auto-reconnect: EventSource нативно ретраит на network errors
 *     (с exponential backoff внутри браузера). Auth-fail (401) ловим
 *     через onerror + readyState === CLOSED, и переоткрываем после
 *     успешного /api/auth/refresh.
 *   - Last subscriber unsubscribe → close().
 *
 * Channel routing — простая Map<channel, Set<callback>>. Один SSE
 * event с `event: <channel>` рассылается всем callback'ам канала.
 */

let source = /** @type {EventSource | null} */ (null);
const channelSubscribers = /** @type {Map<string, Set<(payload: unknown) => void>>} */ (new Map());
let reconnectTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

function ensureConnection() {
  if (source && source.readyState !== EventSource.CLOSED) return source;
  const es = new EventSource("/api/events", { withCredentials: true });
  source = es;
  es.onerror = () => {
    /* EventSource reconnect автомат не различает auth-fail от network-fail.
     * При CLOSED state делаем backoff и пытаемся заново — refresh-loop
     * в http.js уже обеспечивает рабочий cookie. */
    if (es.readyState === EventSource.CLOSED && channelSubscribers.size > 0) {
      scheduleReconnect();
    }
  };
  /* Привязываем уже-зарегистрированные каналы к новому EventSource. */
  for (const channel of channelSubscribers.keys()) {
    attachChannel(es, channel);
  }
  return es;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (channelSubscribers.size > 0) ensureConnection();
  }, 2_000);
}

/** @param {EventSource} es @param {string} channel */
function attachChannel(es, channel) {
  es.addEventListener(channel, (ev) => {
    const subs = channelSubscribers.get(channel);
    if (!subs || subs.size === 0) return;
    let payload = /** @type {unknown} */ (null);
    try {
      payload = ev instanceof MessageEvent && typeof ev.data === "string"
        ? JSON.parse(ev.data)
        : null;
    } catch {
      payload = ev instanceof MessageEvent ? ev.data : null;
    }
    for (const cb of subs) {
      try {
        cb(payload);
      } catch (err) {
        console.warn(`[realtime] subscriber on '${channel}' threw:`, err);
      }
    }
  });
}

/**
 * Subscribe to a server-side channel. Returns unsubscribe.
 *
 * @param {string} channel
 * @param {(payload: unknown) => void} callback
 * @returns {() => void}
 */
export function subscribe(channel, callback) {
  let subs = channelSubscribers.get(channel);
  if (!subs) {
    subs = new Set();
    channelSubscribers.set(channel, subs);
    const es = ensureConnection();
    attachChannel(es, channel);
  } else {
    /* Lazy: если EventSource ещё не открыт (первый subscribe вообще),
     * откроется сейчас. */
    ensureConnection();
  }
  subs.add(callback);

  return () => {
    const set = channelSubscribers.get(channel);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) channelSubscribers.delete(channel);
    if (channelSubscribers.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}

/** Тест/cleanup helper — закрывает соединение, дропает подписки. */
export function _resetRealtimeForTesting() {
  if (source) {
    source.close();
    source = null;
  }
  channelSubscribers.clear();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
