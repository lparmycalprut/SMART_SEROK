from __future__ import annotations

import hashlib
import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .engine import Trade
from .gmgn import GMGNError


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _nullish(item: dict[str, Any], *keys: str) -> Any:
    """Match JavaScript's `a ?? b`: zero/empty values do not fall through."""
    for key in keys:
        if key in item and item[key] is not None:
            return item[key]
    return 0


def _collect_tags(value: Any, output: set[str]) -> None:
    if value is None:
        return
    if isinstance(value, (list, tuple, set)):
        for child in value:
            _collect_tags(child, output)
        return
    if isinstance(value, dict):
        named = value.get("tag") or value.get("name") or value.get("id")
        if named:
            _collect_tags(named, output)
        else:
            for key, enabled in value.items():
                if enabled:
                    _collect_tags(key, output)
        return
    for raw in str(value).replace(";", ",").split(","):
        normalized = raw.strip().lower().replace(" ", "_").replace("-", "_")
        if normalized:
            output.add(normalized)


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
            "User-Agent": "Mozilla/5.0 gmgn_trading_bot/0.2.11",
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

    def fetch_holder_context(self, mint: str) -> tuple[dict[str, set[str]], float]:
        """Fetch holder tags and supply multiplier used by content.js."""
        params = urllib.parse.urlencode({"orderby": "amount_percentage", "direction": "desc", "limit": "100"})
        url = f"{self.host}/vas/api/v1/token_holders/sol/{mint}?{params}"
        request = urllib.request.Request(url, headers={
            "Accept": "application/json, text/plain, */*", "Cookie": self.cookie,
            "Origin": "https://gmgn.ai", "Referer": f"https://gmgn.ai/sol/token/{mint}",
            "User-Agent": "Mozilla/5.0 gmgn_trading_bot/0.2.11",
        })
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise GMGNError(f"GMGN holder context gagal: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("code") != 0:
            raise GMGNError("GMGN holder context API error")
        data = payload.get("data") or {}
        roots: list[Any] = [payload, data]
        if isinstance(data, dict):
            roots.append(data.get("data"))
        candidates: list[Any] = []
        for root in roots:
            if isinstance(root, list):
                candidates.append(root)
            elif isinstance(root, dict):
                candidates.extend(root.get(key) for key in ("list", "holders", "traders", "items", "records", "rank", "result"))
        holders = next((value for value in candidates if isinstance(value, list) and value), [])
        wallet_tags: dict[str, set[str]] = {}
        supplies: list[float] = []
        for item in holders:
            if not isinstance(item, dict):
                continue
            address = item.get("address") or item.get("maker") or item.get("wallet") or item.get("account_address")
            tags: set[str] = set()
            for key in ("tags", "maker_tags", "maker_token_tags", "maker_event_tags", "tag"):
                _collect_tags(item.get(key), tags)
            if item.get("is_new") is True:
                tags.add("fresh_wallet")
            if address and tags:
                wallet_tags[str(address)] = tags
            pct, amount = _number(item.get("amount_percentage") or item.get("hold_percentage")), _number(
                item.get("amount_cur") or item.get("balance") or item.get("amount")
            )
            if pct > 0 and amount > 0:
                supplies.append(amount / pct)
        supply = statistics.median(supplies) if supplies else 0.0
        return wallet_tags, supply

    def fetch_trades(
        self, mint: str, from_ts: int, to_ts: int, max_pages: int = 300, *, full_window: bool = False,
    ) -> list[Trade]:
        if not self.enabled:
            raise GMGNError("GMGN_WEB_COOKIE belum diisi di bot.env")
        result: dict[str, Trade] = {}

        def pull(query_from: int, query_to: int, page_limit: int, stop_at: int = 0) -> int:
            cursor: str | None = None
            oldest = query_to
            for _ in range(page_limit):
                history, cursor = self._page(mint, query_from, query_to, cursor)
                page_times: list[int] = []
                for item in history:
                    trade = normalize_trade(mint, item)
                    if trade:
                        page_times.append(trade.ts)
                        if from_ts <= trade.ts <= to_ts:
                            result[trade.trade_id] = trade
                if page_times:
                    oldest = min(oldest, min(page_times))
                if not cursor or not history or (stop_at > 0 and oldest <= stop_at):
                    break
                # Sama dengan cooldown Background Fetch ekstensi.
                time.sleep(0.8)
            return oldest

        if full_window:
            # Port persis strategi ekstensi: initial 48h jangan mengirim `from`
            # karena GMGN kadang memotong hasil jika range panjang diberikan.
            oldest = pull(0, to_ts, min(max_pages, 200), stop_at=from_ts)
            if oldest > from_ts:
                pull(from_ts, max(from_ts + 1, oldest - 1), min(max_pages, 80))
        else:
            pull(from_ts, to_ts, max_pages)
        return sorted(result.values(), key=lambda x: x.ts)


def normalize_trade(mint: str, item: dict[str, Any]) -> Trade | None:
    """Python port of content.js normalizeTradeItem (same fallbacks/corrections)."""
    maker_info = item.get("maker_info") if isinstance(item.get("maker_info"), dict) else {}
    wallet_info = item.get("wallet_info") if isinstance(item.get("wallet_info"), dict) else {}
    maker = (
        item.get("maker") or item.get("maker_address") or item.get("wallet") or item.get("address")
        or item.get("from_address") or item.get("owner") or item.get("trader")
        or maker_info.get("address") or wallet_info.get("address")
    )
    raw_event = str(
        item.get("event") or item.get("trade_type") or item.get("type") or item.get("direction")
        or item.get("side") or item.get("action") or ""
    ).lower().strip()
    if "buy" in raw_event and "buyback" not in raw_event:
        event = "buy"
    elif "sell" in raw_event:
        event = "sell"
    elif "is_buy" in item:
        event = "buy" if bool(item.get("is_buy")) else "sell"
    else:
        event = None
    if not maker or event is None:
        return None
    ts = int(_number(_nullish(
        item, "timestamp", "time", "ts", "created_at", "create_time", "block_time", "trade_time"
    )))
    if ts > 1_000_000_000_000:
        ts //= 1000
    sol = _number(_nullish(
        item, "quote_amount", "amount_sol", "sol_amount", "quote_volume", "sol", "quote"
    ))
    base_amount = _number(_nullish(
        item, "base_amount", "token_amount", "amount", "token_volume", "token"
    ))
    amount_usd = _number(_nullish(
        item, "amount_usd", "usd_amount", "cost_usd", "usd", "quote_value"
    ))
    price = _number(_nullish(item, "price_usd", "price"))
    if amount_usd <= 0 and base_amount > 0 and price > 0:
        amount_usd = base_amount * price
    if amount_usd > 0 and sol > 0:
        implied_sol_price = amount_usd / sol
        if implied_sol_price < 10.0 or implied_sol_price > 500.0:
            sol = amount_usd / 160.0
    # content.js tetap menyimpan trade price=0 untuk CVD/volume; hanya OHLC yang
    # menyaring price <= 0 saat buildBars.
    if ts <= 0 or sol < 0:
        return None
    tx_hash = str(item.get("tx_hash") or item.get("tx_id") or item.get("signature") or item.get("hash") or item.get("id") or "")
    if not tx_hash:
        stable = json.dumps(item, sort_keys=True, separators=(",", ":"), default=str).encode()
        tx_hash = "id_" + hashlib.sha256(stable).hexdigest()[:24]

    tags: set[str] = set()
    for source in (item, maker_info, wallet_info):
        for key in ("maker_tags", "maker_token_tags", "maker_event_tags", "tags", "tag"):
            _collect_tags(source.get(key), tags)
    if item.get("is_new") is True or maker_info.get("is_new") is True or wallet_info.get("is_new") is True:
        tags.add("fresh_wallet")
    trade_id = f"{tx_hash}:{event}:{ts}:{maker}"
    return Trade(trade_id, mint, str(maker), event, sol, price, ts, tx_hash, tuple(sorted(tags)))
