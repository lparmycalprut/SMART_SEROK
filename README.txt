SMART SEROK v9.2.0 — LEVEL ENGINE
=================================
Load unpacked: Chrome → chrome://extensions → Developer mode → Load unpacked.
Setelah update ekstensi, klik Reload lalu hard-refresh tab GMGN (Ctrl+Shift+R) agar
script versi lama yang masih menempel di halaman benar-benar diganti.

PERUBAHAN BESAR
---------------
Semua sinyal lama DIHAPUS (WASPADA DUMP, SIAP2 PUMP, SERAP SELL, BATTLE TERJADI).
Sekarang hanya ada 4 sinyal, semuanya berbasis level.

Ide dasarnya: R yang melonjak menandakan ada yang menyerap. Tapi penyerapan bisa
BERHASIL atau GAGAL. Hanya penyerapan yang TERBUKTI berhasil yang melahirkan level.
Level itu kemudian dipantau: saat harga kembali ke sana dengan R yang hanya normal,
artinya penjaga level sudah tidak hadir lagi — tidak ada supply/demand tersisa di situ.

EMPAT SINYAL
------------
1. RESISTANCE TERBENTUK
   Candle penyerapan BUY: |R| ≥ 10× bar sebelumnya, |R| ≥ 10, R bertanda POSITIF
   (net BUY diserap seller). Lalu TERBUKTI dalam ≤6 bar berikutnya:
     - R runtuh ≤50% dari R candle penyerapan (median bar sesudahnya)
     - cumCVD turun
     - harga turun ≥2%
   Level = LOW–HIGH candle penyerapan itu, dinyatakan dalam MARKET CAP.

2. SUPPORT TERBENTUK
   Kebalikannya: R bertanda NEGATIF (net SELL diserap buyer), lalu terbukti dengan
   R runtuh, cumCVD naik, dan harga naik ≥2%.

3. RETEST RESISTANCE — KEMUNGKINAN BREAKOUT
   Harga kembali menyentuh zona resistance, TETAPI:
     - |R| hanya ≤1,2× median |R| klaster aktif (tidak ada perlawanan berarti)
     - cumCVD NAIK
   Artinya seller yang dulu menjaga level itu sudah tidak ada. No supply lagi di situ.

4. RETEST SUPPORT — KEMUNGKINAN BREAKDOWN
   Harga kembali ke zona support dengan R normal dan cumCVD TURUN.
   Buyer yang dulu menjaga sudah tidak hadir.

PENYERAPAN GAGAL
----------------
Jika setelah penyerapan harga justru menembus level >2% ke arah yang berlawanan
dengan penyerapan, itu dianggap GAGAL:
  - tidak melahirkan level
  - tidak muncul di daftar sinyal sama sekali
Ini yang membedakan v9.2.0 dari versi lama: dulu spike R langsung jadi sinyal,
sekarang wajib dibuktikan dulu oleh pergerakan harga sesudahnya.

SATU ALERT PER KUNJUNGAN
------------------------
Candle berturut-turut di zona yang sama tidak memunculkan alert berulang. Alert baru
hanya muncul setelah harga keluar zona lalu kembali lagi.

AMBANG (content.js)
-------------------
  R_SPIKE_MULT      10     |R| vs bar sebelumnya
  R_MIN_ABS         10     lantai |R|
  ABSORB_MIN_CVD    3 SOL  lantai effort agar R tidak artefak pembagian
  LVL_CONFIRM_BARS  6      jendela pembuktian
  LVL_R_DROP        0.5    R sesudahnya harus ≤50%
  LVL_MIN_MOVE_PCT  2      harga wajib bergerak ≥2% ke arah yang benar
  LVL_FAIL_PCT      2      tembus >2% = penyerapan gagal
  LVL_ZONE_PAD_PCT  0.5    toleransi sentuhan zona saat retest
  LVL_RETEST_R_MAX  1.2    retest valid bila |R| ≤1,2× median klaster

R MONITOR
---------
Mode baca R murni tetap ada. Tombol di toolbar untuk berpindah antara
R MONITOR dan MODE SINYAL. R MONITOR tidak memberi sinyal, hanya melaporkan
kondisi perlawanan per candle: BEBAS / NORMAL / SERAP / TEMBOK / SEPI.

MARKET CAP
----------
Level dan retest selalu dinyatakan dalam MARKET CAP, bukan price. Ekstensi
mengambil effective supply dari holder, lalu token_info, lalu inferensi.
Jika belum tertangkap, detail menampilkan "MC belum tersedia".

EXPORT
------
Nama file memakai SIMBOL token, bukan contract address:
  <SIMBOL>.csv        — recap + BARS + RAW TRADES
  <SIMBOL>_AI.csv     — ringkas untuk analisa AI
BARS memuat kolom r_ratio dan r_state dari R MONITOR.

CATATAN
-------
- Tidak ada konfirmasi otomatis; keputusan entry tetap manual.
- Wash tidak menjadi syarat sinyal; nilainya tetap ditampilkan.
- Jam menggunakan WIB (Asia/Jakarta, UTC+7).
