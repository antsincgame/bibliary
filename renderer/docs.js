// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";

/**
 * Справка — встроенная документация для разработчиков-вайбкодеров.
 * Стиль: компактный, без лишних анимаций, обтекаемый ToC + плотные секции.
 *
 * Структура (4 секции вместо 8 в v1):
 *   1. Локальный старт — env, Qdrant, LM Studio, первая коллекция
 *   2. Книга → датасет — как работает pipeline ingest и Crystallizer
 *   3. RAG в чате — выбор коллекции, контекст, A/B сравнение
 *   4. Кастомизация — промпты, ролевые модели, дообучение, контекст YaRN
 *
 * @param {HTMLElement} root
 */
export function mountDocs(root) {
  clear(root);
  root.appendChild(buildHeader());
  root.appendChild(buildLayout());
}

function buildHeader() {
  return el("header", { class: "docs-header" }, [
    el("div", { class: "docs-eyebrow" }, t("docs.hero.eyebrow")),
    el("h1", { class: "docs-title" }, t("docs.hero.title")),
    el("p", { class: "docs-sub" }, t("docs.hero.sub")),
  ]);
}

function buildLayout() {
  const sections = ["start", "ingest", "rag", "custom"];
  const wrap = el("div", { class: "docs-layout" });
  wrap.appendChild(buildToc(sections));
  const body = el("div", { class: "docs-body" });
  for (const id of sections) body.appendChild(buildSection(id));
  wrap.appendChild(body);
  return wrap;
}

function buildToc(sections) {
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

function buildSection(id) {
  return el("section", { class: "docs-section", id: `docs-${id}` }, [
    el("header", { class: "docs-section-head" }, [
      el("div", { class: "docs-section-title" }, t(`docs.section.${id}.title`)),
      el("div", { class: "docs-section-sub" }, t(`docs.section.${id}.sub`)),
    ]),
    buildSectionBody(id),
  ]);
}

function buildSectionBody(id) {
  if (id === "start") return buildStart();
  if (id === "ingest") return buildIngest();
  if (id === "rag") return buildRag();
  if (id === "custom") return buildCustom();
  return el("div", {}, "");
}

function buildStart() {
  return el("div", { class: "docs-card" }, [
    el("p", { class: "docs-paragraph" }, t("docs.section.start.body")),
    el("ol", { class: "docs-list docs-list-numbered" }, [
      el("li", {}, t("docs.section.start.steps.1")),
      el("li", {}, t("docs.section.start.steps.2")),
      el("li", {}, t("docs.section.start.steps.3")),
      el("li", {}, t("docs.section.start.steps.4")),
    ]),
    el("p", { class: "docs-paragraph docs-mono" }, t("docs.section.start.env")),
  ]);
}

function buildIngest() {
  return el("div", { class: "docs-card" }, [
    el("p", { class: "docs-paragraph" }, t("docs.section.ingest.body")),
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.ingest.points.1")),
      el("li", {}, t("docs.section.ingest.points.2")),
      el("li", {}, t("docs.section.ingest.points.3")),
      el("li", {}, t("docs.section.ingest.points.4")),
    ]),
  ]);
}

function buildRag() {
  return el("div", { class: "docs-card" }, [
    el("p", { class: "docs-paragraph" }, t("docs.section.rag.body")),
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.rag.tips.1")),
      el("li", {}, t("docs.section.rag.tips.2")),
      el("li", {}, t("docs.section.rag.tips.3")),
    ]),
  ]);
}

function buildCustom() {
  return el("div", { class: "docs-card" }, [
    el("p", { class: "docs-paragraph" }, t("docs.section.custom.body")),
    el("ul", { class: "docs-list" }, [
      el("li", {}, t("docs.section.custom.points.1")),
      el("li", {}, t("docs.section.custom.points.2")),
      el("li", {}, t("docs.section.custom.points.3")),
      el("li", {}, t("docs.section.custom.points.4")),
    ]),
    el("p", { class: "docs-paragraph docs-mono" }, t("docs.section.custom.note")),
  ]);
}

function scrollToSection(id) {
  const node = document.getElementById(`docs-${id}`);
  if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
}
