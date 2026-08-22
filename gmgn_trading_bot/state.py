from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .engine import Trade
from .models import WatchToken


class StateStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS token_state (
                    mint TEXT NOT NULL, resolution TEXT NOT NULL,
                    last_closed_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (mint, resolution)
                );
                CREATE TABLE IF NOT EXISTS sent_events (
                    event_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS watchlist (
                    mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                    added_at INTEGER NOT NULL, refresh_requested INTEGER NOT NULL DEFAULT 1,
                    last_fetch INTEGER, last_error TEXT
                );
                CREATE TABLE IF NOT EXISTS trades (
                    trade_id TEXT PRIMARY KEY, mint TEXT NOT NULL, maker TEXT NOT NULL,
                    event TEXT NOT NULL, sol REAL NOT NULL, price REAL NOT NULL,
                    ts INTEGER NOT NULL, tx_hash TEXT NOT NULL, tags_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_trades_mint_ts ON trades(mint, ts);
                CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                """
            )
            self.connection.commit()

    def seed_watchlist(self, tokens: tuple[WatchToken, ...]) -> None:
        now = int(time.time())
        with self.lock:
            for token in tokens:
                removed = self.connection.execute(
                    "SELECT value FROM kv WHERE key=?", (f"removed_watch:{token.mint}",)
                ).fetchone()
                if removed and str(removed[0]) == "1":
                    continue
                self.connection.execute(
                    "INSERT OR IGNORE INTO watchlist(mint,symbol,enabled,added_at) VALUES(?,?,1,?)",
                    (token.mint, token.symbol, now),
                )
            self.connection.commit()

    def list_watchlist(self, enabled_only: bool = False) -> list[sqlite3.Row]:
        sql = "SELECT * FROM watchlist" + (" WHERE enabled=1" if enabled_only else "") + " ORDER BY added_at, symbol"
        with self.lock:
            return list(self.connection.execute(sql).fetchall())

    def add_watch(self, mint: str, symbol: str) -> None:
        with self.lock:
            self.connection.execute("DELETE FROM kv WHERE key=?", (f"removed_watch:{mint}",))
            self.connection.execute(
                """INSERT INTO watchlist(mint,symbol,enabled,added_at,refresh_requested,last_error)
                   VALUES(?,?,1,?,1,NULL) ON CONFLICT(mint) DO UPDATE SET
                   symbol=excluded.symbol,enabled=1,refresh_requested=1,last_error=NULL""",
                (mint, symbol or mint[:6], int(time.time())),
            )
            self.connection.commit()

    def remove_watch(self, mint: str) -> bool:
        with self.lock:
            cursor = self.connection.execute("DELETE FROM watchlist WHERE mint=?", (mint,))
            self.connection.execute("DELETE FROM trades WHERE mint=?", (mint,))
            self.connection.execute("DELETE FROM kv WHERE key IN (?,?)", (f"initialized:{mint}", f"error_alert:{mint}"))
            if cursor.rowcount > 0:
                # Tombstone mencegah seed dari config menghidupkan kembali token
                # yang sengaja dihapus melalui Telegram pada restart berikutnya.
                self.connection.execute(
                    "INSERT INTO kv(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value='1'",
                    (f"removed_watch:{mint}",),
                )
            self.connection.commit()
            return cursor.rowcount > 0

    def set_enabled(self, mint: str, enabled: bool) -> bool:
        with self.lock:
            cursor = self.connection.execute("UPDATE watchlist SET enabled=? WHERE mint=?", (int(enabled), mint))
            self.connection.commit()
            return cursor.rowcount > 0

    def request_refresh(self, mint: str) -> bool:
        with self.lock:
            cursor = self.connection.execute("UPDATE watchlist SET refresh_requested=1 WHERE mint=?", (mint,))
            if cursor.rowcount > 0:
                self.connection.execute("DELETE FROM kv WHERE key=?", (f"initialized:{mint}",))
            self.connection.commit()
            return cursor.rowcount > 0

    def request_refresh_all(self, *, suppress_history: bool = False) -> None:
        with self.lock:
            self.connection.execute("UPDATE watchlist SET refresh_requested=1")
            if suppress_history:
                self.connection.execute("DELETE FROM kv WHERE key LIKE 'initialized:%'")
            self.connection.commit()

    def mark_fetch(self, mint: str, error: str | None = None) -> None:
        with self.lock:
            self.connection.execute(
                "UPDATE watchlist SET last_fetch=?,last_error=?,refresh_requested=0 WHERE mint=?",
                (int(time.time()), error, mint),
            )
            self.connection.commit()

    def add_trades(self, trades: list[Trade]) -> int:
        with self.lock:
            before = self.connection.total_changes
            self._insert_trades(trades)
            self.connection.commit()
            return self.connection.total_changes - before

    def replace_trades(self, mint: str, trades: list[Trade]) -> int:
        """Atomically replace one token after a successful full-window fetch."""
        with self.lock:
            self.connection.execute("DELETE FROM trades WHERE mint=?", (mint,))
            self._insert_trades(trades)
            self.connection.commit()
            return len(trades)

    def _insert_trades(self, trades: list[Trade]) -> None:
        self.connection.executemany(
            """INSERT OR IGNORE INTO trades
               (trade_id,mint,maker,event,sol,price,ts,tx_hash,tags_json)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            [(x.trade_id, x.mint, x.maker, x.event, x.sol, x.price, x.ts, x.tx_hash, json.dumps(x.tags)) for x in trades],
        )

    def get_trades(self, mint: str, since_ts: int = 0) -> list[Trade]:
        with self.lock:
            rows = self.connection.execute(
                "SELECT * FROM trades WHERE mint=? AND ts>=? ORDER BY ts", (mint, since_ts)
            ).fetchall()
        return [Trade(row["trade_id"], row["mint"], row["maker"], row["event"], row["sol"], row["price"], row["ts"], row["tx_hash"], tuple(json.loads(row["tags_json"]))) for row in rows]

    def max_trade_ts(self, mint: str) -> int | None:
        with self.lock:
            row = self.connection.execute("SELECT MAX(ts) value FROM trades WHERE mint=?", (mint,)).fetchone()
            return int(row["value"]) if row and row["value"] is not None else None

    def trade_count(self, mint: str) -> int:
        with self.lock:
            return int(self.connection.execute("SELECT COUNT(*) FROM trades WHERE mint=?", (mint,)).fetchone()[0])

    def get_kv(self, key: str, default: str = "") -> str:
        with self.lock:
            row = self.connection.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
            return str(row[0]) if row else default

    def set_kv(self, key: str, value: str) -> None:
        with self.lock:
            self.connection.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
            self.connection.commit()

    def last_closed(self, mint: str, resolution: str) -> int | None:
        with self.lock:
            row = self.connection.execute("SELECT last_closed_ms FROM token_state WHERE mint=? AND resolution=?", (mint, resolution)).fetchone()
            return int(row[0]) if row else None

    def set_last_closed(self, mint: str, resolution: str, start_ms: int) -> None:
        with self.lock:
            self.connection.execute(
                """INSERT INTO token_state(mint,resolution,last_closed_ms,updated_at) VALUES(?,?,?,?)
                   ON CONFLICT(mint,resolution) DO UPDATE SET last_closed_ms=excluded.last_closed_ms,updated_at=excluded.updated_at""",
                (mint, resolution, start_ms, int(time.time())),
            )
            self.connection.commit()

    def was_sent(self, event_id: str) -> bool:
        with self.lock:
            return self.connection.execute("SELECT 1 FROM sent_events WHERE event_id=?", (event_id,)).fetchone() is not None

    def mark_sent(self, event_id: str) -> None:
        with self.lock:
            self.connection.execute("INSERT OR IGNORE INTO sent_events(event_id,sent_at) VALUES(?,?)", (event_id, int(time.time())))
            self.connection.commit()

    def close(self) -> None:
        with self.lock:
            self.connection.close()
