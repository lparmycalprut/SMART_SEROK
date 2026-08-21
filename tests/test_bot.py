import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gmgn_trading_bot.config import load_config, load_env_file
from gmgn_trading_bot.models import Candle, WatchToken
from gmgn_trading_bot.signals import detect_chart_signals
from gmgn_trading_bot.state import StateStore


class CandleTests(unittest.TestCase):
    def test_parse_documented_dict(self):
        candle = Candle.from_api({
            "time": 1_700_000_000_000, "open": "1", "high": "1.3", "low": "0.9",
            "close": "1.2", "volume": "100", "amount": "200",
        })
        self.assertEqual(candle.close, 1.2)
        self.assertAlmostEqual(candle.change_pct, 20.0)

    def test_seconds_are_normalized(self):
        self.assertEqual(Candle.from_api([1_700_000_000, 1, 2, 0.5, 1.5, 10]).start_ms, 1_700_000_000_000)

    def test_display_time_is_wib(self):
        candle = Candle(0, 1, 2, 0.5, 1.5, 10, 0)
        self.assertEqual(candle.start_wib, "01-01-1970 07:00 WIB")


class SignalTests(unittest.TestCase):
    def test_breakout(self):
        previous = [Candle(i * 1000, 10, 11, 9, 10, 100, 0) for i in range(20)]
        latest = Candle(21_000, 10, 13, 9.8, 12, 200, 0)
        signals = detect_chart_signals(
            WatchToken("A" * 32, "TEST"), previous + [latest],
            lookback=20, min_volume_ratio=1.5, min_move_pct=3,
        )
        self.assertEqual([s.kind for s in signals], ["CHART_BREAKOUT"])

    def test_no_signal_without_volume(self):
        previous = [Candle(i * 1000, 10, 11, 9, 10, 100, 0) for i in range(20)]
        latest = Candle(21_000, 10, 13, 9.8, 12, 120, 0)
        self.assertEqual(detect_chart_signals(
            WatchToken("A" * 32, "TEST"), previous + [latest],
            lookback=20, min_volume_ratio=1.5, min_move_pct=3,
        ), [])


class ConfigTests(unittest.TestCase):
    def test_env_file_loads_secrets_without_overriding_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bot.env"
            path.write_text('GMGN_API_KEY="from-file"\nTELEGRAM_CHAT_ID=-123\n')
            with patch.dict(os.environ, {"GMGN_API_KEY": "from-process"}, clear=True):
                self.assertTrue(load_env_file(path))
                self.assertEqual(os.environ["GMGN_API_KEY"], "from-process")
                self.assertEqual(os.environ["TELEGRAM_CHAT_ID"], "-123")

    def test_disabled_empty_watchlist_slot_is_ignored(self):
        text = '''
[monitor]
resolution = "1h"
[[watchlist]]
mint = ""
symbol = "NANTI"
enabled = false
[[watchlist]]
mint = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
symbol = "ACTIVE"
enabled = true
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_text(text)
            with patch.dict(os.environ, {"GMGN_API_KEY": "test-key"}, clear=False):
                config = load_config(path)
        self.assertEqual([token.symbol for token in config.watchlist], ["ACTIVE"])


class StateTests(unittest.TestCase):
    def test_persists_dedup(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(Path(directory) / "state.db")
            store.set_last_closed("mint", "1h", 123)
            store.mark_sent("event")
            self.assertEqual(store.last_closed("mint", "1h"), 123)
            self.assertTrue(store.was_sent("event"))
            store.close()


if __name__ == "__main__":
    unittest.main()
