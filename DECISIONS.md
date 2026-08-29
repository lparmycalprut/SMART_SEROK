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
---

## 2026-08-27 — Validasi level DIHAPUS total: LEVEL INSTAN (v9.2.17 + v9.2.18)

**Masalah:** v9.2.17 sudah membuang syarat gerak harga >=5% dari validasi, tapi mesin
pembuktian masih ada: level baru lahir setelah <=12 bar (R runtuh <=50% + arah cumCVD
searah) dan bisa dibatalkan kalau harga menembus >2% sebelum terbukti. Yang
ditindaklanjuti pengguna ternyata bukan "level yang terbukti", melainkan candle R BESAR
itu sendiri — mesin validasi cuma menambah latensi dan kalimat "penyerapan gagal".

**Keputusan:**
- **v9.2.17** — sinyal RETEST RESISTANCE / RETEST SUPPORT DIHAPUS total. Tinggal 2
  sinyal: RESISTANCE TERBENTUK / SUPPORT TERBENTUK. Ikut terhapus:
  LVL_LINE_PAD_PCT, LVL_EXIT_PCT, LVL_RETEST_MIN_GAP, LVL_RETEST_R_MAX, SIG_RETEST_*,
  makeRetestEvent, levelLine, touchesLine, retestDiagText, arming (lv.armed/pendingArm),
  panel STATUS PEMANTAUAN RETEST, section "=== STATUS RETEST ===" di export, wajik
  retest di chart, entri SIG_META. Syarat LVL_MIN_MOVE_PCT (harga wajib >=5%) dihapus
  dari validasi — pergerakan harga hanya INFO (tetap dicatat di narasi + export).
- **v9.2.18** — validasi level DIHAPUS TOTAL. Konstanta LVL_CONFIRM_BARS,
  LVL_MIN_CONFIRM_BARS, LVL_R_DROP, LVL_FAIL_PCT dan fungsi verifyAbsorption()
  dicabut (bersama status confirmed/pending/failed dan pengukuran titik terjauh).
  Candle penyerapan (|R| >=10x bar sebelumnya DAN |R| >=50, effort >=3 SOL) LANGSUNG
  jadi garis level di bar yang sama. **Tidak ada lagi "penyerapan gagal"**; level tidak
  dibatalkan oleh penembusan harga yang datang belakangan.
- **Aturan dasar baru: R BESAR = level.** Sekalian: TIDAK ADA status tunggu apa pun di
  mesin — scanSignals mengembalikan `pending: null` selalu.

**Tetap tidak diubah:** ambang deteksi penyerapan (R_SPIKE_MULT=10, R_MIN_ABS=50,
ABSORB_MIN_CVD=3), penanda RAPUH (v9.2.15), fetch walk (v9.2.16), R MONITOR.

**Tes:** suite `tests/regression.js` disesuaikan — tes 07/08 (verifyAbsorption) dihapus,
tes 19/20 dibersihkan dari klausa retest, tes 23 dilepas dari konstanta yang sudah mati,
lalu ditambahkan tes 35 (RETEST + seluruh konstanta validasi tidak ada lagi, baik di
export maupun di sumber), 36 (level lahir di bar penyerapan walau tidak ada bar
sesudahnya dan walau harga <5%), 37 (penembusan tidak membatalkan level), 38 (tanpa R
besar tidak ada level: |R| <50, lonjakan <10x, effort <3 SOL — masing-masing diisolasi).
Total 36 tes, LULUS semua.

**Status: SELESAI** — ter-merge ke `main` lewat PR #9 (v9.2.17 + v9.2.18).

> **Catatan kehilangan kerja (penting, untuk sesi berikutnya).** Kedua commit ini
> sempat ADA di branch sesi (`2a0be80` v9.2.17, `67fb224` v9.2.18) tapi sesi ditutup
> sistem sebelum sempat di-push, jadi kerja itu tidak ada di GitHub dan tidak ada di
> sandbox baru. Pemulihannya hanya mungkin karena file hasil masih dipegang user:
> ZIP diunggah lewat portal (`tools/upload_portal.py`, POST /upload) lalu di-commit.
> **Aturan baru: push + buat PR SEGERA setelah setiap commit yang disetujui user** —
> jangan menumpuk commit lokal di ujung sesi. Upload portal sebaiknya menyertakan
> `tests/regression.js` dan `DECISIONS.md`; arsip portal hanya berisi 6 file ekstensi,
> sehingga suite dan catatan keputusan tidak ikut berpindah.


## 2026-08-27 — OPEN/CLOSE bebas trade debu (v9.2.19)

**Masalah:** laporan user — 27 Agu jam 23:00 (WIB) harga naik ~3%, tapi R MONITOR
menampilkan `harga -0,04%` (dan R meledak jadi TEMBOK). Verifikasi engine dilakukan
dengan reproduksi data sintetis langsung pada `content.js` via hook suite regresi:

- bar 23: open jujur 100,2 → close jujur 103,3 (+3,09%), effort 9 SOL;
- ditambah satu sell DEBU `0,00001 SOL` di akhir bar di harga 100,16;
- hasil engine v9.2.18: `chg_pct = -0,0399%` (≈ -0,04% di tabel), `R = 225,4× acuan`,
  status **TEMBOK SELLER** — persis gejala yang dilaporkan.

