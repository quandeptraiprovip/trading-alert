# MEXC Futures Integration — Assumption Interview

The user explicitly asked the assistant to make the decisions and produce the plan. The following
is therefore a recorded decision interview, not a claim that the user answered each question.
Every mainnet-enabling action remains a separate, explicit approval.

## 1. What problem are we solving?

**Decision:** Remove cross-strategy symbol contention by assigning each active strategy a permanent
execution venue:

- Turtle Hybrid -> Binance USD-M Futures.
- Fast Trend -> MEXC USDT-M Futures.
- SMC remains disabled.

This is account/venue isolation, not duplicate exposure prevention across the combined portfolio.
If both strategies signal the same symbol, both positions are allowed because they belong to
different strategies and exchanges.

## 2. Should orders fail over between exchanges?

**Decision:** No. A MEXC failure pauses new Fast Trend entries while continuing to manage any
existing MEXC exposure. It must never send the rejected/ambiguous order to Binance. Binance failure
must not stop MEXC management, and vice versa.

Reason: automatic failover creates duplicate-order risk when an earlier request has an unknown
outcome and reintroduces strategy contention on Binance.

## 3. Which market data should Fast Trend use?

**Decision:** Preserve the currently backtested Binance 4h signal feed in the first release. MEXC is
the execution venue. Convert the signal's entry-to-stop distance into a percentage, then anchor the
stop to the confirmed MEXC fill. Record Binance signal price, MEXC reference price, fill, basis,
slippage, fees and funding.

Adding MEXC candles would change the strategy and requires an independent backtest and walk-forward
validation; it is not silently included in this integration.

## 4. What account mode and order behavior should be required?

**Decision:** Use a dedicated MEXC Futures account in one-way mode, isolated margin where the
contract supports it, and the same low configured leverage used by the strategy. The adapter must
discover contract size, volume step, price tick, leverage bounds and API eligibility at runtime.
Binance quantities must never be sent to MEXC.

## 5. What is the protection policy?

**Decision:** A filled entry is not considered successfully opened until a native MEXC stop-market
bound to the confirmed `positionId` is visible through a read-after-write query. Stop updates use
the official modify endpoint and are verified after mutation. If initial protection cannot be
verified after bounded retries, the bot submits an idempotent reduce-only market close and freezes
that symbol. Unknown/orphan positions are frozen and alerted, never blindly adopted or flattened.

## 6. How should ambiguous network outcomes be handled?

**Decision:** Every regular order intent gets a deterministic `externalOid`. On timeout or 5xx, the
bot queries by that ID before deciding whether a retry is safe. It never blindly retries an order
POST. TP/SL endpoints do not expose an equivalent client id, so their retries must first reconcile
the open TP/SL list.

## 7. How should rollout work without a documented API testnet?

**Decision:** Use local contract tests and mocks, production read-only discovery, then a shadow mode
that emits complete order plans without signing a write request. MEXC has a demo UI, but the current
Futures API documentation does not publish a testnet API base URL or API-key workflow, so no testnet
hostname will be guessed.

The first mainnet canary requires explicit user approval and starts with:

- BTC_USDT only;
- one unit maximum, no pyramiding;
- 0.10% account-equity risk per trade;
- minimum valid contract volume;
- new entries blocked when absolute Binance/MEXC basis exceeds 0.30%;
- immediate alerting and a manual kill switch.

Pyramiding and additional symbols are enabled only after the full lifecycle—entry, fill, native
stop, modify, exit and restart reconciliation—has been verified. Risk is not automatically raised
to the prior 0.50% setting.

## 8. What are the migration rules for current Fast Trend state?

**Decision:** Existing Binance Fast Trend state and any real/unknown Binance position must be drained
by the old Binance executor before MEXC write mode is enabled. MEXC uses a new state/journal file
with an explicit venue and schema version. It may not adopt old Binance state.

## 9. What security rules apply?

**Decision:** KYC and MEXC Futures API permission are prerequisites. Use a dedicated key with only
the minimum account/read/order permissions, no withdrawal permission, an IP whitelist, secrets only
through the runtime environment, and startup logs that redact credentials and signatures.

## 10. What is explicitly out of scope?

- Dynamic best-price routing or automatic venue failover.
- Cross-exchange hedging, arbitrage or balance transfer.
- Re-enabling SMC.
- Retuning Fast Trend parameters as part of the connector work.
- Assuming the nominal Binance backtest remains profitable after MEXC fees and basis; cost-adjusted
  validation is a release gate.
