# Alt Trend — implementation boundary and research protocol

## Status

Research-only. `alt-trend.ts` is not imported by `btc-alert-bot.ts`, `turtle.ts`, `strategy.ts`, or any
live execution class. It cannot place an order and does not change the existing SMC/Turtle/Fast rules.

The first implementation is deliberately narrow:

- daily, long-only dual momentum;
- BTC SMA 10d/100d regime gate;
- coin close above SMA100 and positive 28-day return;
- candidates ranked by 28-day return;
- median 30-day quote-volume capacity gate;
- entry at the next daily open;
- initial/trailing stop at 3 ATR, 20-day channel/trend/time exits;
- at most four concurrent positions, no pyramiding;
- conservative perpetual funding drag and configurable per-side cost;
- 10% delisting haircut when a held symbol stops printing candles.

These are pre-registered research defaults, not a claim that the parameters are optimal.

## Current-universe scanner

```bash
npm run scan:alt-universe -- 100 80
npm run scan:alt-universe -- 100 80 --save
```

Arguments are planned notional USD and maximum symbols inspected. The scanner uses current Binance
USDⓈ-M `exchangeInfo`, 24h quote volume, best bid/ask, depth within ±20 bps, current open interest and
ADL risk. A symbol passes when it has at least 180 days of age, spread ≤10 bps, 24h quote volume
≥20,000× planned notional, two-sided depth ≥50× notional, OI ≥1,000× notional and ADL risk is not high.

`--save` writes a dated snapshot under `.cache/alt-trend/universe/`. This creates forward point-in-time
data. A current snapshot must not be used as if it represented the historical universe.

## Backtest

There is intentionally no default symbol list:

```bash
npm run backtest:alt-trend -- 1200 coin1usdt,coin2usdt,coin3usdt 100
```

Arguments are evaluation days, explicit universe and planned notional USD. The report always runs
10/25/50/100 bps cost per side, 28-day block bootstrap, three eras, per-symbol results and a run with
the best coin removed.

Historical OHLCV can enforce listing age and trailing quote-volume without lookahead. It cannot
reconstruct historical spread, order-book depth, OI, delist announcements, ADL risk or all symbols that
were tradable at each past date. Consequently, a run using today's survivors is diagnostic only.

### First diagnostic result — 2026-08-02

A frozen first run used 20 current scanner survivors over 1,200 evaluation days. No parameter was
changed after seeing the result:

- 211 trades;
- base 25 bps/side: `+8.1R`, expectancy `+0.038R/trade`;
- 50 bps/side: `+3.3R`; 100 bps/side: `-6.3R`;
- three eras: `+11.5R / -7.4R / +4.0R`;
- 28-day block-bootstrap CI90 `[-25.4R, +45.2R]`, `P(NET>0)=63.5%`;
- removing the best coin reduced the base result to `+0.8R`.

Verdict: the engine and cost gate work, but this candidate **fails the promotion gate**. It remains a
data-collection/research module and must not be connected to shadow or live execution.

## Promotion gate

Do not connect the module to live trading unless all conditions hold:

1. point-in-time snapshots have accumulated for at least six months;
2. at least 30 closed shadow positions exist;
3. base and 2× modeled cost remain net positive;
4. all three forward eras are non-negative;
5. 28-day block bootstrap gives `P(NET>0) >= 90%`;
6. actual spread, fill slippage and funding do not exceed the modeled cost;
7. a separate canary review approves a live execution path with capped marketable-limit orders.

## Verification

```bash
npm run test:alt-trend
./node_modules/.bin/tsc --noEmit --strict --esModuleInterop --target ES2022 \
  --module CommonJS --moduleResolution node --skipLibCheck \
  alt-trend.ts test-alt-trend.ts scripts/alt-universe-scanner.ts scripts/alt-trend-backtest.ts
```

The repository-wide TypeScript check currently has unrelated pre-existing Next/React type errors in
`app/`; the isolated command above verifies every Alt Trend file under strict mode.
