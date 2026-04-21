// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Универсальный resume-banner для незавершённых batch-ов.
 * Показывается при mount Dataset-page (и потенциально других страниц).
 *
 * @param {object} opts
 * @param {Array<{ pipeline: string; id: string; snapshot: any }>} opts.unfinished
 * @param {(batchId: string) => Promise<void>} opts.onResume
 * @param {(batchId: string) => Promise<void>} opts.onDiscard
 * @param {() => void} [opts.onDismiss]
 * @returns {HTMLElement|null}
 */
export function buildResumeBanner({ unfinished, onResume, onDiscard, onDismiss }) {
  const datasetItems = unfinished.filter((u) => u.pipeline === "dataset");
  if (datasetItems.length === 0) return null;

  const list = el("div", { class: "resume-banner-list", role: "list" });
  for (const item of datasetItems) {
    const snap = item.snapshot ?? {};
    const processed = Array.isArray(snap.processedChunkIds) ? snap.processedChunkIds.length : 0;
    const lastSavedAt = typeof snap.lastSavedAt === "string" ? snap.lastSavedAt : "—";
    const batchFile = typeof snap.batchFile === "string" ? snap.batchFile : item.id;

    const continueBtn = el(
      "button",
      {
        class: "btn btn-gold",
        type: "button",
      },
      t("ds.resume.banner.continue")
    );
    const discardBtn = el(
      "button",
      {
        class: "btn btn-ghost",
        type: "button",
      },
      t("ds.resume.banner.discard")
    );

    // Защита от двойного клика: блокируем обе кнопки на время IPC.
    const lock = (action) => async () => {
      if (continueBtn.disabled || discardBtn.disabled) return;
      continueBtn.disabled = true;
      discardBtn.disabled = true;
      try {
        await action();
      } finally {
        continueBtn.disabled = false;
        discardBtn.disabled = false;
      }
    };

    continueBtn.addEventListener("click", lock(() => onResume(item.id)));
    discardBtn.addEventListener(
      "click",
      lock(async () => {
        if (!confirm(t("ds.resume.banner.confirm_discard", { batch: batchFile }))) return;
        await onDiscard(item.id);
      })
    );

    list.appendChild(
      el("div", { class: "resume-banner-row", role: "listitem" }, [
        el("div", { class: "resume-banner-id" }, batchFile),
        el(
          "div",
          { class: "resume-banner-meta" },
          t("ds.resume.banner.meta", { processed, ts: shortTs(lastSavedAt) })
        ),
        continueBtn,
        discardBtn,
      ])
    );
  }

  return el("div", { class: "card resume-banner" }, [
    el("div", { class: "resume-banner-title" }, t("ds.resume.banner.title")),
    el("div", { class: "resume-banner-sub" }, t("ds.resume.banner.sub")),
    list,
    onDismiss
      ? el(
          "button",
          {
            class: "btn btn-ghost resume-banner-close",
            onclick: onDismiss,
          },
          t("ds.resume.banner.dismiss")
        )
      : null,
  ].filter(Boolean));
}

function shortTs(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
