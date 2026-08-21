from __future__ import annotations

import argparse
import logging
import os
import sys

from .config import ConfigError, load_config, load_env_file
from .monitor import WatchlistMonitor
from .notifier import TelegramNotifier


def main() -> None:
    parser = argparse.ArgumentParser(description="SMART SEROK GMGN watchlist monitor")
    parser.add_argument("--config", default="config.toml", help="path config TOML")
    parser.add_argument("--env-file", default="bot.env", help="file KEY=VALUE untuk secret (default: bot.env)")
    parser.add_argument("--once", action="store_true", help="jalankan satu siklus lalu keluar")
    parser.add_argument("--check-config", action="store_true", help="validasi konfigurasi tanpa request")
    parser.add_argument("--telegram-chats", action="store_true", help="tampilkan chat Telegram terbaru untuk mencari chat ID")
    parser.add_argument("--test-telegram", action="store_true", help="kirim pesan tes ke TELEGRAM_CHAT_ID")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )
    try:
        load_env_file(args.env_file)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    if args.telegram_chats:
        notifier = TelegramNotifier(os.getenv("TELEGRAM_BOT_TOKEN"), None)
        try:
            me = notifier.get_me()
            print(f"Bot Telegram: @{me.get('username', '?')}")
            chats = notifier.recent_chats()
        except RuntimeError as exc:
            print(f"telegram error: {exc}", file=sys.stderr)
            raise SystemExit(3) from exc
        if not chats:
            print("Belum ada chat. Buka bot di Telegram, tekan Start, kirim /start, lalu jalankan perintah ini lagi.")
        else:
            print("CHAT_ID\tTYPE\tNAME\tPESAN TERAKHIR")
            for chat in chats:
                print(f"{chat['id']}\t{chat['type']}\t{chat['name']}\t{chat['text']}")
        return

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    if args.check_config:
        print(
            f"OK: {len(config.watchlist)} seed token, TF={config.resolution}, "
            f"Telegram={'ON' if config.telegram_token else 'OFF'}, "
            f"GMGN raw trades={'ON' if config.web_cookie else 'OFF'}, auto-trade=OFF"
        )
        return

    if args.test_telegram:
        notifier = TelegramNotifier(config.telegram_token, config.telegram_chat_id)
        try:
            notifier.send_text("✅ gmgn_trading_bot berhasil terhubung. Auto-trade OFF.")
        except RuntimeError as exc:
            print(f"telegram error: {exc}", file=sys.stderr)
            raise SystemExit(3) from exc
        print("OK: pesan tes Telegram berhasil dikirim")
        return

    monitor = WatchlistMonitor(config)
    if args.once:
        try:
            monitor.run_cycle()
        finally:
            monitor.state.close()
    else:
        monitor.run_forever()


if __name__ == "__main__":
    main()
