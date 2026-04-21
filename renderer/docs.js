// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";

/**
 * Помощь / Документация / Кодекс — встроенный онбординг.
 * Стиль: neon-wave-future. Тёмный фон, золотой акцент, сакральная сетка.
 *
 * @param {HTMLElement} root
 */
export function mountDocs(root) {
  clear(root);
  root.appendChild(buildHero());
  root.appendChild(buildToc());
  root.appendChild(buildSection("overview", buildOverview));
  root.appendChild(buildSection("start", buildStart));
  root.appendChild(buildSection("memory", buildMemory));
  root.appendChild(buildSection("chat", buildChat));
  root.appendChild(buildSection("formats", buildFormats));
  root.appendChild(buildSection("resilience", buildResilience));
  root.appendChild(buildSection("troubleshoot", buildTroubleshoot));
  root.appendChild(buildSection("advanced", buildAdvanced));
  root.appendChild(buildCta());
}

function buildHero() {
  const hero = el("section", { class: "docs-hero" }, [
    el("div", { class: "docs-hero-grid", "aria-hidden": "true" }),
    el("div", { class: "docs-hero-glow", "aria-hidden": "true" }),
    el("div", { class: "docs-hero-inner" }, [
      el("div", { class: "docs-hero-eyebrow" }, t("docs.hero.eyebrow")),
      el("h1", { class: "docs-hero-title" }, t("docs.hero.title")),
      el("p", { class: "docs-hero-sub" }, t("docs.hero.sub")),
      el(
        "button",
        {
          class: "docs-hero-cta",
          type: "button",
          onclick: () => scrollToSection("overview"),
        },
        t("docs.hero.cta")
      ),
    ]),
  ]);
  return hero;
}

function buildToc() {
  const sections = ["overview", "start", "memory", "chat", "formats", "resilience", "troubleshoot", "advanced"];
  const list = el("ol", { class: "docs-toc-list" });
  sections.forEach((id, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const li = el("li", { class: "docs-toc-item" }, [
      el(
        "button",
        {
          class: "docs-toc-link",
          type: "button",
          onclick: () => scrollToSection(id),
        },
        [
          el("span", { class: "docs-toc-num" }, num),
          el("span", { class: "docs-toc-text" }, t(`docs.section.${id}.title`)),
        ]
      ),
    ]);
    list.appendChild(li);
  });
  return el("nav", { class: "docs-toc", "aria-label": t("docs.toc.title") }, [
    el("div", { class: "docs-toc-title" }, t("docs.toc.title")),
    list,
  ]);
}

/**
 * @param {string} id
 * @param {() => HTMLElement} bodyBuilder
 */
function buildSection(id, bodyBuilder) {
  return el("section", { class: "docs-section", id: `docs-${id}` }, [
    el("header", { class: "docs-section-head" }, [
      el("div", { class: "docs-section-title" }, t(`docs.section.${id}.title`)),
      el("div", { class: "docs-section-sub" }, t(`docs.section.${id}.sub`)),
    ]),
    bodyBuilder(),
  ]);
}

function buildOverview() {
  return el("div", { class: "docs-card docs-card-wide" }, [
    el("p", { class: "docs-paragraph" }, t("docs.section.overview.body")),
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.overview.points.1")),
      el("li", {}, t("docs.section.overview.points.2")),
      el("li", {}, t("docs.section.overview.points.3")),
      el("li", {}, t("docs.section.overview.points.4")),
    ]),
  ]);
}

function buildStart() {
  return el("div", { class: "docs-grid" }, [
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.start.req.title")),
      el("ul", { class: "docs-list" }, [
        el("li", {}, t("docs.section.start.req.1")),
        el("li", {}, t("docs.section.start.req.2")),
        el("li", {}, t("docs.section.start.req.3")),
      ]),
    ]),
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.start.steps.title")),
      el("ol", { class: "docs-list docs-list-numbered" }, [
        el("li", {}, t("docs.section.start.steps.1")),
        el("li", {}, t("docs.section.start.steps.2")),
        el("li", {}, t("docs.section.start.steps.3")),
        el("li", {}, t("docs.section.start.steps.4")),
      ]),
    ]),
  ]);
}

