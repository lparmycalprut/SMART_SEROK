SMART SEROK v9.2.11 — LEVEL ENGINE
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
   Candle penyerapan BUY: |R| ≥ 10× bar sebelumnya DAN |R| ≥ 50, R bertanda POSITIF
   (net BUY diserap seller). Lalu TERBUKTI dalam ≤12 bar berikutnya:
     - R runtuh ≤50% dari R candle penyerapan
     - cumCVD turun
     - harga turun ≥5% DIUKUR KE TITIK TERJAUH, bukan ke bar terakhir

   Contoh: high 121,76K lalu turun sampai 49,54K (−59%). Yang membuktikan level
   adalah titik 49,54K itu, meskipun setelahnya harga memantul naik lagi.
   GARIS LEVEL = HIGH candle penyerapan, dinyatakan dalam MARKET CAP.
   (rentang LOW–HIGH tetap ditampilkan sebagai konteks)

2. SUPPORT TERBENTUK
   Kebalikannya: R bertanda NEGATIF (net SELL diserap buyer), lalu terbukti dengan
   R runtuh, cumCVD naik, dan harga naik ≥5% ke titik terjauh.
   GARIS LEVEL = LOW candle penyerapan.

3. RETEST RESISTANCE — KEMUNGKINAN BREAKOUT
   Harga kembali menyentuh GARIS resistance (HIGH candle penyerapan), TETAPI:
     - |R| hanya ≤1,2× median |R| klaster aktif (tidak ada perlawanan berarti)
     - cumCVD NAIK
   Artinya seller yang dulu menjaga level itu sudah tidak ada. No supply lagi di situ.

4. RETEST SUPPORT — KEMUNGKINAN BREAKDOWN
   Harga kembali menyentuh GARIS support (LOW candle penyerapan) dengan R normal
   dan cumCVD TURUN. Buyer yang dulu menjaga sudah tidak hadir.

RETEST = KEMBALI KE GARIS, BUKAN KE PITA
----------------------------------------
Retest diukur terhadap SATU GARIS:
  resistance -> HIGH candle penyerapan
  support    -> LOW  candle penyerapan
Toleransi sentuhan 0,5% dari harga garis.

Selain itu harga wajib PERGI dulu sebelum boleh dihitung "kembali": harus menjauh
minimal 2% dari garis (LVL_EXIT_PCT) agar level menjadi "armed". Tanpa syarat ini,
harga yang masih berkeliaran di sekitar level yang baru terbentuk akan salah
terbaca sebagai retest. Setelah satu alert, level dikunci lagi sampai harga
kembali menjauh — jadi tetap satu alert per kunjungan.

PENYERAPAN GAGAL
----------------
Jika setelah penyerapan harga justru menembus level >2% ke arah yang berlawanan
dengan penyerapan, itu dianggap GAGAL:
  - tidak melahirkan level
  - tidak muncul di daftar sinyal sama sekali
Ini yang membedakan v9.2.0 dari versi lama: dulu spike R langsung jadi sinyal,
sekarang wajib dibuktikan dulu oleh pergerakan harga sesudahnya.

AMBANG (content.js)
-------------------
  R_SPIKE_MULT      10     |R| minimal 10x bar sebelumnya
  R_MIN_ABS         50     lantai |R| — di bawah ini bukan penyerapan
  ABSORB_MIN_CVD    3 SOL  lantai effort agar R tidak artefak pembagian
  LVL_CONFIRM_BARS  12     jendela pembuktian
  LVL_R_DROP        0.5    R sesudahnya harus ≤50%
  LVL_MIN_MOVE_PCT  5      harga wajib bergerak ≥5% ke titik terjauh
  LVL_FAIL_PCT      2      tembus >2% = penyerapan gagal
  LVL_LINE_PAD_PCT  0.5    toleransi sentuhan garis saat retest
  LVL_EXIT_PCT      2      harga wajib menjauh ≥2% dari garis sebelum retest
  LVL_RETEST_R_MAX  1.5    retest valid bila |R| <1,5× acuan (= band normal R MONITOR)

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


