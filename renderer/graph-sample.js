// @ts-check
/**
 * Demo knowledge graph — the core topology of Darwin's "On the Origin
 * of Species" (1859, public domain). Hand-authored so the graph view
 * has a real, recognisable graph to render on a fresh install, before
 * the operator has imported and crystallised any books of their own.
 *
 * Same shape as `GET /api/vectordb/graph/book/:bookId` returns:
 *   { nodes: [{ id, label }], edges: [{ id, source, target, predicate }] }
 * (the view computes node degree itself, so degree is omitted here.)
 */

export const SAMPLE_GRAPH = {
  meta: {
    title: "On the Origin of Species",
    source: "Charles Darwin, 1859 (public domain)",
  },
  nodes: [
    { id: 1, label: "Charles Darwin" },
    { id: 2, label: "On the Origin of Species" },
    { id: 3, label: "Natural selection" },
    { id: 4, label: "Variation" },
    { id: 5, label: "Struggle for existence" },
    { id: 6, label: "Heredity" },
    { id: 7, label: "Descent with modification" },
    { id: 8, label: "Common descent" },
    { id: 9, label: "Divergence of character" },
    { id: 10, label: "Extinction" },
    { id: 11, label: "Geographical distribution" },
    { id: 12, label: "Geological record" },
    { id: 13, label: "Artificial selection" },
    { id: 14, label: "Thomas Malthus" },
    { id: 15, label: "Population growth" },
    { id: 16, label: "Favourable variations" },
    { id: 17, label: "Adaptation" },
    { id: 18, label: "Species" },
    { id: 19, label: "Varieties" },
    { id: 20, label: "Genera" },
    { id: 21, label: "Tree of life" },
    { id: 22, label: "Embryology" },
    { id: 23, label: "Vestigial organs" },
    { id: 24, label: "Fossil record" },
    { id: 25, label: "Geological time" },
    { id: 26, label: "Sexual selection" },
    { id: 27, label: "Instinct" },
    { id: 28, label: "Hybridism" },
  ],
  edges: [
    { id: 1, source: 1, target: 2, predicate: "authored" },
    { id: 2, source: 2, target: 3, predicate: "proposes" },
    { id: 3, source: 14, target: 1, predicate: "influenced" },
    { id: 4, source: 14, target: 15, predicate: "analysed" },
    { id: 5, source: 15, target: 5, predicate: "causes" },
    { id: 6, source: 4, target: 16, predicate: "yields" },
    { id: 7, source: 5, target: 3, predicate: "drives" },
    { id: 8, source: 3, target: 16, predicate: "preserves" },
    { id: 9, source: 3, target: 4, predicate: "acts on" },
    { id: 10, source: 16, target: 17, predicate: "improves" },
    { id: 11, source: 6, target: 16, predicate: "transmits" },
    { id: 12, source: 3, target: 7, predicate: "produces" },
    { id: 13, source: 6, target: 7, predicate: "enables" },
    { id: 14, source: 7, target: 9, predicate: "leads to" },
    { id: 15, source: 9, target: 19, predicate: "forms" },
    { id: 16, source: 19, target: 18, predicate: "become" },
    { id: 17, source: 18, target: 20, predicate: "grouped into" },
    { id: 18, source: 7, target: 8, predicate: "supports" },
    { id: 19, source: 8, target: 21, predicate: "explains" },
    { id: 20, source: 3, target: 10, predicate: "causes" },
    { id: 21, source: 10, target: 24, predicate: "shapes" },
    { id: 22, source: 12, target: 24, predicate: "preserves" },
    { id: 23, source: 13, target: 3, predicate: "analogous to" },
    { id: 24, source: 1, target: 13, predicate: "studied" },
    { id: 25, source: 22, target: 8, predicate: "evidences" },
    { id: 26, source: 23, target: 7, predicate: "evidences" },
    { id: 27, source: 24, target: 7, predicate: "evidences" },
    { id: 28, source: 11, target: 8, predicate: "evidences" },
    { id: 29, source: 25, target: 3, predicate: "enables" },
    { id: 30, source: 26, target: 3, predicate: "supplements" },
    { id: 31, source: 3, target: 27, predicate: "shapes" },
    { id: 32, source: 28, target: 18, predicate: "tests boundaries of" },
    { id: 33, source: 12, target: 25, predicate: "records" },
    { id: 34, source: 17, target: 18, predicate: "distinguishes" },
    { id: 35, source: 16, target: 7, predicate: "accumulate into" },
    { id: 36, source: 8, target: 18, predicate: "unifies" },
  ],
};
