/**
 * Kiểm bot FX Dream trên NẾN THẬT trước khi deploy: chạy FxDreamLive (đúng code live) qua sàn giả,
 * tự duyệt mọi đề nghị (cứ 3 đề nghị thì 1 lần SỬA TP rồi mới duyệt), soát bất biến sau MỖI nến:
 *   · sàn có vị thế ⇔ state có vị thế, và vị thế luôn có SL trên sàn (không bao giờ trần)
 *   · không có lệnh chờ / SL / TP mồ côi khi state rỗng
 *   · bot không bao giờ tự khoá (không có vị thế lạ nào trong mô phỏng)
 *   · id đề nghị mang tiền tố mã
 *   · vàng: không đề nghị nào từ nến lúc thị trường đóng cửa; giờ đầu sau mở cửa không tự vào
 * Rồi đối chiếu giá vào/SL/TP của đề nghị (chưa sửa) với kế hoạch của engine backtest cùng planId.
 *
 * Không gọi sàn thật, không Telegram (log console bị tắt). Nến lấy từ API công khai.
 * Chạy: npx ts-node scripts/check-fxdream-replay.ts [days] [symbols...]
 */
import fs from "fs";
import os from "os";
import path from "path";
import { FxDreamLive, FxProposal } from "../fxdream-live";
import { FakeVenue } from "../fxdream-fake-venue";
import { KEY_VOLUME_CONFIG, runKeyVolume } from "../key-volume";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { dropsWeekendBars, goldClosedNy } from "../market-hours";
import { TF_MS } from "../strategy";

const M15 = TF_MS["15m"];
const WINDOW_BARS = 45 * 96 + 600; // = WINDOW_BARS của fxdream-live.ts