────────────────────────────────────────────────────────────────────────
PANEL "STATUS PEMANTAUAN RETEST"  (v9.2.4)
────────────────────────────────────────────────────────────────────────
Di bawah daftar sinyal ada status tiap level aktif yang menjelaskan kenapa
sinyal retest BELUM muncul. Kemungkinan pesannya:

  "harga belum menyentuh garis — terdekat X%"
      Harga belum benar-benar balik ke garis. Toleransi sentuhan 0,5%.

  "menyentuh garis N× tapi ditahan — R masih tinggi (X× > 1,5×)"
      Harga sudah balik, TAPI masih ada perlawanan di situ. Ini justru
      informasi bagus: penjaga level masih hadir, belum waktunya breakout.

  "menyentuh garis N× tapi ditahan — cumCVD arah salah"
      Resistance butuh cumCVD NAIK, support butuh cumCVD TURUN.

  "level belum ter-arm (harga belum menjauh 2%)"
      Harga masih nempel di level, belum pernah "pergi" — jadi kembalinya
      belum dihitung sebagai retest.

  "volume terlalu sepi"
      Effort < 3 SOL. R di bar sepi tidak bermakna.

CATATAN AMBANG (v9.2.4)
  LVL_RETEST_R_MAX disamakan dengan R_BAND_ABSORB (1,5) supaya konsisten:
  bar yang dibaca "normal" oleh R MONITOR juga dianggap normal oleh mesin
  retest. Sebelumnya 1,2 — ada bar ber-R 1,3× yang tampil "normal" di
  R MONITOR tapi diam-diam ditolak sebagai retest.


────────────────────────────────────────────────────────────────────────
HIGH/LOW KEBAL TRADE DEBU  (v9.2.5)
────────────────────────────────────────────────────────────────────────
HL_MIN_SOL = 0.001

Trade berukuran ~0 SOL sering tercetak di harga ekstrem (salah rute, sisa
pembulatan, spam). Karena GARIS LEVEL = HIGH/LOW candle penyerapan, satu
trade debu bisa menarik garis ke harga yang TIDAK PERNAH benar-benar
diperdagangkan — akibatnya harga tak pernah menyentuh garis itu lagi dan
sinyal RETEST tidak pernah muncul.

Kasus nyata BABYSHIB, 20 Agustus 01:00 WIB:
  satu trade 0,0000 SOL di harga 2,5243e-4
  -> HIGH tercatat $250,5K
  -> padahal harga nyata tertinggi bar itu $121,76K (0,53 SOL)
  -> garis resistance meleset 106%; retest jam 19:00 tidak terdeteksi

Sekarang HIGH/LOW hanya dihitung dari trade >= 0,001 SOL. OPEN, CLOSE, CVD
dan R tetap memakai SELURUH trade — hanya penentuan wick yang disaring.
Kalau semua trade dalam satu bar berukuran debu, bar itu memakai seluruh
trade (fallback) agar tidak ada bar tanpa harga.

ARMING TERTUNDA
Bar yang menjauhkan harga dari garis baru meng-arm level pada bar
BERIKUTNYA. Tanpa ini, satu candle breakout besar yang wick bawahnya masih
menyerempet garis bisa memicu retest duplikat di bar yang sama
(BABYSHIB 20 Agu 20:00).


────────────────────────────────────────────────────────────────────────
BACAAN R DITULIS ULANG  (v9.2.6)
────────────────────────────────────────────────────────────────────────
Teks lama menempelkan dua fakta terpisah dengan titik tengah:

  "perlawanan kuat saat harga turun · BUY diserap seller"

Terbaca kontradiktif: kenapa harga TURUN kalau yang masuk BUY? Padahal
justru itu maksudnya — beli masuk, tapi harga tetap jatuh karena seller
menyerap semuanya. Kalimatnya yang salah, bukan datanya.

Sekarang satu kalimat utuh yang menyatukan arah harga + siapa yang menahan:

  net BELI masuk (R positif)
    harga naik tipis  -> "beli masuk tapi harga cuma naik 0.4%
                          — seller menahan kuat di atas"
    harga malah turun -> "beli masuk tapi harga malah turun 0.5%
                          — seller menekan kuat, permintaan diserap habis"

  net JUAL keluar (R negatif)
    harga turun tipis -> "jual keluar tapi harga cuma turun 0.6%
                          — buyer menahan kuat di bawah"
    harga malah naik  -> "jual keluar tapi harga malah naik 0.5%
                          — buyer menyerap kuat, tekanan jual ditelan"

Kata "kuat" hanya muncul pada TEMBOK (>=4x acuan); SERAP memakai kalimat
yang sama tanpa "kuat".

