from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request

from .models import ChartSignal

LOG = logging.getLogger(__name__)


class TelegramNotifier:
    def __init__(self, token: str | None, chat_id: str | None):
        self.token = token
        self.chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

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
        if not self.enabled:
            return
        payload = urllib.parse.urlencode({"chat_id": self.chat_id, "text": text, "disable_web_page_preview": "true"}).encode()
        request = urllib.request.Request(
            f"https://api.telegram.org/bot{self.token}/sendMessage",
            data=payload,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read().decode())
            if not body.get("ok"):
                raise RuntimeError(f"Telegram API error: {body.get('description', 'unknown')}")
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"gagal mengirim Telegram: {exc}") from exc
