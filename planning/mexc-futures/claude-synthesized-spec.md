# MEXC Futures Integration — Synthesized Specification

## Objective

Add a second, isolated Futures execution path so the active strategies can trade the same canonical
coin without blocking each other:

```text
Turtle Hybrid -> Binance USD-M account
Fast Trend    -> MEXC USDT-M account
SMC           -> disabled
```

Routing is static. No order, retry, exit or reconciliation operation may cross venues.

## Functional Requirements

### FR-1: Preserve strategy semantics

- Fast Trend continues to consume explicitly identified Binance Futures 4h candles in release 1.
- A Binance spot fallback must not create a real Fast entry.
- Signal state and MEXC execution state are represented separately.
- Convert the signal entry-to-stop distance to a risk fraction and re-anchor it to the confirmed
  MEXC fill; preserve long/short direction and R geometry.
- Preserve the existing entry, pyramiding, trailing, time-exit and maximum-unit rules. During the
  first canary, a rollout gate limits the sleeve to one unit; this is not a strategy-code change.

### FR-2: Execute with MEXC-native semantics

- Sign current official MEXC private REST requests exactly as documented.
- Maintain server-time offset and independent query/mutation rate limiters.
- Discover and cache per-contract metadata, but invalidate it on readiness failures and refresh it
  periodically.
- Size from MEXC equity and the actual stop distance. Convert base quantity to integer/stepped MEXC
  contracts using `contractSize` and `volUnit`; reject a minimum contract that exceeds risk budget.
- Confirm fills by order/fill/position query. The create response alone is insufficient.
- Use one-way position mode and reduce-only exits on a dedicated MEXC account.
- Place a native position-bound stop-market after fill, verify it covers the actual position volume,
  and modify it in place for trailing/add-unit changes.

### FR-3: Make every regular-order mutation recoverable

- Persist an operation intent before sending a write request.
- Derive a deterministic `externalOid` (at most 32 characters) from venue, strategy, symbol, closed
  signal candle, action and unit/attempt generation.
- On timeout, connection loss or 5xx, query by `externalOid` and reconcile position/fills before any
  resend.
- Never blind-retry order creation. Before retrying TP/SL writes—which have no client-supplied ID—
  reconcile the current TP/SL order list.

### FR-4: Recover safely after partial failure or restart

- Exchange state is authoritative; the local journal records ownership and intent.
- Fast must persist `pendingEntry`, `pendingAdd`, `pendingStop` and `pendingExit` until exchange state
  proves the outcome.
- A failed exit may not clear local position state.
- A failed stop update may not advance the confirmed local stop.
- An add fill must be persisted/reconciled before protection resize, even if the latter fails.
- Unknown positions/orders quarantine only the affected MEXC symbol. They are not adopted, canceled
  or flattened without proven ownership.
- On startup and reconnect, reconcile MEXC orders, fills, positions and stops before permitting new
  entries.

### FR-5: Isolate health, risk and ownership

- Binance readiness controls Turtle entries only; MEXC readiness controls Fast entries only.
- Market-data health controls generation of new Fast signals, not management of open MEXC exposure.
- Each exchange uses its own equity and maximum portfolio-risk cap.
- Same canonical symbol on different exchanges is allowed. Collision checks remain within the same
  venue/account/symbol owner domain.
- Health output and alerts expose venue, strategy, authenticated connectivity, position mode,
  readiness/circuit-breaker state, last reconciliation, unprotected exposure and pending operation.

## State and Audit Schema

Create a new MEXC Fast state and append-only journal, separate from legacy Binance Fast state. State
must include:

```text
schemaVersion
venue = "mexc"
accountFingerprint                 # non-secret, stable identifier
canonicalSymbol / venueSymbol
strategy side, entry, SL, ATR, units and candle times
actual positionId, contractSize, contracts, average fill and confirmed stop
owned externalOid/order/fill/stop IDs
desiredStop / confirmedStop
pending operation and mutation generation
last successful reconciliation time
real = explicit boolean
```

