# gmgn_trading_bot — Chart Monitor v0.1.1

Bot 24/7 untuk memantau watchlist mint Solana melalui GMGN OpenAPI dan mengirim
alert Telegram opsional.

## Batasan versi ini

Versi pertama hanya membaca **OHLCV K-line resmi GMGN**. Sinyal sementara:

- `CHART_BREAKOUT`: close candle selesai menembus high N candle sebelumnya.
- `CHART_BREAKDOWN`: close candle selesai menembus low N candle sebelumnya.
- Keduanya dapat mensyaratkan rasio volume dan minimum perubahan candle.

Ini **bukan** empat sinyal Level Engine ekstensi. K-line tidak memiliki buy/sell
flow, maker, dan trade SOL sehingga `cvd_clean`, signed R, resistance/support
terbukti, dan retest tanpa perlawanan belum bisa dihitung secara identik.

Auto-trade belum ada dan selalu **OFF**.

## Instalasi

Python 3.11+ cukup; bot tidak membutuhkan package pihak ketiga.

```bash
cp config.example.toml config.toml
cp bot.env.example bot.env
chmod 600 bot.env

# Edit watchlist di config.toml dan isi secret di bot.env, lalu muat environment.
set -a; source bot.env; set +a

python -m gmgn_trading_bot.cli --config config.toml --check-config
python -m gmgn_trading_bot.cli --config config.toml --once
python -m gmgn_trading_bot.cli --config config.toml
```

`config.toml`, `bot.env`, `.env`, dan database runtime diabaikan Git. API key
tidak boleh ditulis ke `config.example.toml`, source code, log, atau Telegram.

> Karena API key pernah ditempel di percakapan, disarankan membuat/merotasi key
> baru di https://gmgn.ai/ai sebelum deployment produksi.

## Windows PowerShell

PowerShell tidak memakai `\` untuk menyambung perintah seperti Bash. Cara paling
aman adalah menjalankan perintah dalam satu baris:

```powershell
Copy-Item config.example.toml config.toml
$env:GMGN_API_KEY = "isi_api_key_gmgn_di_sini"
python -m gmgn_trading_bot.cli --config config.toml --check-config
python -m gmgn_trading_bot.cli --config config.toml --once
python -m gmgn_trading_bot.cli --config config.toml
```

Jika ingin beberapa baris, gunakan backtick PowerShell (`` ` ``), bukan
backslash. Backtick harus menjadi karakter terakhir pada baris—jangan beri spasi
setelahnya:

```powershell
python -m gmgn_trading_bot.cli `
  --config config.toml `
  --once
```

Environment variable PowerShell hanya aktif di jendela terminal tersebut. Untuk
Telegram opsional:

```powershell
$env:TELEGRAM_BOT_TOKEN = "..."
$env:TELEGRAM_CHAT_ID = "..."
```

## Telegram (Linux/macOS, opsional)

```bash
export TELEGRAM_BOT_TOKEN='...'
export TELEGRAM_CHAT_ID='...'
python -m gmgn_trading_bot.cli --config config.toml
```

Tanpa dua environment variable tersebut, alert tetap dicatat di log console.
Bot tidak akan menerima konfigurasi Telegram yang hanya terisi salah satu.

## Operasi 24/7 dengan systemd

Contoh unit (sesuaikan path dan user):

```ini
[Unit]
Description=SMART SEROK GMGN monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=smartserok
WorkingDirectory=/opt/smart-serok
EnvironmentFile=/etc/gmgn-trading-bot.env
ExecStart=/usr/bin/python3 -m gmgn_trading_bot.cli --config /etc/gmgn-trading-bot.toml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

GMGN OpenAPI hanya mendukung IPv4. Pastikan VPS memiliki koneksi keluar IPv4.
`request_spacing_seconds` minimum 1 detik untuk menghormati rate limit default.

## State dan deduplikasi

SQLite menyimpan candle terakhir dan event yang sudah dikirim. Restart bot tidak
mengirim ulang alert yang sama. Pada start pertama, default
`alert_on_startup=false` melakukan warm-up tanpa mengirim sinyal historis.

## Tes

```bash
python -m unittest discover -s tests -v
```