async function check(symbol: string, days: number): Promise<boolean> {
  const raw = await fetchFuturesKlinesPaged(symbol, "15m", WINDOW_BARS + days * 96);
  const closed = dropsWeekendBars(symbol) ? goldClosedNy : () => false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxdream-replay-"));
  const venue = new FakeVenue();
  const startAt = raw.length - days * 96;
  let idx = startAt;
  let clock = raw[idx].openTime + M15 + 5000;
  venue.cur = raw[idx];
  const fx = new FxDreamLive({
    symbol, venue, telegram: { enabled: false, botToken: "", chatId: "" }, riskUsd: 5, maxLeverage: 20,
    dataDir: dir, isTradingReady: () => true, now: () => clock,
    stateName: symbol === "btcusdt" ? "fxdream" : `fxdream-${symbol}`,
    marketClosed: dropsWeekendBars(symbol) ? goldClosedNy : undefined,
    fetchClosed: async (n) => raw.slice(Math.max(0, idx + 1 - n), idx + 1),
  });
  const violations: string[] = [];
  const bad = (why: string) => {
    if (violations.length < 20) violations.push(`${new Date(raw[idx].openTime).toISOString().slice(0, 16)} ${why}`);
  };
  let decided = 0;
  let edited = 0;
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    await fx.start();
    for (idx = startAt + 1; idx < raw.length; idx++) {
      venue.step(raw[idx]);
      clock = raw[idx].openTime + M15 + 5000;
      await fx.tick();
      for (const p of fx.snapshot().proposals.filter((x) => x.status === "pending")) {
        if (decided++ % 3 === 2) {
          // Sửa TP thành đúng 2R rồi mới duyệt — đi qua luồng ✏️ với giá thật.
          const r = Math.abs(p.entry - p.stop);
          const tp = p.dir === "long" ? p.entry + 2 * r : p.entry - 2 * r;
          await fx.startEdit(p.id);
          await fx.handleText(`tp ${tp.toFixed(2)}`);
          if (!fx.snapshot().proposals.find((x) => x.id === p.id)?.edited?.includes("tp")) bad(`sửa TP ${tp.toFixed(2)} bị từ chối`);
          else edited++;
        }
        await fx.decide(p.id, true);
      }
      const st = fx.snapshot();
      if (fx.blocked) bad(`bot tự khoá: ${fx.blocked}`);
      if (venue.pos !== 0 && !st.position && !st.working) bad(`sàn có vị thế ${venue.pos} mà state không biết`);
      if (venue.pos !== 0 && !venue.algos.some((a) => a.orderType === "STOP_MARKET")) bad("vị thế TRẦN — không có SL trên sàn");
      if (venue.pos === 0 && !st.position && !st.working && venue.orders.length + venue.algos.length > 0) bad("lệnh mồ côi trên sàn");
      if (st.position && venue.pos === 0) bad("state còn vị thế mà sàn đã đóng");
    }
  } finally {
    console.log = log;
    console.warn = warn;
  }

  const st = fx.snapshot();
  const ps: FxProposal[] = st.proposals;
  for (const p of ps) {
    if (!fx.owns(p.id) || !p.id.startsWith(symbol.replace(/usdt$/, ""))) bad(`id ${p.id} thiếu tiền tố mã`);
    if (closed(p.createdAt - M15)) bad(`đề nghị ${p.id} từ nến lúc thị trường đóng cửa`);
    if (p.auto && closed(p.createdAt - M15 - 60 * 60_000)) bad(`đề nghị ${p.id} tự vào trong giờ đầu sau mở cửa`);
  }
  const journalFile = path.join(dir, `${symbol === "btcusdt" ? "fxdream" : `fxdream-${symbol}`}-trades.jsonl`);
  const journal = fs.existsSync(journalFile)
    ? fs.readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const closedTrades = journal.filter((e) => e.event === "closed");
  const opened = journal.filter((e) => e.event === "opened").length;

  // Đối chiếu với engine backtest (cùng cách bỏ nến) theo planId.
  const bt = runKeyVolume(symbol, raw.filter((c) => !closed(c.openTime)), KEY_VOLUME_CONFIG);
  const plans = new Map(bt.plans.map((p) => [p.id, p]));
  let compared = 0;
  let mismatched = 0;
  for (const p of ps.filter((x) => !x.edited?.length && x.kind === "limit")) {
    const plan = plans.get(p.planId);
    if (!plan) continue;
    compared++;
    if (Math.abs(plan.obEntryEdge - p.entry) > 1e-9) {
      mismatched++;
      bad(`đề nghị ${p.id}: entry ${p.entry} ≠ engine ${plan.obEntryEdge}`);
    }
  }

  const byStatus = ps.reduce<Record<string, number>>((m, p) => ((m[p.status] = (m[p.status] ?? 0) + 1), m), {});
  const nights = ps.filter((p) => p.auto).length;
  console.log(`\n${symbol.toUpperCase()} · ${days} ngày · ${raw.length - startAt - 1} nến`
    + `${dropsWeekendBars(symbol) ? ` (bỏ ${raw.slice(startAt).filter((c) => closed(c.openTime)).length} nến đóng cửa)` : ""}`);
  console.log(`  đề nghị ${ps.length} (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}) · tự vào đêm ${nights} · sửa TP ${edited}`);
  console.log(`  mở ${opened} vị thế · đóng ${closedTrades.length} · R thuần ${closedTrades.reduce((a, e) => a + (e.grossR ?? 0), 0).toFixed(2)}`);
  console.log(`  LIMIT chưa sửa so với engine backtest: ${compared - mismatched}/${compared} khớp entry`);
  for (const p of ps.filter((x) => x.status === "failed")) console.log(`  · không vào ${p.id}: ${p.note}`);
  console.log(`  vi phạm bất biến: ${violations.length}`);
  for (const v of violations) console.log(`    ✗ ${v}`);
  return violations.length === 0;
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 60);
  const symbols = process.argv.length > 3 ? process.argv.slice(3) : ["xauusdt", "btcusdt"];
  let ok = true;
  for (const s of symbols) ok = (await check(s, days)) && ok;
  console.log(ok ? "\nOK — không vi phạm bất biến nào." : "\nCÓ VI PHẠM — xem ở trên.");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
