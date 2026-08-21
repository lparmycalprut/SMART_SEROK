# gmgn_trading_bot — Chart Monitor v0.1.4

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

# Edit watchlist di config.toml dan isi secret di bot.env.
# bot.env dimuat otomatis oleh bot pada semua OS.
python -m gmgn_trading_bot.cli --config config.toml --check-config
python -m gmgn_trading_bot.cli --config config.toml --once
python -m gmgn_trading_bot.cli --config config.toml
```

`config.toml`, `bot.env`, `.env`, dan database runtime diabaikan Git. API key
tidak boleh ditulis ke `config.example.toml`, source code, log, atau Telegram.

> Karena API key pernah ditempel di percakapan, disarankan membuat/merotasi key
> baru di https://gmgn.ai/ai sebelum deployment produksi.

## Windows + VS Code (tanpa PowerShell)

Di VS Code tekan `Ctrl+Shift+P` → **Terminal: Select Default Profile** → pilih
**Command Prompt**, lalu buka terminal baru. Jalankan:

```bat
cd /d D:\gmgn_trading_bot
copy config.example.toml config.toml
copy bot.env.example bot.env
notepad config.toml
notepad bot.env
python -m gmgn_trading_bot.cli --config config.toml --check-config
python -m gmgn_trading_bot.cli --config config.toml --once
```

Untuk menemukan chat ID tanpa perintah khusus PowerShell:

1. Buka bot di Telegram, tekan **Start**, lalu kirim `/start`.
2. Jalankan:

```bat
python -m gmgn_trading_bot.cli --telegram-chats
```

3. Salin `CHAT_ID` yang tampil ke `TELEGRAM_CHAT_ID` dalam `bot.env`.
4. Tes pengiriman:

```bat
python -m gmgn_trading_bot.cli --config config.toml --test-telegram
```

5. Jalankan monitor:

```bat
python -m gmgn_trading_bot.cli --config config.toml
```

## Windows PowerShell (alternatif)

PowerShell tidak memakai `\` untuk menyambung perintah seperti Bash. Cara paling
aman adalah menjalankan perintah dalam satu baris:

```powershell
Copy-Item config.example.toml config.toml
Copy-Item bot.env.example bot.env
notepad config.toml
notepad bot.env
python -m gmgn_trading_bot.cli --config config.toml --check-config
python -m gmgn_trading_bot.cli --config config.toml --once
python -m gmgn_trading_bot.cli --config config.toml
```

Bot memuat `bot.env` secara otomatis. Isi API key dan Telegram di file tersebut;
tidak perlu menjalankan `$env:...` setiap membuka PowerShell baru. File `bot.env`
diabaikan Git dan **tidak dimasukkan ke ZIP hasil portal** agar secret tidak bocor.

### Update versi tanpa kehilangan secret/config

Simpan ZIP versi terbaru di komputer, lalu jalankan dari folder bot lama:

```powershell
.\update_from_zip.ps1 -ZipPath "D:\Downloads\gmgn_trading_bot_vTERBARU.zip"
```

Updater mengganti source terbaru tetapi selalu mempertahankan tiga item lokal:

- `bot.env` — API key dan Telegram
- `config.toml` — watchlist dan setting
- `var/` — database deduplikasi alert

Jadi secret tidak perlu dimasukkan ke ZIP dan tidak perlu diketik ulang. Jika
PowerShell memblokir script lokal, jalankan satu kali untuk proses tersebut:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

Jika ingin beberapa baris, gunakan backtick PowerShell (`` ` ``), bukan
backslash. Backtick harus menjadi karakter terakhir pada baris—jangan beri spasi
setelahnya:

```powershell
python -m gmgn_trading_bot.cli `
  --config config.toml `
  --once
```

Sebagai alternatif, environment PowerShell dapat dipakai untuk override sementara
(nilainya menang atas `bot.env`), tetapi hanya aktif di terminal tersebut:

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
