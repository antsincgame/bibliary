// @ts-check
import { t } from "../i18n.js";
import { buildContextSlider } from "../components/context-slider.js";
import { chatToast, formatTokensShort } from "./dom-helpers.js";

/**
 * @param {{
 *   modelSelect: HTMLSelectElement,
 *   btnMemory: HTMLButtonElement,
 *   btnMemoryLabel: HTMLSpanElement,
 *   memoryPopover: HTMLDivElement
 * }} refs
 */
export function setupMemoryPopover({ modelSelect, btnMemory, btnMemoryLabel, memoryPopover }) {
  let activeForKey = /** @type {string|null} */ (null);

  async function refreshLabel() {
    const modelKey = modelSelect.value;
    if (!modelKey) {
      btnMemoryLabel.textContent = t("ctx.btn.default");
      return;
    }
    try {
      const cur = await window.api.yarn.readCurrent(modelKey);
      if (cur && typeof cur.factor === "number" && typeof cur.original_max_position_embeddings === "number") {
        const tokens = Math.round(cur.factor * cur.original_max_position_embeddings);
        btnMemoryLabel.textContent = formatTokensShort(tokens);
      } else {
        btnMemoryLabel.textContent = t("ctx.btn.default");
      }
    } catch {
      btnMemoryLabel.textContent = t("ctx.btn.default");
    }
  }

  function rebuildSlider() {
    const modelKey = modelSelect.value;
    activeForKey = modelKey;
    memoryPopover.innerHTML = "";
    if (!modelKey) {
      const empty = document.createElement("div");
      empty.className = "memory-popover-empty";
      empty.textContent = t("ctx.btn.no_model");
      memoryPopover.appendChild(empty);
      return;
    }
    const slider = buildContextSlider({
      modelKey,
      mode: "compact",
      onApply: async (target, kvDtype) => {
        try {
          await window.api.yarn.apply(modelKey, target, kvDtype);
          chatToast(t("ctx.toast.applied"), "success");
          await refreshLabel();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          chatToast(t("ctx.toast.apply_fail", { msg }), "error");
        }
      },
      onRevert: async () => {
        try {
          await window.api.yarn.revert(modelKey);
          chatToast(t("ctx.toast.reverted"), "success");
          await refreshLabel();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          chatToast(t("ctx.toast.revert_fail", { msg }), "error");
        }
      },
    });
    memoryPopover.appendChild(slider);
  }

  function open() {
    if (memoryPopover.hidden) {
      const modelKey = modelSelect.value;
      if (activeForKey !== modelKey) rebuildSlider();
      memoryPopover.hidden = false;
      btnMemory.classList.add("active");
    }
  }
  function close() {
    if (!memoryPopover.hidden) {
      memoryPopover.hidden = true;
      btnMemory.classList.remove("active");
    }
  }
  function toggle() {
    if (memoryPopover.hidden) open();
    else close();
  }

  btnMemory.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  document.addEventListener("click", (e) => {
    if (memoryPopover.hidden) return;
    const target = e.target;
    if (target instanceof Node && (memoryPopover.contains(target) || btnMemory.contains(target))) return;
    close();
  });
  modelSelect.addEventListener("change", () => {
    refreshLabel();
    if (!memoryPopover.hidden) rebuildSlider();
  });

  refreshLabel();
}
