import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gmgn_trading_bot.config import load_config, load_env_file
from gmgn_trading_bot.engine import (
    Bar, SIG_RESISTANCE, SIG_RETEST_RES, SIG_RETEST_SUP, SIG_SUPPORT, scan_smart_serok,
)
from gmgn_trading_bot.gmgn import GMGNClient
from gmgn_trading_bot.gmgn_web import GMGNWebClient, normalize_trade
from gmgn_trading_bot.models import Candle, WatchToken
from gmgn_trading_bot.notifier import TelegramNotifier
from gmgn_trading_bot.state import StateStore
from gmgn_trading_bot.telegram_control import TelegramController


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


class ConfigTests(unittest.TestCase):
    def test_env_file_and_disabled_empty_slot(self):
        config_text = '''
[monitor]
resolution = "1h"
[[watchlist]]
mint = ""
enabled = false
[[watchlist]]
mint = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
symbol = "ACTIVE"
enabled = true
'''
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / "bot.env"
            env_path.write_text("GMGN_API_KEY=from-file\nGMGN_WEB_COOKIE=session=value\n")
            config_path = Path(directory) / "config.toml"
            config_path.write_text(config_text)
            with patch.dict(os.environ, {}, clear=True):
                load_env_file(env_path)
                config = load_config(config_path)
        self.assertEqual(config.web_cookie, "session=value")
        self.assertEqual([token.symbol for token in config.watchlist], ["ACTIVE"])


class SmartSerokEngineTests(unittest.TestCase):
    def test_resistance_and_retest_are_detected(self):
        def bar(i, close, high, low, cvd, r, cum):
            return Bar(i * 3600, 100, high, low, close, cvd, 20, abs(r), r, False, cum)
        bars = [
            bar(0, 100, 101, 99, 1, 5, 1),
            bar(1, 100, 101, 99, 6, 60, 7),
            bar(2, 95, 98, 94, -8, -10, -1),
            bar(3, 94, 97, 93, -4, -10, -5),
            bar(4, 90, 92, 89, -1, -2, -6),
            bar(5, 90, 92, 89, -1, -2, -7),
            bar(6, 101, 101.2, 100.5, 4, 1, -3),
        ]
        events, levels = scan_smart_serok("A" * 32, "TEST", bars)
        self.assertEqual([event.signal for event in events], [SIG_RESISTANCE, SIG_RETEST_RES])
        self.assertEqual(len(levels), 1)

    def test_support_and_retest_are_detected(self):
        def bar(i, close, high, low, cvd, r, cum):
            return Bar(i * 3600, 100, high, low, close, cvd, 20, abs(r), r, False, cum)
        bars = [
            bar(0, 100, 101, 99, -1, -5, -1),
            bar(1, 100, 101, 99, -6, -60, -7),
            bar(2, 105, 106, 102, 8, 10, 1),
            bar(3, 106, 107, 103, 4, 10, 5),
            bar(4, 110, 111, 108, 1, 2, 6),
            bar(5, 110, 111, 108, 1, 2, 7),
            bar(6, 99, 99.5, 98.8, -4, -1, 3),
        ]
        events, levels = scan_smart_serok("B" * 32, "TEST2", bars)
        self.assertEqual([event.signal for event in events], [SIG_SUPPORT, SIG_RETEST_SUP])
        self.assertEqual(len(levels), 1)


