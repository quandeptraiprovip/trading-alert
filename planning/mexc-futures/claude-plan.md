# Implementation Plan: Route Fast Trend to MEXC Futures

**Status:** Proposed; no live-trading code or configuration is changed by this plan.  
**Primary outcome:** Turtle Hybrid remains on Binance and Fast Trend runs on a dedicated MEXC
Futures account, allowing both strategies to hold the same coin without cross-strategy blocking.

## 1. Decisions and Constraints

### Static routing

```text
Binance Futures account                           MEXC Futures account
┌─────────────────────────┐                       ┌─────────────────────────┐
│ Turtle Hybrid           │                       │ Fast Trend              │
│ Binance market/execution│                       │ Binance signal candles  │
│ Binance equity/risk     │                       │ MEXC execution/equity   │
└─────────────────────────┘                       └─────────────────────────┘
             independent readiness, state, risk and reconciliation
```

- Same canonical symbol on the two venues is valid and intentional.
- No automatic exchange failover. An ambiguous MEXC order must be resolved on MEXC, never resent to
  Binance.
- SMC remains disabled.
- Release 1 retains Binance Futures 4h candles for Fast signals. MEXC candles would constitute a
  strategy change and need a separate backtest.
- No mainnet write request is authorized by implementing this plan. Enabling the canary is a later,
  explicit user action.

### Chosen architecture

Add a narrow high-level Fast execution boundary and a MEXC-specific adapter/executor. Do not refactor
the already-live Turtle/Binance path into a universal exchange framework in the same release.

```text
FastTrendLive
    │ risk intent, signal geometry, lifecycle event
    ▼
FastExecution interface
    ├── BinanceFastExecution (compatibility + regression baseline)
    └── MexcFastExecution
            └── MexcFutures REST adapter
```

The interface exposes strategy operations (`openInitial`, `addUnit`, `syncProtection`, `requestExit`,
`reconcile`), not Binance-shaped primitives. This keeps MEXC contract volume and position-bound stop
semantics out of the strategy and limits changes to Turtle.

## 2. Phase 0 — Freeze Baseline and Audit Existing Exposure

### Changes

1. Add a deterministic snapshot/test harness around current Fast signal generation using fixed
   Binance Futures candle fixtures. Capture entries, adds, trailing changes and exits.
2. Add a read-only operational audit that reports:
   - current Fast local state and whether `real`/venue ownership is knowable;
   - Binance positions/orders that could belong to legacy Fast;
   - MEXC positions, regular orders, plan orders and TP/SL orders;
   - mismatches and unknown ownership, without mutating either exchange.
3. Document the cutover condition: legacy Binance Fast must be flat and have no unresolved pending
   operation before MEXC write mode can be enabled. Keep its existing state/journal for audit and use
   new MEXC files.

### Files

- Add tests/fixtures under the project's new test directory.
- Add a read-only script such as `scripts/audit-fast-venue-cutover.ts`.
- Do not modify `.env.local` or live enablement flags.

### Verification gate

- Baseline fixture is reproducible in CI/local execution.
- The audit cannot call create/cancel/modify/close endpoints by construction.
- Any current unknown/real Binance Fast position blocks later cutover rather than being inferred from
  `fast-trend-state.json`.

## 3. Phase 1 — Repair Fast Trend State Safety

Do this while the current Binance executor is still available so behavior can be compared before and
after the refactor.

### Changes in `fast-trend-live.ts`

1. Add durable pending lifecycle states:
   - `pendingEntry` before entry submission;
   - `pendingAdd` before add submission;
   - `pendingStop` while protection is unconfirmed;
   - `pendingExit` until position closure is exchange-confirmed.
2. Never clear `st.pos` after a failed/unknown exit. Mirror Turtle's confirmed-exit behavior.
3. Track `desiredSl` separately from `confirmedVenueSl`. On stop-sync failure, retain the confirmed
   stop and retry/reconcile instead of publishing the desired price as active.
4. On an add fill, persist the exchange-confirmed size/fill before resizing protection. A protection
   error leaves a recoverable pending state and blocks new exposure.
5. Replace direction-only startup adoption with ownership-aware reconciliation. An unknown position
   quarantines its symbol.
