from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .engine import Trade
from .gmgn import GMGNError


class GMGNWebClient:
    """Adapter for GMGN's web token_trades feed used by the Chrome extension."""

    def __init__(self, cookie: str, host: str = "https://gmgn.ai", timeout: int = 30):
        self.cookie = cookie.strip()
        self.host = host.rstrip("/")
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self.cookie)

    def _page(self, mint: str, from_ts: int, to_ts: int, cursor: str | None) -> tuple[list[dict[str, Any]], str | None]:
        params: list[tuple[str, str]] = [("event", "buy"), ("event", "sell"), ("limit", "200")]
        if from_ts > 0:
            params.append(("from", str(from_ts)))
        if to_ts > 0:
            params.append(("to", str(to_ts)))
        if cursor:
            params.append(("cursor", cursor))
        url = f"{self.host}/vas/api/v1/token_trades/sol/{mint}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, headers={
            "Accept": "application/json, text/plain, */*",
            "Cookie": self.cookie,
            "Origin": "https://gmgn.ai",
            "Referer": f"https://gmgn.ai/sol/token/{mint}",
            "User-Agent": "Mozilla/5.0 gmgn_trading_bot/0.2.4",
        })
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            raise GMGNError(f"GMGN raw trades HTTP {exc.code}: {body}") from exc
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            raise GMGNError(f"GMGN raw trades gagal: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("code") != 0:
            raise GMGNError(f"GMGN raw trades API error: {payload if isinstance(payload, dict) else 'non-object'}")
        data = payload.get("data") or {}
        return list(data.get("history") or []), data.get("next")

    def fetch_trades(self, mint: str, from_ts: int, to_ts: int, max_pages: int = 300) -> list[Trade]:
        if not self.enabled:
            raise GMGNError("GMGN_WEB_COOKIE belum diisi di bot.env")
        result: dict[str, Trade] = {}
        cursor: str | None = None
        for page in range(max_pages):
            history, cursor = self._page(mint, from_ts, to_ts, cursor)
            for item in history:
                trade = normalize_trade(mint, item)
                if trade and from_ts <= trade.ts <= to_ts:
                    result[trade.trade_id] = trade
            if not cursor or not history:
                break
            # Sama dengan cooldown default Background Fetch ekstensi; lebih lambat
            # tetapi jauh lebih aman terhadap rate limit/Cloudflare GMGN.
            time.sleep(0.8)
        return sorted(result.values(), key=lambda x: x.ts)


def normalize_trade(mint: str, item: dict[str, Any]) -> Trade | None:
    maker_info = item.get("maker_info") if isinstance(item.get("maker_info"), dict) else {}
    wallet_info = item.get("wallet_info") if isinstance(item.get("wallet_info"), dict) else {}
    maker = item.get("maker") or item.get("maker_address") or item.get("wallet") or item.get("address") or maker_info.get("address") or wallet_info.get("address")
    raw_event = str(item.get("event") or item.get("trade_type") or item.get("type") or item.get("side") or "").lower()
    event = "buy" if "buy" in raw_event and "buyback" not in raw_event else "sell" if "sell" in raw_event else None
    if not maker or event is None:
        return None
    try:
        ts = int(item.get("timestamp") or item.get("time") or item.get("ts") or item.get("block_time") or 0)
        if ts > 1_000_000_000_000:
            ts //= 1000
        sol = float(item.get("quote_amount") or item.get("amount_sol") or item.get("sol_amount") or item.get("quote_volume") or item.get("sol") or 0)
        price = float(item.get("price_usd") or item.get("price") or 0)
    except (TypeError, ValueError):
        return None
    if ts <= 0 or sol < 0 or price <= 0:
        return None
    tx_hash = str(item.get("tx_hash") or item.get("tx_id") or item.get("signature") or item.get("hash") or item.get("id") or "")
    if not tx_hash:
        return None
    tags: set[str] = set()
    for source in (item, maker_info, wallet_info):
        for key in ("maker_tags", "maker_token_tags", "maker_event_tags", "tags", "tag"):
            value = source.get(key)
            values = value if isinstance(value, list) else str(value or "").replace(";", ",").split(",")
            for tag in values:
                if isinstance(tag, dict):
                    tag = tag.get("tag") or tag.get("name") or tag.get("id") or ""
                normalized = str(tag).strip().lower().replace(" ", "_").replace("-", "_")
                if normalized:
                    tags.add(normalized)
    trade_id = f"{tx_hash}:{event}:{ts}:{maker}"
    return Trade(trade_id, mint, str(maker), event, sol, price, ts, tx_hash, tuple(sorted(tags)))
