SMART SEROK v9.1.7
==================
Load unpacked: Chrome → chrome://extensions → Developer mode → Load unpacked.
Setelah update ekstensi, klik Reload lalu hard-refresh tab GMGN (Ctrl+Shift+R) agar
script versi lama yang masih menempel di halaman benar-benar diganti.

Sinyal setup & konteks
-----------------------
WASPADA DUMP (merah — logika lama tidak diubah)
  harga naik + cumCVD naik + |R| ≥ 10× bar sebelumnya + |R| ≥ 10

SIAP2 PUMP (hijau — logika lama tidak diubah)
  harga turun + cumCVD turun + |R| ≥ 10× bar sebelumnya + |R| ≥ 10

SERAP SELL — POTENSI PUMP (hijau — sinyal konteks baru)
  |R| ≥ 10× bar sebelumnya + |R| ≥ 10 + R bertanda negatif + cumCVD turun
  + CVD bersih ≤ −3 SOL + harga tertahan / naik tipis (0% s/d +3%).

Ini menangkap kondisi seller agresif, tetapi harga tidak berhasil turun karena
buy-side menyerap jualan. Sinyal ini terpisah dari SIAP2 PUMP; jadi definisi
SIAP2 PUMP lama tidak berubah. Batas CVD bersih −3 SOL menahan effort mikro,
namun tetap menangkap R− ekstrem ketika harga nyaris tidak bergerak.

BATTLE TERJADI (Bisa LP) (kuning)
---------------------------------
BATTLE bersifat mandiri: tidak membutuhkan WASPADA DUMP, SIAP2 PUMP, atau
SERAP SELL sebelumnya. BATTLE muncul bila candle selesai memenuhi seluruh syarat
volume, gap BUY/SELL, TX, wallet unik, dan fresh_wallet di bawah.

Badge header menampilkan total wallet bertag fresh yang berhasil ditangkap, sehingga
bisa langsung dicek apakah respons GMGN benar-benar mengirim tag fresh_wallet.

Semua syarat berikut wajib terpenuhi:
  1. gap = |BUY − SELL| / (BUY + SELL) ≤ 2,5%
  2. total volume candle BATTLE (BUY + SELL) ≥ 200 SOL
  3. TX ≥ persentil 65 periode/klaster aktif
  4. wallet unik ≥ persentil 65 periode/klaster aktif
  5. jumlah wallet unik bertag fresh_wallet ≥ persentil 65 periode/klaster aktif

Pada TF 1H, volume ini berarti total volume pada jam BATTLE. Pada TF 4H/D1,
ambang yang sama diterapkan ke total volume candle aktif.

Minimum 8 bar selesai untuk menghitung ambang aktivitas. Bar yang masih berjalan
tidak memunculkan BATTLE agar sinyal tidak berubah intrabar. Tag fresh_wallet wajib
tersedia; tanpa tag fresh_wallet, BATTLE tidak akan muncul.

Penangkapan tag fresh_wallet
----------------------------
Ekstensi menangkap tag dari field GMGN berikut, termasuk bentuk nested:
  maker_tags, maker_token_tags, maker_event_tags, tags, tag,
  maker_info.*, dan wallet_info.*

Nama tag produksi yang dikenali:
  fresh_wallet (exact setelah normalisasi huruf/spasi/tanda hubung).
Field is_new=true pada holder hanya dipakai sebagai fallback/enrichment; tag
fresh_wallet dari payload GMGN tetap menjadi sumber utama.

Agregasi per candle:
  fresh_wallets, fresh_wallet_pct, fresh_tx, fresh_buy_sol, fresh_sell_sol,
  dan tagged_makers.

Range BATTLE menggunakan market cap
-----------------------------------
Detail BATTLE menampilkan:
  RANGE BATTLE MC: LOW market cap — HIGH market cap

Ekstensi otomatis meminta endpoint token_holders saat halaman token dibuka, saat
Background Fetch/LIVE dimulai, dan tetap menangkap respons holder/top-holder/token-trader
berdasarkan bentuk payload meskipun nama URL berubah. Dari beberapa
holder valid, ekstensi mengambil median kandidat berikut agar satu record tidak
mendistorsi hasil:
  market cap = usd_value / amount_percentage
  supply     = amount_cur / amount_percentage
  price      = usd_value / amount_cur
Tag holder disimpan per address dan memperkaya trade yang maker_tags-nya kosong.
Registry tag dan konteks market cap direset saat pindah token atau Reset manual.
Badge header menampilkan MC dan sumbernya (holder/token_info) agar keberhasilan
penangkapan konteks market cap dapat diperiksa langsung.

Konversi market cap historis memprioritaskan effective supply hasil holder,
kemudian rasio market_cap/price dari token_info, total_supply, atau inferensi
market cap terkini terhadap close terbaru. Jika data belum tertangkap, detail menampilkan
"MC belum tersedia" dan tidak kembali menggunakan range price.

Export
------
- BARS menambahkan open/high/low/close market cap dan metrik fresh wallet.
- RAW TRADES menambahkan kolom tags.
- Export AI menambahkan market cap dan metrik fresh wallet; current_signal dan
  signal_history juga memuat SERAP SELL — POTENSI PUMP bila lolos.

Catatan
-------
- AKTIVASI PUMP dan AKTIVASI DUMP tetap dihapus.
- Tidak ada konfirmasi fakeout/higher-high otomatis.
- Wash tidak menjadi syarat sinyal; nilainya tetap ditampilkan.
- Jam menggunakan WIB (Asia/Jakarta, UTC+7).
