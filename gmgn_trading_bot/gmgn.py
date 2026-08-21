from __future__ import annotations

import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from .models import Candle


class GMGNError(RuntimeError):
    pass


class GMGNClient:
    """Small read-only client matching the official gmgn-cli exist-auth flow."""

    def __init__(self, api_key: str, host: str = "https://openapi.gmgn.ai", timeout: int = 20):
        self.api_key = api_key
        self.host = host.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str, params: dict[str, str | int]) -> Any:
        query = {
            **params,
            "timestamp": int(time.time()),
            "client_id": str(uuid.uuid4()),
        }
        url = f"{self.host}{path}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(
            url,
            headers={
                "X-APIKEY": self.api_key,
                "Content-Type": "application/json",
                "User-Agent": "gmgn-trading-bot/0.1.2",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            raise GMGNError(f"GMGN HTTP {exc.code}: {body}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            raise GMGNError(f"koneksi GMGN gagal: {exc}") from exc

        try:
            envelope = json.loads(text)
        except json.JSONDecodeError as exc:
            raise GMGNError("GMGN mengembalikan respons non-JSON") from exc
        if not isinstance(envelope, dict) or envelope.get("code") != 0:
            safe = {k: v for k, v in envelope.items() if k in {"code", "error", "message"}} if isinstance(envelope, dict) else {}
            raise GMGNError(f"GMGN API error: {safe}")
        return envelope.get("data")

    def get_klines(self, chain: str, mint: str, resolution: str, *, bars: int = 80) -> list[Candle]:
        now_ms = int(time.time() * 1000)
        sec = {"30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}[resolution]
        data = self._get(
            "/v1/market/token_kline",
            {
                "chain": chain,
                "address": mint,
                "resolution": resolution,
                "from": now_ms - bars * sec * 1000,
                "to": now_ms,
            },
        )
        # Current API documents an array. Tolerate common wrapper names.
        if isinstance(data, dict):
            data = data.get("list", data.get("klines", data.get("candles", data.get("items", []))))
        if not isinstance(data, list):
            raise GMGNError("bentuk data kline GMGN tidak dikenal")
        parsed: list[Candle] = []
        errors = 0
        for row in data:
            try:
                parsed.append(Candle.from_api(row))
            except (TypeError, ValueError):
                errors += 1
        if data and not parsed:
            raise GMGNError(f"semua {errors} candle GMGN gagal diparse; schema mungkin berubah")
        return sorted({c.start_ms: c for c in parsed}.values(), key=lambda c: c.start_ms)


def retry_delay(attempt: int, cap: float = 60.0) -> float:
    return min(cap, (2 ** max(0, attempt - 1)) + random.random())
