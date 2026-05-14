// @ts-check
import { clear, el } from "./dom.js";
import { http } from "./api-client/http.js";
import { SAMPLE_GRAPH } from "./graph-sample.js";

/**
 * Knowledge-graph view — renders the entity / relation topology the
 * crystalliser extracted from a book as an interactive force-directed
 * graph (cytoscape). Node size tracks degree so hub concepts stand out;
 * tapping a node isolates its neighbourhood and lists its relations.
 *
 * Defaults to a hand-authored sample (Darwin's "On the Origin of
 * Species") so a fresh install shows a real graph with zero setup; type
 * a book id to load one of your own via
 * `GET /api/vectordb/graph/book/:bookId`.
 */

/** @typedef {{ id: number, label: string }} GraphNode */
/** @typedef {{ id: number, source: number, target: number, predicate: string }} GraphEdge */
/** @typedef {{ nodes: GraphNode[], edges: GraphEdge[], meta?: { title?: string, source?: string } }} Graph */

const STATE = {
  /** @type {any} the live cytoscape instance, or null */
  cy: null,
};

/**
 * cytoscape (~450 KB) is code-split: it loads on the first graph render,
 * not in the app's initial bundle, so the five non-graph routes never
 * pay for it. Cached after the first await.
 * @type {any}
 */
let cytoscapeLib = null;
async function loadCytoscape() {
  if (!cytoscapeLib) {
    cytoscapeLib = (await import("cytoscape")).default;
  }
  return cytoscapeLib;
}

/** cytoscape visual style — on-theme: cyan nodes, gold hubs, dim edges. */
const CY_STYLE = [
  {
    selector: "node",
    style: {
      "background-color": "#0b2930",
      "border-color": "#00f0ff",
      "border-width": 1.5,
      label: "data(label)",
      color: "#bfe9ee",
      "font-size": 9,
      "font-family": "monospace",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
      "text-max-width": 86,
      width: "mapData(degree, 1, 10, 18, 60)",
      height: "mapData(degree, 1, 10, 18, 60)",
    },
  },
  {
    selector: "node[degree >= 5]",
    style: { "border-color": "#ffd700", color: "#ffe680" },
  },
  {
    selector: "edge",
    style: {
      width: 1,
      "line-color": "#1d3b42",
      "target-arrow-color": "#1d3b42",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.7,
      "curve-style": "bezier",
      label: "data(label)",
      "font-size": 7,
      color: "#5f8088",
      "text-rotation": "autorotate",
      "text-background-color": "#05080a",
      "text-background-opacity": 0.85,
      "text-background-padding": 2,
    },
  },
  { selector: ".faded", style: { opacity: 0.1 } },
  {
    selector: "edge.lit",
    style: {
      "line-color": "#00f0ff",
      "target-arrow-color": "#00f0ff",
      color: "#a6ebf1",
      width: 2,
    },
  },
  {
    selector: "node.lit",
    style: { "border-color": "#00f0ff", "border-width": 2.5 },
  },
];

/** Force-directed layout — `cose` ships in cytoscape core, no extension. */
const LAYOUT = {
  name: "cose",
  animate: false,
  nodeRepulsion: 9000,
  idealEdgeLength: 95,
  padding: 28,
  randomize: true,
};

/** @param {Graph} graph */
function captionFor(graph) {
  const base = `${graph.nodes.length} entities · ${graph.edges.length} relations`;
  const m = graph.meta;
  if (m && m.title) {
    return `${m.title}${m.source ? ` — ${m.source}` : ""}  ·  ${base}`;
  }
  return base;
}

/**
 * Map a {nodes,edges} graph to cytoscape elements, computing node degree
 * client-side so the sample and the API response render identically.
 * Edges with a missing endpoint are dropped — cytoscape rejects them.
 * @param {Graph} graph
 */
function toElements(graph) {
  /** @type {Map<number, number>} */
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const known = new Set(graph.nodes.map((n) => n.id));
  const nodes = graph.nodes.map((n) => ({
    data: { id: `n${n.id}`, label: n.label, degree: degree.get(n.id) || 0 },
  }));
  const edges = graph.edges
    .filter((e) => known.has(e.source) && known.has(e.target))
    .map((e) => ({
      data: {
        id: `e${e.id}`,
        source: `n${e.source}`,
        target: `n${e.target}`,
        label: e.predicate,
      },
    }));
  return [...nodes, ...edges];
}

/**
 * Remove any current overlay; if `content` is given, show it over the
 * stage (loading / empty / error states).
 * @param {HTMLElement} stage
 * @param {string|null} content
 */
function setOverlay(stage, content) {
  stage.querySelector(".graph-overlay")?.remove();
  if (content == null) return;
  stage.append(el("div", { class: "graph-overlay" }, content));
}

/** @param {HTMLElement} stage */
function clearDetail(stage) {
  stage.querySelector(".graph-detail")?.remove();
}

