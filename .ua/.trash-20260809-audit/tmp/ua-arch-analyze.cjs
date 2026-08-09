const fs = require('fs');
const path = require('path');

function fail(error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}

function commonDirectoryPrefix(paths) {
  if (!paths.length) return [];
  const dirs = paths.map((filePath) => filePath.split('/').slice(0, -1));
  const prefix = [];
  for (let index = 0; ; index += 1) {
    const segment = dirs[0][index];
    if (segment === undefined || dirs.some((parts) => parts[index] !== segment)) break;
    prefix.push(segment);
  }
  return prefix;
}

function patternForDirectory(name) {
  const patterns = new Map([
    ['api', ['routes', 'api', 'controllers', 'endpoints', 'handlers', 'serializers', 'controller', 'routers', 'blueprints']],
    ['service', ['services', 'core', 'lib', 'domain', 'logic', 'internal', 'composables', 'mailers', 'jobs', 'channels', 'signals']],
    ['data', ['models', 'db', 'data', 'persistence', 'repository', 'entities', 'migrations', 'database', 'schema', 'sql', 'entity']],
    ['ui', ['components', 'views', 'pages', 'ui', 'layouts', 'screens']],
    ['middleware', ['middleware', 'plugins', 'interceptors', 'guards']],
    ['utility', ['utils', 'helpers', 'common', 'shared', 'tools', 'pkg', 'templatetags']],
    ['config', ['config', 'constants', 'env', 'settings', 'management', 'commands']],
    ['test', ['__tests__', 'test', 'tests', 'spec', 'specs', 'src/test/java']],
    ['types', ['types', 'interfaces', 'schemas', 'contracts', 'dtos', 'dto', 'request', 'response']],
    ['hooks', ['hooks']],
    ['state', ['store', 'state', 'reducers', 'actions', 'slices']],
    ['assets', ['assets', 'static', 'public']],
    ['entry', ['cmd', 'bin']],
    ['documentation', ['docs', 'documentation', 'wiki']],
    ['infrastructure', ['deploy', 'deployment', 'infra', 'infrastructure', 'k8s', 'kubernetes', 'helm', 'charts', 'terraform', 'tf', 'docker']],
    ['ci-cd', ['.github', '.gitlab', '.circleci']],
  ]);
  const lower = name.toLowerCase();
  for (const [label, names] of patterns) if (names.includes(lower)) return label;
  return null;
}

