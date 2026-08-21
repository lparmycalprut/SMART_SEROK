from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

WIB = ZoneInfo("Asia/Jakarta")


@dataclass(frozen=True, slots=True)
class WatchToken:
    mint: str
    symbol: str
    enabled: bool = True


@dataclass(frozen=True, slots=True)
class Candle:
    start_ms: int
    open: float
    high: float
    low: float
    close: float
    volume_usd: float
    amount_token: float

    @property
    def change_pct(self) -> float:
        return (self.close / self.open - 1.0) * 100 if self.open > 0 else 0.0

    @property
    def start_iso(self) -> str:
        """Timestamp ISO UTC untuk penyimpanan/diagnostik teknis."""
        return datetime.fromtimestamp(self.start_ms / 1000, timezone.utc).isoformat()

    @property
    def start_wib(self) -> str:
        """Waktu candle yang ramah dibaca dan konsisten dengan GMGN Jakarta."""
        return datetime.fromtimestamp(self.start_ms / 1000, WIB).strftime("%d-%m-%Y %H:%M WIB")

    @classmethod
    def from_api(cls, raw: Any) -> "Candle":
        """Parse documented GMGN OHLCV fields and tolerate array-style klines."""
        if isinstance(raw, dict):
            start = raw.get("time", raw.get("timestamp", raw.get("t")))
            values = (
                raw.get("open", raw.get("o")),
                raw.get("high", raw.get("h")),
                raw.get("low", raw.get("l")),
                raw.get("close", raw.get("c")),
                raw.get("volume", raw.get("v", 0)),
                raw.get("amount", raw.get("a", 0)),
            )
        elif isinstance(raw, (list, tuple)) and len(raw) >= 6:
            # Common format: [time, open, high, low, close, volume, amount?]
            start, *rest = raw
            values = (*rest[:5], rest[5] if len(rest) > 5 else 0)
        else:
            raise ValueError("unknown GMGN candle shape")

        if start is None or any(v is None for v in values[:4]):
            raise ValueError("GMGN candle is missing time/OHLC")
        start_ms = int(float(start))
        if start_ms < 10_000_000_000:  # accept seconds defensively
            start_ms *= 1000
        o, h, low, close, volume, amount = (float(v or 0) for v in values)
        if min(o, h, low, close) <= 0 or low > h:
            raise ValueError("invalid GMGN candle prices")
        return cls(start_ms, o, h, low, close, volume, amount)


@dataclass(frozen=True, slots=True)
class ChartSignal:
    event_id: str
    mint: str
    symbol: str
    kind: str
    candle: Candle
    message: str
