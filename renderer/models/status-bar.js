// @ts-check
import { el } from "./dom.js";

/** @param {{online:boolean,version?:string}} status */
export function statusBar(status) {
  const dot = el("div", {
    class: `status-dot${status.online ? " online" : ""}`,
    title: status.online ? "LM Studio online" : "LM Studio offline",
  });
  return el(
    "div",
    { style: "display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text-dim);letter-spacing:1px;" },
    [
      dot,
      document.createTextNode(
        status.online ? `LM Studio online${status.version ? ` · v${status.version}` : ""}` : "LM Studio offline"
      ),
    ]
  );
}
