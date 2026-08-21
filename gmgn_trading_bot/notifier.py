from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

LOG = logging.getLogger(__name__)


class TelegramNotifier:
    def __init__(self, token: str | None, chat_id: str | None):
        self.token = token
        self.chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

    def _call(self, method: str, payload: dict[str, Any] | None = None) -> Any:
        if not self.token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN belum diisi di bot.env")
        data = urllib.parse.urlencode(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"https://api.telegram.org/bot{self.token}/{method}",
            data=data,
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                description = json.loads(detail).get("description", detail)
            except json.JSONDecodeError:
                description = detail
            raise RuntimeError(f"Telegram {method} gagal: {description}") from exc
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Telegram {method} gagal: {exc}") from exc
        if not body.get("ok"):
            raise RuntimeError(f"Telegram {method} gagal: {body.get('description', 'unknown')}")
        return body.get("result")

    def get_me(self) -> dict[str, Any]:
        result = self._call("getMe")
        return result if isinstance(result, dict) else {}

    def get_updates(self, offset: int = 0, timeout: int = 5) -> list[dict[str, Any]]:
        result = self._call("getUpdates", {"offset": str(offset), "timeout": str(timeout)})
        return result if isinstance(result, list) else []

    def recent_chats(self) -> list[dict[str, str]]:
        result = self.get_updates(timeout=0)
        chats: dict[str, dict[str, str]] = {}
        for update in result if isinstance(result, list) else []:
            event = update.get("message") or update.get("channel_post") or update.get("edited_message") or {}
            chat = event.get("chat") or {}
            chat_id = str(chat.get("id", ""))
            if not chat_id:
                continue
            chats[chat_id] = {
                "id": chat_id,
                "type": str(chat.get("type", "")),
                "name": str(chat.get("username") or chat.get("title") or chat.get("first_name") or ""),
                "text": str(event.get("text") or ""),
            }
        return list(chats.values())

    def send_text(self, text: str, reply_markup: dict[str, Any] | None = None) -> None:
        if not self.chat_id:
            raise RuntimeError("TELEGRAM_CHAT_ID belum diisi di bot.env")
        payload = {"chat_id": self.chat_id, "text": text, "disable_web_page_preview": "true"}
        if reply_markup is not None:
            payload["reply_markup"] = json.dumps(reply_markup, separators=(",", ":"))
        self._call("sendMessage", payload)

    def answer_callback(self, callback_id: str, text: str) -> None:
        self._call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text})

    def set_commands(self) -> None:
        commands = [
            {"command": "add", "description": "Tambah CA ke watchlist"},
            {"command": "list", "description": "Watchlist dan tombol hapus"},
            {"command": "levels", "description": "Level SMART SEROK aktif"},
            {"command": "status", "description": "Status bot dan provider"},
            {"command": "refresh", "description": "Backfill ulang satu CA"},
            {"command": "help", "description": "Daftar command"},
        ]
        self._call("setMyCommands", {"commands": json.dumps(commands, separators=(",", ":"))})
