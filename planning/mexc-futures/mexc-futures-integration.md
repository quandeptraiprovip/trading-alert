# MEXC Futures Integration — Initial Spec

## Goal

Add a second futures execution venue so the two active trend strategies no longer block each other
when they want to trade the same symbol.

## Strategy Routing

- Turtle Hybrid remains on Binance USD-M Futures.
- Fast Trend executes on MEXC USDT-M perpetual futures.
- SMC remains disabled.
- Routing is static by strategy. A failed order must not automatically fail over to the other exchange.

## Signal and Risk Intent

- Preserve the existing, backtested Fast Trend signal semantics unless MEXC market-data validation
  proves that a separate MEXC signal feed is required.
- Size every MEXC order from MEXC account equity, MEXC contract metadata and the configured risk per
  unit; never reuse Binance quantity or minimum-notional assumptions.
- Translate entry-to-stop distance as a percentage/R distance around the actual MEXC fill so a
  Binance-derived signal cannot place an invalid absolute stop on MEXC.
- Preserve pyramiding, exchange-side protection, maximum units, portfolio risk checks, time exit,
  reconciliation and restart recovery.

## Safety Requirements

- Testnet or paper/shadow mode first. No mainnet order until symbol discovery, signing, clock sync,
  precision, position mode, leverage, margin type, SL/TP and reconciliation are verified.
- API key must have futures trading permission only; withdrawals disabled; IP whitelist enabled.
- Client order IDs and a durable journal must make retries idempotent.
- Unknown/orphan positions are never flattened automatically. Adopt only when ownership can be
  established; otherwise alert and stop new entries for that symbol.
- If protection placement fails after entry, retry immediately, alert loudly and fail closed for new
  entries. Define an emergency-close policy before mainnet rollout.
- Binance failure must not disable MEXC management, and MEXC failure must not disable Turtle/Binance.

## Rollout

1. Read-only connectivity and contract metadata.
2. Shadow execution plan without sending orders.
3. MEXC demo/test environment if supported for this account; otherwise minimum-size mainnet canary
   only after explicit user approval.
4. One symbol and one unit, then the full Fast Trend basket.
5. Compare planned versus actual fill, stop distance, fees, funding and signal/execution basis.

## Non-Goals

- No cross-exchange hedging, arbitrage or automatic balance transfer.
- No dynamic best-price routing.
- No re-enabling SMC.
- No strategy parameter optimization as part of exchange integration.

