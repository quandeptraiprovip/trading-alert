export const DEFAULT_FXDREAM_SYMBOLS = [
  "btcusdt",
  "xauusdt",
] as const;

function parseSymbols(value: string): string[] {
  return [...new Set(value.split(",").map((symbol) => symbol.trim().toLowerCase()).filter(Boolean))];
}

export function getBotUniverse(env: NodeJS.ProcessEnv = process.env): {
  turtle: string[];
  fast: string[];
  all: string[];
} {
  const fxdream = parseSymbols(env.FXDREAM_SYMBOLS ?? DEFAULT_FXDREAM_SYMBOLS.join(","));
  return { turtle: [], fast: [], all: fxdream };
}
