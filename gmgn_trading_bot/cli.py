from __future__ import annotations

import argparse
import logging
import sys

from .config import ConfigError, load_config, load_env_file
from .monitor import WatchlistMonitor


def main() -> None:
    parser = argparse.ArgumentParser(description="SMART SEROK GMGN watchlist monitor")
    parser.add_argument("--config", default="config.toml", help="path config TOML")
    parser.add_argument("--env-file", default="bot.env", help="file KEY=VALUE untuk secret (default: bot.env)")
    parser.add_argument("--once", action="store_true", help="jalankan satu siklus lalu keluar")
    parser.add_argument("--check-config", action="store_true", help="validasi konfigurasi tanpa request")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )
    try:
        load_env_file(args.env_file)
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    if args.check_config:
        print(
            f"OK: {len(config.watchlist)} token, TF={config.resolution}, "
            f"Telegram={'ON' if config.telegram_token else 'OFF'}, auto-trade=OFF"
        )
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
