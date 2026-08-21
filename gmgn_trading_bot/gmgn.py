from __future__ import annotations

import json
import logging
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email.utils import parsedate_to_datetime
from typing import Any

from .models import Candle

LOG = logging.getLogger(__name__)


class GMGNError(RuntimeError):
    pass


class GMGNClient:
    """Small read-only client matching the official gmgn-cli exist-auth flow."""

    def __init__(self, api_key: str, host: str = "https://openapi.gmgn.ai", timeout: int = 20):
        self.api_key = api_key
        self.host = host.rstrip("/")
        self.timeout = timeout
        self._server_epoch_at_sync: float | None = None
        self._monotonic_at_sync: float | None = None

    def _server_now(self) -> float:
        if self._server_epoch_at_sync is None or self._monotonic_at_sync is None:
            return time.time()
        return self._server_epoch_at_sync + (time.monotonic() - self._monotonic_at_sync)

    def now_ms(self) -> int:
        """Current epoch milliseconds, corrected to GMGN time after a sync."""
        return int(self._server_now() * 1000)

    def _sync_clock_from_http_date(self, value: str | None) -> bool:
        """Use GMGN's HTTP Date after AUTH_TIMESTAMP_EXPIRED and keep monotonic time."""
        if not value:
            return False
        try:
            server_epoch = parsedate_to_datetime(value).timestamp()
        except (TypeError, ValueError, OverflowError):
            return False
        offset = server_epoch - time.time()
        # A wildly wrong Date header is more dangerous than a clear error.
        if abs(offset) > 7 * 86400:
            return False
        self._server_epoch_at_sync = server_epoch
        self._monotonic_at_sync = time.monotonic()
        LOG.warning(
            "jam komputer berbeda %.1f detik dari server GMGN; bot memakai waktu server untuk autentikasi",
            offset,
        )
        return True

    def _get(self, path: str, params: dict[str, str | int]) -> Any:
        for attempt in range(2):
            query = {
                **params,
                "timestamp": int(self._server_now()),
                "client_id": str(uuid.uuid4()),
            }
            url = f"{self.host}{path}?{urllib.parse.urlencode(query)}"
            request = urllib.request.Request(
                url,
                headers={
                    "X-APIKEY": self.api_key,
                    "Content-Type": "application/json",
                    "User-Agent": "gmgn-trading-bot/0.2.4",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    text = response.read().decode("utf-8")
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")[:1000]
                error_code = ""
                try:
                    parsed = json.loads(body)
                    error_code = str(parsed.get("error", "")) if isinstance(parsed, dict) else ""
                except json.JSONDecodeError:
                    pass
                if (
                    attempt == 0
                    and exc.code == 401
                    and error_code == "AUTH_TIMESTAMP_EXPIRED"
                    and self._sync_clock_from_http_date(exc.headers.get("Date"))
                ):
                    continue
                raise GMGNError(f"GMGN HTTP {exc.code}: {body[:500]}") from exc
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
        raise GMGNError("gagal menyelaraskan timestamp dengan server GMGN")

    def get_token_info(self, chain: str, mint: str) -> dict[str, Any]:
        data = self._get("/v1/token/info", {"chain": chain, "address": mint})
        return data if isinstance(data, dict) else {}

    def get_klines(self, chain: str, mint: str, resolution: str, *, bars: int = 80) -> list[Candle]:
        now_ms = self.now_ms()
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