TEKS BANTUAN JADI DINAMIS
Panel bantuan dan catatan header CSV dulu menulis ambang sebagai angka
mati, sehingga tertinggal saat konstanta berubah. Sebelum perbaikan ini
panel masih menyebut "|R|>=10", "<=6 bar", ">=2%", "<=1,2x median" —
semuanya sudah usang. Sekarang semua diinterpolasi dari konstanta, jadi
tidak akan pernah basi lagi.

ISTILAH "ZONA" DIHAPUS
Level adalah GARIS (satu titik harga), bukan pita. Teks yang masih
menyebut "harga kembali ke zona level" diganti "harga balik menyentuh
GARIS itu". Narasi retest juga memakai istilah yang konsisten dengan
sinyalnya: "kemungkinan tembus ke atas" / "kemungkinan jebol ke bawah".


────────────────────────────────────────────────────────────────────────
TEMBOK SELLER vs TEMBOK BUYER  (v9.2.7)
────────────────────────────────────────────────────────────────────────
Dulu semua R >=4x acuan diberi label "TEMBOK" merah, baik yang di atas
maupun di bawah garis nol. Padahal keduanya berlawanan arti.

  +R  (batang di ATAS garis)   = order SELL yang menahan
      -> judul  : TEMBOK SELLER
      -> warna  : merah  #ef4444
      -> artinya: harga sulit naik

  -R  (batang di BAWAH garis)  = order BUY yang menahan
      -> judul  : TEMBOK BUYER
      -> warna  : hijau  #22c55e
      -> artinya: harga sulit turun

Berlaku di semua tempat: pil kondisi pada tabel candle, warna batang
grafik, pita zona >=4x (atas merah, bawah hijau), label ambang di sumbu
kanan, ringkasan candle terakhir, panel bantuan, dan kolom r_state pada
ekspor CSV (TEMBOK_SELLER / TEMBOK_BUYER).

Label sumbu kiri diperjelas: +R = "order SELL", -R = "order BUY"
(sebelumnya "serap BUY" / "serap SELL" yang membingungkan).

SERAP (>=1,5x), BEBAS, NORMAL, SEPI tidak berubah. Ambang tembok tetap
R_BAND_WALL = 4x. Tata letak grafik tidak diubah.


────────────────────────────────────────────────────────────────────────
BLOK MENYALA SESUAI BESAR SERAPAN  (v9.2.8)
────────────────────────────────────────────────────────────────────────
R_BAND_BLAZE = 12

Sebelumnya semua tembok (>=4x acuan) diwarnai sama persis, padahal 4x dan
200x sangat berbeda artinya. Sekarang candle bertembok diberi BLOK LATAR
setinggi setengah panel, dan terangnya mengikuti besar serapan.

  sisi ATAS  (+R, order SELL menahan) -> blok MERAH
  sisi BAWAH (-R, order BUY menahan)  -> blok HIJAU

  rasio      warna      opacity blok   keterangan
   4x        #ef4444    0.10           tembok baru muncul
   6x        #ff2d2d    0.21
   8x        #ff2d2d    0.29
  >=12x      #ff0033    0.40           RAKSASA: menyala penuh + 🔥
                                       + garis tepi terang + penanda ▮

Sisi buyer memakai tangga hijau yang setara:
  #22c55e -> #00e05a -> #00ff66

Skalanya LOGARITMIK antara 4x dan 12x, lalu jenuh. Kalau linear terhadap
rasio mentah, satu candle 200x akan membuat semua candle 12x-30x terlihat
pucat padahal sama-sama raksasa.

Blok hanya digambar pada setengah panel sesuai sisinya, tidak pernah
melintasi garis nol, sehingga tembok seller dan tembok buyer tidak
tertukar secara visual.

Label pada tabel jadi "TEMBOK SELLER 🔥" / "TEMBOK BUYER 🔥" untuk serapan
raksasa, dan bacaannya diberi tambahan "· serapan RAKSASA 150x acuan".

Ambang tembok tetap R_BAND_WALL = 4x. SERAP, BEBAS, NORMAL, SEPI dan tata
letak grafik tidak berubah.


────────────────────────────────────────────────────────────────────────
BUKTI DINILAI MAJU BAR PER BAR  (v9.2.9)
────────────────────────────────────────────────────────────────────────
verifyAbsorption() dulu memindai SELURUH jendela 12 bar mencari
penembusan level LEBIH DULU, baru menilai bukti. Akibatnya level yang
sudah terbukti berjam-jam sebelumnya tetap dibatalkan oleh pantulan yang
datang belakangan.

