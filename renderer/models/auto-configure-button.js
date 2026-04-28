// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { CALIBRATABLE_ROLES } from "./role-utils.js";

export function buildAutoConfigureButton({ progress, onDone, onError }) {
  const btn = el("button", { class: "cyber-button cyber-button-primary", type: "button" }, [
    el("span", { class: "cyber-prefix", "aria-hidden": "true" }, ">"),
    el("span", {}, t("models.autoConfigure")),
  ]);

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      progress?.start(t("models.calibration.all_roles"));
      progress?.log(t("models.calibration.lock_check"));
      const lock = await window.api.arena.getLockStatus();
      if (lock.busy) {
        const reason = lock.reasons.join(", ");
        progress?.finish(false, t("models.calibration.skipped", { reason }));
        return;
      }

      progress?.log(t("models.calibration.running"));
      const report = await window.api.arena.runCycle({ roles: CALIBRATABLE_ROLES, manual: true });
      if (report.skipped) {
        const reason = (report.skipReasons ?? []).join(", ") || report.message;
        progress?.finish(false, t("models.calibration.skipped", { reason }));
        return;
      }
      for (const role of report.perRole ?? []) {
        progress?.log(`${role.role}: ${role.matches} ${t("models.calibration.matches")}`, role.matches > 0 ? "ok" : "info");
      }
      progress?.finish(report.ok, report.message);
      if (onDone) await onDone(report);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      progress?.finish(false, error.message);
      if (onError) onError(error);
    } finally {
      btn.disabled = false;
    }
  });

  return btn;
}
