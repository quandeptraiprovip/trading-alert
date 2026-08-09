/**
 * dashboard-server.ts — Dashboard web theo dõi BOT GIAO DỊCH (chạy CÙNG VM với bot).
 *
 * Run:  npx ts-node dashboard-server.ts [port]      (mặc định 3848)
 * Mở:   http://localhost:3848
 *
 * Nguồn dữ liệu:
 *   - bot-state.json     : trạng thái bot (vị thế/cooldown/lastOpenTime) — do bot ghi.
 *   - trades-live.jsonl  : nhật ký entry/exit — để tính thống kê (số lệnh, win%, tổng R).
 *   - Binance (read-only): equity + vị thế THẬT trên sàn (nếu có API key) — nguồn AUTHORITATIVE.
 *
 * CHỈ ĐỌC: dashboard không đặt/huỷ lệnh. Đặt sau firewall/VPN — KHÔNG mở ra Internet công khai
 * vì hiển thị số dư/vị thế.
 */
import "./load-env";
import http from "http";
import fs from "fs";
import path from "path";
import { createBinanceFromEnv, PositionRisk } from "./binance-futures";
import { loadExecConfig } from "./live-trade";

// Tiền tố MỌI log bằng giờ Việt Nam (kèm giây) để truy vết theo thời gian khi đọc log.
const logTimeVn = (): string =>
  new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(`[${logTimeVn()}]`, ...args);
}

const PORT = parseInt(process.argv[2] ?? "3848", 10);
const DATA_DIR = path.resolve(process.env.TRADING_DATA_DIR?.trim() || process.cwd());
const STATE_FILE = path.join(DATA_DIR, "bot-state.json");
const JOURNAL_FILE = path.join(DATA_DIR, "trades-live.jsonl");

const TRADING_ENABLED = (process.env.TRADING_ENABLED ?? "false").toLowerCase() === "true";
const TESTNET = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() !== "false";
const execCfg = loadExecConfig();
const binance = createBinanceFromEnv(); // read-only ở đây; null nếu thiếu key
let timeSynced = false;

type StateSymbol = {
  symbol: string;
  lastOpenTime: number;
  cooldownUntilTime: number;
  livePos: {
    dir: "long" | "short";
    entryTime: number;
    entry: number;
    initialSL: number;
    sl: number;
    target: number;
    sizeMult?: number;
    quality?: string;
    qty?: number;
    riskUsd?: number;
  } | null;
};

