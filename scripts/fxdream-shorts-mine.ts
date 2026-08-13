/**
 * fxdream-shorts-mine.ts — bóc luật phương pháp từ phụ đề tự động của các YouTube Short
 * kênh @fxdreamtrading.
 *
 * VÌ SAO CẦN: các vòng trước chỉ bóc video DÀI (#10, #11, #22, #23, #28, #31, #50). Corpus Short
 * (399 video) chưa từng được khai thác, trong khi câu hỏi còn mở nhất — "cái gì làm một cây volume
 * trở thành KEY" — chính là thứ tác giả hay nói trong clip ngắn khi chỉ vào biểu đồ.
 *
 * Phụ đề là bản DỊCH MÁY tự động từ tiếng Việt sang tiếng Anh, nên rất nhiễu (vd "volume tree" =
 * "cây volume"). Vì vậy công cụ này chỉ ĐỊNH VỊ đoạn cần đọc, không tự kết luận: nó gom cụm từ khoá
 * theo chủ đề rồi in ngữ cảnh để người đọc tự thẩm định.
 *
 * Run: ./node_modules/.bin/ts-node scripts/fxdream-shorts-mine.ts <thư mục subs> [chủ đề|all]
 */
import fs from "fs";
import path from "path";

/**
 * VTT phụ đề tự động lăn từng dòng nên mỗi câu xuất hiện nhiều lần kèm thẻ thời gian trong dòng.
 * Hàm này bỏ thẻ, bỏ trùng lặp liên tiếp và trả về văn bản liền mạch.
 */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line)) continue;
    const clean = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
      .replace(/<\/?c[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) continue;
    if (out.length && out[out.length - 1] === clean) continue;
    // dòng lăn: câu mới thường CHỨA câu cũ làm tiền tố
    if (out.length && clean.startsWith(out[out.length - 1])) out[out.length - 1] = clean;
    else out.push(clean);
  }
  // gộp lại rồi bỏ trùng lặp cụm 6 từ liên tiếp (di chứng của caption lăn)
  const words = out.join(" ").split(" ");
  const dedup: string[] = [];
  for (const w of words) {
    dedup.push(w);
    if (dedup.length >= 12) {
      const a = dedup.slice(-12, -6).join(" ");
      const b = dedup.slice(-6).join(" ");
      if (a === b) dedup.splice(-6);
    }
  }
  return dedup.join(" ");
}

/** Cụm từ khoá theo chủ đề — thuật ngữ bản dịch máy hay dùng, gồm cả biến thể sai. */
const TOPICS: Record<string, string[]> = {
  key: ["key", "keyvol", "key level", "important level", "support", "resistance", "zone"],
  volume: ["volume", "vol tree", "volume tree", "volume candle", "big volume", "large volume", "spike"],
  entry: ["entry", "enter", "order block", "ob ", "ftr", "breaker", "sfp", "quasimodo", "pattern", "engulf"],
  stop: ["stop", "sl ", "stop loss", "risk"],
  target: ["target", "tp ", "take profit", "rr", "r:r", "reward"],
  timeframe: ["m5", "m15", "h1", "h4", "d1", "daily", "weekly", "w1", "timeframe", "frame"],
  filter: ["confluence", "confirm", "wait", "only", "avoid", "not enter", "don't", "skip"],
  liquidity: ["liquidity", "sweep", "trap", "stop hunt", "hunt", "fake", "break out", "breakout"],
};

function main() {
  const dir = process.argv[2];
  const topic = (process.argv[3] ?? "all").toLowerCase();
  if (!dir || !fs.existsSync(dir)) {
    console.error("Thiếu thư mục subs. Ví dụ: ts-node scripts/fxdream-shorts-mine.ts /tmp/subs key");
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".vtt"));
  const docs = files.map((f) => ({
    id: f.replace(/\.(en|vi)\.vtt$/, ""),
    text: vttToText(fs.readFileSync(path.join(dir, f), "utf8")),
  })).filter((d) => d.text.length > 40);

  const totalWords = docs.reduce((s, d) => s + d.text.split(" ").length, 0);
  console.log(`${docs.length} short có phụ đề · ${totalWords.toLocaleString("vi-VN")} từ · TB ${Math.round(totalWords / docs.length)} từ/clip\n`);

  if (topic === "stats") {
    console.log("Tần suất cụm từ khoá theo chủ đề (số clip có chứa):");
    for (const [name, keys] of Object.entries(TOPICS)) {
      const n = docs.filter((d) => keys.some((k) => d.text.toLowerCase().includes(k))).length;
      console.log(`  ${name.padEnd(11)} ${String(n).padStart(4)} clip (${((n / docs.length) * 100).toFixed(0)}%)`);
    }
    return;
  }

  const keys = TOPICS[topic] ?? [topic];
  let hits = 0;
  for (const d of docs) {
    const lower = d.text.toLowerCase();
    const idx: number[] = [];
    for (const k of keys) {
      let p = lower.indexOf(k);
      while (p >= 0 && idx.length < 4) { idx.push(p); p = lower.indexOf(k, p + k.length); }
    }
    if (!idx.length) continue;
    hits++;
    const seen = new Set<string>();
    const frags = idx.sort((a, b) => a - b).map((p) => d.text.slice(Math.max(0, p - 140), p + 200).trim())
      .filter((f) => { const k = f.slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; });
    console.log(`\n── ${d.id} ──`);
    for (const f of frags.slice(0, 2)) console.log(`  …${f}…`);
  }
  console.log(`\n${hits}/${docs.length} clip khớp chủ đề "${topic}".`);
}

if (require.main === module && /fxdream-shorts-mine\.(ts|js)$/.test(process.argv[1] ?? "")) main();
