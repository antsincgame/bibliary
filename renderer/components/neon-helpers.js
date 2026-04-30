// @ts-check
/**
 * Phase 5.0 -- Shared Neon UI helpers.
 *
 * Reusable building blocks for Neon Wave Future design system:
 * - buildNeonHero()    -- hero section with sacred geometry background
 * - neonDivider()      -- quantum gradient separator
 */
import { el } from "../dom.js";
import { metatronCube, flowerOfLife, svgDataUrl } from "./sacred-geometry.js";

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {"metatron"|"flower"|"none"} [opts.pattern]
 * @param {Node|Node[]} [opts.actions]
 * @returns {HTMLElement}
 */
export function buildNeonHero({ title, subtitle, pattern = "metatron", actions }) {
  const bgSvg = pattern === "metatron"
    ? svgDataUrl(metatronCube({ size: 400, opacity: 0.07, color: "#ffd700" }))
    : pattern === "flower"
      ? svgDataUrl(flowerOfLife({ size: 400, opacity: 0.07, color: "#ffd700" }))
      : null;

  const hero = el("div", { class: "hero-neon" });

  if (bgSvg) {
    hero.style.setProperty("--hero-pattern", `url("${bgSvg}")`);
  }

  const titleEl = el("h2", { class: "hero-neon-title neon-heading" }, title);
  hero.appendChild(titleEl);

  if (subtitle) {
    hero.appendChild(el("p", { class: "hero-neon-sub neon-sub" }, subtitle));
  }

  if (actions) {
    const bar = el("div", { class: "hero-neon-actions" });
    const list = Array.isArray(actions) ? actions : [actions];
    for (const a of list) bar.appendChild(a);
    hero.appendChild(bar);
  }

  return hero;
}

/** Quantum gradient separator. */
export function neonDivider() {
  return el("div", { class: "quantum-divider" });
}
