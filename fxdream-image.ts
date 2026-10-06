/**
 * fxdream-image.ts — Vẽ ẢNH đề nghị vào lệnh FX Dream để gửi Telegram.
 *
 * Dựng SVG thuần (không phụ thuộc trình duyệt) rồi đổi sang PNG bằng resvg. Telegram
 * không nhận SVG làm ảnh. Không có resvg (máy dev thiếu gói) thì `renderPng` trả null và
 * bot gửi chữ thay ảnh — ảnh là để dễ đọc, không bao giờ được chặn việc hỏi ý.
 */

import type { Candle } from "./strategy";

export interface ProposalMark {
  time: number;
  price: number;
  label: string;
}

export interface ProposalImageInput {
  candles: Candle[];
  dir: "long" | "short";
  title: string;
  subtitle: string;
  keyPrice: number | null;
  otherKeys: number[];
  box: { low: number; high: number; startTime: number; endTime: number } | null;
  entry: number;
  stop: number;
  target: number;
  partial: number | null;
  marks: ProposalMark[];
  /** Mốc nến tín hiệu (giờ MỞ). Vẽ vạch dọc + vùng dự phóng bên phải. */
  signalTime: number;
  footer: string[];
}

const W = 1200;
const H = 720;
const PAD_L = 16;
/** Cột phải: nhãn trục giá + thẻ VÀO/SL/TP, không đè lên nến. */
const PAD_R = 230;
const TOP = 92;
const BOTTOM = 112;
const FUTURE_BARS = 22;
const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";
const C = {
  bg: "#0d1117",
  grid: "#1f2630",
  axis: "#8b949e",
  text: "#e6edf3",
  up: "#26a69a",
  down: "#ef5350",
  key: "#f2c94c",
  keyFaint: "#5c5a3a",
  entry: "#58a6ff",
  stop: "#ff6b70",
  target: "#4ee2a1",
  box: "#a371f7",
};

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** BTC ~86.000 → 1 số lẻ; vàng ~4.180 → 2 số lẻ (bước giá 0,01). */
function fmt(n: number): string {
  const digits = Math.abs(n) >= 10_000 ? 1 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function ddmm(ms: number): string {
  return new Date(ms).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" });
}

export function buildProposalSvg(input: ProposalImageInput): string {
  const bars = input.candles;
  const n = bars.length;
  const tf = n > 1 ? bars[1].openTime - bars[0].openTime : 15 * 60_000;
  const plotW = W - PAD_L - PAD_R;
  const slot = plotW / (n + FUTURE_BARS);
  const xOf = (time: number) => PAD_L + ((time - bars[0].openTime) / tf + 0.5) * slot;

  const prices = [
    ...bars.flatMap((c) => [c.high, c.low]),
    input.entry, input.stop, input.target,
    ...(input.keyPrice != null ? [input.keyPrice] : []),
  ];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || hi * 0.001;
  lo -= pad;
  hi += pad;
  const plotH = H - TOP - BOTTOM;
  const yOf = (price: number) => TOP + ((hi - price) / (hi - lo)) * plotH;
  // Key phụ chỉ vẽ khi nằm trong khung giá, để không kéo giãn trục.
  const otherKeys = input.otherKeys.filter((p) => p > lo && p < hi && p !== input.keyPrice);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  // Lưới giá + nhãn trục phải.
  const step = niceStep((hi - lo) / 7);
  for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
    const y = yOf(p);
    out.push(`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`);
    out.push(`<text x="${W - PAD_R - 4}" y="${y - 4}" fill="${C.axis}" font-size="11" text-anchor="end">${fmt(p)}</text>`);
  }
  // Nhãn giờ mỗi 4 giờ.
  for (const c of bars) {
    if (Math.round(c.openTime / tf) % 16 !== 0) continue;
    const x = xOf(c.openTime);
    out.push(`<line x1="${x}" x2="${x}" y1="${TOP}" y2="${H - BOTTOM}" stroke="${C.grid}" stroke-width="1"/>`);
    const label = hhmm(c.openTime) === "00:00" ? ddmm(c.openTime) : hhmm(c.openTime);
    out.push(`<text x="${x}" y="${H - BOTTOM + 18}" fill="${C.axis}" font-size="12" text-anchor="middle">${label}</text>`);
  }

  const sigX = xOf(input.signalTime);
  const rightX = W - PAD_R;
  // Vùng rủi ro / lợi nhuận dự phóng từ nến tín hiệu sang phải.
  const zone = (a: number, b: number, color: string) =>
    `<rect x="${sigX}" y="${Math.min(yOf(a), yOf(b))}" width="${rightX - sigX}" height="${Math.abs(yOf(a) - yOf(b))}" fill="${color}" fill-opacity="0.12"/>`;
  out.push(zone(input.entry, input.stop, C.stop));
  out.push(zone(input.entry, input.target, C.target));

  if (input.box) {
    const x1 = xOf(input.box.startTime) - slot / 2;
    const x2 = Math.max(xOf(input.box.endTime) + slot / 2, x1 + 4);
    out.push(`<rect x="${x1}" y="${yOf(input.box.high)}" width="${x2 - x1}" height="${Math.max(2, yOf(input.box.low) - yOf(input.box.high))}" fill="${C.box}" fill-opacity="0.22" stroke="${C.box}" stroke-width="1.5"/>`);
    out.push(`<text x="${x1 - 6}" y="${(yOf(input.box.high) + yOf(input.box.low)) / 2 + 4}" fill="${C.box}" font-size="12" text-anchor="end">Order block</text>`);
  }

  for (const p of otherKeys) {
    out.push(`<line x1="${PAD_L}" x2="${rightX}" y1="${yOf(p)}" y2="${yOf(p)}" stroke="${C.keyFaint}" stroke-width="1" stroke-dasharray="6 4"/>`);
  }
  if (input.keyPrice != null) {
    const y = yOf(input.keyPrice);
    out.push(`<line x1="${PAD_L}" x2="${rightX}" y1="${y}" y2="${y}" stroke="${C.key}" stroke-width="2"/>`);
    out.push(`<text x="${PAD_L + 4}" y="${y - 6}" fill="${C.key}" font-size="13" font-weight="bold">KEY ${fmt(input.keyPrice)}</text>`);
  }

  // Nến.
  const bodyW = Math.max(2, slot * 0.62);
  for (const c of bars) {
    const x = xOf(c.openTime);
    const color = c.close >= c.open ? C.up : C.down;
    out.push(`<line x1="${x}" x2="${x}" y1="${yOf(c.high)}" y2="${yOf(c.low)}" stroke="${color}" stroke-width="1.2"/>`);
    const top = yOf(Math.max(c.open, c.close));
    const h = Math.max(1, Math.abs(yOf(c.open) - yOf(c.close)));
    out.push(`<rect x="${x - bodyW / 2}" y="${top}" width="${bodyW}" height="${h}" fill="${color}"/>`);
  }

  out.push(`<line x1="${sigX}" x2="${sigX}" y1="${TOP}" y2="${H - BOTTOM}" stroke="${C.axis}" stroke-width="1" stroke-dasharray="3 3"/>`);

  // Mức giá + nhãn bên phải.
  const risk = Math.abs(input.entry - input.stop);
  const rOf = (p: number) => (risk > 0 ? Math.abs(p - input.entry) / risk : 0);
  const levels: { price: number; color: string; label: string; dash?: string }[] = [
    { price: input.target, color: C.target, label: `TP ${fmt(input.target)} · ${rOf(input.target).toFixed(2)}R` },
    ...(input.partial != null ? [{ price: input.partial, color: C.target, label: `Chốt 33% ${fmt(input.partial)} · 1R`, dash: "4 4" }] : []),
    { price: input.entry, color: C.entry, label: `VÀO ${fmt(input.entry)}` },
    { price: input.stop, color: C.stop, label: `SL ${fmt(input.stop)}` },
  ];
  // Thẻ nhãn nằm ở cột phải, xếp theo giá từ trên xuống, đẩy nhau ra nếu sát.
  const tags = levels
    .map((lv) => ({ ...lv, y: yOf(lv.price) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < tags.length; k++) tags[k].y = Math.max(tags[k].y, tags[k - 1].y + 22);
  for (const lv of levels) {
    const y = yOf(lv.price);
    out.push(`<line x1="${sigX}" x2="${rightX}" y1="${y}" y2="${y}" stroke="${lv.color}" stroke-width="2"${lv.dash ? ` stroke-dasharray="${lv.dash}"` : ""}/>`);
  }
  for (const t of tags) {
    const y = yOf(t.price);
    out.push(`<line x1="${rightX}" x2="${rightX + 8}" y1="${y}" y2="${t.y}" stroke="${t.color}" stroke-width="1.5"/>`);
    out.push(`<rect x="${rightX + 8}" y="${t.y - 10}" width="${W - rightX - 14}" height="20" rx="4" fill="${t.color}" fill-opacity="0.16" stroke="${t.color}" stroke-width="1"/>`);
    out.push(`<text x="${rightX + 14}" y="${t.y + 5}" fill="${t.color}" font-size="13" font-weight="bold">${esc(t.label)}</text>`);
  }

  for (const m of input.marks) {
    const x = xOf(m.time);
    const above = input.dir === "short" ? m.price >= input.entry : m.price > input.entry;
    const y = yOf(m.price) + (above ? -10 : 18);
    out.push(`<circle cx="${x}" cy="${yOf(m.price)}" r="4" fill="${C.text}"/>`);
    out.push(`<text x="${x}" y="${y}" fill="${C.text}" font-size="12" text-anchor="middle">${esc(m.label)}</text>`);
  }

  // Tiêu đề + chân.
  const dirColor = input.dir === "long" ? C.up : C.down;
  out.push(`<rect x="0" y="0" width="${W}" height="${TOP - 18}" fill="#161b22"/>`);
  out.push(`<text x="20" y="34" fill="${dirColor}" font-size="24" font-weight="bold">${esc(input.title)}</text>`);
  out.push(`<text x="20" y="60" fill="${C.axis}" font-size="15">${esc(input.subtitle)}</text>`);
  out.push(`<rect x="0" y="${H - BOTTOM + 30}" width="${W}" height="${BOTTOM - 30}" fill="#161b22"/>`);
  input.footer.slice(0, 3).forEach((line, k) => {
    out.push(`<text x="20" y="${H - BOTTOM + 56 + k * 22}" fill="${C.text}" font-size="15">${esc(line)}</text>`);
  });
  out.push("</svg>");
  return out.join("\n");
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

/** SVG → PNG. Null nếu không có resvg (bot vẫn hỏi ý bằng chữ). */
export function renderPng(svg: string): Buffer | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resvg } = require("@resvg/resvg-js") as typeof import("@resvg/resvg-js");
    return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render().asPng();
  } catch (err) {
    console.error("[FX Dream] không vẽ được ảnh:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
