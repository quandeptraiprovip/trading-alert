#!/usr/bin/env python3
"""
Backtest: The exact case study from the FX Dream video (2026-10-06):
1. Sweep of recent Swing Low (SFP) with long lower wick.
2. Volume Spike 1 (Big Boy absorption at low).
3. Retest of the level / Order Block within max_wait bars.
4. Volume Spike 2 (Second confirmation of Big Boy defending the level).
5. Entry Long at close of Retest candle, SL below SFP low.
6. Target: Fixed R:R (1.5R, 2R, 3R, 4R, 5R) or Swing High.
7. Exclude weekends (Saturday & Sunday).
"""

import json
import math
from datetime import datetime, timezone
import pandas as pd
import numpy as np

def is_weekend(timestamp_ms):
    # Check if Saturday or Sunday in UTC (or Friday 22:00 UTC to Sunday 22:00 UTC)
    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    # Friday >= 22:00 UTC to Sunday < 22:00 UTC corresponds to NY market close
    weekday = dt.weekday() # 0=Monday, 4=Friday, 5=Saturday, 6=Sunday
    hour = dt.hour
    if weekday == 4 and hour >= 22:
        return True
    if weekday == 5: # Saturday
        return True
    if weekday == 6 and hour < 22: # Sunday before 22 UTC
        return True
    return False

