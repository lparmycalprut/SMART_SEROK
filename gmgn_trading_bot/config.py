from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .models import WatchToken


@dataclass(frozen=True, slots=True)
class BotConfig:
    api_key: str
    api_host: str
    chain: str
    resolution: str
    poll_seconds: int
    request_spacing_seconds: float
    history_bars: int
    close_grace_seconds: int
    breakout_lookback: int
    min_volume_ratio: float
    min_candle_move_pct: float
    alert_on_startup: bool
    db_path: Path
    telegram_token: str | None
    telegram_chat_id: str | None
    watchlist: tuple[WatchToken, ...]


class ConfigError(ValueError):
    pass


def load_config(path: str | Path) -> BotConfig:
    config_path = Path(path)
    try:
        with config_path.open("rb") as fh:
            raw = tomllib.load(fh)
    except FileNotFoundError as exc:
        raise ConfigError(f"config tidak ditemukan: {config_path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"TOML tidak valid: {exc}") from exc

    gmgn = raw.get("gmgn", {})
    monitor = raw.get("monitor", {})
    signal = raw.get("chart_signal", {})
    storage = raw.get("storage", {})
    telegram = raw.get("telegram", {})

    api_key = os.getenv("GMGN_API_KEY", "").strip()
    if not api_key:
        raise ConfigError("environment variable GMGN_API_KEY belum diisi")

    tokens: list[WatchToken] = []
    for index, item in enumerate(raw.get("watchlist", []), start=1):
        is_enabled = bool(item.get("enabled", True))
        # Blok contoh yang dinonaktifkan boleh dibiarkan kosong. Ini memudahkan
        # user menyiapkan slot watchlist tanpa membuat seluruh config gagal.
        if not is_enabled:
            continue
        mint = str(item.get("mint", "")).strip()
        if not (32 <= len(mint) <= 44) or not mint.isalnum():
            raise ConfigError(
                f"watchlist #{index} aktif tetapi mint Solana tidak valid: {mint!r}. "
                "Isi mint yang benar, hapus bloknya, atau set enabled = false"
            )
        tokens.append(WatchToken(mint, str(item.get("symbol") or mint[:6]), True))
    enabled = tuple(tokens)
    if not enabled:
        raise ConfigError("watchlist aktif masih kosong")

    resolution = str(monitor.get("resolution", "1h"))
    if resolution not in {"30s", "1m", "5m", "15m", "1h", "4h", "1d"}:
        raise ConfigError(f"resolution tidak didukung: {resolution}")

    tg_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip() or None
    tg_chat = os.getenv("TELEGRAM_CHAT_ID", "").strip() or None
    if bool(tg_token) != bool(tg_chat):
        raise ConfigError("TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID harus diisi berpasangan")

    return BotConfig(
        api_key=api_key,
        api_host=str(gmgn.get("host", "https://openapi.gmgn.ai")).rstrip("/"),
        chain=str(gmgn.get("chain", "sol")),
        resolution=resolution,
        poll_seconds=max(15, int(monitor.get("poll_seconds", 60))),
        request_spacing_seconds=max(1.0, float(monitor.get("request_spacing_seconds", 1.1))),
        history_bars=max(10, int(monitor.get("history_bars", 80))),
        close_grace_seconds=max(0, int(monitor.get("close_grace_seconds", 15))),
        breakout_lookback=max(3, int(signal.get("breakout_lookback", 20))),
        min_volume_ratio=max(0.0, float(signal.get("min_volume_ratio", 1.5))),
        min_candle_move_pct=max(0.0, float(signal.get("min_candle_move_pct", 3.0))),
        alert_on_startup=bool(monitor.get("alert_on_startup", False)),
        db_path=Path(str(storage.get("sqlite_path", "var/smart_serok.db"))),
        telegram_token=tg_token,
        telegram_chat_id=tg_chat,
        watchlist=enabled,
    )


def resolution_seconds(value: str) -> int:
    return {"30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}[value]
