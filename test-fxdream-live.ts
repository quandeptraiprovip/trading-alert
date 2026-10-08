/**
 * test-fxdream-live.ts — Luồng bot FX Dream có hỏi ý, chạy trên SÀN GIẢ và nến giả lập.
 *
 * KHÔNG import load-env: env sạch, Telegram tắt, không đụng key thật. State ghi vào thư mục tạm.
 * Run: npm run test:fxdream-live
 */
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { FxDreamLive, FxDreamLiveOptions, isNightVn, parseEditText, parsePrice, pickLeverage } from "./fxdream-live";
import { FakeVenue } from "./fxdream-fake-venue";
import { KEY_VOLUME_CONFIG } from "./key-volume";
import { buildProposalSvg, renderPng } from "./fxdream-image";
import { Candle, TF_MS } from "./strategy";

type Bar = { open: number; high: number; low: number; close: number; volume?: number };
const M15 = TF_MS["15m"];
const BELOW: Bar = { open: 99.3, high: 99.5, low: 99.1, close: 99.4 };

/**
 * Cùng hình với fixture nhánh 4 của test-key-volume.ts: key 100 ở nến 100, nến 701 râu chạm key
 * thành đỉnh phản ứng 100,3, nến xanh 704 lên đỉnh thấp hơn 99,75, nến 705 xác nhận.
 */
function fixture(base: number, tail: Bar[]): Candle[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 700; i++) {
    bars.push(i === 100 ? { open: 100.0, high: 100.1, low: 99.0, close: 99.2, volume: 2000 } : BELOW);
  }
  bars.push(
    { open: 99.4, high: 99.9, low: 99.35, close: 99.85 },
    { open: 99.85, high: 100.3, low: 99.8, close: 99.95 },
    { open: 99.95, high: 100.0, low: 99.4, close: 99.45 },
    { open: 99.45, high: 99.5, low: 99.2, close: 99.3 },
    { open: 99.3, high: 99.75, low: 99.25, close: 99.7 },
    { open: 99.7, high: 99.72, low: 99.1, close: 99.15 },
    ...tail,
  );
  return bars.map((b, i) => ({
    openTime: base + i * M15, open: b.open, high: b.high, low: b.low, close: b.close,
    volume: b.volume ?? 100, quoteVolume: b.volume ?? 100, takerBuyVolume: (b.volume ?? 100) / 2,
  }));
}
const CONFIRM = 705;

const PARAMS = {
  ...KEY_VOLUME_CONFIG,
  minRR: 0,
  requireStructuralTarget: false,
  requireKeyMaturation: false,
  enableSweepBranch: false,
  enableVolumeReversalBranch: false,
  enableKeyTrapBranch: false,
};

