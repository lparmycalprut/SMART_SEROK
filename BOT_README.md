# gmgn_trading_bot v0.2.4 — SMART SEROK Level Engine

Bot 24/7 Solana dengan empat sinyal saja:

1. `RESISTANCE TERBENTUK`
2. `SUPPORT TERBENTUK`
3. `RETEST RESISTANCE — KEMUNGKINAN BREAKOUT`
4. `RETEST SUPPORT — KEMUNGKINAN BREAKDOWN`

`CHART_BREAKOUT` dan `CHART_BREAKDOWN` telah dihapus. Auto-trade selalu OFF.

## Sumber data

- GMGN OpenAPI: metadata dan market-cap context.
- GMGN web `token_trades`: raw buy/sell, SOL, maker, harga, tx hash, tags.
- SQLite: watchlist, raw trades, deduplikasi, dan state.

Raw trades memakai endpoint web yang sama dengan ekstensi, tetapi bukan OpenAPI
publik. Cookie dapat kedaluwarsa. Bot akan melaporkan error lewat `/status`.

## Setup Windows + VS Code

Pilih VS Code → `Ctrl+Shift+P` → **Terminal: Select Default Profile** →
**Command Prompt**. Kemudian:

```bat
cd /d D:\gmgn_trading_bot
notepad config.toml
notepad bot.env
python bot.py --check-config
python bot.py --once
python bot.py
```

Mulai v0.2.4, ZIP update tidak berisi `bot.env`, `config.toml`, maupun kedua
file contohnya. Gunakan file lokal yang sudah ada. Jangan ekstrak ZIP langsung
menimpa instalasi; gunakan updater agar source saja yang diganti.

Cara paling mudah di VS Code: tekan `Ctrl+Shift+B`, lalu pilih
**Jalankan SMART SEROK Bot**. Launcher lama berbentuk `.bat` telah dihapus agar
tidak memicu deteksi heuristik antivirus.

Isi `bot.env` dengan API key, cookie GMGN lokal, dan Telegram. Jangan kirim
nilainya ke chat atau memasukkannya ke source/ZIP.

## Cara mengambil cookie GMGN

1. Login GMGN di browser.
2. Buka halaman token → DevTools (`F12`) → tab **Network**.
3. Cari request `token_trades`.
4. Buka request → **Request Headers** → salin nilai header `Cookie` saja.
5. Isi satu baris `GMGN_WEB_COOKIE=...` di `bot.env`.

Cookie adalah kredensial sesi. Jika bocor atau error 401/403, logout/login GMGN
dan ganti nilainya.

## Backfill dan Level Engine

Saat token baru ditambahkan, bot mengambil raw trades 48 jam, membentuk candle
1H, menjalankan wash/MEV filtering, CVD bersih, signed R, pembuktian maksimal 12
candle, arming 2%, dan retest garis ±0,5%. Sinyal historis disimpan tetapi tidak
dikirim. Alert baru dikirim satu kali per event.

## Telegram control

```text
/add <CA> [SYMBOL]  tambah + jadwalkan backfill 48 jam
/remove <CA>        hapus token dan raw data
/list               watchlist + tombol 🗑 per CA
/pause <CA>         jeda tanpa hapus
/resume <CA>        aktifkan
/refresh <CA>       fetch ulang 48 jam
/levels             level aktif
/status             kesehatan bot/provider
/test               tes Telegram
/help               bantuan
```

Hanya `TELEGRAM_CHAT_ID` pemilik yang dapat menjalankan command.

## Update tanpa kehilangan lokal

```bat
powershell -ExecutionPolicy Bypass -File update_from_zip.ps1 -ZipPath "D:\Downloads\gmgn_trading_bot_vTERBARU.zip"
```

Updater mempertahankan `bot.env`, `config.toml`, dan `var/`.

## Tes

```bat
python -m unittest discover -s tests -v
```
