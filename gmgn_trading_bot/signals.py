from __future__ import annotations

import statistics

from .models import Candle, ChartSignal, WatchToken


def detect_chart_signals(
    token: WatchToken,
    candles: list[Candle],
    *,
    lookback: int,
    min_volume_ratio: float,
    min_move_pct: float,
) -> list[ChartSignal]:
    """Detect basic OHLCV-only signals on the newest closed candle.

    These are intentionally called CHART signals. They are not SMART SEROK's
    CVD/R resistance-support signals because GMGN K-line does not expose signed
    buy/sell flow.
    """
    if len(candles) < lookback + 1:
        return []
    current = candles[-1]
    previous = candles[-(lookback + 1) : -1]
    volumes = [c.volume_usd for c in previous if c.volume_usd > 0]
    median_volume = statistics.median(volumes) if volumes else 0.0
    volume_ratio = current.volume_usd / median_volume if median_volume > 0 else 0.0
    volume_ok = min_volume_ratio <= 0 or volume_ratio >= min_volume_ratio
    move_ok = min_move_pct <= 0 or abs(current.change_pct) >= min_move_pct

    signals: list[ChartSignal] = []
    prior_high = max(c.high for c in previous)
    prior_low = min(c.low for c in previous)
    common = f"candle {current.start_iso} · perubahan {current.change_pct:+.2f}% · volume {volume_ratio:.2f}× median"

    if current.close > prior_high and volume_ok and move_ok:
        kind = "CHART_BREAKOUT"
        signals.append(
            ChartSignal(
                f"{token.mint}:{current.start_ms}:{kind}", token.mint, token.symbol, kind, current,
                f"Close menembus HIGH {lookback} candle sebelumnya. {common}",
            )
        )
    if current.close < prior_low and volume_ok and move_ok:
        kind = "CHART_BREAKDOWN"
        signals.append(
            ChartSignal(
                f"{token.mint}:{current.start_ms}:{kind}", token.mint, token.symbol, kind, current,
                f"Close menembus LOW {lookback} candle sebelumnya. {common}",
            )
        )
    return signals
