from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from .config import BotConfig
from .engine import Level, build_bars, event_message, fmt_mc, fmt_wib, scan_smart_serok
from .gmgn import GMGNClient, GMGNError
from .gmgn_web import GMGNWebClient
from .notifier import TelegramNotifier
from .state import StateStore
from .telegram_control import TelegramController

LOG = logging.getLogger(__name__)
WIB = ZoneInfo("Asia/Jakarta")


class WatchlistMonitor:
    def __init__(self, config: BotConfig):
        self.config = config
        self.client = GMGNClient(config.api_key, config.api_host)
        self.raw_client = GMGNWebClient(config.web_cookie, config.web_host)
        self.state = StateStore(config.db_path)
        self.state.seed_watchlist(config.watchlist)
        self.notifier = TelegramNotifier(config.telegram_token, config.telegram_chat_id)
        self.controller = TelegramController(self.notifier, self.state, self) if self.notifier.enabled else None
        self.started_at = time.time()
        self.last_cycle_at = 0.0
        self.last_error = ""
        self.level_cache: dict[str, tuple[str, list[Level]]] = {}
        self.cache_lock = threading.RLock()

    def run_cycle(self) -> None:
        rows = self.state.list_watchlist(enabled_only=True)
        for index, row in enumerate(rows):
            if index:
                time.sleep(self.config.request_spacing_seconds)
            self._monitor_token(str(row["mint"]), str(row["symbol"]), bool(row["refresh_requested"]))
        self.last_cycle_at = time.time()

    def _monitor_token(self, mint: str, symbol: str, force_refresh: bool) -> None:
        now_ts = int(self.client._server_now())
        previous_max = self.state.max_trade_ts(mint)
        # Terpisah dari keberadaan raw trade: jika proses gagal setelah INSERT tetapi
        # sebelum scan selesai, siklus berikutnya tetap dianggap initial backfill.
        first_backfill = self.state.get_kv(f"initialized:{mint}") != "1"
        from_ts = now_ts - self.config.backfill_hours * 3600 if force_refresh or first_backfill else max(0, (previous_max or 0) + 1)
        try:
            trades = self.raw_client.fetch_trades(mint, from_ts, now_ts)
            added = self.state.add_trades(trades)
            self.state.mark_fetch(mint)
            self.state.set_kv(f"error_alert:{mint}", "")
            all_trades = self.state.get_trades(mint)
            if not all_trades:
                LOG.info("%s: raw trade belum tersedia", symbol)
                return
            mc_per_price = self._mc_per_price(mint)
            bars = build_bars(all_trades, now_ts - self.config.close_grace_seconds, 3600, mc_per_price)
            events, levels = scan_smart_serok(mint, symbol, bars)
            with self.cache_lock:
                self.level_cache[mint] = (symbol, levels)

            if first_backfill:
                for event in events:
                    self.state.mark_sent(event.event_id)
                self.state.set_kv(f"initialized:{mint}", "1")
                LOG.info(
                    "%s: backfill %dh selesai · +%d trade · %d bar · %d level · %d sinyal historis tidak dikirim",
                    symbol, self.config.backfill_hours, added, len(bars), len(levels), len(events),
                )
                if self.notifier.enabled:
                    self.notifier.send_text(
                        f"✅ {symbol} siap dipantau\nBackfill: {self.config.backfill_hours} jam\n"
                        f"Raw trades: {len(all_trades)}\nCandle 1H: {len(bars)}\n"
                        f"Level aktif: {len(levels)}\nSinyal historis tidak dikirim."
                    )
                return

            new_events = 0
            for event in events:
                if self.state.was_sent(event.event_id):
                    continue
                self.notifier.send_text(event_message(event))
                self.state.mark_sent(event.event_id)
                new_events += 1
            LOG.info("%s: +%d raw trade · %d bar · %d level · %d sinyal baru", symbol, added, len(bars), len(levels), new_events)
        except Exception as exc:
            self.last_error = f"{symbol}: {exc}"
            self.state.mark_fetch(mint, str(exc))
            LOG.error("%s (%s): %s", symbol, mint[:8], exc)
            previous_alert = self.state.get_kv(f"error_alert:{mint}")
            if self.notifier.enabled and previous_alert != str(exc):
                try:
                    self.notifier.send_text(
                        f"⚠️ DATA PROVIDER ERROR\nToken: {symbol}\n{exc}\n\n"
                        "Jika 401/403, perbarui GMGN_WEB_COOKIE di bot.env. Auto-trade OFF."
                    )
                    self.state.set_kv(f"error_alert:{mint}", str(exc))
                except Exception as notify_exc:
                    LOG.error("gagal mengirim provider error ke Telegram: %s", notify_exc)

    def _mc_per_price(self, mint: str) -> float:
        try:
            info = self.client.get_token_info("sol", mint)
        except GMGNError:
            return 0.0
        roots = [info]
        for key in ("token", "token_info", "base_token_info"):
            if isinstance(info.get(key), dict):
                roots.append(info[key])
        for root in roots:
            try:
                market_cap = float(root.get("market_cap") or root.get("usd_market_cap") or root.get("market_cap_usd") or 0)
                price = root.get("price")
                if isinstance(price, dict):
                    price = price.get("price") or price.get("price_usd")
                price_value = float(price or root.get("price_usd") or root.get("usd_price") or 0)
                supply = float(root.get("total_supply") or root.get("circulating_supply") or root.get("supply") or 0)
                if supply > 0:
                    return supply
                if market_cap > 0 and price_value > 0:
                    return market_cap / price_value
            except (TypeError, ValueError):
                continue
        return 0.0

    def levels_text(self) -> str:
        with self.cache_lock:
            if not self.level_cache:
                return "Belum ada cache level. Tunggu backfill selesai."
            lines = ["📐 LEVEL SMART SEROK"]
            for symbol, levels in self.level_cache.values():
                lines.append(f"\n{symbol}: {len(levels)} level")
                for level in levels[-10:]:
                    label = "Resistance" if level.kind == "resistance" else "Support"
                    lines.append(f"• {label} {fmt_mc(level.line_mc)} · {fmt_wib(level.start)} · {'armed' if level.armed else 'menunggu'}")
            return "\n".join(lines)

    def status_text(self) -> str:
        rows = self.state.list_watchlist()
        active = sum(1 for row in rows if row["enabled"])
        uptime = int(time.time() - self.started_at)
        last = datetime.fromtimestamp(self.last_cycle_at, WIB).strftime("%H:%M:%S WIB") if self.last_cycle_at else "belum"
        return (
            "🤖 STATUS gmgn_trading_bot\n"
            f"Uptime: {uptime // 3600}j {(uptime % 3600) // 60}m\n"
            f"Watchlist: {active} aktif / {len(rows)} total\n"
            f"GMGN OpenAPI: ON\nGMGN raw trades: {'ON' if self.raw_client.enabled else 'OFF'}\n"
            f"Telegram control: {'ON' if self.notifier.enabled else 'OFF'}\n"
            f"Siklus terakhir: {last}\nError terakhir: {self.last_error or '-'}\nAuto-trade: OFF"
        )

    def run_forever(self) -> None:
        LOG.info(
            "monitor aktif · %d token · TF 1h · Telegram %s · raw trades %s · auto-trade OFF",
            len(self.state.list_watchlist(enabled_only=True)), "ON" if self.notifier.enabled else "OFF",
            "ON" if self.raw_client.enabled else "OFF",
        )
        if self.controller:
            self.controller.start()
        try:
            while True:
                started = time.monotonic()
                self.run_cycle()
                time.sleep(max(1.0, self.config.poll_seconds - (time.monotonic() - started)))
        except KeyboardInterrupt:
            LOG.info("monitor dihentikan")
        finally:
            if self.controller:
                self.controller.stop()
                self.controller.join(timeout=7)
            self.state.close()
