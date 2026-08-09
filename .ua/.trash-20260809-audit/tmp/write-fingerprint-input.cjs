const fs = require("fs");
const projectRoot = process.argv[2];
const scanPath = process.argv[3];
const outputPath = process.argv[4];
const gitCommitHash = process.argv[5];
const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
fs.writeFileSync(outputPath, JSON.stringify({
  projectRoot,
  sourceFilePaths: scan.files.map((file) => file.path),
  gitCommitHash,
}, null, 2));
