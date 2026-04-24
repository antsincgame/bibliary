// @ts-check
/**
 * Preview pane: book metadata, sample chunks, OCR hints.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { STATE } from "./state.js";

/**
 * @param {import("./state.js").BookFile} book
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {(listEl: HTMLElement|null, root: HTMLElement) => void} deps.renderBooks
 */
export async function selectForPreview(book, root, deps) {
  STATE.previewBook = book;
  STATE.previewState = "loading";
  STATE.previewData = null;
  renderPreview(root, deps);
  deps.renderBooks(root.querySelector(".lib-list"), root);
  try {
    const data = await window.api.scanner.parsePreview(book.absPath);
    if (STATE.previewBook?.absPath !== book.absPath) return;
    STATE.previewData = data;
    STATE.previewState = "ready";
  } catch (e) {
    if (STATE.previewBook?.absPath !== book.absPath) return;
    STATE.previewData = { error: e instanceof Error ? e.message : String(e) };
    STATE.previewState = "error";
  }
  renderPreview(root, deps);
}

/**
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {(listEl: HTMLElement|null, root: HTMLElement) => void} deps.renderBooks
 * @param {(books: import("./state.js").BookFile[], root: HTMLElement) => void} [deps.enqueueAndStart]
 */
export function renderPreview(root, deps) {
  const pane = root.querySelector(".lib-preview");
  if (!pane) return;
  clear(pane);
  if (!STATE.previewBook) {
    pane.appendChild(el("div", { class: "lib-preview-empty" }, t("library.preview.empty")));
    return;
  }
  const header = el("div", { class: "lib-preview-header" }, [
    el("div", { class: "lib-preview-title" }, STATE.previewBook.fileName),
    el("button", { class: "lib-preview-close", type: "button", "aria-label": "close",
      onclick: () => { STATE.previewBook = null; renderPreview(root, deps); deps.renderBooks(root.querySelector(".lib-list"), root); } }, "x"),
  ]);
  pane.appendChild(header);
  if (STATE.previewState === "loading") {
    pane.appendChild(el("div", { class: "lib-preview-loading" }, t("library.preview.loading")));
    return;
  }
  if (STATE.previewState === "error" || !STATE.previewData) {
    const msg = STATE.previewData?.error || "--";
    pane.appendChild(el("div", { class: "lib-preview-error" }, [t("library.preview.error") + ": ", msg]));
    return;
  }
  if (STATE.previewState !== "ready") return;
  const d = STATE.previewData;
  const meta = d.metadata ?? {};
  const stats = el("div", { class: "lib-preview-stats" }, [
    el("div", {}, [el("strong", {}, t("library.preview.stat.title") + ": "), meta.title ?? "--"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.author") + ": "), meta.author ?? "--"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.lang") + ": "), meta.language ?? "--"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.sections") + ": "), String(d.sectionCount)]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.estChunks") + ": "), String(d.estimatedChunks)]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.chars") + ": "), String(d.rawCharCount)]),
  ]);
  pane.appendChild(stats);
  if (Array.isArray(meta.warnings) && meta.warnings.length > 0) {
    const w = el("div", { class: "lib-preview-warnings" }, [
      el("strong", {}, t("library.preview.warnings") + ":"),
      ...meta.warnings.map((wm) => el("div", { class: "lib-warning" }, "* " + wm)),
    ]);
    pane.appendChild(w);
    const hasOcrCandidate = meta.warnings.some((wm) => /scanned|image|OCR|no text/i.test(String(wm)));
    if (hasOcrCandidate && d.rawCharCount === 0) {
      pane.appendChild(buildOcrHintCard());
    }
  }
  const samples = el("div", { class: "lib-preview-samples" }, [
    el("strong", {}, t("library.preview.firstChunks") + ":"),
  ]);
  for (const c of d.sampleChunks ?? []) {
    samples.appendChild(
      el("div", { class: "lib-sample" }, [
        el("div", { class: "lib-sample-head" }, `${c.chapterTitle} - #${c.chunkIndex} - ${c.charCount} chars`),
        el("div", { class: "lib-sample-body" }, c.text),
      ])
    );
  }
  pane.appendChild(samples);
  const ocrToggleWrap = STATE.prefs.ocrSupported ? buildOcrToggle(root, deps) : null;
  const actions = el("div", { class: "lib-preview-actions" }, [
    deps.enqueueAndStart
      ? el("button", { class: "lib-btn lib-btn-accent", type: "button",
          onclick: () => {
            STATE.selected.set(STATE.previewBook.absPath, STATE.previewBook);
            deps.enqueueAndStart([STATE.previewBook], root);
          } }, t("library.preview.btn.ingestThis"))
      : null,
    ocrToggleWrap,
  ].filter(Boolean));
  pane.appendChild(actions);
}

function buildOcrHintCard() {
  if (STATE.prefs.ocrSupported) {
    return el("div", { class: "lib-warning-ocr lib-warning-ocr-actionable", role: "note" }, [
      el("span", { class: "lib-warning-ocr-icon", "aria-hidden": "true" }, "i"),
      el("div", {}, [
        el("span", { class: "lib-warning-ocr-title" }, t("library.preview.ocr.actionable.title")),
        el("span", { class: "lib-warning-ocr-body" }, t("library.preview.ocr.actionable.body")),
      ]),
    ]);
  }
  return el("div", { class: "lib-warning-ocr", role: "note" }, [
    el("span", { class: "lib-warning-ocr-icon", "aria-hidden": "true" }, "i"),
    el("div", {}, [
      el("span", { class: "lib-warning-ocr-title" }, t("library.preview.ocr.title")),
      el("span", { class: "lib-warning-ocr-body" }, t("library.preview.ocr.body")),
    ]),
  ]);
}

function buildOcrToggle(root, deps) {
  const checked = STATE.ocrOverride !== null ? STATE.ocrOverride : STATE.prefs.ocrEnabled;
  const cb = el("input", { type: "checkbox", class: "lib-ocr-cb", id: "lib-ocr-toggle" });
  if (checked) cb.checked = true;
  cb.addEventListener("change", () => {
    STATE.ocrOverride = cb.checked;
    renderPreview(root, deps);
  });
  return el("label", { class: "lib-ocr-toggle", for: "lib-ocr-toggle", title: t("library.ocr.tooltip") }, [
    cb,
    el("span", {}, t("library.ocr.label")),
  ]);
}
