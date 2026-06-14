/**
 * Load .env then .env.local (local overrides). Supports TELEGRAM_* in either file.
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const root = process.cwd();

function loadFile(name: string, override: boolean): void {
  const p = path.join(root, name);
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override });
  }
}

loadFile(".env", false);
loadFile(".env.local", true);

export {};