/** Chạy bot từ nến `startAt` tới hết `candles`; `onPending` quyết định từng đề nghị. */
async function replay(
  candles: Candle[],
  startAt: number,
  onPending: (fx: FxDreamLive, id: string) => Promise<void>,
  setup?: (venue: FakeVenue, dir: string) => void,
  params = PARAMS,
  extra: Pick<FxDreamLiveOptions, "symbol" | "stateName" | "marketClosed"> = { symbol: "test" },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxdream-test-"));
  const venue = new FakeVenue();
  let idx = startAt;
  let clock = candles[idx].openTime + M15 + 5000;
  venue.cur = candles[idx];
  setup?.(venue, dir);
  const fx = new FxDreamLive({
    ...extra, venue, telegram: { enabled: false, botToken: "", chatId: "" }, riskUsd: 5, maxLeverage: 20,
    dataDir: dir, isTradingReady: () => true, params, now: () => clock,
    fetchClosed: async (n) => candles.slice(Math.max(0, idx + 1 - n), idx + 1),
  });
  const log = console.log;
  console.log = () => {};
  try {
    await fx.start();
    for (idx = startAt + 1; idx < candles.length; idx++) {
      venue.step(candles[idx]);
      clock = candles[idx].openTime + M15 + 5000;
      await fx.tick();
      for (const p of fx.snapshot().proposals.filter((x) => x.status === "pending")) await onPending(fx, p.id);
    }
  } finally {
    console.log = log;
  }
  const journalFile = path.join(dir, `${extra.stateName ?? "fxdream"}-trades.jsonl`);
  const journal = fs.existsSync(journalFile)
    ? fs.readFileSync(journalFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  return { fx, venue, journal, dir };
}

// Giờ VN ban ngày: nến 0 mở lúc 07:00 VN ⇒ nến xác nhận đóng 15:30 VN.
const DAY = 0;
// Dịch 9h30 ⇒ nến xác nhận đóng 01:00 VN.
const NIGHT = 9.5 * 3600_000;

const TAIL: Bar[] = [
  { open: 99.15, high: 99.35, low: 99.1, close: 99.2 }, // hồi chạm mép 99,3 → khớp
  { open: 99.2, high: 99.25, low: 98.1, close: 98.3 }, // chạm +1R → chốt 33%
  { open: 98.3, high: 99.4, low: 98.2, close: 99.35 }, // quay lên chạm SL đã dời về giá vào
  BELOW,
];

async function testApproveFillPartialBreakeven(): Promise<void> {
  const candles = fixture(DAY, TAIL);
  assert.equal(isNightVn(candles[CONFIRM].openTime + M15), false);
  const { fx, venue, journal } = await replay(candles, CONFIRM - 1, (f, id) => f.decide(id, true));
  const p = fx.snapshot().proposals[0];
  assert.ok(p, "nến xác nhận đỉnh thấp hơn phải sinh đề nghị");
  assert.equal(p.kind, "limit");
  assert.equal(p.dir, "short");
  assert.equal(p.branch, "key-lower-high");
  assert.equal(p.entry, 99.3, "LIMIT ở mép dưới thân nến xanh");
  assert.equal(p.auto, false, "ban ngày phải hỏi");
  assert.equal(p.status, "approved");
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened, "LIMIT phải khớp và mở vị thế");
  assert.equal(opened.entry, 99.3);
  assert.ok(opened.stop > 100.3, "SL ngoài đỉnh phản ứng");
  assert.ok(opened.riskUsd > 4.5 && opened.riskUsd < 5.1, `lệnh bạn duyệt: rủi ro đủ $5, được ${opened.riskUsd}`);
  const closed = journal.find((e) => e.event === "closed");
  assert.ok(closed, "vị thế phải đóng");
  assert.equal(closed.reason, "SL về giá vào sau khi chốt 33%");
  assert.ok(closed.grossR > 0.3 && closed.grossR < 0.36, `chốt 33% ở 1R rồi hoà phần còn lại ≈ +0,33R, được ${closed.grossR}`);
  assert.equal(venue.pos, 0);
  assert.equal(fx.snapshot().position, null);
}

async function testRejectPlacesNothing(): Promise<void> {
  const { fx, venue, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, (f, id) => f.decide(id, false));
  assert.equal(fx.snapshot().proposals[0].status, "rejected");
  assert.equal(venue.fills.length, 0, "bỏ qua thì không có lệnh nào");
  assert.equal(journal.length, 0);
}

async function testNightAutoEnters(): Promise<void> {
  const candles = fixture(NIGHT, TAIL);
  assert.equal(isNightVn(candles[CONFIRM].openTime + M15), true);
  let asked = 0;
  const { fx, journal } = await replay(candles, CONFIRM - 1, async () => { asked++; });
  assert.equal(asked, 0, "00:00–06:00 không hỏi");
  const p = fx.snapshot().proposals[0];
  assert.equal(p.auto, true);
  assert.equal(p.status, "approved");
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened, "tự vào lệnh");
  assert.ok(opened.riskUsd > 2 && opened.riskUsd < 2.6, `tự vào ban đêm: nửa rủi ro $2,5, được ${opened.riskUsd}`);
}

