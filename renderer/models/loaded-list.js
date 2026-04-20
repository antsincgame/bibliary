// @ts-check
import { el } from "./dom.js";

/**
 * @param {Array<{identifier:string,modelKey:string,contextLength?:number,quantization?:string}>} loaded
 * @param {(identifier:string)=>void} onUnload
 */
export function loadedList(loaded, onUnload) {
  if (loaded.length === 0) {
    return el("div", { style: "font-size:12px;color:var(--text-dim);" }, "No models in memory.");
  }
  return el(
    "div",
    {},
    loaded.map((m) => {
      const meta = [
        m.quantization ? m.quantization : null,
        m.contextLength ? `${m.contextLength.toLocaleString()} ctx` : null,
      ].filter(Boolean).join(" · ");
      return el("div", { class: "list-row" }, [
        el("div", { class: "col-main" }, [
          el("strong", { style: "color:var(--cyan);" }, m.modelKey),
          document.createTextNode(`  · id ${m.identifier.slice(0, 12)}…`),
        ]),
        el("div", { class: "col-meta" }, meta),
        el(
          "button",
          {
            class: "btn btn-ghost",
            style: "padding:4px 10px;font-size:9px;",
            onclick: () => onUnload(m.identifier),
          },
          "Unload"
        ),
      ]);
    })
  );
}
