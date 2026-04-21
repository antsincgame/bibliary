// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";

/** @param {{online:boolean,version?:string}} status */
export function statusBar(status) {
  const dot = el("div", {
    class: `status-dot${status.online ? " online" : ""}`,
    title: status.online ? t("chat.status.online") : t("chat.status.offline"),
  });
  const text = status.online
    ? t("models.status.online", { ver: status.version ? ` · v${status.version}` : "" })
    : t("models.status.offline");
  return el(
    "div",
    { style: "display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text-dim);letter-spacing:1px;" },
    [dot, document.createTextNode(text)]
  );
}