/** User 06/10/26: ban đêm mà TP < 1R thì KHÔNG tự vào — hỏi như ban ngày, duyệt thì đủ $5. */
async function testNightThinTargetAsks(): Promise<void> {
  let asked = 0;
  const { fx, journal } = await replay(fixture(NIGHT, TAIL), CONFIRM - 1, async (f, id) => {
    asked++;
    await f.decide(id, true);
  }, undefined, { ...PARAMS, finalTargetR: 0.5 });
  const p = fx.snapshot().proposals[0];
  assert.ok(Math.abs(p.target - p.entry) < Math.abs(p.entry - p.stop), "fixture phải có TP < 1R");
  assert.equal(p.auto, false, "TP < 1R ban đêm không được tự vào");
  assert.equal(asked, 1, "phải hỏi ý");
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened && opened.riskUsd > 4.5, "bạn duyệt thì rủi ro đủ $5");
}

/** Ổ đầy (06/10/26): ghi state lỗi không được làm bot bỏ dở việc huỷ LIMIT hết hạn. */
async function testLimitExpiresWhenDiskFull(): Promise<void> {
  const AWAY: Bar = { open: 99.0, high: 99.1, low: 98.9, close: 99.0 };
  const { fx, venue, journal } = await replay(
    fixture(DAY, Array(20).fill(AWAY)),
    CONFIRM - 1,
    (f, id) => f.decide(id, true),
    (_v, dir) => fs.mkdirSync(path.join(dir, "fxdream-state.json.tmp")), // writeFileSync → EISDIR
  );
  assert.equal(fx.snapshot().proposals[0].status, "approved");
  assert.ok(journal.some((e) => e.event === "limit-placed"), "LIMIT phải được đặt");
  assert.ok(journal.some((e) => e.event === "limit-expired"), "hết 16 nến phải huỷ LIMIT dù không ghi được state");
  assert.equal(venue.orders.length, 0, "không còn lệnh chờ trên sàn");
  assert.equal(fx.snapshot().working, null);
  assert.equal(venue.fills.length, 0);
}

async function testForeignPositionBlocks(): Promise<void> {
  const { fx, venue } = await replay(fixture(DAY, TAIL), CONFIRM - 1, (f, id) => f.decide(id, true), (v) => {
    v.pos = 0.5;
    v.entry = 99;
  });
  assert.ok(fx.blocked, "vị thế lạ trên sàn phải khoá bot");
  assert.equal(fx.snapshot().proposals[0].status, "skipped");
  assert.equal(venue.orders.length + venue.fills.length, 0, "không đụng vào vị thế lạ");
}

async function testUnansweredProposalExpires(): Promise<void> {
  // Đề nghị không được trả lời thì hết hạn, không vào.
  const { fx, venue } = await replay(fixture(DAY, [...TAIL, BELOW, BELOW, BELOW, ...Array(16).fill(BELOW)]), CONFIRM - 1, async () => {});
  assert.equal(fx.snapshot().proposals[0].status, "expired");
  assert.equal(venue.fills.length, 0);
}

function testParsePrice(): void {
  assert.equal(parsePrice("78900"), 78900);
  assert.equal(parsePrice("78,900.5"), 78900.5);
  assert.equal(parsePrice("78.900,5"), 78900.5);
  assert.equal(parsePrice("78900,5"), 78900.5);
  assert.equal(parsePrice("78.900"), 78900, "một dấu chấm + đúng 3 số = phân cách nghìn");
  assert.equal(parsePrice("99.35"), 99.35);
  assert.equal(parsePrice("abc"), null);
  assert.deepEqual(parseEditText("sl 79400 tp 78300"), { stop: 79400, target: 78300 });
  assert.deepEqual(parseEditText("Vào: 78.850,5"), { entry: 78850.5 });
  assert.deepEqual(parseEditText("entry=78850 SL=79,400"), { entry: 78850, stop: 79400 });
  // Giá vàng (2 số lẻ).
  assert.equal(parsePrice("4172.35"), 4172.35);
  assert.equal(parsePrice("4.172,35"), 4172.35);
  assert.equal(parsePrice("4172,3"), 4172.3);
  assert.deepEqual(parseEditText("sl 4155,8 tp 4262.4 entry 4,172.35"), { stop: 4155.8, target: 4262.4, entry: 4172.35 });
  assert.equal(parseEditText("ok"), null);
}