function readState(): StateSymbol[] {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function readJournal(limit = 50): any[] {
  try {
    const lines = fs.readFileSync(JOURNAL_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Thống kê đầy đủ từ journal: win%, tổng/PF/avg R, best/worst, max DD, theo lý do/symbol/hướng, streak. */
function journalStats(journal: any[]) {
  // CHỈ tính lệnh VÀO THẬT (real === true). Bỏ qua paper (alert-only) & bản ghi cũ chưa gắn cờ.
  const exits = journal
    .filter((r) => r.event === "exit" && r.real === true && typeof r.grossR === "number")
    .sort((a, b) => a.time - b.time);

  const wins = exits.filter((r) => r.grossR > 0);
  const losses = exits.filter((r) => r.grossR <= 0);
  const totalR = exits.reduce((s, r) => s + r.grossR, 0);
  const grossWin = wins.reduce((s, r) => s + r.grossR, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.grossR, 0));

  // Đường cong vốn (R tích luỹ) + max drawdown theo R
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  const curve: number[] = [];
  for (const e of exits) {
    cum += e.grossR;
    curve.push(cum);
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Streak hiện tại (chuỗi thắng/thua liên tiếp tính từ lệnh mới nhất)
  let streak = 0;
  for (let i = exits.length - 1; i >= 0; i--) {
    const w = exits[i].grossR > 0;
    if (i === exits.length - 1) streak = w ? 1 : -1;
    else if (w === streak > 0) streak += w ? 1 : -1;
    else break;
  }

  const byReason: Record<string, number> = {};
  const bySymbol: Record<string, { n: number; r: number }> = {};
  let longN = 0, longR = 0, shortN = 0, shortR = 0, holdSum = 0;
  for (const e of exits) {
    byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    const sym = (e.symbol ?? "?").toUpperCase();
    bySymbol[sym] = bySymbol[sym] ?? { n: 0, r: 0 };
    bySymbol[sym].n++;
    bySymbol[sym].r += e.grossR;
    if (e.dir === "long") { longN++; longR += e.grossR; } else { shortN++; shortR += e.grossR; }
    if (typeof e.holdBars === "number") holdSum += e.holdBars;
  }

  return {
    closed: exits.length,
    wins: wins.length,
    winRate: exits.length ? wins.length / exits.length : 0,
    totalR,
    avgR: exits.length ? totalR / exits.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWinR: wins.length ? grossWin / wins.length : 0,
    avgLossR: losses.length ? grossLoss / losses.length : 0,
    bestR: exits.length ? Math.max(...exits.map((e) => e.grossR)) : 0,
    worstR: exits.length ? Math.min(...exits.map((e) => e.grossR)) : 0,
    maxDD,
    streak,
    avgHoldDays: exits.length ? holdSum / exits.length / 96 : 0, // 96 nến 15m = 1 ngày
    curve,
    byReason,
    bySymbol,
    long: { n: longN, r: longR },
    short: { n: shortN, r: shortR },
  };
}

async function buildPayload() {
  const state = readState();
  const journal = readJournal();
  const stats = journalStats(journal);

  let account: {
    equity: number | null;
    available: number | null;
    unrealized: number | null;
    marginBalance: number | null;
    marginUsed: number | null;
    marginRatio: number | null; // maintMargin/marginBalance — gần 1 = sát thanh lý
    exposure: number | null; // tổng notional |amt|×mark
    exposurePct: number | null; // exposure / equity
    usdt: number | null; // số dư ví USDT
    usdtAvailable: number | null; // USDT khả dụng
    apiError: string | null;
  } = { equity: null, available: null, unrealized: null, marginBalance: null, marginUsed: null, marginRatio: null, exposure: null, exposurePct: null, usdt: null, usdtAvailable: null, apiError: null };
  const positions: Record<string, PositionRisk> = {};
  // Lệnh CHỜ thật trên sàn (SL/TP/limit…) — để theo dõi & phát hiện vị thế thiếu SL.
  const orders: {
    symbol: string;
    type: string;
    side: string;
    stopPrice: number;
    price: number;
    origQty: number;
    closePosition: boolean;
    reduceOnly: boolean;
    time: number;
  }[] = [];

  if (binance) {
    try {
      if (!timeSynced) {
        await binance.syncTime();
        timeSynced = true;
      }
      const bal = await binance.getEquity();
      let exposure = 0;
      for (const s of state) {
        try {
          const p = await binance.getPosition(s.symbol);
          if (Math.abs(p.positionAmt) > 0) {
            positions[s.symbol.toUpperCase()] = p;
            exposure += Math.abs(p.positionAmt) * p.markPrice;
          }
        } catch {
          /* bỏ qua từng symbol lỗi */
        }
        try {
          for (const o of await binance.getOpenOrders(s.symbol)) {
            orders.push({
              symbol: o.symbol,
              type: o.type,
              side: o.side,
              stopPrice: parseFloat(o.stopPrice ?? "0"),
              price: parseFloat(o.price ?? "0"),
              origQty: parseFloat(o.origQty ?? "0"),
              closePosition: o.closePosition === true || o.closePosition === "true",
              reduceOnly: o.reduceOnly === true || o.reduceOnly === "true",
              time: o.time,
            });
          }
        } catch {
          /* bỏ qua từng symbol lỗi */
        }
      }
      account = {
        equity: bal.walletBalance,
        available: bal.available,
        unrealized: bal.unrealized,
        marginBalance: bal.marginBalance,
        marginUsed: bal.initialMargin,
        marginRatio: bal.marginBalance > 0 ? bal.maintMargin / bal.marginBalance : 0,
        exposure,
        exposurePct: bal.walletBalance > 0 ? exposure / bal.walletBalance : 0,
        usdt: bal.usdtWallet,
        usdtAvailable: bal.usdtAvailable,
        apiError: null,
      };
    } catch (err) {
      account.apiError = err instanceof Error ? err.message : String(err);
      timeSynced = false; // thử sync lại lần sau
    }
  }

  // Tổng risk các vị thế ĐANG mở (theo state bot) so với trần
  const openRiskPct = state.reduce(
    (s, x) => s + (x.livePos ? execCfg.riskPct * (x.livePos.sizeMult ?? 1) : 0),
    0
  );

  return {
    now: Date.now(),
    mode: {
      tradingEnabled: TRADING_ENABLED,
      testnet: TESTNET,
      hasKeys: !!binance,
      riskPct: execCfg.riskPct,
      maxPortfolioRiskPct: execCfg.maxPortfolioRiskPct,
      leverage: execCfg.leverage,
      marginType: execCfg.marginType,
    },
    account,
    orders,
    openRiskPct,
    symbols: state.map((s) => ({ ...s, exchange: positions[s.symbol.toUpperCase()] ?? null })),
    stats,
    journal: journal.filter((j) => j.real === true).slice(-30).reverse(), // chỉ lệnh vào thật
  };
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/dashboard")) {
    try {
      sendJson(res, 200, await buildPayload());
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(PAGE);
});

server.listen(PORT, () => {
  console.log(`\n📊 Dashboard giao dịch: http://localhost:${PORT}`);
  console.log(`   Chế độ: ${TRADING_ENABLED ? (TESTNET ? "THỰC THI · TESTNET" : "THỰC THI · MAINNET ⚠️") : "ALERT-ONLY"}`);
  console.log(`   ⚠️  Chỉ mở trong mạng nội bộ/VPN — trang hiển thị số dư & vị thế.\n`);
});

// ── Trang HTML (self-contained, không phụ thuộc CDN) ────────────────────────
const PAGE = /* html */ `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Dashboard</title>
<style>
  :root{--bg:#0e1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--grn:#3fb950;--red:#f85149;--yel:#d29922;--blu:#388bfd}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:16px}
  h1{font-size:18px;margin:0 0 2px} .sub{color:var(--mut);font-size:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;margin-left:8px}
  .b-test{background:#1f6feb33;color:#79c0ff} .b-main{background:#f8514933;color:#ff7b72} .b-alert{background:#8b949e33;color:#c9d1d9}
  .sec{color:var(--mut);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
  .split2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:640px){.split2{grid-template-columns:1fr}}
  .stat,.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px}
  .stat .k{color:var(--mut);font-size:12px} .stat .v{font-size:19px;font-weight:700;margin-top:2px} .stat .sm{font-size:11px;color:var(--mut)}
  .pos,.flat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;margin-bottom:8px}
  .pos.long{border-left:3px solid var(--grn)} .pos.short{border-left:3px solid var(--red)}
  .flat{border-left:3px solid #30363d;color:var(--mut)}
  .row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px}
  .sym{font-weight:700;font-size:15px} .pill{font-size:11px;padding:1px 7px;border-radius:5px;background:#30363d;margin-left:4px}
  .lng{color:var(--grn)} .shr{color:var(--red)}
  .meta{color:var(--mut);font-size:12px;margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd)}
  th{color:var(--mut);font-weight:600}
  .pos-r{color:var(--grn)} .neg-r{color:var(--red)}
  .bar{height:8px;background:#30363d;border-radius:4px;overflow:hidden;margin-top:6px;position:relative}
  .bar>i{display:block;height:100%;background:var(--blu)}
  .pbar{position:relative;height:10px;background:linear-gradient(90deg,#f8514955,#30363d 50%,#3fb95055);border-radius:5px;margin:8px 0 4px}
  .pbar>.mk{position:absolute;top:-3px;width:2px;height:16px;background:var(--fg)}
  .err{background:#f8514922;border:1px solid #f85149;color:#ff7b72;padding:8px 12px;border-radius:8px;margin:10px 0;font-size:13px}
  .muted{color:var(--mut)}
</style></head>
<body><div class="wrap">
  <h1>📊 Bot Dashboard <span id="mode"></span></h1>
  <div class="sub" id="updated">Đang tải…</div>
  <div id="err"></div>

  <div class="sec">Tài khoản</div>
  <div class="grid" id="account"></div>

  <div class="sec">Hiệu suất (lệnh đã đóng)</div>
  <div class="grid" id="perf"></div>

  <div class="card" style="margin-top:10px">
    <div class="row"><b>Đường cong vốn — R tích luỹ</b><span class="muted" id="curveLast"></span></div>
    <div id="curve"></div>
  </div>

  <div class="split2" style="margin-top:10px">
    <div class="card"><b>Theo lý do thoát</b><div id="reasons" style="margin-top:6px"></div></div>
    <div class="card"><b>Long / Short</b><div id="ls" style="margin-top:6px"></div></div>
  </div>

  <div class="card" style="margin-top:10px"><b>Theo symbol</b><div id="bysym"></div></div>

  <div class="sec">Vị thế &amp; symbol</div>
  <div id="positions"></div>

  <div class="sec">Lệnh chờ trên sàn</div>
  <div id="orders"></div>

  <div class="sec">Nhật ký lệnh gần đây</div>
  <div id="journal"></div>
</div>
<script>
const fmt=(n,d=2)=>n==null?'—':Number(n).toLocaleString('en-US',{maximumFractionDigits:d});
const usd=n=>n==null?'—':'$'+fmt(n,2);
const sgn=(n,d=2,suf='')=>n==null?'—':(n>=0?'+':'')+fmt(n,d)+suf;
const tvn=t=>new Date(t).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour12:false});
const rcls=n=>n>=0?'pos-r':'neg-r';
function rOf(p,mark){const risk=Math.abs(p.entry-p.initialSL);if(!risk)return 0;const pnl=p.dir==='long'?mark-p.entry:p.entry-mark;return pnl/risk;}
function dur(ms){const h=ms/3.6e6;if(h<24)return h.toFixed(1)+'h';return (h/24).toFixed(1)+'d';}
function card(k,v,sm){return '<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div>'+(sm?'<div class="sm">'+sm+'</div>':'')+'</div>';}
function sparkline(curve){
  if(!curve||!curve.length) return '<div class="muted" style="padding:20px 0">Chưa có lệnh đóng.</div>';
  const w=600,h=80,pad=6,min=Math.min(0,...curve),max=Math.max(0,...curve),rng=(max-min)||1;
  const X=i=>pad+i*(w-2*pad)/Math.max(1,curve.length-1), Y=v=>h-pad-(v-min)/rng*(h-2*pad);
  const pts=curve.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join(' ');
  const z=Y(0).toFixed(1), col=curve[curve.length-1]>=0?'var(--grn)':'var(--red)';
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" style="width:100%;height:80px;margin-top:6px">'
    +'<line x1="0" y1="'+z+'" x2="'+w+'" y2="'+z+'" stroke="#30363d"/>'
    +'<polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="2"/></svg>';
}
const RICON={target:'🎯 TP',sl:'🛑 SL',trail:'↗️ Trail',time:'⏱ Time'};
async function tick(){
  let d; try{d=await (await fetch('/api/dashboard')).json();}catch(e){return;}
  const m=d.mode, a=d.account, st=d.stats;
  document.getElementById('mode').innerHTML = m.tradingEnabled
    ? (m.testnet?'<span class="badge b-test">THỰC THI · TESTNET</span>':'<span class="badge b-main">⚠️ MAINNET</span>')
    : '<span class="badge b-alert">ALERT-ONLY</span>';
  document.getElementById('updated').textContent='Cập nhật: '+tvn(d.now)+' · risk '+(m.riskPct*100).toFixed(1)+'%×sizeMult · trần '+(m.maxPortfolioRiskPct*100).toFixed(0)+'% · '+m.marginType+' '+m.leverage+'x';
  document.getElementById('err').innerHTML = a.apiError ? '<div class="err">Lỗi API Binance: '+a.apiError+'</div>' : (m.tradingEnabled&&!m.hasKeys?'<div class="err">TRADING_ENABLED nhưng thiếu API key.</div>':'');

  // ── Tài khoản ──
  const capPct=Math.min(100,d.openRiskPct/m.maxPortfolioRiskPct*100);
  const mr=a.marginRatio==null?null:a.marginRatio*100;
  document.getElementById('account').innerHTML = [
    card('USDT (ví)', a.usdt==null?'—':fmt(a.usdt,2)+' <span class="sm">USDT</span>', a.usdtAvailable!=null?'khả dụng '+fmt(a.usdtAvailable,2):''),
    card('Equity (ví)', usd(a.equity)),
    card('Unrealized PnL', '<span class="'+rcls(a.unrealized||0)+'">'+(a.unrealized==null?'—':sgn(a.unrealized)+'$')+'</span>', a.marginBalance!=null?'Margin bal '+usd(a.marginBalance):''),
    card('Khả dụng', usd(a.available), a.marginUsed!=null?'Đang ký quỹ '+usd(a.marginUsed):''),
    card('Exposure', usd(a.exposure), a.exposurePct!=null?fmt(a.exposurePct,2)+'× equity':''),
    card('Margin ratio', mr==null?'—':mr.toFixed(1)+'%', 'càng cao càng gần thanh lý'),
    card('Risk đang mở', (d.openRiskPct*100).toFixed(1)+'% <span class="muted">/ '+(m.maxPortfolioRiskPct*100).toFixed(0)+'%</span><div class="bar"><i style="width:'+capPct+'%;background:'+(capPct>90?'var(--red)':'var(--blu)')+'"></i></div>'),
  ].join('');

  // ── Hiệu suất ──
  const pf=st.profitFactor===null?'—':(st.profitFactor===Infinity?'∞':fmt(st.profitFactor,2));
  document.getElementById('perf').innerHTML = [
    card('Lệnh đã đóng', st.closed, st.wins+' thắng / '+(st.closed-st.wins)+' thua'),
    card('Win rate', (st.winRate*100).toFixed(0)+'%'),
    card('Tổng R', '<span class="'+rcls(st.totalR)+'">'+sgn(st.totalR,1,'R')+'</span>', 'TB '+sgn(st.avgR,2,'R')+'/lệnh'),
    card('Profit factor', pf, 'lãi gộp / lỗ gộp'),
    card('Avg W / Avg L', '<span class="pos-r">'+sgn(st.avgWinR,2)+'</span> / <span class="neg-r">-'+fmt(st.avgLossR,2)+'</span>','R'),
    card('Best / Worst', '<span class="pos-r">'+sgn(st.bestR,1)+'</span> / <span class="neg-r">'+fmt(st.worstR,1)+'</span>','R'),
    card('Max drawdown', '<span class="neg-r">-'+fmt(st.maxDD,1)+'R</span>'),
    card('Avg hold', fmt(st.avgHoldDays,1)+'d'),
    card('Streak', (st.streak>0?'<span class="pos-r">'+st.streak+' thắng</span>':st.streak<0?'<span class="neg-r">'+(-st.streak)+' thua</span>':'—')),
  ].join('');

  // ── Đường cong vốn ──
  document.getElementById('curve').innerHTML = sparkline(st.curve);
  document.getElementById('curveLast').textContent = st.curve.length? 'hiện '+sgn(st.curve[st.curve.length-1],1,'R') : '';

  // ── Lý do thoát ──
  const rk=Object.keys(st.byReason);
  document.getElementById('reasons').innerHTML = rk.length
    ? rk.map(k=>'<span class="pill">'+(RICON[k]||k)+' '+st.byReason[k]+'</span>').join(' ')
    : '<span class="muted">—</span>';

  // ── Long / Short ──
  document.getElementById('ls').innerHTML =
    '<div class="row"><span class="lng">Long</span><span>'+st.long.n+' lệnh · <span class="'+rcls(st.long.r)+'">'+sgn(st.long.r,1,'R')+'</span></span></div>'
   +'<div class="row" style="margin-top:4px"><span class="shr">Short</span><span>'+st.short.n+' lệnh · <span class="'+rcls(st.short.r)+'">'+sgn(st.short.r,1,'R')+'</span></span></div>';

  // ── Theo symbol ──
  const syms=Object.keys(st.bySymbol).sort((x,y)=>st.bySymbol[y].r-st.bySymbol[x].r);
  document.getElementById('bysym').innerHTML = syms.length
    ? '<table><tr><th>Symbol</th><th>Lệnh</th><th>Tổng R</th></tr>'+syms.map(s=>'<tr><td>'+s.replace('USDT','/USDT')+'</td><td>'+st.bySymbol[s].n+'</td><td class="'+rcls(st.bySymbol[s].r)+'">'+sgn(st.bySymbol[s].r,1,'R')+'</td></tr>').join('')+'</table>'
    : '<div class="muted" style="margin-top:6px">Chưa có lệnh.</div>';

  // ── Vị thế ──
  document.getElementById('positions').innerHTML = d.symbols.map(s=>{
    const tag=s.symbol.toUpperCase().replace('USDT','/USDT');
    if(s.livePos){
      const p=s.livePos, ex=s.exchange;
      const mark=ex?ex.markPrice:p.entry;
      const r=rOf(p,mark), pnl=ex?ex.unrealizedProfit:null, cls=p.dir==='long'?'long':'short';
      const tR=Math.abs(p.entry-p.initialSL)>0?Math.abs(p.target-p.entry)/Math.abs(p.entry-p.initialSL):0;
      const prog=Math.max(0,Math.min(100,(r+1)/((tR||1)+1)*100)); // SL(-1R)=0% → TP=100%
      const dSL=Math.abs((mark-p.sl)/mark*100), dTP=Math.abs((p.target-mark)/mark*100);
      const notional=ex?Math.abs(ex.positionAmt)*mark:(p.qty?p.qty*mark:null);
      return '<div class="pos '+cls+'"><div class="row"><span class="sym">'+tag+' <span class="'+(p.dir==='long'?'lng':'shr')+'">'+p.dir.toUpperCase()+'</span>'+(p.quality?'<span class="pill">'+p.quality+'</span>':'')+'</span>'
        +'<span class="'+rcls(r)+'">'+sgn(r,2,'R')+(pnl!=null?' · '+sgn(pnl)+'$':'')+'</span></div>'
        +'<div class="pbar"><span class="mk" style="left:'+prog+'%"></span></div>'
        +'<div class="meta">Entry '+fmt(p.entry)+' · SL '+fmt(p.sl)+(p.sl!==p.initialSL?' (trail)':'')+' ('+dSL.toFixed(1)+'%) · TP '+fmt(p.target)+' ('+dTP.toFixed(1)+'%)</div>'
        +'<div class="meta">Mark '+fmt(mark)+(notional!=null?' · notional '+usd(notional):'')+(p.riskUsd!=null?' · risk '+usd(p.riskUsd):'')+(ex&&ex.liquidationPrice?' · liq '+fmt(ex.liquidationPrice):'')+'</div>'
        +'<div class="meta">'+(p.qty!=null?'Qty '+p.qty+' · ':'')+'giữ '+dur(d.now-p.entryTime)+' · mở '+tvn(p.entryTime)+'</div>'
        +(ex?'':'<div class="meta" style="color:var(--yel)">⚠ chưa khớp vị thế thật trên sàn</div>')+'</div>';
    }
    const cd=s.cooldownUntilTime>d.now?' · cooldown tới '+tvn(s.cooldownUntilTime):'';
    return '<div class="flat"><span class="sym">'+tag+'</span> — flat'+cd+'</div>';
  }).join('');

  // ── Lệnh chờ trên sàn (+ cảnh báo vị thế thiếu SL) ──
  const OT={STOP_MARKET:'🛑 SL',TAKE_PROFIT_MARKET:'🎯 TP',STOP:'🛑 SL-Limit',TAKE_PROFIT:'🎯 TP-Limit',LIMIT:'Limit',MARKET:'Market',TRAILING_STOP_MARKET:'↗️ Trail'};
  const ords=d.orders||[];
  const posSyms=d.symbols.filter(s=>s.exchange).map(s=>s.symbol.toUpperCase());
  const naked=posSyms.filter(sym=>!ords.some(o=>o.symbol===sym&&(o.type==='STOP_MARKET'||o.type==='STOP')));
  const nakedBanner=naked.length?'<div class="err">⚠️ Vị thế KHÔNG có SL trên sàn: '+naked.map(s=>s.replace('USDT','/USDT')).join(', ')+' — KIỂM TRA NGAY!</div>':'';
  document.getElementById('orders').innerHTML = nakedBanner + (ords.length
    ? '<table><tr><th>Symbol</th><th>Loại</th><th>Side</th><th>Giá kích hoạt</th><th>Khối lượng</th><th>Đặt lúc</th></tr>'
      + ords.slice().sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.type.localeCompare(b.type)).map(o=>'<tr><td>'+o.symbol.replace('USDT','/USDT')+'</td>'
        +'<td>'+(OT[o.type]||o.type)+'</td>'
        +'<td class="'+(o.side==='BUY'?'lng':'shr')+'">'+o.side+'</td>'
        +'<td>'+fmt(o.stopPrice||o.price)+'</td>'
        +'<td>'+(o.closePosition?'đóng toàn bộ':fmt(o.origQty,4))+(o.reduceOnly?' <span class="muted">(reduceOnly)</span>':'')+'</td>'
        +'<td>'+tvn(o.time)+'</td></tr>').join('')+'</table>'
    : '<div class="muted" style="margin-top:6px">'+(m.hasKeys?'Không có lệnh chờ trên sàn.':'Cần API key để xem.')+'</div>');

  // ── Nhật ký ──
  document.getElementById('journal').innerHTML='<table><tr><th>Thời gian</th><th>Sự kiện</th><th>Symbol</th><th>Hướng</th><th>Giá</th><th>R</th><th>Giữ</th><th>Lý do</th></tr>'
    +d.journal.map(j=>'<tr><td>'+tvn(j.time)+'</td><td>'+j.event+'</td><td>'+(j.symbol||'').toUpperCase().replace('USDT','/USDT')+'</td><td class="'+(j.dir==='long'?'lng':'shr')+'">'+(j.dir||'')+'</td>'
      +'<td>'+fmt(j.event==='exit'?j.exitPrice:j.entry)+'</td>'
      +'<td class="'+(j.grossR>=0?'pos-r':'neg-r')+'">'+(j.grossR!=null?sgn(j.grossR,2,'R'):'—')+'</td>'
      +'<td>'+(j.holdBars!=null?fmt(j.holdBars/96,1)+'d':'—')+'</td>'
      +'<td>'+(RICON[j.reason]||j.reason||'')+'</td></tr>').join('')+'</table>';
}
tick(); setInterval(tick,5000);
</script>
</body></html>`;
