# Native small-cap research implementation

## Status and isolation

Research-only. The implementation is deliberately separate from SMC, Turtle, Fast Trend, Alt Trend,
`btc-alert-bot.ts` and every exchange execution adapter. It cannot place or cancel an order.

The default market-cap range is an explicit working assumption: USD 25 million to USD 5 billion.
Market cap only defines the point-in-time universe; it is not an entry signal.

## Engines

### `smallcap-reversal.ts`

At a completed daily timestamp, the engine:

1. requires at least 365 daily observations and a point-in-time tradability snapshot;
2. rejects stable/wrapped/inactive/event-risk assets, daily moves of 20% or more, excessive volume
   shock, spread over 20 bps, insufficient depth and insufficient quote volume;
3. computes previous-day return minus the cross-sectional median return;
4. computes log-volume shock against the preceding 30 observations, excluding the signal day;
5. keeps the lowest third by volume shock;
6. longs the largest residual losers and shorts the largest residual winners with dollar-neutral weights.

`quotePassiveOrder` only creates an offline post-only intent at best bid/ask. The conservative fill model
does not count a touch as a fill: an aggregate trade of the correct aggressor side must trade strictly
through the limit before expiry. This is deliberately pessimistic because OHLCV cannot reconstruct queue
position.

### `smallcap-supply.ts`

At a weekly point-in-time snapshot, the engine ranks young tokens by five equal-weight percentile
components:

- FDV premium over market cap;
- circulating-supply growth over 12 weeks;
- next-30-day unlock as a fraction of circulating supply;
- exchange net inflow as a fraction of circulating supply;
- inverse 12-week usage growth.

It longs the lowest-pressure tokens with positive usage growth and shorts the highest-pressure tokens
that were actually shortable at the snapshot. Defaults restrict listing age to 84–365 days.

## Offline runner

```bash
npm run research:smallcap-native -- path/to/point-in-time-periods.json
```

The JSON accepts `reversalPeriods` and `supplyPeriods`. Each period contains the exact observations
known at that time and may include `forwardReturns` for evaluation. Reversal evaluation is fail-closed:
without a book and qualifying aggregate trade, the symbol is unfilled. The runner makes no network call.

Provider-specific market-cap, supply, unlock and on-chain collectors are intentionally not fabricated.
Historical snapshots from a provider must preserve publication/observation timestamps; using today's
FDV, circulating supply, shortability or survivor list for past periods would introduce look-ahead.

## Verification

```bash
npm run test:smallcap-native
./node_modules/.bin/tsc --noEmit --strict --esModuleInterop --target ES2022 \
  --module CommonJS --moduleResolution node --skipLibCheck \
  smallcap-research.ts smallcap-reversal.ts smallcap-supply.ts \
  test-smallcap-native.ts scripts/smallcap-native-research.ts
```

Before any shadow promotion, require point-in-time dead/delisted assets, actual funding/borrow, a queue
and latency model, three forward eras, 2x cost stress, block bootstrap and leave-one-coin-out analysis.