6. Make state persistence atomic: write a temporary file in the same directory, fsync/close, rename.
   Invalid/corrupt state must fail closed and preserve the original for diagnosis.

### Journal/schema

Introduce a versioned internal schema and operation record containing action, symbol, closed candle,
unit generation, desired outcome, venue result and confirmation state. Do not migrate the legacy file
to MEXC automatically.

### Tests

- flatten throws or times out -> position remains with `pendingExit`;
- stop modification fails -> confirmed stop stays unchanged;
- add fills and stop resize fails -> added volume is recoverable and no second add is allowed;
- process restarts after each persistence boundary -> one lifecycle action, correct state;
- corrupt/interrupted write -> no clean-state adoption or automated flatten;
- current fixed-candle Fast signal sequence remains identical.

### Gate

No MEXC write implementation begins until the above tests pass. Turtle files and behavior remain
unchanged in this phase.

## 4. Phase 2 — Introduce the Fast Execution Boundary

### New contract

Add `fast-execution.ts` with normalized request/result types. Suggested operations:

```ts
interface FastExecution {
  preflight(symbols: string[]): Promise<VenueReadiness>;
  planInitial(intent: RiskIntent): Promise<ExecutionPlan>;
  openInitial(plan: ExecutionPlan, operationId: string): Promise<ConfirmedPosition>;
  addUnit(intent: AddIntent, operationId: string): Promise<ConfirmedPosition>;
  syncProtection(intent: ProtectionIntent): Promise<ConfirmedProtection>;
  requestExit(intent: ExitIntent, operationId: string): Promise<ExitOutcome>;
  reconcile(symbol: string, ownership: OwnershipRecord): Promise<ReconcileOutcome>;
}
```

Types must distinguish:

- canonical symbol from venue symbol;
- strategy signal price/stop from venue fill/protection price;
- desired contracts/quantity from confirmed position size;
- desired operation from confirmed exchange outcome;
- owned, absent, ambiguous and unknown exchange objects.

### Compatibility implementation

Create `binance-fast-execution.ts` as a thin wrapper over current Binance/LiveTrader behavior and move
Fast's direct add-unit sizing/order path behind it. Supply deterministic client IDs to Binance calls
as a regression exercise. Do not route Turtle through this wrapper.

### Composition

Change `FastTrendLive` to depend only on `FastExecution` and a separately injected signal-data health
provider. Keep strategy calculations in `FastTrendLive`; keep rounding, equity, fills and protection
inside execution implementations.

### Tests and gate

- Fake implementation drives entry/add/stop/exit/reconcile success and every ambiguous outcome.
- Binance compatibility adapter matches baseline order intents and Fast signals.
- Two invocations of the same symbol/candle/action produce the same operation ID and one order.
- Existing Turtle baseline and live composition remain unchanged.

## 5. Phase 3 — Build the MEXC Read-Only Adapter

### New file: `mexc-futures.ts`

Implement current official MEXC REST primitives with typed request/response validation:

1. Public server time and contract metadata.
2. Private assets/USDT equity and actual account fee.
3. User position mode and leverage configuration reads.
4. Open/history positions, regular orders/fills, plan orders and TP/SL orders.
5. Later write methods for create/query/cancel/modify, kept impossible to call while adapter mode is
   read-only.

### Signing and transport

- GET/DELETE sign sorted non-null business parameters.
- POST serialize once, sign those exact bytes, and send the same bytes.
- Maintain measured server offset; do not hide clock/auth failure by expanding `Recv-Window`.
- Add independent token buckets for create/mutate versus query traffic.
- Parse response `success` and MEXC error code; classify retryable reads separately from ambiguous
  writes and permanent permission/precision/risk errors.
- Redact key, signature and raw authenticated headers from all errors/logs.
- Pin the production REST default to `https://api.mexc.com`; an override is allowed only for explicit
  test mocks, not a guessed public testnet.

### Symbol/metadata gate

For every configured symbol, require `state=0`, `apiAllowed=true`, USDT quote, non-Innovation status,
compatible position/margin mode and leverage bounds. Cache with a TTL and include metadata version
or fetch timestamp in execution plans.