Kasus nyata Plumber, 21 Agustus 01:00 WIB:
  penyerapan  : R 70,0 (18,5x bar sebelumnya), CVD +6,6 SOL  -> LULUS
  garis HIGH  : $132,9K
  02:00-05:00 : harga jatuh ke $102,1K (-18,6%), R runtuh 70 -> 2,5
                cumCVD -132 -> -145            -> BUKTI SUDAH LENGKAP
  06:00       : memantul, close $139,5K (+5% di atas garis)

Versi lama: melihat penembusan jam 06:00 lebih dulu -> "penyerapan GAGAL",
level tidak pernah muncul. Padahal itu resistance sah yang bertahan 4 jam
lalu ditembus — kejadian biasa, bukan penyerapan gagal.

Sekarang mesin berjalan MAJU bar per bar. Di tiap langkah:
  1. cek apakah bukti sudah lengkap sampai titik itu -> CONFIRMED, berhenti
  2. kalau belum, cek penembusan                     -> FAILED, berhenti

Urutan ini membuat penembusan hanya membatalkan level yang BELUM terbukti.
Prinsipnya sama dengan pengukuran titik terjauh (v9.2.3): begitu level
terbukti, ia tidak bisa dibatalkan oleh apa yang terjadi sesudahnya.

Aturan penyerapan gagal TETAP berlaku: kalau harga menembus level sebelum
bukti lengkap, tidak jadi level dan tidak ditampilkan.


────────────────────────────────────────────────────────────────────────
SATU TOMBOL EXPORT  (v9.2.11)
────────────────────────────────────────────────────────────────────────
Dulu ada dua tombol: "Export" (recap + bars + RAW TRADES, ~800 KB) dan
"for AI" (bars saja, ~8 KB). Sekarang tinggal satu: "⬇ Export CSV".

Raw trades DIBUANG — itu penyumbang ~99% ukuran file. Contoh nyata:
Plumber.csv 806 KB vs Plumber_AI.csv 8 KB untuk data yang sama.

Sebagai gantinya file baru membawa hal-hal yang dulu hanya bisa dijawab
dengan membuka raw trades:

  1. LEVEL & SINYAL — tiap level/retest yang terdeteksi beserta narasi
     lengkapnya (garis MC, jam pembentukan, angka penyerapan, pembuktian).
  2. STATUS RETEST — untuk tiap level, alasan kenapa retest belum muncul
     (belum menyentuh garis / R masih tinggi / cumCVD arah salah / dst).
  3. FORENSIK WICK — kolom high_raw_mc, low_raw_mc, dust_tx, max_trade_sol.
     high/low resmi hanya dari trade >=0,001 SOL; kolom _raw adalah versi
     tanpa saringan. Kalau keduanya berbeda jauh berarti ada trade debu di
     harga ekstrem. Ini yang dulu butuh 800 KB raw trades untuk ketahuan
     (kasus BABYSHIB 20 Agu 01:00: HIGH $250,5K vs nyata $121,8K).
     Kolom _raw sengaja DIKOSONGKAN kalau nilainya sama dengan yang
     dipakai, supaya file tidak membengkak oleh angka berulang.
  4. r_baseline_median dan r_ratio + r_state per bar, jadi pembacaan
     R MONITOR bisa direproduksi persis tanpa menghitung ulang.

Ukuran hasil: ~9 KB untuk 49 bar (1 jam TF) — praktis sama dengan file AI
lama, tapi isinya jauh lebih berguna untuk analisa ulang.

Nama file tetap NAMA TOKEN saja (tanpa CA/mint), tanpa akhiran _AI.
Kolom r_state di CSV dibersihkan dari emoji: TEMBOK_SELLER_RAKSASA,
bukan "TEMBOK_SELLER_🔥".

================================================================
TEMBOK MENYALA HARUS SETARA SINYAL (v9.2.11)
================================================================
MASALAH
Warna blok tembok dulu ditentukan MURNI oleh rasio |R| terhadap
acuan klaster. Akibatnya candle yang rasionya besar tapi |R|-nya
kecil ikut menyala merah sebagai "TEMBOK SELLER RAKSASA",
padahal candle itu tidak akan pernah melahirkan sinyal.

Contoh nyata (Plumber, acuan median 1,52):
  19 Agu 08:00   |R| = 45,8   rasio 30,1x   -> dulu RAKSASA (salah)
  19 Agu 09:00   |R| = 29,3   rasio 19,2x   -> dulu RAKSASA (salah)
  21 Agu 01:00   |R| = 70,0   rasio 46,0x   -> RAKSASA (benar)