def load_data():
    with open('.cache/klines/futures/xauusdt_15m.json', 'r') as f:
        raw = json.load(f)
    
    df = pd.DataFrame(raw)
    df = df.rename(columns={
        'openTime': 'timestamp',
        'open': 'open',
        'high': 'high',
        'low': 'low',
        'close': 'close',
        'volume': 'volume'
    })
    
    # Filter weekend bars
    df['is_weekend'] = df['timestamp'].apply(is_weekend)
    df = df[~df['is_weekend']].reset_index(drop=True)
    
    df['open'] = df['open'].astype(float)
    df['high'] = df['high'].astype(float)
    df['low'] = df['low'].astype(float)
    df['close'] = df['close'].astype(float)
    df['volume'] = df['volume'].astype(float)
    
    # Calculate indicators
    df['vol_ma20'] = df['volume'].rolling(20).mean()
    df['vol_ratio'] = df['volume'] / df['vol_ma20']
    
    # ATR
    tr1 = df['high'] - df['low']
    tr2 = (df['high'] - df['close'].shift(1)).abs()
    tr3 = (df['low'] - df['close'].shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    df['atr'] = tr.rolling(14).mean()
    
    return df

def run_backtest(df, 
                 lookback_swing=30, 
                 vol_spike_1=2.5, 
                 vol_spike_2=1.5, 
                 require_double_vol=True, 
                 min_wick_ratio=0.4,
                 max_wait_bars=16,
                 target_rr=3.0):
    
    n = len(df)
    trades = []
    
    # Costs
    taker_fee_pct = 0.0005 # 0.05%
    slippage_pct = 0.0002  # 0.02%
    cost_per_trade_fraction = (taker_fee_pct + slippage_pct) * 2
    
    i = max(lookback_swing, 20) + 1
    
    while i < n - max_wait_bars - 1:
        # Check if candle i is an SFP / Sweep of recent low
        recent_low = df.loc[i - lookback_swing : i - 1, 'low'].min()
        
        c = df.loc[i]
        candle_range = c['high'] - c['low']
        if candle_range <= 0:
            i += 1
            continue
            
        lower_wick = min(c['open'], c['close']) - c['low']
        wick_ratio = lower_wick / candle_range
        
        # SFP conditions:
        # 1. Price swept recent_low
        swept = (c['low'] < recent_low) and (c['close'] > recent_low or wick_ratio >= min_wick_ratio)
        vol_spike_1_cond = (c['vol_ratio'] >= vol_spike_1)
        
        if not (swept and vol_spike_1_cond and wick_ratio >= min_wick_ratio):
            i += 1
            continue
            
        # SFP detected at candle i!
        sweep_bar = i
        sweep_low = c['low']
        sweep_close = c['close']
        sweep_high = c['high']
        sweep_vol_ratio = c['vol_ratio']
        sweep_time = c['timestamp']
        
        entry_bar = None
        entry_price = None
        sl_price = sweep_low - 0.1 * c['atr']
        
        if not require_double_vol:
            # Single confirmation: Enter immediately on next bar open or close
            entry_bar = i + 1
            entry_price = df.loc[entry_bar, 'open']
        else:
            # Wait for Retest + Vol Spike 2 within max_wait_bars
            for wait in range(1, max_wait_bars + 1):
                cur_bar = i + wait
                if cur_bar >= n:
                    break
                curr = df.loc[cur_bar]
                
                # If price breaks below sweep_low, setup invalidated
                if curr['low'] < sweep_low:
                    break
                
                # Retest zone: price touches into the lower wick / body of sweep bar
                # and shows bullish reaction or Vol Spike 2
                in_retest_zone = (curr['low'] <= sweep_close)
                has_vol_spike_2 = (curr['vol_ratio'] >= vol_spike_2)
                is_bullish = (curr['close'] >= curr['open']) or (curr['close'] >= sweep_close * 0.9995)
                
                if in_retest_zone and has_vol_spike_2 and is_bullish:
                    entry_bar = cur_bar
                    entry_price = curr['close']
                    break
                    
        if entry_bar is None or entry_price is None:
            i += 1
            continue
            
        risk = entry_price - sl_price
        if risk <= 0:
            i += 1
            continue
            
        target_price = entry_price + target_rr * risk
        
        # Simulate forward outcome
        outcome = None
        exit_bar = None
        exit_price = None
        gross_r = 0.0
        
        for fwd in range(entry_bar + 1, n):
            fwd_c = df.loc[fwd]
            
            # Pessimistic: check SL first
            hit_sl = (fwd_c['low'] <= sl_price)
            hit_tp = (fwd_c['high'] >= target_price)
            
            if hit_sl and hit_tp:
                # Same bar hits both: pessimistic assume SL
                outcome = 'loss'
                exit_bar = fwd
                exit_price = sl_price
                gross_r = -1.0
                break
            elif hit_sl:
                outcome = 'loss'
                exit_bar = fwd
                exit_price = sl_price
                gross_r = -1.0
                break
            elif hit_tp:
                outcome = 'win'
                exit_bar = fwd
                exit_price = target_price
                gross_r = target_rr
                break
                
            # If held for too long without hitting either (e.g. 150 bars = ~37h), exit at market
            if fwd - entry_bar >= 160:
                exit_bar = fwd
                exit_price = fwd_c['close']
                gross_r = (exit_price - entry_price) / risk
                outcome = 'timeout_win' if gross_r > 0 else 'timeout_loss'
                break
                
        if outcome is not None:
            # Cost in R
            cost_r = (cost_per_trade_fraction * entry_price) / risk
            net_r = gross_r - cost_r
            
            trades.append({
                'sweep_time': sweep_time,
                'entry_time': df.loc[entry_bar, 'timestamp'],
                'entry_price': entry_price,
                'sl_price': sl_price,
                'target_price': target_price,
                'risk': risk,
                'risk_pct': (risk / entry_price) * 100,
                'vol_ratio_1': sweep_vol_ratio,
                'outcome': outcome,
                'gross_r': gross_r,
                'cost_r': cost_r,
                'net_r': net_r,
                'hold_bars': exit_bar - entry_bar
            })
            
            # Fast forward to exit_bar to avoid overlapping trades
            i = exit_bar + 1
        else:
            i += 1
            
    return pd.DataFrame(trades)

if __name__ == '__main__':
    df = load_data()
    print(f"Loaded {len(df)} 15m candles excluding weekends.")
    first_dt = datetime.fromtimestamp(df['timestamp'].iloc[0]/1000, tz=timezone.utc)
    last_dt = datetime.fromtimestamp(df['timestamp'].iloc[-1]/1000, tz=timezone.utc)
    print(f"Period: {first_dt.strftime('%Y-%m-%d')} to {last_dt.strftime('%Y-%m-%d')}")
    
    print("\n" + "="*80)
    print("THỬ NGHIỆM 1: So sánh CÓ và KHÔNG CÓ Cú xác nhận Volume lần 2 (Double Vol Spike)")
    print("="*80)
    
    # Test 1: Single Vol Spike vs Double Vol Spike at 2R and 3R
    for double_vol in [False, True]:
        for rr in [2.0, 3.0, 4.0]:
            label = f"{'Double Vol Spike (như video)' if double_vol else 'Single Vol Spike (vào ngay)'} | TP = {rr}R"
            res = run_backtest(df, vol_spike_1=2.5, vol_spike_2=1.5, require_double_vol=double_vol, target_rr=rr)
            if len(res) == 0:
                print(f"{label}: Không có lệnh nào")
                continue
            wins = (res['gross_r'] > 0).sum()
            wr = wins / len(res) * 100
            total_net_r = res['net_r'].sum()
            total_gross_r = res['gross_r'].sum()
            avg_cost = res['cost_r'].mean()
            print(f"{label.ljust(48)} | N={len(res):3d} | WR={wr:5.1f}% | Gross={total_gross_r:+6.1f}R | Net={total_net_r:+6.1f}R | Phí TB={avg_cost:.2f}R")

    print("\n" + "="*80)
    print("THỬ NGHIỆM 2: Tinh chỉnh Ngưỡng Volume Spike 1 (Độ đột biến của Big Boy)")
    print("="*80)
    for v1 in [2.0, 2.5, 3.0, 4.0]:
        res = run_backtest(df, vol_spike_1=v1, vol_spike_2=1.5, require_double_vol=True, target_rr=3.0)
        if len(res) == 0:
            continue
        wins = (res['gross_r'] > 0).sum()
        wr = wins / len(res) * 100
        total_net_r = res['net_r'].sum()
        print(f"Vol Spike 1 >= {v1:.1f}x MA20 | N={len(res):3d} | WR={wr:5.1f}% | Net={total_net_r:+6.1f}R")
        
    print("\n" + "="*80)
    print("KIỂM TRA LỆNH CỤ THỂ NGÀY 2026-10-06 (Case trong video)")
    print("="*80)
    res_oct6 = run_backtest(df, vol_spike_1=2.5, vol_spike_2=1.5, require_double_vol=True, target_rr=3.0)
    oct6_trades = res_oct6[res_oct6['entry_time'].apply(lambda t: datetime.fromtimestamp(t/1000, tz=timezone.utc).strftime('%Y-%m-%d') == '2026-10-06')]
    print(f"Số lệnh bắt được ngày 2026-10-06: {len(oct6_trades)}")
    for _, tr in oct6_trades.iterrows():
        ent_dt = datetime.fromtimestamp(tr['entry_time']/1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
        print(f"  Entry: {ent_dt} | Giá: {tr['entry_price']:.2f} | SL: {tr['sl_price']:.2f} | TP: {tr['target_price']:.2f} | Net R: {tr['net_r']:+.2f}R ({tr['outcome']})")
