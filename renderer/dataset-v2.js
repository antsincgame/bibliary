// @ts-check
/**
 * Создание датасета — UI для генерации обучающих примеров через нейросеть.
 *
 * Только LLM-синтез (минуты-часы, через выбранную модель LM Studio).
 * Шаблонный «быстрый экспорт» убран — он давал низкое качество.
 *
 * Готовый JSONL заливается прямо в облачные провайдеры (Google Colab,
 * HuggingFace, Together AI, OpenAI, Fireworks).
 *
 * Декомпозиция (Phase 3.4 cross-platform roadmap, 2026-04-30):
 *   - `dataset-v2-state.js`    — STATE singleton + helpers (phaseToLabel)
 *   - `dataset-v2-wizard.js`   — buildStep1..4 + buildPrimaryAction
 *   - `dataset-v2-progress.js` — onSynthStart/Stop + renderProgress + handleEvent
 *
 * В этом файле остаются: `mountCrystal` (entry-point) и публичный
 * re-export `isCrystalBusy` для router.
 */

import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { STATE } from "./dataset-v2-state.js";
import {
  buildStep1,
  buildStep2,
  buildStep3,
  buildStep4,
  buildPrimaryAction,
} from "./dataset-v2-wizard.js";
import {
  buildProgress,
  renderProgress,
  handleEvent,
} from "./dataset-v2-progress.js";

export { isCrystalBusy } from "./dataset-v2-state.js";

let unsub = null;

export function mountCrystal(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  /* Read cross-section pre-fill (set by Library "Создать датасет") */
  try {
    const prefill = sessionStorage.getItem("bibliary_dataset_prefill_collection");
    if (prefill) {
      STATE.collection = prefill;
      sessionStorage.removeItem("bibliary_dataset_prefill_collection");
    }
  } catch {
    /* sessionStorage may be unavailable */
  }

  const hero = el("header", { class: "ds-hero" }, [
    el("h1", { class: "ds-hero-title" }, t("dataset.hero.title")),
    el("p", { class: "ds-hero-sub" }, t("dataset.hero.sub")),
    el("p", { class: "ds-hero-note" }, t("dataset.hero.synthNote")),
  ]);

  const steps = el("div", { class: "ds-steps" }, [
    buildStep1(root),
    buildStep2(),
    buildStep3(),
    buildStep4(root),
  ]);

  const action = buildPrimaryAction(root);
  const progress = buildProgress();

  root.append(hero, steps, action, progress);
  renderProgress(root);

  if (unsub) unsub();
  unsub = window.api.datasetV2.onEvent((payload) => handleEvent(root, payload));
}