/** ✏️ Sửa SL/TP rồi ✅: lệnh vào đúng giá đã sửa, chốt 33% tính lại theo R mới. */
async function testEditThenApprove(): Promise<void> {
  let step = 0;
  const { fx, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    if (step++ > 0) return;
    await f.startEdit(id);
    assert.equal(await f.handleText("sl 99.1 tp 97"), true);
    const bad = f.snapshot().proposals.find((x) => x.id === id)!;
    assert.equal(bad.stop, f.snapshot().proposals[0].stop, "SL dưới entry của lệnh SHORT bị từ chối, giữ nguyên");
    assert.equal(bad.edited, undefined);
    // Gõ nhầm (thiếu chữ số): TP 9,7 vẫn đúng thứ tự TP < entry của SHORT nhưng lệch >20% giá → từ chối.
    assert.equal(await f.handleText("tp 9.7"), true);
    assert.equal(f.snapshot().proposals[0].edited, undefined, "giá lệch >20% so với giá hiện tại bị từ chối");
    assert.equal(await f.handleText("sl 100,5 tp 97"), true);
    await f.decide(id, true);
  });
  const p = fx.snapshot().proposals[0];
  assert.equal(p.stop, 100.5);
  assert.equal(p.target, 97);
  assert.deepEqual(p.edited, ["sl", "tp"]);
  assert.ok(Math.abs(p.partial! - 98.1) < 1e-9, "1R tính lại từ SL mới: 99,3 − 1,2");
  assert.equal(fx.snapshot().editingId, null);
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened, "duyệt sau khi sửa phải vào lệnh");
  assert.equal(opened.stop, 100.5);
  assert.equal(opened.target, 97);
}

/** Đòn bẩy cao nhất mà thanh lý (≈ 1/đòn bẩy − 1%) vẫn cách entry ≥ 1,5× khoảng SL, trần 20x. */
function testPickLeverage(): void {
  assert.equal(pickLeverage(0.003, 20), 20, "SL sát → chạm trần");
  assert.equal(pickLeverage(0.047, 20), 12);
  assert.equal(pickLeverage(0.1, 20), 6, "SL xa nhất cho phép (10%)");
  assert.equal(pickLeverage(0.9, 20), 1);
  for (const sf of [0.001, 0.005, 0.02, 0.05, 0.1]) {
    const lev = pickLeverage(sf, 20);
    assert.ok(lev <= 20 && 1 / lev - 0.01 >= 1.5 * sf, `SL ${sf}: thanh lý phải xa hơn SL, được ${lev}x`);
  }
}

/**
 * User 07/10/26: lệnh vào ở giá đóng không còn trần lệch 0,3R — giá chưa vượt SL là vào, khối lượng
 * và đòn bẩy tính theo khoảng SL từ giá thật. Fixture chỉ sinh LIMIT nên đổi đề nghị thành MARKET.
 */
