// @ts-check
import { el, fmtBytes } from "./dom.js";

/**
 * @param {Array<{modelKey:string,displayName?:string,format?:string,paramsString?:string,architecture?:string,quantization?:string,sizeBytes?:number}>} downloaded
 * @param {(key:string)=>void} onLoad
 * @param {Set<string>=} loadedKeys
 */
export function downloadedList(downloaded, onLoad, loadedKeys) {
  if (downloaded.length === 0) {
    return el("div", { style: "font-size:12px;color:var(--text-dim);" }, "Cannot reach LM Studio (or no LLMs downloaded).");
  }
  const sorted = [...downloaded].sort((a, b) => a.modelKey.localeCompare(b.modelKey));
  return el(
    "div",
    {},
    sorted.map((m) => {
      const isLoaded = loadedKeys?.has(m.modelKey) ?? false;
      const meta = [
        m.architecture,
        m.paramsString,
        m.quantization,
        m.format,
        fmtBytes(m.sizeBytes),
      ].filter(Boolean).join(" · ");
      return el("div", { class: "list-row" }, [
        el("div", { class: "col-main" }, [
          el("strong", { style: "color:var(--text);" }, m.modelKey),
          m.displayName && m.displayName !== m.modelKey
            ? document.createTextNode(`  · ${m.displayName}`)
            : null,
        ].filter(Boolean)),
        el("div", { class: "col-meta" }, meta),
        el(
          "button",
          {
            class: isLoaded ? "btn btn-ghost" : "btn",
            style: "padding:4px 10px;font-size:9px;",
            disabled: isLoaded ? "true" : null,
            onclick: () => onLoad(m.modelKey),
          },
          isLoaded ? "Loaded" : "Load"
        ),
      ]);
    })
  );
}
