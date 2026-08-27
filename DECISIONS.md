# SMART SEROK — Catatan Keputusan Desain

Dokumen ini merekam keputusan desain yang sudah disepakati, supaya tidak hilang
antar sesi dan tidak diputuskan ulang secara berbeda.

---

## 2026-08-20 — Sumber kebenaran versi

- Versi kerja terbaru adalah **v9.1.7**, dipegang user secara lokal.
- Repo GitHub (`main`, commit `df68e46`, PR #1 MERGED) masih di **v9.1.4**.
- Artinya v9.1.5 / v9.1.6 / v9.1.7 **belum pernah ter-merge** ke GitHub.
- **Aturan:** file v9.1.7 dari user menang atas isi repo.
- **Status: SELESAI.** v9.1.7 sudah di-upload lewat portal dan menjadi isi branch
  `arena/01a01ed9-smart-serok`. Basis pekerjaan berikutnya = v9.1.7.
- Icon (`icon16/48/128.png`) identik antara v9.1.4 dan v9.1.7 — tidak berubah.

### Isi perubahan v9.1.4 -> v9.1.7

1. **BATTLE jadi mandiri** — tidak lagi butuh WASPADA DUMP / SIAP2 PUMP sebelumnya.
   `isBattleTriggerSignal()` dan `latestBattleTrigger` dihapus; `makeBattleEvent()`
   kehilangan parameter `trigger`, dan field `triggerSignal` / `triggerStart` / `gap` hilang.
2. **Nama sinyal** jadi `BATTLE TERJADI (Bisa LP)` (konstanta `BATTLE_SIGNAL`).
3. **Syarat volume BATTLE** baru: `BATTLE_MIN_VOL_SOL = 200` (total BUY+SELL per candle).
4. **`MIN_SPIKE_CVD = 8` diganti `SELL_ABSORB_MIN_CVD = 3`** — ambang SERAP SELL
   diturunkan agar tetap menangkap R− ekstrem saat harga nyaris tidak bergerak.
5. **Format tanggal Indonesia** — `fmtDateId()` + `MONTH_NAMES_ID`
   ("20 Agustus 14:00" menggantikan "08-20 14:00").
6. **Layout riwayat sinyal** — 2 kolom dengan `grid-template-areas`, teks membungkus
   (tidak lagi terpotong ellipsis).

> Catatan: penurunan ke `SELL_ABSORB_MIN_CVD = 3` membuat lantai CVD lebih longgar.
> Ini menaikkan risiko "R besar palsu" yang sempat dibahas (isu #1 di bagian bawah),
> tapi itu keputusan sadar user untuk menangkap candle 1H dengan CVD bersih -3,60 SOL.

---

## 2026-08-20 — TIDAK ADA batas waktu (timeout) untuk konfirmasi serapan

**Keputusan:** rencana expiry 12 bar untuk sinyal serapan DIBATALKAN.

**Alasan (dari user):** setelah penyerapan terjadi, fase akumulasi bisa
berlangsung **berhari-hari** sampai seller benar-benar habis. Timeout justru
akan membuang sinyal serapan yang paling berkualitas — yang pelan dan sabar.

### Konsekuensi

| Aspek | Keputusan |
|---|---|
| Status `⚪ HAMBAR` / expiry | **Dibuang.** Tidak dipakai. |
| `CONFIRM_MAX_BARS = 12` | **Tidak** dipakai sebagai pembatal sinyal. |
| Umur sinyal | Sinyal hidup **tanpa batas waktu**. |
| Satu-satunya pembatal | **Garis invalidasi harga** (lihat OPEN di bawah). |
| Tampilan umur (`⏳ 47 bar`) | Tetap ditampilkan sebagai info kualitas, **tidak** membunuh sinyal. |
| `scoreConviction` gap >= 8 bar → −3 (`content.js:975`) | Perlu **direlaksasi**; akumulasi panjang tidak boleh dihukum. |

### Implikasi penting

Karena tidak ada timeout, garis invalidasi harga menjadi **satu-satunya** cara
sinyal bisa mati. Bobot keputusan itu naik, bukan turun.

---

## Konsep dasar yang sudah disepakati

### R = effort / result

`content.js:762-766`

```js
const effortCvd = cvdClean;                 // CVD bersih (wash + MEV dibuang)
const rAbs = |effortCvd| / |priceChgPct|;
const signedR = effortCvd >= 0 ? +rAbs : -rAbs;   // + = serap BUY, - = serap SELL
```

### R tinggi = ada yang menyerap, BUKAN jaminan berhasil

Bar SERAP SELL adalah **pertanyaan** ("siapa yang menampung, sanggup berapa
lama?"), bukan jawaban. Penyerap bisa:

1. **Menang** — seller kehabisan amunisi, harga naik dan mudah naiknya.
2. **Kalah** — bid ditarik, wall jebol, harga jatuh lebih deras dari sebelumnya.
3. **Justru distribusi** — menahan harga sambil jual di tempat lain.

### Tanda penyerapan BERHASIL (bar konfirmasi)

Tiga syarat WAJIB bersamaan — R kecil saja tidak cukup:

1. **R turun tajam** (effort kecil menghasilkan gerakan besar)
2. **`chg_pct` POSITIF** — arah wajib dicek, karena R pakai nilai absolut
3. **`cvd_clean` flip ke positif** — absorber berhenti pasif, mulai mengejar

Pendukung:

4. `high` bar setup tertembus
5. `sell_sol` meluruh berurutan (120 -> 45 -> 18)

**Jebakan utama:** R kecil juga terjadi saat penyerap **kalah** (harga jatuh
bebas dengan effort kecil). Contoh: `chg -31%`, `cvd_clean -60`, `R = 1.9`.
Sama-sama "R kecil", arti berkebalikan total. Pembedanya hanya tanda `chg_pct`.

---

## Dead code yang sudah ada tapi belum tersambung

Logika konfirmasi sebetulnya **sudah ditulis** namun tidak punya call site:

- `scoreConviction()` (`content.js:905-983`) — sudah menghitung `R anjlok`,
  `ΔCVD flip`, `follow-through`, `tembus %`, `jarak konfirmasi`, grade A+/A/B+.
- `scoreSetup()` (`content.js:986`)
- `rFree()` (`content.js:890`)
- Konstanta menganggur: `FREE_R`, `R_COLLAPSE`, `DEFENSE_R`, `CONFIRM_MAX_BARS`

Rencana: sambungkan menjadi pelacak status per sinyal
`⏳ MENUNGGU (n bar)` -> `✅ SERAPAN BERHASIL <grade>` / `❌ SERAPAN JEBOL`,
tampil di kolom Metric riwayat sinyal dan ikut ke export.

---

## OPEN — belum diputuskan

**Garis invalidasi sinyal serapan** (sekarang jadi satu-satunya pembatal):

- **Opsi A:** `close` di bawah `low(setup)` — lebih sabar, tahan wick.
- **Opsi B:** `low` menyentuh `low(setup)` — lebih cepat, sering kena sumbu liar.

---

## Catatan lain

- Definisi lama WASPADA DUMP dan SIAP2 PUMP **tidak boleh diubah**.
- SERAP SELL **tidak** memicu BATTLE.
- Isu R yang sudah teridentifikasi (belum diperbaiki):
  1. Tidak ada lantai CVD (`MIN_SPIKE_CVD`) untuk WASPADA DUMP / SIAP2 PUMP.
  2. R buta wick — pakai `close/open`, bukan `high-low`.
  3. Bar `partial` tetap discan untuk sinyal spike (hanya BATTLE yang memblokir).
  4. R tidak dinormalisasi ke likuiditas / market cap.

## 2026-08-25 — Chart digeser horizontal, tidak dipaksa menyempit (v9.2.14)

**Masalah:** chart (R MONITOR & lintasan harga/CVD) digambar pada viewBox 1000px
tapi SVG dipaksa `width:100%` — saat widget lebih sempit dari 1000px, batang dan
label mengecil tak terbaca.

**Keputusan:** SVG dibiarkan pada lebar aslinya (`min-width:1000px`) dan dibungkus
`.gmgn-chart-wrap` yang bisa di-scroll horizontal. Pengguna bisa:
- geser (drag) dengan mouse / swipe native di layar sentuh,
- klik tombol ‹ › (muncul otomatis hanya saat ada ruang terpotong),
- scroll wheel / trackpad horizontal.

Re-wire otomatis tiap render ulang (updateUI tiap 3 detik) lewat MutationObserver.
Saat widget lebih lebar dari 1000px, chart tetap mengisi penuh dan tombol
disembunyikan — perilaku lama tidak berubah di layar besar.

---

## 2026-08-27 — Penanda level RAPUH (whale tunggal), v9.2.15

**Masalah:** backtest manual — level yang lahir dari absorpsi RAKSASA lebih
sering TEMBUS saat di-retest, bukan bertahan. **Hipotesis:** R ekstrem yang
terpusat di satu wallet tidak meninggalkan penjaga level setelah wallet itu
selesai; hanya absorpsi terdistribusi yang menciptakan defense berlapis.

**Keputusan:**

- `concentration_ratio = max_trade_sol / vol_sol` dihitung per bar di
  `buildBars()` (di titik yang sama dengan max_trade_sol) dan ikut ke export
  BARS sebagai kolom baru.
- `level.fragile` = penyerapan kelas RAKSASA (`isAbsorbGrade(bar, prev)` DAN
  ≥ `R_BAND_BLAZE`× acuan klaster — dibungkus helper `isBlazeGrade()`)
  DAN `concentration_ratio >= CONCENTRATION_FRAGILE_THRESHOLD` (0,6).
- fragile = **metadata murni**: tag judul "(RAPUH — whale tunggal)", satu
  kalimat di narasi level, penegas di narasi retest, aksen warna yang reuse
  skema RAKSASA (seller `#ff3355` / buyer `#00ff5e`), dan kolom export.
  **Tidak ada ambang deteksi level yang diubah** — R_MIN_ABS, R_SPIKE_MULT,
  seluruh LVL_*, R_BAND_WALL, R_BAND_BLAZE tetap. Alasan: hipotesis ini belum
  tervalidasi; sebagai metadata, salah tandai hanya mengubah label, sedangkan
  kalau jadi filter dan hipotesisnya salah, sinyal hilang diam-diam.
- `CONCENTRATION_FRAGILE_THRESHOLD = 0.6` adalah angka AWAL — kalibrasi
  lanjutan dari kolom `concentration_ratio_at_formation` vs hasil retest di
  CSV export.
- LIVE: fetch awal 4 hari (`LIVE_FETCH_SEC`), R MONITOR hanya menampilkan
  24 jam terakhir (`R_MON_WINDOW_SEC`); `rBaseline` TETAP dihitung dari
  seluruh klaster aktif supaya r_ratio/r_state di layar == file export.
- Suite regresi resmi di-commit: `tests/regression.js` — 23 tes (17 lama
  direkonstruksi dari deskripsi README v9.2.11/v9.2.12 + 6 baru). content.js
  memanggil hook `globalThis.__SMART_SEROK_TEST__` yang hanya aktif bila
  simbol itu sudah berupa fungsi sebelum file dievaluasi (di browser: no-op).

**Catatan versi:** v9.2.14 sudah terpakai oleh perubahan chart horizontal
(2026-08-25, PR #5) — content.js/manifest/DECISIONS.md sudah menyebutnya,
hanya changelog README yang belum. Supaya satu nomor versi = satu isi
perubahan, fitur ini naik ke **v9.2.15** (bukan v9.2.14 seperti rencana
awal), dan README di-backfill entri v9.2.14-nya.

---

## 2026-08-27 — Fetch N hari: walk bertahap, cache tidak memangkas rentang (v9.2.16)

**Masalah:** Background Fetch untuk rentang N hari (7/14 hari, dsb.) hanya
mengambil ~1 hari terakhir lalu berhenti "DONE". **Akar** (dua bug
berlapis):
1. API GMGN memotong `from` yang jauh di masa lalu (request
   `from=7 hari lalu&to=now` hanya mengembalikan ~1 hari). backgroundFetch
   v9.2.15 mengirim satu from/to lalu percaya satu rantai cursor — rantai
   habis di ~1 hari, `next` null, dianggap selesai. Workaround untuk
   pemotongan ini memang sudah ada di LIVE ("mundur dari now, tanpa from,
   lalu fill gap"), tapi tidak dipakai backgroundFetch.
2. Cache incremental mengganti `startTs` dengan `lastCachedTs + 1` —
   dengan cache 1 hari, "fetch 7 hari" jadi top-up kecil dan 6 hari
   lainnya tidak pernah di-fetch.

**Keputusan:**
- Inti fetch = `walkTradeRange()`: rentang dijalani mundur dalam
  rantai-rantai cursor. Rantai baru selalu dimulai `to = oldest_dicapai - 1`;
  cursor selalu dari respons sebelumnya; rantai yang terpotong (batas
  halaman / `next` habis) diganti rantai baru; potongan kosong (gap data)
  membuat boundary mundur `WALK_PROBE_STEP_SEC` (12 jam).
  **Syarat desain:** langkah probe harus JAH < jendela tersirat API
  (~1 hari) supaya potongan saling tumpang-tindih — tidak ada trade
  terlewat. Dengan syarat itu walk terbukti lengkap untuk W (jendela
  API) berapa pun >= langkah.
- Konstanta baru: `FETCH_CHAIN_PAGES = 200` (batas per rantai),
  `FETCH_MAX_PAGES = 1000` (pengaman global), `WALK_PROBE_STEP_SEC = 12h`,
  `DEFAULT_RANGE_DAYS = 7` (rentang default saat user belum set filter
  di halaman GMGN — sebelumnya from-kosong tanpa batas).
- Cache: tetap di-seed (UI cepat, dedup tx_hash menampung overlap),
  **TIDAK** memangkas rentang yang diminta.
- `gmgnRequest()` = satu GET dengan 4x retry, dipisah dari walk supaya
  mekanisme bisa dites tanpa browser (hook `__SMART_SEROK_TEST__`).
- Laporan jernih, tidak pernah berhenti diam-diam:
  - tertutup penuh → `✅ DONE X/X hari · N TX`
  - data API tidak menutup rentang (token baru listing/limit provider)
    → `⚠ A/X hari · data terlama <tanggal>` + alert + console.warn
  - kena batas halaman global → `⚠ Batas 1000 halaman — A/X hari`
  - error jaringan → `❌ Gagal di halaman N` + console.error
  - progress per halaman di console: "fetch N hari: halaman K · +Z trade ·
    tersimpan M TX · terlama <tanggal> · rantai baru #R".
- LIVE full-window memakai walk yang sama (jendela 4 hari benar-benar
  penuh, menggantikan dua pullPages 200+80 yang bisa kurang untuk token
  ramai). Sinkron inkremental LIVE tidak berubah perilaku.
- Tidak disentuh: semua ambang sinyal (R_MIN_ABS, R_SPIKE_MULT, LVL_*,
  R_BAND_*, CONCENTRATION_FRAGILE_THRESHOLD), MAX_BARS, R_MON_*.
  Tidak ada clustering/pengelompokan hari.
- Tes: 11 tes baru (total 34) — fake API meniru pemotongan GMGN; tes
  ke-24 mereproduksi bug lama (logika v9.2.15 dapat 500/3500 trade),
  sisanya memvalidasi walk: ramai/sepi, gap, token baru listing,
  cursor macet, batas halaman, stop, error.