function filePattern(node) {
  const filePath = node.filePath || node.name || '';
  const base = path.posix.basename(filePath);
  const lower = filePath.toLowerCase();
  if (/(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) || /(^|\.)(test|spec)\.[^.]+$/.test(base) || /^test_.*\.py$/.test(base) || /(_test\.go|Test\.java|_spec\.rb|Test\.php|Tests\.cs)$/.test(base)) return 'test';
  if (/\.d\.ts$/.test(base)) return 'types';
  if ((base === 'index.ts' || base === 'index.js' || base === '__init__.py') || base === 'manage.py' || base === 'config.ru' || base === 'Application.java' || base === 'Program.cs') return 'entry';
  if (base === 'wsgi.py' || base === 'asgi.py') return 'config';
  if ((base === 'main.go' && /(^|\/)cmd\//.test(filePath)) || ((base === 'main.rs' || base === 'lib.rs') && /(^|\/)src\//.test(filePath))) return 'entry';
  if (['Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'package.json', 'tsconfig.json'].includes(base)) return 'config';
  if (/^dockerfile/i.test(base) || /^docker-compose\./i.test(base) || /\.tf(vars)?$/.test(base) || base === 'Makefile') return 'infrastructure';
  if (/^\.github\/workflows\//.test(filePath) || base === '.gitlab-ci.yml' || base === 'Jenkinsfile') return 'ci-cd';
  if (/\.sql$/.test(base)) return 'data';
  if (/\.(graphql|gql|proto)$/.test(base)) return 'types';
  if (/\.(md|rst)$/.test(base)) return 'documentation';
  return null;
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Usage: node ua-arch-analyze.cjs <input.json> <output.json>');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const { fileNodes = [], importEdges = [], allEdges = [] } = input;
  const nodeById = new Map(fileNodes.map((node) => [node.id, node]));
  const paths = fileNodes.map((node) => node.filePath || node.name || node.id);
  const commonPrefix = commonDirectoryPrefix(paths);
  const flat = paths.every((filePath) => !filePath.includes('/'));

  const directoryGroups = {};
  const groupByNodeId = {};
  for (const node of fileNodes) {
    const filePath = node.filePath || node.name || node.id;
    const parts = filePath.split('/');
    let group;
    if (flat) {
      group = filePattern(node) || path.posix.extname(filePath).replace(/^\./, '') || 'root';
    } else if (commonPrefix.length > 0) {
      group = parts[commonPrefix.length] || 'root';
    } else {
      group = parts.length > 1 ? parts[0] : 'root';
    }
    (directoryGroups[group] ||= []).push(node.id);
    groupByNodeId[node.id] = group;
  }

  const nodeTypeGroups = {};
  for (const node of fileNodes) (nodeTypeGroups[node.type] ||= []).push(node.id);

  const fileFanIn = Object.fromEntries(fileNodes.map((node) => [node.id, 0]));
  const fileFanOut = Object.fromEntries(fileNodes.map((node) => [node.id, 0]));
  const interCounts = new Map();
  const internalCounts = Object.fromEntries(Object.keys(directoryGroups).map((group) => [group, 0]));
  const totalGroupEdges = Object.fromEntries(Object.keys(directoryGroups).map((group) => [group, 0]));
  for (const edge of importEdges) {
    fileFanOut[edge.source] += 1;
    fileFanIn[edge.target] += 1;
    const from = groupByNodeId[edge.source];
    const to = groupByNodeId[edge.target];
    if (from === to) {
      internalCounts[from] += 1;
      totalGroupEdges[from] += 1;
    } else {
      totalGroupEdges[from] += 1;
      totalGroupEdges[to] += 1;
      interCounts.set(`${from}\u0000${to}`, (interCounts.get(`${from}\u0000${to}`) || 0) + 1);
    }
  }

  const interGroupImports = [...interCounts.entries()].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, count };
  }).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const intraGroupDensity = {};
  for (const group of Object.keys(directoryGroups)) {
    const internalEdges = internalCounts[group];
    const totalEdges = totalGroupEdges[group];
    intraGroupDensity[group] = { internalEdges, totalEdges, density: totalEdges ? internalEdges / totalEdges : 0 };
  }

  const patternMatches = {};
  for (const group of Object.keys(directoryGroups)) {
    const match = patternForDirectory(group);
    if (match) patternMatches[group] = match;
  }

  const crossCategory = new Map();
  for (const edge of allEdges) {
    const fromType = nodeById.get(edge.source)?.type;
    const toType = nodeById.get(edge.target)?.type;
    if (!fromType || !toType || fromType === toType) continue;
    const key = `${fromType}\u0000${toType}\u0000${edge.type}`;
    crossCategory.set(key, (crossCategory.get(key) || 0) + 1);
  }
  const crossCategoryEdges = [...crossCategory.entries()].map(([key, count]) => {
    const [fromType, toType, edgeType] = key.split('\u0000');
    return { fromType, toType, edgeType, count };
  }).sort((a, b) => b.count - a.count);

  const dependencyDirection = [];
  const seenPairs = new Set();
  for (const row of interGroupImports) {
    const pair = [row.from, row.to].sort().join('\u0000');
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const forward = interCounts.get(`${row.from}\u0000${row.to}`) || 0;
    const reverse = interCounts.get(`${row.to}\u0000${row.from}`) || 0;
    if (forward > reverse) dependencyDirection.push({ dependent: row.from, dependsOn: row.to, forward, reverse });
    else if (reverse > forward) dependencyDirection.push({ dependent: row.to, dependsOn: row.from, forward: reverse, reverse: forward });
  }

  const infraFiles = fileNodes.filter((node) => filePattern(node) === 'infrastructure' || filePattern(node) === 'ci-cd' || node.type === 'service' || node.type === 'pipeline').map((node) => node.filePath);
  const deploymentTopology = {
    hasDockerfile: paths.some((p) => /^dockerfile/i.test(path.posix.basename(p))),
    hasCompose: paths.some((p) => /^docker-compose\./i.test(path.posix.basename(p))),
    hasK8s: paths.some((p) => /(^|\/)(k8s|kubernetes|helm|charts)(\/|$)/i.test(p)),
    hasTerraform: paths.some((p) => /\.tf(vars)?$/i.test(p) || /(^|\/)(terraform|tf)(\/|$)/i.test(p)),
    hasCI: paths.some((p) => /(^|\/)\.github\/workflows\//.test(p) || /\.gitlab-ci\.yml$/.test(p) || /Jenkinsfile$/.test(p)),
    infraFiles,
  };

  const dataPipeline = {
    schemaFiles: fileNodes.filter((node) => node.type === 'schema' || /\.(graphql|gql|proto|prisma|sql)$/i.test(node.filePath || '')).map((node) => node.filePath),
    migrationFiles: fileNodes.filter((node) => /(^|\/)migrations?(\/|$)/i.test(node.filePath || '')).map((node) => node.filePath),
    dataModelFiles: fileNodes.filter((node) => /(^|\/)(models?|entities|repository)(\/|$)/i.test(node.filePath || '') || node.tags?.some((tag) => /model|persistence|state/.test(tag))).map((node) => node.filePath),
    apiHandlerFiles: fileNodes.filter((node) => /(^|\/)(api|routes|controllers|handlers)(\/|$)/i.test(node.filePath || '') || node.type === 'endpoint').map((node) => node.filePath),
  };

  const docNodes = fileNodes.filter((node) => node.type === 'document' || filePattern(node) === 'documentation');
  const documentedGroups = new Set();
  for (const node of docNodes) {
    const docPath = (node.filePath || '').toLowerCase();
    const docText = `${docPath} ${(node.summary || '').toLowerCase()}`;
    const ownGroup = groupByNodeId[node.id];
    if (/readme\.md$/.test(docPath)) documentedGroups.add(ownGroup);
    for (const group of Object.keys(directoryGroups)) if (group !== 'root' && docText.includes(group.toLowerCase())) documentedGroups.add(group);
  }
  const allGroups = Object.keys(directoryGroups);
  const docCoverage = {
    groupsWithDocs: documentedGroups.size,
    totalGroups: allGroups.length,
    coverageRatio: allGroups.length ? documentedGroups.size / allGroups.length : 0,
    undocumentedGroups: allGroups.filter((group) => !documentedGroups.has(group)),
  };

  const output = {
    scriptCompleted: true,
    commonPathPrefix: commonPrefix.join('/'),
    directoryGroups,
    nodeTypeGroups,
    crossCategoryEdges,
    interGroupImports,
    intraGroupDensity,
    patternMatches,
    deploymentTopology,
    dataPipeline,
    docCoverage,
    dependencyDirection,
    fileStats: {
      totalFileNodes: fileNodes.length,
      filesPerGroup: Object.fromEntries(Object.entries(directoryGroups).map(([group, ids]) => [group, ids.length])),
      nodeTypeCounts: Object.fromEntries(Object.entries(nodeTypeGroups).map(([type, ids]) => [type, ids.length])),
    },
    fileFanIn,
    fileFanOut,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error);
}
