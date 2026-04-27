const controller = new AbortController();

export function getAppShutdownSignal(): AbortSignal {
  return controller.signal;
}

export function triggerAppShutdown(): void {
  if (!controller.signal.aborted) {
    controller.abort("app-quit");
  }
}