**Akar masalah:** `buildBars()` menghitung open/close dari SEMUA trade
(`priced[0]` / `priced[last]`), sedangkan HIGH/LOW sudah disaring dengan
`HL_MIN_SOL = 0,001` sejak v9.2.5 (kasus BABYSHIB — trade debu di harga ekstrem).
Trade debu yang kebetulan menjadi trade pertama/terakhir bar menentukan harga
buka/tutup → `chg_pct` salah → `R = |cvd_clean| / |chg_pct|` meledak, dan monitor
membaca perlawanan yang sebenarnya tidak ada. Ini bukan kesalahan aritmetika
(`close/open−1` memang benar); ini cacat integritas INPUT open/close.

**Keputusan:**
- Aturan v9.2.5 (high/low hanya dari trade ≥ `HL_MIN_SOL`) diterapkan JUGA ke
  open/close: `open`/`close` diambil dari trade bernilai nyata, fallback ke semua
  trade bila satu bar seluruhnya debu (sama seperti aturan wick — tidak boleh ada
  bar tanpa harga).
- `openRaw`/`closeRaw` (harga mentah tanpa saringan) disimpan per bar dan
  diekspor sebagai kolom `open_raw`, `close_raw` di BARS — dikosongkan bila sama
  dengan nilai yang dipakai, mengikuti pola `high_raw_mc` / `low_raw_mc`.
- Catatan export FORENSIK diperbarui menjelaskan aturan baru.
- **Tidak ada ambang sinyal yang diubah** (R_SPIKE_MULT, R_MIN_ABS, ABSORB_MIN_CVD,
  R_BAND_*, HL_MIN_SOL). Namun untuk bar yang sebelumnya tercemar debu, `chg_pct`
  dan `R` kini dihitung dari harga nyata — itu perbaikan yang diinginkan.

**Tes:** +2 tes — 39 (reproduksi kasus -0,04% → sekarang +3,09% dan R wajar, bukan
TEMBOK) dan 40 (debu di AWAL bar, bar seluruhnya debu → fallback, kolom export).
Total 38 tes, LULUS semua.

**Catatan penyebab alternatif** (tidak perlu dianggap bug, tapi bisa menjelaskan
tampilan -0,04% pada data lama):
1. Data capture tertinggal — close = trade terakhir yang BARU ter-capture; LIVE
   sinkron tiap 15 menit, tanpa LIVE hanya feeds halaman. Cek label "berjalan"
   pada bar.
2. Definisi chg — `chg_pct` = open→close dalam bar (trade pertama vs terakhir),
   bukan close-vs-close-jam-sebelumnya; kalau lonjakan terjadi di awal jam (gap),
   bar bisa tampak datar.
3. Zona waktu — label ekstensi selalu WIB (Asia/Jakarta); GMGN mengikuti timezone
   browser. Kalau browser bukan WIB, "jam 23" di chart GMGN ≠ "jam 23" di ekstensi.


## 2026-08-29 — LIVE "❌ gagal · +0 TX": from per request dibatasi + fallback URL (v9.2.20)

**Masalah:** laporan user — status LIVE berhenti di `LIVE ❌ gagal · +0 TX · next
09.08`. Belum ada data tersimpan (`+0 TX`), berarti request pertama
`walkTradeRange` gagal (bukan sekadar tidak ada trade baru).

**Akar masalah (2):**

1. `walkTradeRange` selalu mengirim `from=startTs` (4 hari lalu untuk LIVE awal) ke
   SETIAP request. Perilaku API GMGN yang sudah tercatat sejak v9.2.16: `from` yang
   jauh di belakang `to` dipotong; pada request tertentu (jendela 4 hari, `limit=200`,
   `event=buy&event=sell`) response bisa `code != 0`, sehingga walk berhenti di
   halaman 0 dan LIVE lapor gagal.
2. `gmgnRequest` hanya mencoba SATU format URL (`limit=200`, dengan dua filter
   `event=`), lalu menyerah. Tidak ada fallback page size / filter dan tidak ada
   penyebab kegagalan di status — user harus buka console.

**Keputusan:**

- `walkTradeRange` kini membatasi `from` per request menjadi
  `max(startTs, to - API_FROM_WINDOW_SEC)` dengan `API_FROM_WINDOW_SEC = 24 jam`.
  Loop yang memundurkan `coveredTo` TETAP menutup rentang penuh (4 hari) dalam
  jendela-jendela 1 hari, jadi tidak ada trade yang hilang dan alasan v9.2.16
  (from dipotong ~1 hari) tidak lagi menghancurkan request.
- `gmgnRequest` mencoba urutan variant: default → `limit=100` → `limit=50` →
  `tanpa filter event + limit=50`. Default tetap 3 retry jaringan; fallback 1x.
- Penyebab kegagalan terakhir disimpan di `lastRequestError` dan ditampilkan di
  status LIVE (`LIVE ❌ code=... / HTTP ... · +N TX · next ...`), panjangnya dipotong.
