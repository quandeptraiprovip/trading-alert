# Pre-registered protocol: random-maturity spot–perpetual carry

Locked before running the new backtest on 2026-08-01. The purpose of this file is to make later result-driven changes visible.

## Hypothesis and source

Test the theory-motivated, one-sided version of He, Manela, Ross, and von Wachter, *Fundamentals of Perpetual Futures* (arXiv:2212.06888, v6). This is not the report's earlier cross-sectional premium rank: each asset is traded independently when its own perpetual is far enough above its own spot price.

The source rule is:

- compute the perpetual–spot deviation hourly;
- open long spot / short perpetual when the positive deviation exceeds all-in round-trip trading cost;
- close when the deviation returns to the frictionless theoretical value;
- do not optimize entry/exit thresholds on historical returns.

Only the feasible long-spot/short-perpetual direction is tested. Spot shorting is excluded.

## Locked implementation

- Venue/data: Binance USDT spot, Binance USDⓈ-M perpetual, and Binance realized funding history.
- Universe: `BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `DOGEUSDT`, `ADAUSDT` — the complete five-asset universe used by the source paper, fixed before results.
- Bar frequency: 1 hour, UTC, using only timestamps present in both spot and perpetual series.
- Funding scale: `kappa = 3 * 365 = 1095` settlements/year, matching the paper's eight-hour model.
- Financing assumption for the baseline: 10% APR on the long spot notional; sensitivities at 0%, 5%, and 20% are reported without changing signals.
- Frictionless fair ratio: `lambda = kappa / (kappa - financingApr)`.
- Signal after hour `t` closes: `deviation = perpClose / spotClose - lambda`.
- Estimated retail execution cost per side: spot taker 10 bps + 2 bps slippage; perpetual taker 5 bps + 2 bps slippage.
- Entry threshold: the source paper's theory bound, i.e. positive `deviation` must exceed the estimated round-trip cost of both legs. No multiplier is selected.
- Execution: signal on close `t`, fill both legs at hour `t+1` open with adverse slippage and fees. There is no same-bar fill.
- Hedge: identical base-asset quantity on spot and perpetual, fixed until exit.
- Exit: first close with `perpClose / spotClose <= lambda`, filled at the following hourly open.
- Funding: actual published rate and mark price; count only settlements strictly after entry and strictly before exit. This deliberately declines ambiguous cashflows at an entry/exit timestamp.
- No stop and no maximum holding period, matching the source theory rule. Open positions are conservatively closed at the end of each evaluation window.
- At most one position per asset. No pyramiding, leverage optimization, volatility targeting, coin filtering, or parameter sweep.
- Net P&L includes four trade fees, four adverse-slippage legs, realized funding, and the stated financing APR.
- `net R` is reported only as a transparent normalization where `1R = 1%` of initial spot-leg notional. It is **not** presented as a stop-defined R multiple. Portfolio return, Sharpe, and drawdown are the primary metrics.

## Time isolation

- Development/replication: listing date through 2023-12-31 23:00 UTC.
- Embargo: 2024-01-01 through 2024-01-07 UTC.
- Validation: 2024-01-08 through 2025-12-31 23:00 UTC.
- Embargo: 2026-01-01 through 2026-01-07 UTC.
- Final holdout: 2026-01-08 through 2026-07-31 23:00 UTC.

The code and accounting tests must pass on development data first. Validation is then run without changing the rule. The final holdout is opened once. If any implementation defect is found after opening it, the defect and both pre-fix and post-fix holdout results must be disclosed; no result can be silently replaced.

## Robustness gates

The strategy is not promoted unless all of the following hold without selecting a favorable variant:

1. positive net return in development, validation, and final holdout at baseline cost;
2. positive validation and holdout return at 1.5× execution costs;
3. no single asset contributes more than 50% of total positive P&L;
4. stationary-block bootstrap 90% interval is reported, including when it crosses zero;
5. results are shown by year and asset, including null and negative periods;
6. exact timestamp, fee, slippage, funding-sign, and hedge-P&L unit tests pass.

Failure of a gate means reject or paper-trade only; it is not permission to tune a new threshold on the holdout.

## Pre-validation implementation note

The first development run exposed that Binance's funding-history endpoint returns `markPrice=0` for much of the older history. Before opening validation, the implementation was corrected to use Binance's official hourly mark-price kline at the same settlement timestamp whenever that field is zero (and the perpetual open only as a fail-safe if the mark series itself is unavailable). This changes no signal, threshold, universe, or evaluation window. Development must be rerun after the correction; the uncorrected funding-zero result is not a valid result.