class RawTradeTests(unittest.TestCase):
    def test_normalize_gmgn_trade(self):
        trade = normalize_trade("A" * 32, {
            "maker": "wallet", "event": "buy", "timestamp": 1_700_000_000,
            "quote_amount": "1.25", "price_usd": "0.0001", "tx_hash": "tx",
            "maker_tags": ["mev_bot"],
        })
        self.assertIsNotNone(trade)
        self.assertEqual(trade.event, "buy")
        self.assertIn("mev_bot", trade.tags)

    def test_paginates_until_cursor_is_empty(self):
        class Response(io.BytesIO):
            headers = type("Headers", (), {"get_content_charset": lambda self: "utf-8"})()
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): self.close()
        item = {
            "maker": "wallet", "event": "sell", "timestamp": 1_700_000_000,
            "quote_amount": "2", "price_usd": "0.1", "tx_hash": "tx-2",
        }
        pages = [
            Response(json.dumps({"code": 0, "data": {"history": [item], "next": "cursor-2"}}).encode()),
            Response(json.dumps({"code": 0, "data": {"history": [], "next": ""}}).encode()),
        ]
        client = GMGNWebClient("cookie=value")
        with patch("gmgn_trading_bot.gmgn_web.urllib.request.urlopen", side_effect=pages) as request, patch(
            "gmgn_trading_bot.gmgn_web.time.sleep"
        ):
            trades = client.fetch_trades("A" * 32, 1_699_999_000, 1_700_001_000)
        self.assertEqual(len(trades), 1)
        self.assertEqual(request.call_count, 2)


class GMGNClientTests(unittest.TestCase):
    def test_server_date_corrects_expired_auth_clock(self):
        client = GMGNClient("key")
        with patch("gmgn_trading_bot.gmgn.time.time", return_value=900.0), patch(
            "gmgn_trading_bot.gmgn.time.monotonic", side_effect=[50.0, 52.0]
        ):
            self.assertTrue(client._sync_clock_from_http_date("Thu, 01 Jan 1970 00:16:40 GMT"))
            self.assertEqual(client.now_ms(), 1_002_000)

    def test_rejects_implausible_server_date(self):
        client = GMGNClient("key")
        with patch("gmgn_trading_bot.gmgn.time.time", return_value=0.0):
            self.assertFalse(client._sync_clock_from_http_date("Thu, 01 Jan 1971 00:00:00 GMT"))


class TelegramTests(unittest.TestCase):
    def test_recent_chats_extracts_private_message(self):
        notifier = TelegramNotifier("token", None)
        updates = [{"message": {"chat": {"id": 6743, "type": "private", "username": "tester"}, "text": "/start"}}]
        with patch.object(notifier, "_call", return_value=updates):
            chats = notifier.recent_chats()
        self.assertEqual(chats, [{"id": "6743", "type": "private", "name": "tester", "text": "/start"}])


class TelegramControlTests(unittest.TestCase):
    def test_add_is_authorized_and_persistent(self):
        class Notifier:
            enabled = True
            chat_id = "123"
            sent = []
            stale = False
            def send_text(self, text, reply_markup=None): self.sent.append(text)
            def answer_callback(self, callback_id, text):
                if self.stale:
                    raise RuntimeError("query is too old")
        class Monitor:
            last_cycle_at = None
            last_error = None
            level_cache = {}
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(Path(directory) / "state.db")
            notifier = Notifier()
            controller = TelegramController(notifier, store, Monitor())
            controller._handle({"message": {"chat": {"id": 999}, "text": "/add " + "A" * 32}})
            self.assertEqual(store.list_watchlist(), [])
            controller._handle({"message": {"chat": {"id": 123}, "text": "/add " + "A" * 32 + " TEST"}})
            self.assertEqual(store.list_watchlist()[0]["symbol"], "TEST")

            notifier.stale = True
            controller._handle({"callback_query": {
                "id": "old", "data": "delete:" + "A" * 32,
                "message": {"chat": {"id": 123}},
            }})
            self.assertEqual(store.list_watchlist(), [])
            store.seed_watchlist((WatchToken("A" * 32, "DEFAULT", True),))
            self.assertEqual(store.list_watchlist(), [])
            store.close()


class StateTests(unittest.TestCase):
    def test_migrates_v015_database_without_losing_dedup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.db"
            connection = sqlite3.connect(path)
            connection.execute("CREATE TABLE sent_events(event_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL)")
            connection.execute("INSERT INTO sent_events VALUES('old-event', 1)")
            connection.commit()
            connection.close()
            store = StateStore(path)
            tables = {row[0] for row in store.connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"watchlist", "trades", "kv"}.issubset(tables))
            self.assertTrue(store.was_sent("old-event"))
            store.close()

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