### Tests

- official-example and fixed-vector HMAC signatures;
- POST body serialized once; reordered JSON fails fixture as expected;
- path params excluded and query params sorted;
- clock offset refresh and expired timestamp handling;
- schema errors and misleading `success/code` combinations fail closed;
- all canonical ↔ `*_USDT` symbol mappings;
- contract-size/tick/volume rounding across the entire Fast basket;
- minimum contract exceeding risk is rejected, never rounded up;
- error classification and rate-limit scheduling.

### Gate

Run authenticated production read-only preflight. It must prove account eligibility, fee rates,
one-way mode, clean ownership state and contract availability without any write request.

## 6. Phase 4 — Implement MEXC Fast Execution and Recovery

### New file: `mexc-fast-execution.ts`

#### Initial entry

1. Compute `riskUsd = mexcEquity * configuredRiskPct`, subject to the MEXC-only portfolio cap.
2. Convert Binance signal geometry to `riskFraction = abs(signalEntry - signalStop)/signalEntry`.
3. Read a current MEXC reference price and reject new entry if
   `abs(mexcReference/signalEntry - 1) > MEXC_MAX_BASIS_PCT` (initial default 0.30%).
4. Build a contract plan from reference price and metadata. Reject if minimum volume exceeds risk.
5. Persist deterministic intent/external OID before POST.
6. Submit MEXC market order, then query order/fills/position until a terminal or bounded ambiguous
   state is reached.
7. Re-anchor stop to the actual average fill using the risk fraction and round it away from the
   position toward safety without increasing risk.
8. Place a native, fair-price-triggered position stop, verify its `positionId`, direction, volume and
   price, then mark the position protected.
9. If protection remains unverified after bounded reconcile attempts, submit an owned reduce-only
   emergency exit, confirm flatness and quarantine the symbol. If exit is ambiguous, persist both the
   unprotected alert and pending exit; never clear state.

#### Pyramiding

- The strategy requests an add; the executor recomputes MEXC equity, risk, contract volume and
  portfolio cap.
- Persist intent, submit with a new deterministic operation generation, confirm fill/position, then
  modify the position-bound stop to cover the confirmed total volume.
- No further add/entry is allowed while add or stop state is ambiguous.

#### Stop updates

- Use `POST /api/v1/private/stoporder/change_plan_price` for an existing owned TP/SL planned order,
  then read back and verify.
- Do not cancel the only verified protective stop before a replacement is visible.
- Because TP/SL calls lack `externalOid`, an ambiguous result first reconciles open stop orders. It
  does not immediately create another stop.

#### Exit

- Submit an owned reduce-only market close for the exact confirmed position, with deterministic
  `externalOid` and `positionId` where required.
- Confirm flatness and owned-order cleanup before clearing state.
- Cancel only owned Fast orders/stops. Unknown/manual objects quarantine the symbol.
- Do not use account-wide `close_all` in normal bot logic.

#### Reconciliation

- REST is authoritative at startup, after every ambiguous mutation, after network reconnect and on a
  periodic interval.
- WebSocket may be added later to reduce latency, but every reconnect triggers REST full reconcile.
- Reconcile four sets: durable intents, regular orders/fills, positions and TP/SL protection.
- Outcome is one of `consistent`, `recoverablePending`, `unprotectedOwned`, `unknownOrphan`, or
  `fatalConfiguration`; each has an explicit new-entry circuit-breaker policy.

### Fault-injection tests

- order accepted then connection drops -> query external OID, no duplicate;
- duplicate process/candle event -> one entry;
- partial fill and delayed position -> size from confirmed data, not request;
- protection accepted then timeout -> discover existing stop before repeat;
- entry filled and stop rejected -> reduce-only emergency close and quarantine;
- add filled and stop modify rejected -> added contracts remain in state, entries frozen;
- exit accepted then timeout -> pending exit until query confirms flat;
- restart at every numbered entry step -> deterministic recovery;
- manual/unknown position/order/stop -> no adopt, cancel or flatten;
- stale metadata or contract disabled between plan/send -> reject/reconcile safely;
- exchange error/rate limit/time skew -> correct circuit-breaker behavior.