async function testMarketDriftEntersUntilStop(): Promise<void> {
  const asMarket = (stop: number) => async (f: FxDreamLive, id: string) => {
    const p = f.snapshot().proposals.find((x) => x.id === id)!;
    // Giá hiện tại 99,15 (đóng nến xác nhận). SHORT dự tính 98,5, SL 99,22 ⇒ giá đã trôi 0,9R về phía SL.
    Object.assign(p, { kind: "market", entry: 98.5, stop, target: 94, partial: 98.5 - (stop - 98.5) });
    await f.decide(id, true);
  };
  const drift = await replay(fixture(DAY, TAIL), CONFIRM - 1, asMarket(99.22));
  const opened = drift.journal.find((e) => e.event === "opened");
  assert.ok(opened, "lệch 0,9R vẫn phải vào lệnh");
  assert.equal(opened.entry, 99.15, "khớp ở giá thật");
  assert.ok(opened.riskUsd > 4.9 && opened.riskUsd <= 5, `rủi ro tính từ giá thật vẫn $5, được ${opened.riskUsd}`);
  assert.equal(drift.venue.leverage, pickLeverage(0.07 / 99.15, 20), "đòn bẩy theo khoảng SL thật");

  const past = await replay(fixture(DAY, TAIL), CONFIRM - 1, asMarket(99.1));
  assert.equal(past.fx.snapshot().proposals[0].status, "failed", "giá đã qua SL thì không vào");
  assert.equal(past.venue.fills.length, 0);
}

/** User 06/10/26: sửa SL sát hay xa thì rủi ro vẫn $5 — khối lượng và đòn bẩy tự tính lại. */
async function testEditKeepsRisk(): Promise<void> {
  for (const [sl, lev] of [["99.6", 20], ["104", 12]] as const) {
    let step = 0;
    const { venue, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
      if (step++ > 0) return;
      await f.startEdit(id);
      assert.equal(await f.handleText(`sl ${sl}`), true);
      await f.decide(id, true);
    });
    const opened = journal.find((e) => e.event === "opened");
    assert.ok(opened, `SL ${sl}: phải vào lệnh`);
    assert.equal(opened.stop, +sl);
    assert.ok(opened.riskUsd > 4.9 && opened.riskUsd <= 5, `SL ${sl}: rủi ro vẫn $5, được ${opened.riskUsd}`);
    assert.equal(venue.leverage, lev, `SL ${sl}: đòn bẩy ${lev}x`);
  }
}

/** Không ở chế độ sửa thì tin nhắn chữ không bị FX Dream nuốt. */
async function testTextIgnoredWhenNotEditing(): Promise<void> {
  let used: boolean | null = null;
  await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    if (used !== null) return;
    used = await f.handleText("sl 100");
    await f.decide(id, false);
  });
  assert.equal(used, false);
}

/** Sàn báo lỗi lúc đặt LIMIT → đề nghị "failed" nhưng còn thử lại được; ✅ lần hai đặt lệnh bình thường. */
async function testRetryAfterVenueError(): Promise<void> {
  let calls = 0;
  const { fx, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    await f.decide(id, true);
    const p = f.snapshot().proposals.find((x) => x.id === id)!;
    assert.equal(p.status, "failed");
    assert.equal(p.retryable, true, "lỗi sàn phải cho thử lại");
    assert.match(p.note!, /lỗi sàn: Timestamp/);
    await f.decide(id, true);
  }, (v) => {
    const orig = v.limitOrder.bind(v);
    v.limitOrder = async (...args: Parameters<FakeVenue["limitOrder"]>) => {
      if (calls++ === 0) throw new Error("Timestamp for this request is outside of the recvWindow");
      return orig(...args);
    };
  });
  assert.equal(calls, 2);
  const p = fx.snapshot().proposals[0];
  assert.equal(p.status, "approved");
  assert.ok(journal.some((e) => e.event === "opened"), "thử lại phải vào lệnh");
}

