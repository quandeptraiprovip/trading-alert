const fs = require('fs');
const path = require('path');

const [inputPath, structuralPath, outputPath] = process.argv.slice(2);
if (!inputPath || !structuralPath || !outputPath) {
  console.error('Usage: node ua-arch-layers.cjs <input.json> <structural.json> <layers.json>');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const structural = JSON.parse(fs.readFileSync(structuralPath, 'utf8'));
if (!structural.scriptCompleted) throw new Error('Structural analysis did not complete');

const layers = [
  {
    id: 'layer:strategy-core',
    name: 'Lõi chiến lược và mô phỏng',
    description: 'Chứa các mô hình SMC, Turtle, Key Volume, alt/small-cap, dữ liệu nến và engine mô phỏng dùng chung để sinh tín hiệu và đo hiệu suất.',
    nodeIds: [],
  },
  {
    id: 'layer:live-execution',
    name: 'Thực thi giao dịch trực tiếp',
    description: 'Điều phối bot, quản lý trạng thái và rủi ro lệnh, kết nối Binance/MEXC và phát thông báo Telegram trong runtime giao dịch.',
    nodeIds: [],
  },
  {
    id: 'layer:research-audit',
    name: 'Nghiên cứu và kiểm toán định lượng',
    description: 'Tập hợp các sweep, ablation, stress test, phân tích overfit, attribution và nghiên cứu danh mục dùng để thẩm định các phương pháp giao dịch.',
    nodeIds: [],
  },
  {
    id: 'layer:test-validation',
    name: 'Kiểm thử và đối chiếu parity',
    description: 'Kiểm tra hồi quy, no-lookahead, mô phỏng execution và sự tương đương giữa tín hiệu live với engine nghiên cứu.',
    nodeIds: [],
  },
  {
    id: 'layer:monitoring-ui',
    name: 'Giám sát và giao diện',
    description: 'Cung cấp dashboard, API dữ liệu biểu đồ và giao diện Next.js/HTML để quan sát kết quả backtest và trạng thái hệ thống.',
    nodeIds: [],
  },
  {
    id: 'layer:configuration',
    name: 'Cấu hình và công cụ build',
    description: 'Quản lý biến môi trường, cấu hình Node/TypeScript/Next/Vercel, metadata phân tích codebase và cache build sinh tự động.',
    nodeIds: [],
  },
  {
    id: 'layer:infrastructure',
    name: 'Hạ tầng triển khai',
    description: 'Định nghĩa build nhiều giai đoạn, runtime container, Docker Compose và phạm vi build cho dịch vụ cảnh báo giao dịch.',
    nodeIds: [],
  },
  {
    id: 'layer:documentation',
    name: 'Tài liệu và kế hoạch',
    description: 'Ghi lại kiến trúc vận hành, phương pháp nghiên cứu, kế hoạch khắc phục, đặc tả MEXC và hướng dẫn cộng tác của dự án.',
    nodeIds: [],
  },
];
const layerById = new Map(layers.map((layer) => [layer.id, layer]));

const corePaths = new Set([
  'backtest.ts', 'strategy.ts', 'turtle.ts', 'key-volume.ts', 'kline-fetch.ts',
  'smallcap-research.ts', 'smallcap-reversal.ts', 'smallcap-supply.ts', 'alt-trend.ts',
]);
const livePaths = new Set([
  'binance-futures.ts', 'btc-alert-bot.ts', 'fast-trend-execution.ts',
  'fast-trend-live.ts', 'live-state.ts', 'live-trade.ts', 'mexc-fast-execution.ts',
  'mexc-futures.ts', 'telegram.ts', 'turtle-live.ts',
]);
const uiPaths = new Set([
  'dashboard-server.ts', 'app/api/chart/route.ts', 'chart-payload.ts',
  'chart-server.ts', 'app/layout.tsx', 'public/index.html',
]);
const configPaths = new Set([
  'load-env.ts', '.ua/.understandignore', 'next-env.d.ts', 'next.config.js',
  'tsconfig.tsbuildinfo',
]);

function chooseLayer(node) {
  const filePath = node.filePath || '';
  const base = path.posix.basename(filePath);
  const tags = new Set(node.tags || []);

  if (node.type === 'document') return 'layer:documentation';
  if (node.type === 'config') return 'layer:configuration';
  if (node.type === 'service' || node.type === 'pipeline' || node.type === 'resource') return 'layer:infrastructure';
  if (node.type === 'table' || node.type === 'schema' || node.type === 'endpoint') return 'layer:strategy-core';

  if (filePath === 'scripts/turtle-live-parity.ts') return 'layer:test-validation';
  if (filePath.startsWith('scripts/')) return 'layer:research-audit';
  if (base.startsWith('test-') || base.endsWith('-test.ts') || tags.has('test')) return 'layer:test-validation';
  if (corePaths.has(filePath)) return 'layer:strategy-core';
  if (livePaths.has(filePath)) return 'layer:live-execution';
  if (uiPaths.has(filePath)) return 'layer:monitoring-ui';
  if (configPaths.has(filePath)) return 'layer:configuration';
  if (base.startsWith('exp-') || filePath === 'key-volume-backtest.ts') return 'layer:research-audit';
  throw new Error(`Không thể phân lớp node: ${node.id} (${filePath}, ${node.type})`);
}

for (const node of input.fileNodes) layerById.get(chooseLayer(node)).nodeIds.push(node.id);

const assigned = layers.flatMap((layer) => layer.nodeIds);
const unique = new Set(assigned);
const expected = new Set(input.fileNodes.map((node) => node.id));
if (layers.length < 3 || layers.length > 10) throw new Error(`Invalid layer count: ${layers.length}`);
if (assigned.length !== structural.fileStats.totalFileNodes) throw new Error(`Assigned ${assigned.length}; expected ${structural.fileStats.totalFileNodes}`);
if (unique.size !== assigned.length) throw new Error('Duplicate node assignment detected');
if ([...expected].some((id) => !unique.has(id))) throw new Error('Missing node assignment detected');
if ([...unique].some((id) => !expected.has(id))) throw new Error('Invented node ID detected');
if (layers.some((layer) => layer.nodeIds.length === 0)) throw new Error('Empty layer detected');

for (const layer of layers) layer.nodeIds.sort();
fs.writeFileSync(outputPath, `${JSON.stringify(layers, null, 2)}\n`);
