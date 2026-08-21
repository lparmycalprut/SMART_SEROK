from __future__ import annotations

import logging
import time

from .config import BotConfig, resolution_seconds
from .gmgn import GMGNClient, GMGNError
from .notifier import TelegramNotifier
from .signals import detect_chart_signals
from .state import StateStore

LOG = logging.getLogger(__name__)


class WatchlistMonitor:
    def __init__(self, config: BotConfig):
        self.config = config
        self.client = GMGNClient(config.api_key, config.api_host)
        self.state = StateStore(config.db_path)
        self.notifier = TelegramNotifier(config.telegram_token, config.telegram_chat_id)

    def run_cycle(self) -> None:
        for index, token in enumerate(self.config.watchlist):
            if index:
                time.sleep(self.config.request_spacing_seconds)
            try:
                candles = self.client.get_klines(
                    self.config.chain, token.mint, self.config.resolution, bars=self.config.history_bars
                )
            except GMGNError as exc:
                LOG.error("%s (%s): %s", token.symbol, token.mint[:8], exc)
                continue

            now_ms = int(time.time() * 1000)
            period_ms = resolution_seconds(self.config.resolution) * 1000
            grace_ms = self.config.close_grace_seconds * 1000
            closed = [c for c in candles if c.start_ms + period_ms + grace_ms <= now_ms]
            if not closed:
                LOG.info("%s: belum ada candle selesai", token.symbol)
                continue

            newest = closed[-1]
            previous_seen = self.state.last_closed(token.mint, self.config.resolution)
            if previous_seen is None and not self.config.alert_on_startup:
                self.state.set_last_closed(token.mint, self.config.resolution, newest.start_ms)
                LOG.info("%s: warm-up di candle %s (tanpa alert historis)", token.symbol, newest.start_iso)
                continue
            if previous_seen is not None and newest.start_ms <= previous_seen:
                LOG.info("%s: tidak ada candle baru · close %.12g", token.symbol, newest.close)
                continue

            signals = detect_chart_signals(
                token,
                closed,
                lookback=self.config.breakout_lookback,
                min_volume_ratio=self.config.min_volume_ratio,
                min_move_pct=self.config.min_candle_move_pct,
            )
            LOG.info(
                "%s: candle baru %s · O %.12g H %.12g L %.12g C %.12g · %+.2f%% · %d signal",
                token.symbol, newest.start_iso, newest.open, newest.high, newest.low, newest.close,
                newest.change_pct, len(signals),
            )
            for signal in signals:
                if self.state.was_sent(signal.event_id):
                    continue
                self.notifier.send_signal(signal, self.config.resolution)
                self.state.mark_sent(signal.event_id)
            self.state.set_last_closed(token.mint, self.config.resolution, newest.start_ms)

    def run_forever(self) -> None:
        LOG.info(
            "monitor aktif · %d token · TF %s · Telegram %s · auto-trade OFF",
            len(self.config.watchlist), self.config.resolution, "ON" if self.notifier.enabled else "OFF",
        )
        try:
            while True:
                started = time.monotonic()
                self.run_cycle()
                elapsed = time.monotonic() - started
                time.sleep(max(1.0, self.config.poll_seconds - elapsed))
        except KeyboardInterrupt:
            LOG.info("monitor dihentikan")
        finally:
            self.state.close()