/** Báo lỗi nhưng lệnh THẬT ra đã lên sàn (timeout): thử lại phải khoá, không đặt lệnh thứ hai. */
async function testRetryDoesNotDoubleOrder(): Promise<void> {
  let calls = 0;
  const { fx, venue } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    await f.decide(id, true);
    await f.decide(id, true);
  }, (v) => {
    const orig = v.limitOrder.bind(v);
    v.limitOrder = async (...args: Parameters<FakeVenue["limitOrder"]>) => {
      calls++;
      await orig(...args);
      throw new Error("timeout of 10000ms exceeded");
    };
  });
  assert.equal(calls, 1, "không được gửi lệnh lần hai");
  assert.ok(fx.blocked, "lệnh lạ trên sàn phải khoá bot");
  const p = fx.snapshot().proposals[0];
  assert.equal(p.status, "failed");
  assert.equal(p.retryable, false);
  assert.ok(venue.orders.length + venue.fills.length <= 1);
}

/** Lỗi sàn mà không thử lại: quá hạn đề nghị thì mất quyền thử lại, bấm nút cũ không đặt lệnh. */
async function testRetryExpires(): Promise<void> {
  let first = true;
  const { fx } = await replay(fixture(DAY, Array(21).fill(BELOW)), CONFIRM - 1, async (f, id) => {
    if (!first) return;
    first = false;
    await f.decide(id, true);
  }, (v) => {
    v.limitOrder = async () => { throw new Error("Service unavailable"); };
  });
  const p = fx.snapshot().proposals[0];
  assert.equal(p.status, "failed");
  assert.equal(p.retryable, false, "quá hạn đề nghị thì hết thử lại");
  await fx.decide(p.id, true);
  assert.equal(fx.snapshot().proposals[0].status, "failed", "bấm nút cũ sau hạn không đặt lệnh");
}

/**
 * Vàng (06/10/26): instance thứ hai cùng thư mục dữ liệu phải có file state/journal RIÊNG và id
 * đề nghị mang tiền tố mã — nếu không, BTC và vàng ghi đè state của nhau, nút bấm vào nhầm mã.
 */
async function testSecondSymbolSeparateStateAndIds(): Promise<void> {
  const { fx, journal, dir } = await replay(fixture(DAY, TAIL), CONFIRM - 1, (f, id) => f.decide(id, true), undefined, PARAMS,
    { symbol: "xauusdt", stateName: "fxdream-xauusdt" });
  const p = fx.snapshot().proposals[0];
  assert.ok(p.id.startsWith("xau"), `id phải có tiền tố mã, được ${p.id}`);
  assert.ok(fx.owns(p.id));
  assert.equal(fx.owns(p.id.replace(/^xau/, "btc")), false, "id của mã khác không thuộc instance này");
  assert.ok(fs.existsSync(path.join(dir, "fxdream-xauusdt-state.json")));
  assert.equal(fs.existsSync(path.join(dir, "fxdream-state.json")), false, "không được đụng file state của BTC");
  assert.ok(journal.some((e) => e.event === "opened"), "journal riêng của vàng phải ghi lệnh");
}

/** Bot truyền `marketClosed: undefined` cho BTC (06/10/26: từng làm bot sập lúc khởi động). */
async function testUndefinedOptionsKeepDefaults(): Promise<void> {
  const { fx } = await replay(fixture(DAY, TAIL), CONFIRM - 1, (f, id) => f.decide(id, true), undefined, PARAMS,
    { symbol: "btcusdt", stateName: undefined, marketClosed: undefined });
  assert.ok(fx.snapshot().proposals[0]?.id.startsWith("btc"), "BTC không có giờ đóng cửa vẫn phải ra đề nghị");
}

/** Bấm ✏️ ở mã khác: chế độ sửa ở mã này tắt, tin chữ không còn bị nó bắt. */
async function testCancelEdit(): Promise<void> {
  let used: boolean | null = null;
  await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    if (used !== null) return;
    await f.startEdit(id);
    await f.cancelEdit();
    assert.equal(f.snapshot().editingId, null);
    used = await f.handleText("sl 100,5");
    await f.decide(id, false);
  });
  assert.equal(used, false);
}

