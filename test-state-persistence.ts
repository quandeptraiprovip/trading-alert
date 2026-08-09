import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-state-"));
process.env.TRADING_DATA_DIR = dataDir;

try {
  const { loadState, saveState } = require("./live-state") as typeof import("./live-state");
  const snapshot = [{
    symbol: "btcusdt",
    lastOpenTime: 1_700_000_000_000,
    cooldownUntilTime: 0,
    livePos: null,
  }];
  saveState(snapshot);

  const target = path.join(dataDir, "bot-state.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), snapshot);
  assert.equal(fs.existsSync(`${target}.tmp`), false, "atomic rename phải dọn file tạm sau khi thành công");
  assert.deepEqual(loadState(), { btcusdt: snapshot[0] });
  console.log("SMC atomic state/data-directory tests: OK");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
