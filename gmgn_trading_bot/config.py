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
    web_cookie: str
    web_host: str
    chain: str
    resolution: str
    poll_seconds: int
    request_spacing_seconds: float
    backfill_hours: int
    close_grace_seconds: int
    db_path: Path
    telegram_token: str | None
    telegram_chat_id: str | None
    watchlist: tuple[WatchToken, ...]


class ConfigError(ValueError):
    pass


def load_env_file(path: str | Path) -> bool:
    env_path = Path(path)
    if not env_path.is_file():
        return False
    for line_number, raw_line in enumerate(env_path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            raise ConfigError(f"{env_path}:{line_number}: format environment harus KEY=VALUE")
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
            raise ConfigError(f"{env_path}:{line_number}: nama environment tidak valid: {key!r}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'\"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)
    return True


def load_config(path: str | Path) -> BotConfig:
    config_path = Path(path)
    try:
        with config_path.open("rb") as fh:
            raw = tomllib.load(fh)
    except FileNotFoundError as exc:
        raise ConfigError(f"config tidak ditemukan: {config_path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"TOML tidak valid: {exc}") from exc

    gmgn, monitor, storage = raw.get("gmgn", {}), raw.get("monitor", {}), raw.get("storage", {})
    api_key = os.getenv("GMGN_API_KEY", "").strip()
    if not api_key:
        raise ConfigError("GMGN_API_KEY belum diisi di bot.env")
    tg_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip() or None
    tg_chat = os.getenv("TELEGRAM_CHAT_ID", "").strip() or None
    if bool(tg_token) != bool(tg_chat):
        raise ConfigError("TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID harus diisi berpasangan")

    tokens: list[WatchToken] = []
    for index, item in enumerate(raw.get("watchlist", []), start=1):
        if not bool(item.get("enabled", True)):
            continue
        mint = str(item.get("mint", "")).strip()
        if not (32 <= len(mint) <= 44) or not mint.isalnum():
            raise ConfigError(f"watchlist #{index} aktif tetapi mint Solana tidak valid: {mint!r}")
        tokens.append(WatchToken(mint, str(item.get("symbol") or mint[:6]), True))

    resolution = str(monitor.get("resolution", "1h"))
    if resolution != "1h":
        raise ConfigError("Level Engine v0.2 hanya mendukung resolution = \"1h\"")
    return BotConfig(
        api_key, str(gmgn.get("host", "https://openapi.gmgn.ai")).rstrip("/"),
        os.getenv("GMGN_WEB_COOKIE", "").strip(), str(gmgn.get("web_host", "https://gmgn.ai")).rstrip("/"),
        "sol", resolution, max(30, int(monitor.get("poll_seconds", 60))),
        max(1.0, float(monitor.get("request_spacing_seconds", 1.1))),
        max(48, int(monitor.get("backfill_hours", 48))),
        max(0, int(monitor.get("close_grace_seconds", 15))),
        Path(str(storage.get("sqlite_path", "var/gmgn_trading_bot.db"))),
        tg_token, tg_chat, tuple(tokens),
    )


def resolution_seconds(value: str) -> int:
    return {"1h": 3600}[value]
