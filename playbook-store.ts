import fs from "fs";
import path from "path";

export type PlaybookDocument = {
  version: 1;
  symbol: string;
  updatedAt: string;
  sampleOrders: Record<string, unknown>[];
  userFeedback: Record<string, unknown>[];
  /** Nhãn người dùng chấm cho từng Key Volume do detector sinh ra. */
  keyVerdicts: Record<string, unknown>[];
};

type LegacyPlaybookDocument = Partial<PlaybookDocument> & {
  botFeedback?: unknown;
};

const PLAYBOOK_DIR = path.resolve(
  process.env.CHART_PLAYBOOK_DIR?.trim() || path.join(process.cwd(), "trading-runtime", "chart-playbook"),
);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function normalizeSymbol(value: unknown): string {
  const symbol = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+usdt$/.test(symbol) && symbol !== "xauusd") throw new Error("Symbol playbook không hợp lệ");
  return symbol;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").slice(0, 10_000)
    : [];
}

export function playbookFilePath(symbol: string): string {
  return path.join(PLAYBOOK_DIR, `${normalizeSymbol(symbol)}.json`);
}

export async function loadPlaybookDocument(symbolValue: unknown): Promise<PlaybookDocument> {
  const symbol = normalizeSymbol(symbolValue);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(playbookFilePath(symbol), "utf8")) as LegacyPlaybookDocument;
    return {
      version: 1,
      symbol: symbol.toUpperCase(),
      updatedAt: String(parsed.updatedAt || ""),
      sampleOrders: records(parsed.sampleOrders),
      userFeedback: records(parsed.userFeedback ?? parsed.botFeedback),
      keyVerdicts: records(parsed.keyVerdicts),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, symbol: symbol.toUpperCase(), updatedAt: "", sampleOrders: [], userFeedback: [], keyVerdicts: [] };
  }
}

export async function savePlaybookDocument(value: unknown): Promise<{ document: PlaybookDocument; file: string }> {
  if (!value || typeof value !== "object") throw new Error("Playbook JSON không hợp lệ");
  const input = value as LegacyPlaybookDocument;
  const symbol = normalizeSymbol(input.symbol);
  const document: PlaybookDocument = {
    version: 1,
    symbol: symbol.toUpperCase(),
    updatedAt: new Date().toISOString(),
    sampleOrders: records(input.sampleOrders),
    userFeedback: records(input.userFeedback ?? input.botFeedback),
    keyVerdicts: records(input.keyVerdicts),
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("Playbook JSON vượt quá 5 MB");

  const target = playbookFilePath(symbol);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(temporary, serialized, "utf8");
  await fs.promises.rename(temporary, target);
  return {
    document,
    file: path.relative(process.cwd(), target),
  };
}
