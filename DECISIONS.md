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