State writes use temp file + fsync/close + atomic rename. The journal includes planned and actual
prices, basis, slippage, risk USD, contracts, fees, funding, IDs and reconciliation outcome, while
never logging secrets/signatures.

## Configuration

MEXC defaults are fail-closed and independent of existing Binance `TRADING_ENABLED`:

```text
MEXC_ENABLED=false
MEXC_TRADING_ENABLED=false
MEXC_API_KEY=
MEXC_API_SECRET=
MEXC_BASE_URL=https://api.mexc.com
MEXC_FAST_RISK_PCT=0.001
MEXC_MAX_PORTFOLIO_RISK_PCT=0.10
MEXC_LEVERAGE=<existing low leverage, clamped to contract/account limits>
MEXC_MARGIN_TYPE=isolated
MEXC_CANARY_SYMBOLS=BTCUSDT
MEXC_MAX_BASIS_PCT=0.003
```

The implementation may normalize canonical `BTCUSDT` to MEXC `BTC_USDT` internally. Secrets are
provided only through runtime environment/secret storage and are never committed.

## Preflight Gates

`MEXC_TRADING_ENABLED=true` still may not authorize writes until all gates pass:

1. Authenticated ping/time, asset, position-mode, fee and contract queries succeed.
2. Account is one-way mode and has no unknown position, open order, plan order or TP/SL order.
3. Every enabled symbol is active, API-allowed, USDT-quoted, non-Innovation, and supports selected
   margin/leverage.
4. Metadata/risk calculator produces valid price and contract volume without exceeding risk budget.
5. Local state schema and account fingerprint match; no unresolved legacy Binance Fast position is
   present.
6. Fake-venue failure tests, shadow mode and authenticated read-only reconciliation pass.
7. Mainnet canary is separately approved.

## Rollout Requirements

1. **Code safety baseline:** repair Fast pending-exit, stop rollback and add-unit durability on the
   current path; prove Fast signal output unchanged.
2. **Read-only:** contract discovery, fees, account mode, assets and empty-state reconciliation.
3. **Shadow:** emit complete planned MEXC operations for all Fast signals, with no signed write call.
   Measure basis, rounding, expected/actual fee model, funding and rejection reasons.
4. **Mainnet canary (explicit approval):** BTC_USDT, one unit, 0.10% risk, minimum valid volume,
   no pyramiding. Drill restart and ambiguous-response recovery.
5. **Controlled expansion:** enable pyramiding, then symbols one at a time. Do not automatically
   raise risk to 0.50%; that is a separate evidence-based decision.

## Acceptance Criteria

- Turtle baseline/signals and Binance execution behavior remain unchanged by the MEXC-disabled build.
- Fast emits the same signal sequence for identical Binance Futures candles.
- Same symbol can be owned concurrently by Turtle/Binance and Fast/MEXC without blocking or
  cross-canceling.
- A duplicated process/candle event produces one MEXC order intent and no duplicate position.
- Every injected ambiguous order outcome resolves by query/reconcile without a blind repeat.
- A filled entry is either visibly protected or is closed and quarantined; no test ends with an
  unowned/unprotected position.
- Exit failure leaves a durable pending exit. Stop-sync failure preserves the last confirmed stop.
- Restart reconstructs owned order/position/protection from exchange plus journal and blocks unknowns.
- Contract sizing fixtures pass for every enabled symbol and never exceed risk after rounding.
- MEXC outage does not disable Turtle/Binance management; Binance private outage does not disable
  existing MEXC management. Binance signal-data outage blocks new Fast entries only.
- Shadow and canary reports include fees, funding, basis and slippage sufficient to recompute net R.

## Non-Goals

- Dynamic routing, failover, cross-exchange hedging, arbitrage or balance transfer.
- Re-enabling SMC.
- Retuning Fast Trend or switching its signal feed to MEXC candles.
- Account-wide automated `close_all` in normal bot behavior.
- Automatically increasing risk after a fixed date/order count.
