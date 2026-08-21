from __future__ import annotations

import sqlite3
import time
from pathlib import Path


class StateStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS token_state (
                mint TEXT NOT NULL,
                resolution TEXT NOT NULL,
                last_closed_ms INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (mint, resolution)
            );
            CREATE TABLE IF NOT EXISTS sent_events (
                event_id TEXT PRIMARY KEY,
                sent_at INTEGER NOT NULL
            );
            """
        )
        self.connection.commit()

    def last_closed(self, mint: str, resolution: str) -> int | None:
        row = self.connection.execute(
            "SELECT last_closed_ms FROM token_state WHERE mint=? AND resolution=?", (mint, resolution)
        ).fetchone()
        return int(row[0]) if row else None

    def set_last_closed(self, mint: str, resolution: str, start_ms: int) -> None:
        self.connection.execute(
            """INSERT INTO token_state(mint,resolution,last_closed_ms,updated_at) VALUES(?,?,?,?)
               ON CONFLICT(mint,resolution) DO UPDATE SET
                 last_closed_ms=excluded.last_closed_ms, updated_at=excluded.updated_at""",
            (mint, resolution, start_ms, int(time.time())),
        )
        self.connection.commit()

    def was_sent(self, event_id: str) -> bool:
        return self.connection.execute("SELECT 1 FROM sent_events WHERE event_id=?", (event_id,)).fetchone() is not None

    def mark_sent(self, event_id: str) -> None:
        self.connection.execute("INSERT OR IGNORE INTO sent_events(event_id,sent_at) VALUES(?,?)", (event_id, int(time.time())))
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()
