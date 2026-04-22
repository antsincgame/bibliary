// @ts-check
// Изменено: новый файл — toast о ребрендинге v2.4 (Forge → Дообучение, Crystallizer →
// Извлечение знаний, Memory Forge → Расширение контекста). Показывается один раз
// существующим пользователям; persist через preferences.seenRebrandV2.

import { el } from "../dom.js";
import { t } from "../i18n.js";

const TOAST_ID = "changelog-rebrand-v2-toast";
const AUTO_DISMISS_MS = 15_000;

/**
 * Показывает changelog-toast о ребрендинге v2.4, если пользователь его ещё
 * не видел. Идемпотентен: повторные вызовы при уже-показанном toast — no-op.
 *
 * Контракт: вызывается ОДИН раз из router.js после bootstrap'а UI и только
 * если onboardingDone === true (новички видят полноценный wizard, им toast
 * не нужен — они итак узнают новые названия).
 *
 * Persist-слой: window.api.preferences.{getAll, set} (см. electron/lib/preferences/store.ts,
 * ключ seenRebrandV2: boolean).
 *
 * @returns {Promise<void>}
 */
export async function maybeShowRebrandToast() {
  if (document.getElementById(TOAST_ID)) return;

  let seen = false;
  try {
    const prefs = /** @type {any} */ (await window.api.preferences.getAll());
    seen = prefs?.seenRebrandV2 === true;
  } catch (err) {
    /* preferences недоступны — не показываем toast чтобы не дёргать
       пользователя без возможности сохранить «прочитано». */
    console.warn("[changelog-toast] preferences unavailable, skipping:", err);
    return;
  }
  if (seen) return;

  renderToast();
}

function renderToast() {
  const dismiss = async () => {
    const node = document.getElementById(TOAST_ID);
    if (node) node.remove();
    try {
      await window.api.preferences.set({ seenRebrandV2: true });
    } catch (err) {
      console.error("[changelog-toast] failed to persist seenRebrandV2:", err);
    }
  };

  const overlay = el("div", {
    id: TOAST_ID,
    class: "changelog-toast",
    role: "alert",
    "aria-live": "polite",
  }, [
    el("div", { class: "changelog-toast-title" }, t("changelog.rebrand_v2.title")),
    el("div", { class: "changelog-toast-body" }, t("changelog.rebrand_v2.body")),
    el("button", {
      class: "changelog-toast-dismiss",
      type: "button",
      onclick: () => { void dismiss(); },
    }, t("changelog.rebrand_v2.dismiss")),
  ]);

  document.body.appendChild(overlay);

  /* Авто-скрытие через AUTO_DISMISS_MS — toast НЕ блокирует UI, но и не должен
     висеть вечно. Setting persist'ится только при явном клике "Понятно" —
     это нарочно: если человек просто прошёл мимо, при следующем запуске
     toast покажется снова. */
  setTimeout(() => {
    const node = document.getElementById(TOAST_ID);
    if (node) node.remove();
  }, AUTO_DISMISS_MS);
}
