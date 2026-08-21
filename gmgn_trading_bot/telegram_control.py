from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .notifier import TelegramNotifier
from .state import StateStore

LOG = logging.getLogger(__name__)

HELP = """🤖 gmgn_trading_bot

/add <CA> [SYMBOL] — tambah dan backfill 48 jam
/remove <CA> — hapus token dan datanya
/list — watchlist + tombol hapus
/pause <CA> — jeda tanpa menghapus data
/resume <CA> — aktifkan kembali
/refresh <CA> — fetch ulang 48 jam
/levels — level aktif hasil SMART SEROK
/status — kondisi bot dan sumber data
/test — tes Telegram
/help — bantuan

Alert hanya 4 sinyal SMART SEROK. Auto-trade OFF."""


class TelegramController(threading.Thread):
    daemon = True

    def __init__(self, notifier: TelegramNotifier, state: StateStore, monitor: Any):
        super().__init__(name="telegram-controller")
        self.notifier = notifier
        self.state = state
        self.monitor = monitor
        self.stop_event = threading.Event()
        self.allowed_chat = str(notifier.chat_id or "")

    def stop(self) -> None:
        self.stop_event.set()

    def run(self) -> None:
        try:
            self.notifier.set_commands()
        except Exception as exc:
            LOG.warning("gagal memasang menu command Telegram: %s", exc)
        offset = int(self.state.get_kv("telegram_offset", "0") or 0)
        while not self.stop_event.is_set():
            try:
                updates = self.notifier.get_updates(offset, timeout=5)
                for update in updates:
                    offset = max(offset, int(update.get("update_id", 0)) + 1)
                    self.state.set_kv("telegram_offset", str(offset))
                    self._handle(update)
            except Exception as exc:  # keep monitor alive when Telegram is unavailable
                LOG.error("Telegram command polling gagal: %s", exc)
                time.sleep(5)

    def _authorized(self, chat_id: Any) -> bool:
        return str(chat_id) == self.allowed_chat

    def _handle(self, update: dict[str, Any]) -> None:
        callback = update.get("callback_query")
        if callback:
            message = callback.get("message") or {}
            chat = message.get("chat") or {}
            if not self._authorized(chat.get("id")):
                return
            data = str(callback.get("data") or "")
            if data.startswith("delete:"):
                mint = data.split(":", 1)[1]
                deleted = self.state.remove_watch(mint)
                self.notifier.answer_callback(str(callback.get("id")), "Dihapus" if deleted else "Tidak ditemukan")
                self.notifier.send_text(f"🗑 {'Dihapus' if deleted else 'Tidak ditemukan'}: {mint}")
            return

        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if not self._authorized(chat.get("id")):
            return
        text = str(message.get("text") or "").strip()
        if not text.startswith("/"):
            return
        parts = text.split()
        command = parts[0].split("@", 1)[0].lower()
        args = parts[1:]
        try:
            if command == "/add":
                if not args or not _valid_mint(args[0]):
                    self.notifier.send_text("Format: /add <MINT_SOLANA> [SYMBOL]")
                    return
                mint, symbol = args[0], args[1] if len(args) > 1 else args[0][:6]
                self.state.add_watch(mint, symbol)
                self.notifier.send_text(f"✅ {symbol} ditambahkan. Backfill raw trades 48 jam dimulai pada siklus berikutnya.")
            elif command == "/remove":
                if not args:
                    self.notifier.send_text("Format: /remove <MINT_SOLANA>")
                    return
                self.notifier.send_text("🗑 Token dihapus." if self.state.remove_watch(args[0]) else "Token tidak ditemukan.")
            elif command == "/list":
                self._send_list()
            elif command in {"/pause", "/resume"}:
                if not args:
                    self.notifier.send_text(f"Format: {command} <MINT_SOLANA>")
                    return
                enabled = command == "/resume"
                ok = self.state.set_enabled(args[0], enabled)
                self.notifier.send_text(("▶️ Aktif" if enabled else "⏸ Dijeda") if ok else "Token tidak ditemukan.")
            elif command == "/refresh":
                if not args:
                    self.notifier.send_text("Format: /refresh <MINT_SOLANA>")
                    return
                self.notifier.send_text("🔄 Backfill dijadwalkan." if self.state.request_refresh(args[0]) else "Token tidak ditemukan.")
            elif command == "/levels":
                self.notifier.send_text(self.monitor.levels_text())
            elif command == "/status":
                self.notifier.send_text(self.monitor.status_text())
            elif command == "/test":
                self.notifier.send_text("✅ Telegram control aktif. Auto-trade OFF.")
            elif command in {"/start", "/help"}:
                self.notifier.send_text(HELP)
            else:
                self.notifier.send_text("Command tidak dikenal. Gunakan /help")
        except Exception as exc:
            LOG.exception("command Telegram gagal")
            self.notifier.send_text(f"❌ Command gagal: {exc}")

    def _send_list(self) -> None:
        rows = self.state.list_watchlist()
        if not rows:
            self.notifier.send_text("Watchlist kosong. Gunakan /add <CA> [SYMBOL]")
            return
        self.notifier.send_text(f"📋 Watchlist: {len(rows)} token")
        for row in rows:
            status = "aktif" if row["enabled"] else "pause"
            count = self.state.trade_count(row["mint"])
            text = f"{row['symbol']} · {status}\n{row['mint']}\nRaw trades tersimpan: {count}"
            keyboard = {"inline_keyboard": [[{"text": f"🗑 Hapus {row['symbol']}", "callback_data": f"delete:{row['mint']}"}]]}
            self.notifier.send_text(text, keyboard)


def _valid_mint(value: str) -> bool:
    return 32 <= len(value) <= 44 and value.isalnum()