Dua yang pertama ada di bawah lantai |R| >= 50, jadi absorptionAt()
menolaknya. Mata melihat bahaya besar, mesin tidak mengeluarkan
sinyal apa pun. Itu kontradiksi.

PERBAIKAN
Ditambahkan isAbsorbGrade(bar, prev) yang memakai ambang yang sama
persis dengan mesin sinyal:
  |R| >= R_MIN_ABS (50)  DAN  lonjakan >= R_SPIKE_MULT (10x) bar sebelumnya
Hanya candle yang lolos itu boleh mencapai warna menyala penuh dan
status RAKSASA. Candle bertembok lain tetap ditandai TEMBOK
SELLER/BUYER dengan warna dasar, dibatasi di bawah ambang menyala.

readR() sekarang menerima parameter ketiga (bar sebelumnya). Semua
5 pemanggil sudah dilewatkan bar sebelumnya: ringkasan R MONITOR,
skala grafik, batang grafik, tabel candle, dan penulisan CSV.

HASIL PADA DATA PLUMBER (49 bar)
  tembok        : 4 candle
  menyala       : 1 candle  (21 Agu 01:00)
  kandidat sinyal: 1 candle  (21 Agu 01:00)
Yang menyala tepat sama dengan yang menghasilkan sinyal.

Regresi 9 tes: LULUS semua.

================================================================
DUA KELAS TEMBOK: KALEM vs MENYALA (v9.2.12)
================================================================
MASALAH
Setelah v9.2.11 status RAKSASA sudah benar, tapi WARNANYA masih
hampir sama. Tembok biasa tetap #ef4444 (merah terang) dan raksasa
#ff0033 — bedanya cuma 1,3x luminansi. Di layar penuh candle,
tembok sepele terlihat sama mengancamnya dengan serapan raksasa.

PERBAIKAN — warna
  TEMBOK BIASA  seller #77403f / #8a4744  (merah bata teredam)
                buyer  #3d6b50 / #457a5a  (hijau lumut teredam)
  RAKSASA       seller #ff3355            (merah menyala)
                buyer  #00ff5e            (hijau menyala)

Loncatan kecerahan biasa -> raksasa: seller 2,35x, buyer 4,54x.
Sebelumnya cuma 1,3x.

PERBAIKAN — ukuran
Batang candle RAKSASA dilebarkan hingga 1,9x (dibatasi 95% slot),
sudut lebih tumpul, opacity penuh, garis tepi 1,6px. Tembok biasa
tetap selebar candle lain dengan opacity 0,8.

Blok latar: tembok biasa turun ke 0,06-0,13 (nyaris bayangan),
raksasa naik ke 0,34.

CATATAN KETERBACAAN
Warna isian yang teredam itu dipakai juga sebagai warna TEKS pada
pill tabel dan tag ringkasan, dan di sana kontrasnya cuma 2,3-3,7x
terhadap latar gelap — terlalu redup untuk dibaca. Karena itu
ditambahkan wallTextColor(): teks memakai versi terang dari rona
yang sama (seller #cf8a84 = 6,8x, buyer #7fc79a = 9,4x), sehingga
nuansa warnanya tetap satu keluarga tapi tetap nyaman dibaca.
Candle raksasa memakai warna yang sama untuk isian dan teks.

Regresi 17 tes (9 lama + 8 baru soal warna/kontras): LULUS semua.

================================================================
NAMA KONSTANTA & LABEL TABEL CANDLE (v9.2.13)
================================================================
MASALAH
Tabel candle terakhir di R MONITOR cuma menampilkan 12 baris padahal
datanya bisa 48 jam. Angka 12 itu hardcoded (slice(-12)) tanpa nama,
dan tabelnya tidak menuliskan jumlahnya — harus dihitung baris per
baris untuk sadar kenapa tabel tampak lebih pendek dari datanya.

PERBAIKAN
  - slice(-12) diberi nama konstanta R_MON_TABLE_BARS = 12
    (komentar: candle terakhir yang masuk tabel).
  - Tabel kini berjudul kecil "12 candle terakhir" yang menginterpolasi
    konstanta, jadi jumlahnya langsung terbaca tanpa dihitung manual.

Nilai tetap 12 — ini murni pemberian nama & label, bukan perubahan perilaku.