## 7. Phase 5 — Compose Independent Venues in the Bot

### `btc-alert-bot.ts`

1. Keep the Binance client/trader and Turtle wiring intact.
2. Instantiate MEXC read-only components when `MEXC_ENABLED=true`; instantiate write capability only
   when the separate `MEXC_TRADING_ENABLED` flag and all preflight gates pass.
3. Replace global readiness with:
   - `binanceReadiness` for Turtle new entries;
   - `mexcReadiness` for Fast new entries;
   - `fastSignalDataHealth` for new Fast signal generation.
4. Existing-position reconciliation/exits run even when new-entry readiness is false.
5. Remove cross-venue Fast/Turtle symbol exclusion. Keep ownership collisions scoped by
   venue/account/symbol.
6. Compute Binance/Turtle and MEXC/Fast risk caps from their respective account equity. Do not sum
   percentages across accounts.

### Configuration

Add documented, fail-closed MEXC variables to `.env.example`. Do not copy secrets into examples,
source, Docker image or logs. `TRADING_ENABLED=true` must not imply MEXC writes.

Recommended canary defaults:

```text
MEXC_ENABLED=false
MEXC_TRADING_ENABLED=false
MEXC_BASE_URL=https://api.mexc.com
MEXC_FAST_RISK_PCT=0.001
MEXC_MAX_PORTFOLIO_RISK_PCT=0.10
MEXC_MARGIN_TYPE=isolated
MEXC_CANARY_SYMBOLS=BTCUSDT
MEXC_MAX_BASIS_PCT=0.003
```

### State paths

Use new files such as `fast-trend-mexc-state.json` and `fast-trend-mexc-trades.jsonl`, with Docker
mounts and gitignore entries. Preserve legacy Binance Fast files for drain/audit/rollback.

### Health and alerts

Expose per venue/strategy:

- public/authenticated connectivity and server-time drift;
- new-entry readiness and exact failed gate;
- account fingerprint, position mode, fee tier and equity age (never secrets);
- owned/unknown positions and protection status;
- pending operation and last full reconciliation;
- circuit-breaker state, basis and latest planned-versus-actual execution metrics.

Alert immediately on unprotected exposure, unknown orphan, persistent auth/time failure, state
corruption or ambiguous exit. Fix the Fast paper/live label to derive from actual venue mode.

### Isolation tests

- same BTC symbol concurrently on Turtle/Binance and Fast/MEXC;
- MEXC auth outage blocks Fast entries but not Turtle or management of existing MEXC exposure;
- Binance private outage blocks Turtle entries but not MEXC management;
- Binance public Futures data outage blocks new Fast signals, while MEXC reconcile/exit continues;
- no MEXC cancel/flatten operation can target Binance and no venue cleanup is account-wide.

## 8. Phase 6 — Cost Validation and Shadow Rollout

### Reprice Fast Trend evidence

Before mainnet, replay the existing Fast trade ledger with:

- actual `realMakerFee`/`realTakerFee` from the MEXC account;
- taker/taker assumption for market entry/exit unless evidence says otherwise;
- measured Binance-signal/MEXC-reference basis distribution;
- measured plan-to-fill slippage;
- symbol-specific funding from historical/current MEXC data;
- rejected trades caused by contract minimum, API eligibility or basis gate.

Report net R overall, per symbol, per year/regime, drawdown, trade count and a sensitivity grid for
fees/slippage/basis. This is validation of execution portability, not parameter optimization.

### Shadow mode

Run at least 14 calendar days and capture at least 20 eligible Fast signal/add/exit events; extend the
window if the event count is lower. Shadow mode builds complete execution plans and performs read-only
reconciliation but contains a transport-level prohibition on private write endpoints.

Gate to canary only if:

- no signing/schema/reconciliation errors remain;
- every basket symbol passes metadata and sizing fixtures;
- p99 observed basis is understood and the 0.30% gate has an acceptable rejection rate;
- cost-adjusted Fast expectation remains positive under the predeclared conservative scenario;
- restart, timeout, stop failure and orphan drills pass;
- MEXC API key is KYC-enabled, Futures-scoped, IP-whitelisted and has no withdrawal permission.