/**
 * Side panel for a tapped node: its label + every relation it takes
 * part in, direction-aware.
 * @param {HTMLElement} stage
 * @param {any} node
 */
function showDetail(stage, node) {
  clearDetail(stage);
  const id = node.id();
  /** @type {string[]} */
  const rels = [];
  node.connectedEdges().forEach((edge) => {
    const label = String(edge.data("label") || "relates to");
    if (edge.source().id() === id) {
      rels.push(`→ ${label} → ${edge.target().data("label")}`);
    } else {
      rels.push(`← ${label} ← ${edge.source().data("label")}`);
    }
  });
  stage.append(
    el("div", { class: "graph-detail" }, [
      el("div", { class: "graph-detail-name" }, String(node.data("label"))),
      el(
        "div",
        { class: "graph-detail-rel" },
        rels.length > 0 ? rels.map((r) => el("div", {}, r)) : "no relations",
      ),
    ]),
  );
}

/**
 * (Re)render a graph into the stage, tearing down any previous cytoscape
 * instance first. The empty graph gets a friendly overlay rather than a
 * blank canvas.
 * @param {HTMLElement} stage
 * @param {HTMLElement} cyHost
 * @param {Graph} graph
 */
async function renderGraph(stage, cyHost, graph) {
  const caption = document.getElementById("graph-caption");
  if (caption) caption.textContent = captionFor(graph);

  if (STATE.cy) {
    STATE.cy.destroy();
    STATE.cy = null;
  }
  clearDetail(stage);

  if (!graph.nodes || graph.nodes.length === 0) {
    setOverlay(
      stage,
      "No graph for this book yet — import it and run Crystallize to extract the topology.",
    );
    return;
  }
  setOverlay(stage, "Rendering…");
  const cytoscape = await loadCytoscape();
  setOverlay(stage, null);

  const cy = cytoscape({
    container: cyHost,
    elements: toElements(graph),
    style: CY_STYLE,
    layout: LAYOUT,
    wheelSensitivity: 0.2,
    minZoom: 0.15,
    maxZoom: 3,
  });

  cy.on("tap", "node", (evt) => {
    const node = evt.target;
    cy.elements().addClass("faded");
    const hood = node.closedNeighborhood();
    hood.removeClass("faded");
    hood.addClass("lit");
    showDetail(stage, node);
  });
  cy.on("tap", (evt) => {
    if (evt.target === cy) {
      cy.elements().removeClass("faded lit");
      clearDetail(stage);
    }
  });

  STATE.cy = cy;
}

/**
 * Fetch and render one book's extracted graph.
 * @param {HTMLElement} stage
 * @param {HTMLElement} cyHost
 * @param {string} bookId
 */
async function loadBookGraph(stage, cyHost, bookId) {
  if (STATE.cy) {
    STATE.cy.destroy();
    STATE.cy = null;
  }
  clearDetail(stage);
  setOverlay(stage, `Loading graph for ${bookId}…`);
  try {
    /** @type {Graph} */
    const graph = await http.get(
      `/api/vectordb/graph/book/${encodeURIComponent(bookId)}`,
    );
    await renderGraph(stage, cyHost, graph);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setOverlay(stage, `Could not load graph for "${bookId}": ${msg}`);
  }
}

/** @param {HTMLElement} root */
export function mountGraph(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") {
    /* The container may have resized while the route was hidden. */
    if (STATE.cy) {
      STATE.cy.resize();
      STATE.cy.fit(undefined, 28);
    }
    return;
  }
  root.dataset.mounted = "1";
  clear(root);

  const cyHost = el("div", { class: "graph-cy", id: "graph-cy" });
  const stage = el("div", { class: "graph-stage" }, cyHost);

  const bookInput = el("input", {
    type: "text",
    class: "graph-book-input",
    placeholder: "book id…",
  });
  const loadBtn = el(
    "button",
    {
      class: "cv-btn",
      type: "button",
      onclick: () => {
        const id = String(
          /** @type {HTMLInputElement} */ (bookInput).value || "",
        ).trim();
        if (id) void loadBookGraph(stage, cyHost, id);
      },
    },
    "Load book",
  );
  const sampleBtn = el(
    "button",
    {
      class: "cv-btn",
      type: "button",
      onclick: () => void renderGraph(stage, cyHost, SAMPLE_GRAPH),
    },
    "Sample",
  );

  const bar = el("div", { class: "graph-bar" }, [
    el("div", {}, [
      el("h1", {}, "Knowledge graph"),
      el("p", { id: "graph-caption" }, captionFor(SAMPLE_GRAPH)),
    ]),
    el("div", { class: "graph-controls" }, [bookInput, loadBtn, sampleBtn]),
  ]);

  root.append(el("div", { class: "graph-page" }, [bar, stage]));

  /* Zero-setup demo: the sample renders immediately. */
  void renderGraph(stage, cyHost, SAMPLE_GRAPH);
}
