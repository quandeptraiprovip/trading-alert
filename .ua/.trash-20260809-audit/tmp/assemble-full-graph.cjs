const fs = require("fs");

const [fragmentPath, layersPath, tourPath, scanPath, commit] = process.argv.slice(2);
const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
const nodeIds = new Set(fragment.nodes.map((node) => node.id));
const prefixes = /^(file|config|document|service|pipeline|table|schema|resource|endpoint):/;
const normalizeIds = (ids) => (Array.isArray(ids) ? ids : [])
  .map((id) => typeof id === "string" && !prefixes.test(id) ? `file:${id}` : id)
  .filter((id) => typeof id === "string" && nodeIds.has(id));

let layers = JSON.parse(fs.readFileSync(layersPath, "utf8"));
if (!Array.isArray(layers)) layers = layers.layers ?? [];
layers = layers.map((layer) => ({
  id: layer.id || `layer:${String(layer.name || "unnamed").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  name: String(layer.name || "Unnamed"),
  description: String(layer.description || "No description available"),
  nodeIds: normalizeIds(layer.nodeIds ?? layer.nodes),
})).filter((layer) => layer.nodeIds.length > 0);

let tour = JSON.parse(fs.readFileSync(tourPath, "utf8"));
if (!Array.isArray(tour)) tour = tour.steps ?? [];
tour = tour.map((step, index) => {
  const out = {
    order: Number.isInteger(step.order) ? step.order : index + 1,
    title: String(step.title || `Bước ${index + 1}`),
    description: String(step.description || step.whyItMatters || "No description available"),
    nodeIds: normalizeIds(step.nodeIds ?? step.nodesToInspect),
  };
  if (typeof step.languageLesson === "string") out.languageLesson = step.languageLesson;
  return out;
}).filter((step) => step.nodeIds.length > 0).sort((a, b) => a.order - b.order)
  .map((step, index) => ({ ...step, order: index + 1 }));

const graph = {
  version: "1.0.0",
  project: {
    name: scan.name,
    languages: scan.languages,
    frameworks: scan.frameworks,
    description: scan.description,
    analyzedAt: new Date().toISOString(),
    gitCommitHash: commit,
  },
  nodes: fragment.nodes,
  edges: fragment.edges,
  layers,
  tour,
};

fs.writeFileSync(fragmentPath, JSON.stringify(graph, null, 2));
console.log(JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, layers: graph.layers.length, tour: graph.tour.length }));
