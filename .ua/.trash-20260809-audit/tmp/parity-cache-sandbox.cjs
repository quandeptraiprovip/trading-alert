const fs = require("fs");
const path = require("path");

Date.now = () => 1785934800000;

const originalMkdtempSync = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = (prefix, options) => {
  const dir = originalMkdtempSync(prefix, options);
  if (String(prefix).includes("turtle-parity-")) {
    const cacheRoot = path.join(dir, ".cache");
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.symlinkSync("/Users/quanton/Desktop/alert/.cache/klines", path.join(cacheRoot, "klines"), "dir");
  }
  return dir;
};
