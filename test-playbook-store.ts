import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-playbook-"));
process.env.CHART_PLAYBOOK_DIR = dataDir;

async function main(): Promise<void> {
  const { loadPlaybookDocument, playbookFilePath, savePlaybookDocument } = require("./playbook-store") as typeof import("./playbook-store");
  const saved = await savePlaybookDocument({
    symbol: "BTCUSDT",
    sampleOrders: [{
      id: "sample-1",
      entryTime: 1_786_579_200_000,
      startTime: 1_786_579_200_000,
      endTime: 1_786_582_800_000,
      entry: 100,
      sl: 99,
      tp: 102,
      drawings: [{ id: "zone-1", type: "rectangle", purpose: "reaction-entry-zone" }],
    }],
    userFeedback: [{ tradeId: "turtle-1", verdict: "approved", note: "Đúng breakout" }],
  });
  assert.equal(saved.document.symbol, "BTCUSDT");
  assert.equal(saved.document.sampleOrders.length, 1);
  assert.ok(fs.existsSync(playbookFilePath("btcusdt")));
  const loaded = await loadPlaybookDocument("btcusdt");
  assert.equal(loaded.sampleOrders[0].entryTime, 1_786_579_200_000);
  assert.equal(loaded.sampleOrders[0].startTime, 1_786_579_200_000);
  assert.equal(loaded.sampleOrders[0].endTime, 1_786_582_800_000);
  assert.equal((loaded.sampleOrders[0].drawings as Record<string, unknown>[])[0].type, "rectangle");
  assert.equal((loaded.sampleOrders[0].drawings as Record<string, unknown>[])[0].purpose, "reaction-entry-zone");
  assert.equal(loaded.userFeedback[0].note, "Đúng breakout");
  fs.writeFileSync(playbookFilePath("ethusdt"), JSON.stringify({
    version: 1,
    symbol: "ETHUSDT",
    botFeedback: [{ tradeId: "fast-1", verdict: "review", note: "Dữ liệu cũ" }],
  }));
  const migrated = await loadPlaybookDocument("ethusdt");
  assert.equal(migrated.userFeedback[0].note, "Dữ liệu cũ");
  const gold = await savePlaybookDocument({
    symbol: "XAUUSD",
    sampleOrders: [{ id: "gold-plan", entry: 2_000, sl: 1_990, tp: 2_020 }],
    userFeedback: [],
  });
  assert.equal(gold.document.symbol, "XAUUSD");
  assert.ok(fs.existsSync(playbookFilePath("xauusd")));
  await assert.rejects(savePlaybookDocument({ symbol: "../../etc", sampleOrders: [] }), /không hợp lệ/);
  console.log(`Playbook JSON tests: OK (${saved.file})`);
}

main().finally(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
