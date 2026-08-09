const fs = require('fs');

const [graphPath, layersPath, outputPath] = process.argv.slice(2);
if (!graphPath || !layersPath || !outputPath) {
  console.error('Usage: node ua-tour-prepare.js <graph.json> <layers.json> <output.json>');
  process.exit(1);
}

try {
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const layers = JSON.parse(fs.readFileSync(layersPath, 'utf8'));
  fs.writeFileSync(outputPath, `${JSON.stringify({
    nodes: graph.nodes || [],
    edges: graph.edges || [],
    layers: Array.isArray(layers) ? layers : (layers.layers || []),
  }, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
