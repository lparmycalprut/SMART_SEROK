from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .models import ChartSignal

LOG = logging.getLogger(__name__)


class TelegramNotifier:
    def __init__(self, token: str | None, chat_id: str | None):
        self.token = token
        self.chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

    def _call(self, method: str, payload: dict[str, str] | None = None) -> Any:
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

    def recent_chats(self) -> list[dict[str, str]]:
        result = self._call("getUpdates")
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

    def send_text(self, text: str) -> None:
        if not self.chat_id:
            raise RuntimeError("TELEGRAM_CHAT_ID belum diisi di bot.env")
        self._call("sendMessage", {
            "chat_id": self.chat_id,
            "text": text,
            "disable_web_page_preview": "true",
        })

    def send_signal(self, signal: ChartSignal, resolution: str) -> None:
        icon = "🔵" if signal.kind == "CHART_BREAKOUT" else "🟠"
        text = (
            f"{icon} {signal.kind.replace('_', ' ')}\n\n"
            f"Token: {signal.symbol}\nMint: {signal.mint}\nTF: {resolution}\n"
            f"Close: {signal.candle.close:.12g}\n{signal.message}\n\n"
            "Mode: OHLCV chart-only · bukan sinyal R/CVD SMART SEROK\n"
            "Auto-trade: OFF"
        )
        LOG.warning("SIGNAL %s %s — %s", signal.symbol, signal.kind, signal.message)
        if self.enabled:
            self.send_text(text)
