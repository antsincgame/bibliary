/**
 * EventSink — runtime abstraction для push-событий из background-модулей
 * (watchdog, snapshot broadcasters, evaluator queue, ...) в потребителя.
 *
 * В Electron-режиме потребитель — main window: реализация оборачивает
 * `webContents.send(channel, payload)` с проверкой `isDestroyed()`.
 *
 * В Web-режиме (`server/`) реализация пишет document в соответствующую
 * Appwrite collection (renderer подписан через Appwrite Realtime SDK
 * напрямую — backend не держит WebSocket dispatcher). Это даёт single
 * source of truth для прогресса (документ в БД) + RT-broadcast «бесплатно».
 *
 * Контракт реализации:
 *   - Не должна выбрасывать — push событий лучше тихо потерять чем уронить
 *     module (модули вроде watchdog'а перепланируют tick независимо).
 *   - Должна быть быстрой (микросекунды), потому что вызывается из
 *     горячих циклов (polling, batch progress).
 *   - В Electron: webContents.send уже асинхронен (POSTs через IPC pipe),
 *     не блокирует. В Web: Appwrite SDK call — должен быть fire-and-forget
 *     (`void promise`) чтобы не блокировать tick.
 */
export type EventSink = (channel: string, payload: unknown) => void;

/** No-op sink — для тестов / отключённых режимов. */
export const noopEventSink: EventSink = () => undefined;
