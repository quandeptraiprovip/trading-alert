# MEXC Futures Integration — Research

**Research date:** 2026-07-22  
**Scope:** Current bot architecture, Fast Trend safety gaps, and the current official MEXC Futures API.

## Executive Findings

1. The correct contention fix is static strategy-to-venue routing: Turtle/Binance and Fast/MEXC.
   Automatic failover would recreate duplicate-order risk and is excluded.
2. The MEXC Futures API is available to KYC users with Futures permission as of 2026-03-31, except
   in restricted regions and on Innovation Zone contracts. The production REST base URL is
   `https://api.mexc.com`.
3. MEXC order volume is a number of contracts, not Binance-style base-asset quantity. Dynamic
   `contractSize`, tick, volume step, minimum/maximum volume and API eligibility checks are mandatory.
4. MEXC documents a demo trading UI but no supported Futures API testnet base URL or API-key flow.
   The rollout must therefore use mocks, production read-only checks, shadow execution and an
   explicitly approved minimum-size mainnet canary.
5. Fast Trend currently has failure paths that can forget a real position, record a stop that was
   not updated at the exchange, or desynchronize an add-unit fill. These must be repaired before the
   first MEXC write request.
6. The connector alone does not preserve the strategy's expected value. Current account-specific
   MEXC fees, funding, cross-exchange basis and slippage must be measured and applied to the Fast
   Trend validation before rollout.

## Current Codebase

### Composition and coupling

- The composition root creates one Binance client and a shared execution-readiness flag in
  `btc-alert-bot.ts:69,150`. The same flag is passed to Turtle at `btc-alert-bot.ts:162` and Fast at
  `btc-alert-bot.ts:193`; a single Binance preflight controls it at `btc-alert-bot.ts:1033`.
- `LiveTrader` imports and stores concrete `BinanceFutures` at `live-trade.ts:12,55`. Its high-level
  operations—preflight, risk-based open, protection, flatten and reconcile—are the useful behavior
  boundary, but its low-level contract is Binance-specific (`live-trade.ts:62,152,233,254,292`).
- `FastTrendLive` exposes concrete Binance and LiveTrader types at `fast-trend-live.ts:47`.
  Pyramiding bypasses the high-level trader and directly calls Binance sizing/order primitives at
  `fast-trend-live.ts:239`. Turtle has the same direct pattern at `turtle-live.ts:333`.
- Both strategies derive signals from Binance 4h candles (`fast-trend-live.ts:365`,
  `turtle-live.ts:562`). The fetcher silently falls back from Binance Futures to spot at
  `backtest.ts:35`, which is unacceptable for unlabelled live signal generation.

### Contention and risk coupling

- The current symbol exclusion assumes both strategies share one Binance account
  (`btc-alert-bot.ts:123,191`). It must become venue/account scoped so Turtle and Fast can hold the
  same canonical symbol on different exchanges.
- Current portfolio-risk callbacks combine Turtle and Fast fractions using one Binance-equity model
  (`btc-alert-bot.ts:161,192`). Fractions of two different account equities are not additive. Each
  account needs an independent risk cap; an optional combined USD cap is a separate future feature.
- One Boolean Binance health monitor does not actively trip the order circuit breaker even though
  its alert claims new orders will stop (`btc-alert-bot.ts:772`). Each venue needs its own readiness,
  circuit breaker and last-successful reconciliation status.

### Fast Trend safety gaps that block mainnet MEXC

1. **Lost real position:** Fast catches a flatten failure and still clears `st.pos` at
   `fast-trend-live.ts:283`. Turtle already persists a `pendingExit` until closure is confirmed at
   `turtle-live.ts:390`; Fast needs equivalent behavior.
2. **False local stop:** Fast mutates local SL before synchronization and does not restore the last
   confirmed price when sync fails (`fast-trend-live.ts:325`). Turtle rolls back at
   `turtle-live.ts:515`.
3. **Lost add-unit fill:** Fast sends the add directly, then updates local units only after protection
   succeeds (`fast-trend-live.ts:239,262`). A successful fill followed by a protection error leaves
   exchange exposure absent from local state.
4. **Weak ownership:** Startup adoption infers ownership from direction/replayed state at
   `fast-trend-live.ts:397`. A manual or unknown MEXC position must instead quarantine the symbol
   unless a durable operation/order ID proves ownership.
5. **No idempotent intent:** Binance methods accept client IDs (`binance-futures.ts:221,240,259`),
   but the live execution calls omit them (`live-trade.ts:122,201,292`). An accepted request followed
   by a timeout can be duplicated.