/**
 * Vàng: nến lúc thị trường đóng cửa bị bỏ khỏi engine, và tín hiệu trong giờ đầu sau khi mở cửa
 * lại (05:00 sáng thứ Hai VN rơi vào khung tự vào ban đêm) phải HỎI chứ không tự vào.
 */
async function testReopenHourAsksAndClosedBarsDropped(): Promise<void> {
  const GAP = 49 * 3600_000; // như một cuối tuần vàng
  const base = fixture(NIGHT, TAIL);
  // Chèn 10 nến "cuối tuần" (sẽ bị bỏ) ngay trước nến xác nhận, rồi dời nến xác nhận về sau khoảng đóng cửa.
  const closedFrom = base[CONFIRM - 1].openTime + M15;
  const closedTo = closedFrom + GAP;
  const weekend: Candle[] = Array.from({ length: 10 }, (_, k) => ({
    openTime: closedFrom + k * M15, open: 120, high: 130, low: 110, close: 120, volume: 99999, quoteVolume: 99999, takerBuyVolume: 1,
  }));
  const after = base.slice(CONFIRM).map((c) => ({ ...c, openTime: c.openTime + GAP }));
  const candles = [...base.slice(0, CONFIRM), ...weekend, ...after];
  const confirmBar = candles[CONFIRM + weekend.length];
  assert.equal(isNightVn(confirmBar.openTime + M15), true, "fixture: nến xác nhận đóng giữa đêm");
  let asked = 0;
  const { fx, journal } = await replay(candles, CONFIRM - 1, async (f, id) => {
    asked++;
    await f.decide(id, true);
  }, undefined, PARAMS, { symbol: "xauusdt", stateName: "fxdream-xauusdt", marketClosed: (ms) => ms >= closedFrom && ms < closedTo });
  const p = fx.snapshot().proposals[0];
  assert.ok(p, "bỏ nến cuối tuần thì mẫu hình vẫn nối liền, phải ra tín hiệu ở nến đầu tiên sau mở cửa");
  assert.equal(p.createdAt, confirmBar.openTime + M15);
  assert.equal(p.auto, false, "giờ đầu sau mở cửa không được tự vào dù là ban đêm");
  assert.equal(asked, 1);
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened && opened.riskUsd > 4.5, "bạn duyệt thì rủi ro đủ $5");
}

function testImageRenders(): void {
  const candles = fixture(DAY, TAIL).slice(-96);
  const svg = buildProposalSvg({
    candles, dir: "short", title: "SHORT TEST · Đỉnh thấp dần sau key", subtitle: "thử",
    keyPrice: 100, otherKeys: [], box: { low: 99.3, high: 99.7, startTime: candles[90].openTime, endTime: candles[90].openTime },
    entry: 99.3, stop: 100.36, target: 94, partial: 98.24, marks: [], signalTime: candles[91].openTime, footer: ["a", "b"],
  });
  assert.ok(svg.startsWith("<svg") && svg.includes("Đỉnh thấp dần"));
  const png = renderPng(svg);
  assert.ok(png && png.length > 1000 && png.subarray(1, 4).toString() === "PNG", "resvg phải ra PNG");
}

(async () => {
  await testApproveFillPartialBreakeven();
  await testRejectPlacesNothing();
  await testNightAutoEnters();
  await testNightThinTargetAsks();
  await testLimitExpiresWhenDiskFull();
  await testForeignPositionBlocks();
  await testUnansweredProposalExpires();
  testParsePrice();
  await testEditThenApprove();
  testPickLeverage();
  await testMarketDriftEntersUntilStop();
  await testEditKeepsRisk();
  await testTextIgnoredWhenNotEditing();
  await testRetryAfterVenueError();
  await testRetryDoesNotDoubleOrder();
  await testRetryExpires();
  await testSecondSymbolSeparateStateAndIds();
  await testCancelEdit();
  await testUndefinedOptionsKeepDefaults();
  await testReopenHourAsksAndClosedBarsDropped();
  testImageRenders();
  console.log("FX Dream live tests: OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