function buildChat() {
  return el("div", { class: "docs-card docs-card-wide" }, [
    el("p", { class: "docs-paragraph" }, t("docs.section.chat.body")),
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.chat.tips.1")),
      el("li", {}, t("docs.section.chat.tips.2")),
      el("li", {}, t("docs.section.chat.tips.3")),
    ]),
  ]);
}

function buildMemory() {
  return el("div", { class: "docs-grid" }, [
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.memory.what.title")),
      el("p", { class: "docs-paragraph" }, t("docs.section.memory.what.body")),
    ]),
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.memory.how.title")),
      el("ul", { class: "docs-list" }, [
        el("li", {}, t("docs.section.memory.how.1")),
        el("li", {}, t("docs.section.memory.how.2")),
        el("li", {}, t("docs.section.memory.how.3")),
        el("li", {}, t("docs.section.memory.how.4")),
        el("li", {}, t("docs.section.memory.how.5")),
      ]),
    ]),
    el("div", { class: "docs-card docs-card-wide" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.memory.under.title")),
      el("p", { class: "docs-paragraph" }, t("docs.section.memory.under.body")),
      el("details", { class: "docs-faq-item" }, [
        el("summary", { class: "docs-faq-q" }, t("docs.section.memory.under.advanced")),
        el("div", { class: "docs-faq-a" }, t("docs.section.memory.under.advanced_body")),
      ]),
    ]),
  ]);
}

function buildFormats() {
  return el("div", { class: "docs-grid docs-grid-3" }, [
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.formats.chunk.title")),
      el("p", { class: "docs-paragraph docs-mono" }, t("docs.section.formats.chunk.body")),
    ]),
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.formats.t.title")),
      el("p", { class: "docs-paragraph" }, t("docs.section.formats.t.body")),
    ]),
    el("div", { class: "docs-card" }, [
      el("h3", { class: "docs-h3" }, t("docs.section.formats.sharegpt.title")),
      el("p", { class: "docs-paragraph docs-mono" }, t("docs.section.formats.sharegpt.body")),
    ]),
  ]);
}

function buildResilience() {
  return el("div", { class: "docs-card docs-card-wide" }, [
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.resilience.points.1")),
      el("li", {}, t("docs.section.resilience.points.2")),
      el("li", {}, t("docs.section.resilience.points.3")),
      el("li", {}, t("docs.section.resilience.points.4")),
      el("li", {}, t("docs.section.resilience.points.5")),
    ]),
  ]);
}

function buildTroubleshoot() {
  const wrap = el("div", { class: "docs-faq" });
  for (let i = 1; i <= 7; i++) {
    const item = el("details", { class: "docs-faq-item" }, [
      el("summary", { class: "docs-faq-q" }, t(`docs.section.troubleshoot.q${i}`)),
      el("div", { class: "docs-faq-a" }, t(`docs.section.troubleshoot.a${i}`)),
    ]);
    wrap.appendChild(item);
  }
  return wrap;
}

function buildAdvanced() {
  return el("div", { class: "docs-card docs-card-wide" }, [
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.advanced.points.1")),
      el("li", {}, t("docs.section.advanced.points.2")),
      el("li", {}, t("docs.section.advanced.points.3")),
      el("li", {}, t("docs.section.advanced.points.4")),
    ]),
  ]);
}

function buildCta() {
  return el("section", { class: "docs-cta" }, [
    el("div", { class: "docs-cta-glow", "aria-hidden": "true" }),
    el("div", { class: "docs-cta-text" }, t("docs.cta.ready")),
    el(
      "button",
      {
        class: "docs-cta-button",
        type: "button",
        onclick: () => {
          const btn = document.querySelector('.sidebar-icon[data-route="crystal"]');
          if (btn instanceof HTMLElement) btn.click();
        },
      },
      t("docs.cta.action")
    ),
  ]);
}

/** @param {string} id */
function scrollToSection(id) {
  const node = document.getElementById(`docs-${id}`);
  if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
}
