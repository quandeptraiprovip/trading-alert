export const DEFAULT_TURTLE_SYMBOLS = [
  "btcusdt",
  "ethusdt",
  "solusdt",
  "xrpusdt",
  "dogeusdt",
  "adausdt",
  "avaxusdt",
  "dotusdt",
] as const;

function parseSymbols(value: string): string[] {
  return [...new Set(value.split(",").map((symbol) => symbol.trim().toLowerCase()).filter(Boolean))];
}

export function getBotUniverse(env: NodeJS.ProcessEnv = process.env): {
  turtle: string[];
  fast: string[];
  all: string[];
} {
  const turtle = parseSymbols(env.TURTLE_SYMBOLS ?? DEFAULT_TURTLE_SYMBOLS.join(","));
  const fast = parseSymbols(env.FAST_TREND_SYMBOLS ?? turtle.join(","));
  return { turtle, fast, all: [...new Set([...turtle, ...fast])] };
}