- **Tidak ada ambang sinyal yang diubah** — murni keandalan pengambilan data.

**Tes:** +2 tes — 41 (API yang MENOLAK from jauh tetap menutup 4 hari, jadi walk
tidak lagi gagal di halaman 0) dan 42 (helper URL fallback limit/event).
Suite regresi kini 40 tes dan LULUS semua.


## 2026-08-29 — Rollback v9.3.0 dari v9.2.14 + GMGN Agent API + AKD ENGINE

**Rollback dulu.** User meng-upload ZIP "versi yang work" lewat portal
(`_incoming/20260829-125746__SMART_SEROK/`, isi = **v9.2.14**: LEVEL ENGINE
4 sinyal, export satu tombol, chart scroll horizontal). Aturan lama berlaku:
file versi kerja dari user MENANG atas isi repo. Repo v9.2.20 (pencarian work
LIVE 0 TX) ditinggalkan; pekerjaan baru dibangun di ATAS v9.2.14.

### GMGN Agent API (OpenAPI) — v9.3.0

- Sumber protokol: `github.com/GMGNAI/gmgn-skills` (`src/client/OpenApiClient.ts`,
  `src/config.ts`). Host `https://openapi.gmgn.ai`. Endpoint DATA (token/market/
  user-read) pakai auth "exist": header `X-APIKEY: <key>` + query
  `timestamp` (detik, toleransi ±5s) & `client_id` (UUID). Swap/order butuh
  tanda tangan Ed25519/RSA dengan PRIVATE KEY — **tidak dipakai** (read-only).
- **Key bawaan tertanam** (`gmgn_cae4…c925`) di `bridge.js`; dipakai otomatis.
  Kolom input di panel + tombol Simpan → key kustom disimpan di
  `chrome.storage.local` (autosave, tidak perlu isi ulang); tombol "Default"
  kembali ke key bawaan.
- **Arsitektur dua world.** `content.js` tetap MAIN world (harus hook fetch/XHR
  halaman). MAIN world tak bisa CORS ke openapi.gmgn.ai, maka `bridge.js`
  berjalan sebagai content script KEDUA di ISOLATED world + host_permissions
  `https://openapi.gmgn.ai/*` → fetch lintas-origin diizinkan browser. Komunikasi
  MAIN→ISOLATED lewat `window.postMessage` dengan tag `SMART_SEROK_*`.
- Fitur: (a) **Smart Tags** — `/v1/user/smartmoney` + `/v1/user/kol` (limit 200,
  chain sol), registry wallet disimpan di `walletTagRegistry` → tag
  `smart_money`/`kol` menempel di trade yang sudah ter-capture; cache 6 jam di
  storage. (b) **Token API** — `/v1/token/info` + `/v1/token/security`
  dirangkum di kartu (honeypot/renounce/mint/LP burn/sniper/bundle/top10/pajak).
- Auto: status key di-refresh 0,8 dtk setelah boot; smart tags ditarik 2,5 dtk.

### AKD ENGINE — akumulasi & distribusi senyap dari CVD

Mesin BARU, terpisah dari LEVEL ENGINE (LEVEL ENGINE = 1 candle penyerapan
raksasa yang TERBUKTI; AKD = pola aktivitas senyap lintas 6–18 candle).
Jendela jalan 6–18 bar, ambang dinormalisasi ke median |cvd_clean| (otomatis
menyesuaikan likuiditas token, sama seperti R MONITOR). Enam sinyal:

1. `AKUMULASI — ABSORPSI JUAL DI SUPPORT`: CVD window turun tajam
   (|net| ≥ 0,9× upaya normal) tapi harga tertahan (|chg| <3% / malah lower-low
   tipis): jual market ritel diserap beli pasif whale. Penguat: window menempel
   garis support LEVEL ENGINE (+8 skor).
2. `AKUMULASI — BELI BERTAHAP SAAT FLAT`: rentang high-low ≤4% & |chg| ≤2%,
   ≥55% bar net beli, CVD merangkak konsisten.
3. `BULLISH DIVERGENCE`: dua swing dalam window — harga lower-low kedua (≥0,8%)
   tapi delta CVD PER SEGMEN membaik (tekanan jual menyusut). Penting: yang
   dibandingkan delta segmen, BUKAN CVD absolut (saat lower-low CVD absolut
   masih turun; versi pertama yang membandingkan cum absolut tidak pernah
   menyala).
4–6. Cermin distribusi: absorpsi beli di resistance (whale distribusi pasif ke
   ritel FOMO), jual bertahap saat flat, bearish divergence.

Sinyal AKD **tidak kedaluwarsa** (fase akumulasi bisa berhari-hari; satu sinyal
per pola per episode dengan latch 18 bar). Skor 30–96 → grade A+/A/B+/B.
OI (Open Interest) disebut di narasi sebagai konfirmasi tambahan KHUSUS futures
— spot meme on-chain tidak punya OI. Tes: `tests/akd_smoke.js`, 20 assertions,
LULUS semua (3 pola beli + 2 pola divergence + negatif tren sehat + data pendek
+ wash). File hasil: manifest.json, bridge.js, content.js, README.txt, icons.
