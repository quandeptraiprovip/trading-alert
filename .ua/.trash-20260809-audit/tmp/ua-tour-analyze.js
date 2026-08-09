const fs = require('fs');
const path = require('path');

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node ua-tour-analyze.js <input.json> <output.json>');
  process.exit(1);
}

const compareRank = (countKey) => (a, b) =>
  b[countKey] - a[countKey] || a.id.localeCompare(b.id);

try {
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const layers = Array.isArray(input.layers) ? input.layers : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fanIn = new Map(nodes.map((node) => [node.id, 0]));
  const fanOut = new Map(nodes.map((node) => [node.id, 0]));

  for (const edge of edges) {
    if (nodeById.has(edge.source) && nodeById.has(edge.target)) {
      fanOut.set(edge.source, fanOut.get(edge.source) + 1);
      fanIn.set(edge.target, fanIn.get(edge.target) + 1);
    }
  }

  const fanInAll = nodes.map((node) => ({
    id: node.id,
    fanIn: fanIn.get(node.id),
    name: node.name,
  })).sort(compareRank('fanIn'));
  const fanOutAll = nodes.map((node) => ({
    id: node.id,
    fanOut: fanOut.get(node.id),
    name: node.name,
  })).sort(compareRank('fanOut'));

  const topFanOutCount = Math.max(1, Math.ceil(nodes.length * 0.1));
  const lowFanInCount = Math.max(1, Math.ceil(nodes.length * 0.25));
  const highFanOutIds = new Set(fanOutAll.slice(0, topFanOutCount).map((row) => row.id));
  const lowFanInIds = new Set(
    [...fanInAll]
      .sort((a, b) => a.fanIn - b.fanIn || a.id.localeCompare(b.id))
      .slice(0, lowFanInCount)
      .map((row) => row.id),
  );
  const codeEntryNames = new Set([
    'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
    'server.ts', 'server.js', 'mod.rs', 'main.go', 'main.py', 'main.rs',
    'manage.py', 'app.py', 'wsgi.py', 'asgi.py', 'run.py', '__main__.py',
    'Application.java', 'Main.java', 'Program.cs', 'config.ru', 'index.php',
    'App.swift', 'Application.kt', 'main.cpp', 'main.c',
  ]);

  const entryPointCandidates = nodes.map((node) => {
    const filePath = node.filePath || '';
    const baseName = path.posix.basename(filePath || node.name || '');
    const depth = filePath.split('/').filter(Boolean).length;
    let score = 0;
    if (node.type === 'file') {
      if (codeEntryNames.has(baseName)) score += 3;
      if (depth <= 2) score += 1;
      if (highFanOutIds.has(node.id)) score += 1;
      if (lowFanInIds.has(node.id)) score += 1;
    } else if (node.type === 'document') {
      if (filePath === 'README.md' || baseName === 'README.md' && depth === 1) score += 5;
      else if (baseName.endsWith('.md') && depth === 1) score += 2;
    }
    return {id: node.id, score, name: node.name, summary: node.summary || ''};
  }).filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 5);

  const codeStart = entryPointCandidates.find(({id}) => nodeById.get(id)?.type === 'file');
  const bfsTraversal = {startNode: codeStart?.id || null, order: [], depthMap: {}, byDepth: {}};
  if (codeStart) {
    const adjacency = new Map();
    for (const edge of edges) {
      if (!['imports', 'calls'].includes(edge.type)) continue;
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source).push(edge.target);
    }
    for (const targets of adjacency.values()) targets.sort((a, b) => a.localeCompare(b));
    const queue = [codeStart.id];
    bfsTraversal.depthMap[codeStart.id] = 0;
    while (queue.length) {
      const current = queue.shift();
      const depth = bfsTraversal.depthMap[current];
      bfsTraversal.order.push(current);
      (bfsTraversal.byDepth[String(depth)] ||= []).push(current);
      for (const target of adjacency.get(current) || []) {
        if (Object.prototype.hasOwnProperty.call(bfsTraversal.depthMap, target)) continue;
        bfsTraversal.depthMap[target] = depth + 1;
        queue.push(target);
      }
    }
  }

  const compactNode = (node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    summary: node.summary || '',
  });
  const nonCodeFiles = {
    documentation: nodes.filter((node) => node.type === 'document').map(compactNode),
    infrastructure: nodes.filter((node) => ['service', 'pipeline', 'resource'].includes(node.type)).map(compactNode),
    data: nodes.filter((node) => ['table', 'schema', 'endpoint'].includes(node.type)).map(compactNode),
    config: nodes.filter((node) => node.type === 'config').map(compactNode),
  };
  for (const group of Object.values(nonCodeFiles)) group.sort((a, b) => a.id.localeCompare(b.id));

  const relationEdges = edges.filter((edge) => ['imports', 'calls'].includes(edge.type));
  const directed = new Set(relationEdges.map((edge) => `${edge.source}\u0000${edge.target}`));
  const undirectedNeighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of relationEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    undirectedNeighbors.get(edge.source).add(edge.target);
    undirectedNeighbors.get(edge.target).add(edge.source);
  }
  const pairSeeds = [];
  for (const edge of relationEdges) {
    if (edge.source >= edge.target) continue;
    if (directed.has(`${edge.target}\u0000${edge.source}`)) pairSeeds.push([edge.source, edge.target]);
  }
  pairSeeds.sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  const clusterMap = new Map();
  for (const seed of pairSeeds) {
    const cluster = new Set(seed);
    let expanded = true;
    while (expanded && cluster.size < 5) {
      expanded = false;
      const candidates = nodes.map((node) => node.id)
        .filter((id) => !cluster.has(id))
        .map((id) => ({
          id,
          links: [...cluster].filter((member) => undirectedNeighbors.get(id)?.has(member)).length,
        }))
        .filter((candidate) => candidate.links >= 2)
        .sort((a, b) => b.links - a.links || a.id.localeCompare(b.id));
      if (candidates.length) {
        cluster.add(candidates[0].id);
        expanded = true;
      }
    }
    const members = [...cluster].sort((a, b) => a.localeCompare(b));
    let edgeCount = 0;
    for (const edge of relationEdges) {
      if (cluster.has(edge.source) && cluster.has(edge.target)) edgeCount += 1;
    }
    const key = members.join('\u0000');
    const existing = clusterMap.get(key);
    if (!existing || edgeCount > existing.edgeCount) clusterMap.set(key, {nodes: members, edgeCount});
  }
  const clusters = [...clusterMap.values()]
    .sort((a, b) => b.edgeCount - a.edgeCount || b.nodes.length - a.nodes.length || a.nodes.join('\u0000').localeCompare(b.nodes.join('\u0000')))
    .slice(0, 10);

  const nodeSummaryIndex = Object.fromEntries(
    [...nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => [node.id, {name: node.name, type: node.type, summary: node.summary || ''}]),
  );
  const results = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking: fanInAll.slice(0, 20),
    fanOutRanking: fanOutAll.slice(0, 20),
    bfsTraversal,
    nonCodeFiles,
    clusters,
    layers: {
      count: layers.length,
      list: layers.map(({id, name, description}) => ({id, name, description})),
    },
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