6. **Unsafe shared cleanup:** Current protection inspection accepts the first matching type without
   strict owner/side/volume/price checks (`live-trade.ts:254`), while flatten/emergency paths can
   cancel all symbol orders (`live-trade.ts:122,292`). MEXC operations must be owner-scoped.
7. **Non-atomic state:** Fast state is a direct overwrite at `fast-trend-live.ts:78`; shared state has
   the same issue at `live-state.ts:56`. MEXC state needs temp-file, fsync/close and atomic rename.

### Existing state and operational visibility

- Fast state/journal constants are independent (`fast-trend-live.ts:24`) and mounted in Docker
  (`docker-compose.yml:30`), but the schema lacks a version, venue, account fingerprint, confirmed
  exchange identifiers and pending operations (`fast-trend-live.ts:35`).
- The current DOT state has no authoritative `real`, quantity or venue fields
  (`fast-trend-state.json:38`). Cutover must first perform authenticated read-only reconciliation on
  both Binance and MEXC; the file cannot authorize adoption or flattening.
- `/health` reports only one Binance/global execution state (`btc-alert-bot.ts:815`), and the Fast
  status label can say paper even when trading live (`btc-alert-bot.ts:956`). Per-venue status and
  correct runtime labels are required before canary.
- There is no automated test script in `package.json:4`; TypeScript runs transpile-only
  (`tsconfig.json:27`). The existing `test-binance.ts:1` is a manual network test. Deterministic fake
  venue and connector tests are required.

## Current Official MEXC Futures API

### Eligibility and endpoints

- MEXC launched Futures API trading for KYC users on 2026-03-31. Futures permission is subject to
  region and contract eligibility; Innovation Zone contracts are excluded.
- Production REST: `https://api.mexc.com`. The older REST host `contract.mexc.com` is no longer the
  supported REST domain. The current native WebSocket documentation still uses
  `wss://contract.mexc.com/edge`.
- Do not use the legacy `/order/submit` endpoint or old documentation that says order submission is
  under maintenance. The current regular-order endpoint is `POST /api/v1/private/order/create`.

### Authentication

Private calls use `ApiKey`, `Request-Time`, `Signature`, optional `Recv-Window`, and JSON content
type. The signature target is:

```text
target = accessKey + timestampMs + parameterString
signature = hex(HMAC-SHA256(secretKey, target))
```

- GET/DELETE: omit null business parameters, sort them by name, and join with `&`.
- POST: sign the exact raw JSON string sent; do not reserialize or sort after signing.
- Path parameters are not included.
- Default permitted clock drift is ±10 seconds; `Recv-Window` can be at most 60 seconds and values
  over 30 seconds are discouraged. Use `GET /api/v1/contract/ping` to maintain server offset.
- Keys without an IP binding expire after 90 days. Use IP binding and least privilege.

### Metadata and sizing

Discover every contract using `GET /api/v1/contract/detail/country?symbol=...`. Gate on `state=0`,
`apiAllowed=true`, USDT quote and supported account region. Read at least `contractSize`, `priceUnit`,
`priceScale`, `volUnit`, `volScale`, `minVol`, `maxVol`, margin modes and leverage limits.

For a linear USDT contract:

```text
baseQty = riskUsd / abs(fillPrice - stopPrice)
rawContracts = baseQty / contractSize
contracts = floorToVolUnit(rawContracts)
notionalUsd = fillPrice * contracts * contractSize
actualRiskUsd = contracts * contractSize * abs(fillPrice - stopPrice)
```

Reject, rather than round up, when the minimum valid contract would exceed the risk budget. Recheck
actual risk after rounding, leverage/margin requirements and the confirmed fill.

### Orders and idempotency

`POST /api/v1/private/order/create` uses:

- `side`: 1 open long, 2 close short, 3 open short, 4 close long;
- `type=5` for market;
- `openType`: 1 isolated, 2 cross;
- `positionMode`: 1 hedge, 2 one-way;
- `vol`: contract count, not base quantity;
- `externalOid`: client ID, maximum 32 characters.

Use one-way mode (`positionMode=2`) on the dedicated Fast account and reduce-only closes. A regular
order response is not proof of a fill; query order/fill and reconcile the position. For an ambiguous
timeout/5xx, query `GET /api/v1/private/order/external/{symbol}/{external_oid}` before retrying.
Error codes include duplicate/repeated requests and timed-out orders; POST must never be retried
blindly.

### Position protection

- Open positions: `GET /api/v1/private/position/open_positions` returns `positionId`, contract
  volume, direction, average price, margin and liquidation data.