## 9. Phase 7 — Explicitly Approved Mainnet Canary

This phase begins only after the user reviews the shadow/cost report and explicitly approves real
MEXC orders.

### Canary limits

- BTC_USDT only;
- one position and one unit maximum; pyramiding disabled by rollout gate;
- 0.10% MEXC-equity risk, additionally limited by minimum valid contracts;
- basis gate 0.30%; isolated margin and low leverage within contract limits;
- no automatic risk increase or symbol expansion;
- operator kill switch disables new entries while leaving reconcile/protection/exit active.

### Required live lifecycle

1. Readiness and empty/owned-state reconcile.
2. Entry intent -> fill confirmation -> native stop confirmation.
3. Stop-price modify -> read-back confirmation.
4. Normal reduce-only exit -> flat confirmation -> owned stop cleanup.
5. Restart with a live protected position and successful ownership recovery.
6. Controlled ambiguous-response drill using a transport fault after submit; prove query-by-external
   ID prevents a duplicate.

Any unprotected exposure, unknown position/order, duplicate intent, state corruption, failed exit or
unexplained fee/basis deviation returns the system to `MEXC_TRADING_ENABLED=false` and preserves
management/alerts for existing exposure.

## 10. Phase 8 — Controlled Expansion

Expansion is manual and one dimension at a time:

1. Enable Fast pyramiding on BTC, repeat add-fill/protection-resize/restart tests.
2. Add one symbol only after metadata, liquidity/basis and cost evidence passes.
3. Continue until the intended Fast basket is covered.
4. Consider raising risk from 0.10% only in a separate decision after a sufficiently representative
   live sample; never infer permission from elapsed time or order count.

At each stage compare expected versus actual fills, risk USD, stop distance, fees, funding and R. A
rollback disables new MEXC entries; it does not migrate open positions to Binance.

## 11. Verification Matrix

| Area | Required proof |
|---|---|
| Strategy regression | Fixed Binance Futures candles produce identical Fast signals; Turtle baseline unchanged |
| Sizing | Contract fixtures for every symbol; rounded actual risk never exceeds budget |
| Idempotency | Accepted-timeout and duplicate-process tests create one regular order |
| Protection | Every owned filled position has one verified full-volume stop or a durable emergency exit |
| State | Atomic-write interruption and restart at each mutation boundary recover deterministically |
| Ownership | Unknown/manual objects quarantine; no blind adopt/cancel/flatten |
| Isolation | Same symbol on both venues; either venue can fail without disabling management on the other |
| Cost | MEXC account fee, slippage, basis and funding included in net-R sensitivity report |
| Operations | Per-venue health, alerts, circuit breaker and kill switch tested |
| Rollback | New MEXC entries disabled without touching Binance or abandoning existing MEXC management |

## 12. Definition of Done

The integration is complete only when:

1. All deterministic/fault-injection tests pass and the MEXC-disabled build leaves live Binance/Turtle
   behavior unchanged.
2. Legacy Fast/Binance exposure is proven flat or intentionally drained before cutover.
3. MEXC read-only preflight and shadow/cost validation pass for the intended symbols.
4. The user explicitly approves and the one-symbol canary completes entry, protection, modify, exit,
   restart and ambiguous-response recovery without duplicate/unprotected exposure.
5. The bot exposes independent venue readiness/risk/health and an operator-tested rollback path.
6. Any later symbol/risk expansion is separately gated by live evidence rather than automatically
   enabled.

## 13. Key Official MEXC References

- [Futures API availability (2026-03-31)](https://www.mexc.com/announcements/article/introducing-api-futures-trading-on-mar-31-2026-17827791534551)
- [Integration/signing guide](https://www.mexc.com/api-docs/futures/integration-guide)
- [Contract metadata](https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-info)
- [Create regular order](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-order)
- [Query order by external ID](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-order-by-external-id)
- [Open positions](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-open-positions)
- [Place position TP/SL](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-tpsl-order-by-position)
- [Modify TP/SL price](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/modify-tpsl-prices-on-a-tpsl-planned-order)
- [Error codes](https://www.mexc.com/api-docs/futures/error-code)
- [Account-specific fees](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-fee-details)