- Position TP/SL: `POST /api/v1/private/stoporder/place`; verify via current/open TP/SL endpoints.
- Modify an existing TP/SL planned order in place with
  `POST /api/v1/private/stoporder/change_plan_price`, then read it back. This avoids a cancel/create
  interval with no protection.
- Regular orders have `externalOid`; TP/SL endpoints do not. On an ambiguous protection response,
  reconcile active TP/SL orders before sending anything else.
- The normal kill path must close one owned position only. The account-wide `close_all` endpoint is
  reserved for a separately confirmed operational emergency, not bot logic.

### WebSocket and reconciliation

Private WebSocket can push orders, fills, positions, stops and assets. It requires a heartbeat every
10–20 seconds and reconnect logic. Treat it only as a latency optimization: REST reconciliation is
the source of truth after startup, reconnect and any ambiguous mutation. The first safe release can
use REST polling only; WebSocket is not required to authorize mainnet if polling meets the strategy's
4h cadence and all fills/protection are synchronously confirmed.

### Rate limits and errors

Relevant ordinary-user limits include approximately 4 create requests per 2 seconds, 10 metadata
requests per 2 seconds, 20 query/cancel requests per 2 seconds, and stricter leverage mutation
limits. Use separate token buckets for mutation and query families. Apply jittered backoff to safe
reads; ambiguous writes require reconciliation before any repeat.

Classify errors into authentication/time, throttle/transient, permission/availability,
insufficient-risk/margin, precision/limits and duplicate/unknown-outcome groups. A permission,
contract-ineligible or repeated authentication error trips new-entry readiness but must not stop
existing-position management attempts.

### Fees, funding and strategy validity

MEXC's 2026 fee announcement is internally inconsistent; its current table lists API Futures fees
of 0.06% maker and 0.08% taker per side while an example retains older values. At startup and during
shadow validation, query `GET /api/v1/private/account/tiered_fee_rate/v2?symbol=...`, persist the
account's `realMakerFee`/`realTakerFee`, and compare it with actual fills. A taker/taker round trip at
0.08% each side costs at least 0.16% before slippage and funding.

Funding is contract-specific and can settle on schedules other than the common 00:00/08:00/16:00
UTC times. Record funding from account funding records. Re-run the audited Fast Trend trade ledger
with actual MEXC fees plus a conservative basis/slippage/funding model; the connector cannot assume
the prior +R survives these costs.

## Research-Derived Architecture Decision

The safest implementation is incremental:

1. First fix Fast state durability and failure semantics behind its current Binance implementation.
2. Introduce a small high-level execution interface used by Fast (`preflight`, `openInitial`,
   `addUnit`, `syncProtection`, `requestExit`, `reconcile`) and fake it in tests.
3. Keep stable Turtle/Binance behavior untouched. Do not perform a broad low-level exchange
   abstraction in the same release.
4. Implement `MexcFutures` as a venue-specific REST adapter and `MexcFastExecution` as the translator
   between Fast risk intent and MEXC contract/position semantics.
5. Compose Turtle/Binance and Fast/MEXC statically in `btc-alert-bot.ts`, with independent states,
   readiness, risk caps and health.

This is more surgical than making all Binance and MEXC APIs look identical. It prevents MEXC's
contract volume, position-bound TP/SL and response semantics from leaking into the strategy while
avoiding unnecessary changes to the already-live Turtle executor.

## Official Sources

- [MEXC Futures API launch announcement](https://www.mexc.com/announcements/article/introducing-api-futures-trading-on-mar-31-2026-17827791534551)
- [Futures integration guide](https://www.mexc.com/api-docs/futures/integration-guide)
- [REST domain migration](https://www.mexc.com/announcements/article/futures-api-access-domain-update-17827791532974)
- [Contract metadata](https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-info)
- [Place regular order](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-order)
- [Query by external ID](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-order-by-external-id)
- [Open positions](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-open-positions)
- [Position TP/SL](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-tpsl-order-by-position)
- [Modify TP/SL planned order](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/modify-tpsl-prices-on-a-tpsl-planned-order)
- [Futures API error codes](https://www.mexc.com/api-docs/futures/error-code)
- [Account fee endpoint](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-fee-details)
- [Native WebSocket endpoint](https://www.mexc.com/api-docs/futures/websocket-api/native-ws-endpoint)
- [MEXC demo trading UI](https://support.mexc.com/hc/en-001/articles/5705980230169-How-to-Access-Demo-Trading-in-MEXC-Futures)
