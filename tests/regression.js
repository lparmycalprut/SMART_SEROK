#!/usr/bin/env node
/**
 * SMART SEROK — suite regresi (mulai v9.2.15 dipakai sebagai file tes resmi)
 * ==============================================================================
 * Cara jalankan:  node tests/regression.js
 * Keluar:         "N/N LULUS" + exit code 0 (atau exit 1 bila ada yang gagal).
 *
 * Sejarah: README menyebut "regresi 9 tes" (v9.2.11) lalu "regresi 17 tes"
 * (v9.2.12), tetapi file suite-nya belum pernah ikut ter-commit ke repo
 * (riwayat git ter-squash). Suite lama DIREKONSTRUKSI di sini dari deskripsi
 * README v9.2.11/v9.2.12 supaya bisa terus dijalankan, lalu ditambah tes baru
 * v9.2.15 (6) dan v9.2.16 (11 — fetch walk).
 *
 * v9.2.17/v9.2.18: validasi level (LVL_CONFIRM_BARS, LVL_MIN_CONFIRM_BARS,
 * LVL_R_DROP, LVL_FAIL_PCT, LVL_MIN_MOVE_PCT, verifyAbsorption) dan sinyal
 * RETEST DIHAPUS dari content.js. Sesuai README v9.2.18: tes 07/08 (verifyAbsorption)
 * DIHAPUS, tes 19/20 dibersihkan dari klausa retest, tes 23 dilepas dari konstanta
 * yang sudah mati, lalu ditambahkan tes 35-38. Total: 36 tes
 * (21 warisan + 11 fetch walk + 4 level instan).
 *
 * content.js adalah content script browser (IIFE, tanpa export). Suite ini
 * menjalankan file itu di sandbox Node; content.js memanggil hook
 * globalThis.__SMART_SEROK_TEST__ (guard: hanya berfungsi bila simbol itu
 * berupa fungsi SEBELUM file dievaluasi — di browser tidak pernah terjadi).
 */

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

// ── Harness: jalankan content.js di sandbox Node ────────────────────────────
function loadEngine() {
  let api = null;
  const noop = () => {};
  const sandbox = {
    console, Math, JSON, Date, Object, Array, Number, String, Boolean, RegExp, Error,
    Map, Set, Promise, Symbol, BigInt, parseInt, parseFloat, isNaN, isFinite,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: noop,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    alert: noop,
    fetch: async function () {},
    XMLHttpRequest: class {
      open() {} send() {} addEventListener() {}
    },
    document: {
      body: null,
      addEventListener: noop,
      removeEventListener: noop,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop, setAttribute: noop, appendChild: noop }),
      documentElement: {},
    },
  };
  sandbox.window = sandbox;                 // window === global sandbox
  sandbox.location = { pathname: "/", origin: "https://gmgn.ai" };
  sandbox.self = sandbox;
  sandbox.__SMART_SEROK_TEST__ = (x) => { api = x; };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "content.js" });
  if (!api) throw new Error("Hook __SMART_SEROK_TEST__ tidak terpanggil — content.js gagal dimuat?");
  return api;
}

// ── Pabrik trade sintetis (TF 1H, bucket jam lurus) ─────────────────────────
const H = 3600;
const B = 1755900000;                       // jam-aligned epoch (WIB netral utk tes)
let uid = 0;
function T(bar, offsetSec, maker, event, sol, price) {
  return { maker, event, sol, price, ts: B + bar * H + offsetSec,
           tx_hash: "tx" + (++uid), token: 0, usd: sol * price, tags: [] };
}
// Bar "latar" biasa: dua trade satu arah, harga open->close bergerak pct tertentu.
function bgBar(bar, event, totalSol, openP, closeP, makers) {
  const half = totalSol / 2;
  const mk = makers || ["bg" + bar + "a", "bg" + bar + "b"];
  return [
    T(bar, 600, mk[0], event, half, openP),
    T(bar, 2400, mk[1] || mk[0], event, half, closeP),
  ];
}

/**
 * Skenario level lengkap: 8 bar latar (R = baseR) -> bar penyerapan (+34 SOL,
 * chg ~0.62% -> R ~55) -> 2 bar harga menjauh (R runtuh, cumCVD turun)
 * -> 1 bar menjauh -> 1 bar harga KEMBALI menyentuh garis HIGH, R normal.
 * Sejak v9.2.17 bar terakhir itu TIDAK boleh melahirkan sinyal lagi (RETEST
 * dihapus), dan sejak v9.2.18 level sudah lahir di bar 8 tanpa menunggu.
 *
 * Opsi:
 *   whale : true  -> 30 SOL dari SATU wallet (concentration ~0.88)
 *            false -> 30 SOL tersebar ke 10 wallet (concentration ~0.09)
 *   baseR : median |R| bar latar. 1.5 -> rasio penyerapan ~36x (RAKSASA),
 *           5 -> rasio ~11x (tembok besar tapi BUKAN raksasa).
 */
function scenarioTrades({ whale = true, baseR = 1.5 } = {}) {
  const trades = [];
  // 8 bar latar: harga naik +1%/bar, R = baseR
  let p = 100;
  for (let i = 0; i < 8; i++) {
    const open = p, close = p * 1.01;
    trades.push(...bgBar(i, baseR >= 0 ? "buy" : "sell", Math.abs(baseR), open, close));
    p = close;
  }
  // Bar 8: PENYERAPAN (resistance candidate). open 108.28 -> close 108.95 (+0.618%),
  // cvdClean +34 SOL  ->  R ~55 (>= 50), lonjakan vs bar 7 = 55/baseR.
  const abs8 = [
    T(8, 600, "small1", "buy", 1, 108.28),
  ];
  if (whale) {
    abs8.push(T(8, 1200, "WHALE", "buy", 30, 108.60));
  } else {
    for (let k = 1; k <= 10; k++) abs8.push(T(8, 1100 + k * 10, "dist" + k, "buy", 3, 108.60));
  }
  abs8.push(T(8, 1800, "small2", "buy", 1, 108.70));
  abs8.push(T(8, 2400, "small3", "buy", 1, 108.80));
  abs8.push(T(8, 3000, "small4", "buy", 1, 108.95));
  trades.push(...abs8);
  // Bar 9-10: bukti — harga jatuh (low 97.5, -10.5% dari close 108.95), R runtuh,
  // cumCVD turun. Bar 10 diberi effort >= 3 SOL & R normal supaya LOLOS saringan
  // kualitas candle dan blok arming di akhir iterasi benar-benar jalan
  // (bar ber-effort < 3 SOL di-`continue` sebelum pendingArm dicatat).
  trades.push(T(9, 600, "s1", "sell", 0.5, 103));
  trades.push(T(9, 2400, "s2", "sell", 0.5, 98));
  trades.push(T(10, 600, "s3", "sell", 1.5, 100));
  trades.push(T(10, 2400, "s4", "sell", 1.5, 97.5));
  // Bar 11: tetap jauh dari garis (close 93, ~15% di bawah) -> level armed.
  trades.push(T(11, 600, "s5", "sell", 1.5, 96.5));
  trades.push(T(11, 2400, "s6", "sell", 1.5, 93));
  // Bar 12: RETEST — naik sentuh garis (high 108.5 >= garis 108.95 - 0.5%),
  // R = 6/3.33 ~ 1.8 = 1.2x acuan (normal), cumCVD naik (buy).
  trades.push(T(12, 600, "r1", "buy", 3, 105));
  trades.push(T(12, 2400, "r2", "buy", 3, 108.5));
  return trades;
}

// ── Runner mini ─────────────────────────────────────────────────────────────
const results = [];
const queued = [];
let api = null;
function test(name, fn) { queued.push([name, fn]); }
async function runTests() {
  for (const [name, fn] of queued) {
    try { await fn(); results.push([true, name, ""]); }
    catch (e) { results.push([false, name, String(e && e.message || e)]); }
  }
}
// Pengaman: tes walk yang bug (loop tak berhingga) tidak menggantung suite.
const withTimeout = (p, ms, msg) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || "timeout " + ms + " ms — walk tidak selesai?")), ms)),
]);
function ok(cond, msg) { if (!cond) throw new Error(msg || "assert gagal"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "eq") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b)); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || "near") + ": " + a + " vs " + b); }

// luminansi relatif WCAG + rasio kontras (dipakai tes warna v9.2.12)
function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function relLum(hex) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = hexRgb(hex).map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) { const l1 = relLum(a), l2 = relLum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

// ── Muat engine sekali ──────────────────────────────────────────────────────
api = loadEngine();

// ── Data skenario yang dipakai beberapa tes ─────────────────────────────────
// buildBars mengharapkan nowTs dalam MILLISECOND (dibagi 1000 di dalam).
const NOW_MS = (B + 20 * H) * 1000;
const barsWhale = api.buildBars(scenarioTrades({ whale: true,  baseR: 1.5 }), NOW_MS);
const barsDist  = api.buildBars(scenarioTrades({ whale: false, baseR: 1.5 }), NOW_MS);
const barsCalm  = api.buildBars(scenarioTrades({ whale: true,  baseR: 5   }), NOW_MS);
const scanWhale = api.scanSignals(barsWhale);
const scanDist  = api.scanSignals(barsDist);
const scanCalm  = api.scanSignals(barsCalm);
const lvlEvent = (scan) => (scan.events || []).find(e => e.signal.indexOf("TERBENTUK") >= 0) || null;
// v9.2.17: sinyal RETEST dihapus — helper retestEvent ikut dicabut. Nama "RETEST"
// dijaga agar tidak muncul lagi oleh tes 36.

// ══ REGRESI LAMA — direkonstruksi dari README v9.2.11 (9 tes) ═══════════════

test("01 absorptionAt menerima kandidat: |R|>=50, lonjakan >=10x, effort cukup", () => {
  const cand = api.absorptionAt(barsWhale, 8);
  ok(cand, "bar penyerapan (idx 8) harus jadi kandidat");
  eq(cand.kind, "resistance", "cvdClean positif -> kandidat resistance");
  ok(cand.mult >= api.R_SPIKE_MULT, "lonjakan >= 10x bar sebelumnya");
});

test("02 absorptionAt menolak |R| di bawah R_MIN_ABS walau rasio besar", () => {
  // Kasus nyata Plumber 19 Agu 08:00: |R| 45,8 (rasio 30x) -> BUKAN kandidat.
  const trades = [];
  let p = 100;
  for (let i = 0; i < 8; i++) { trades.push(...bgBar(i, "buy", 3, p, p * 1.0638)); p *= 1.0638; }
  // bar 8: cvd +30, chg +0.655% -> R ~45.8 (>= 10x R bar 7 = 3/6.38 = 0.47)
  trades.push(T(8, 600, "x1", "buy", 1, p), T(8, 2400, "x2", "buy", 29, p * 1.00655));
  const bars = api.buildBars(trades, NOW_MS);
  eq(api.absorptionAt(bars, 8), null, "|R| 45.8 < 50 harus ditolak");
});

test("03 absorptionAt menolak lonjakan < 10x meski |R| besar", () => {
  const bars = api.buildBars([
    // bar 0: R = 20 (cvd 20, chg 1%) — acuan tinggi
    T(0, 600, "a", "buy", 10, 100), T(0, 2400, "b", "buy", 10, 101),
    // bar 1: R = 80 (cvd 40, chg 0.5%) -> lonjakan cuma 4x
    T(1, 600, "c", "buy", 20, 102), T(1, 2400, "d", "buy", 20, 102.51),
  ], NOW_MS);
  eq(api.absorptionAt(bars, 1), null, "lonjakan 4x < 10x harus ditolak");
});

test("04 absorptionAt menolak bar sepi (effort < ABSORB_MIN_CVD)", () => {
  const bars = api.buildBars([
    T(0, 600, "a", "buy", 0.5, 100), T(0, 2400, "b", "buy", 0.5, 101),       // R = 1
    T(1, 600, "c", "buy", 1, 102), T(1, 2400, "d", "buy", 1, 102.033),       // R ~60, effort 2 < 3
  ], NOW_MS);
  eq(api.absorptionAt(bars, 1), null, "effort 2 SOL < 3 SOL harus ditolak");
});

test("05 isAbsorbGrade: rasio besar tapi |R| < 50 -> false (Plumber 19 Agu)", () => {
  const prev = { R: 1.5 }, weak = { R: 45.8 }, strong = { R: 55 };
  eq(api.isAbsorbGrade(weak, prev), false, "|R| 45.8 di bawah lantai 50");
  eq(api.isAbsorbGrade(strong, prev), true, "|R| 55 + lonjakan 36x lolos");
  eq(api.isAbsorbGrade({ R: 55 }, null), true, "tanpa prev: jangan gugurkan");
});

test("06 readR: status RAKSASA (🔥) hanya bila grade DAN rasio >= R_BAND_BLAZE", () => {
  const base = 1.5;
  const weak = api.readR({ priceChgPct: 1, cvdClean: 45.8, R: 45.8, signedR: 45.8 }, base, { R: 1.5 });
  eq(weak.code, "TEMBOK", "tetap tembok");
  ok(!weak.blaze, "tidak menyala: |R| 45.8 < ambang sinyal");
  ok(weak.label.indexOf("🔥") < 0, "label tanpa 🔥");
  const strong = api.readR({ priceChgPct: 1, cvdClean: 55, R: 55, signedR: 55 }, base, { R: 1.5 });
  eq(strong.code, "TEMBOK", "tembok");
  ok(strong.blaze, "menyala: grade + rasio 36.7x >= 12x");
  ok(strong.label.indexOf("TEMBOK SELLER") >= 0 && strong.label.indexOf("🔥") >= 0, "label TEMBOK SELLER 🔥");
  ok(strong.desc.indexOf("RAKSASA") >= 0, "bacaan menyebut serapan RAKSASA");
  // grade tapi rasio < 12x -> tembok biasa
  const mid = api.readR({ priceChgPct: 1, cvdClean: 55, R: 55, signedR: 55 }, 10, { R: 1.5 });
  ok(!mid.blaze, "grade tanpa rasio 12x tidak menyala");
});

test("09 buildBars: HIGH/LOW kebal trade debu, high_raw tetap mencatat (BABYSHIB 20 Agu 01:00)", () => {
  const bars = api.buildBars([
    T(0, 600, "real", "buy", 0.53, 100),
    T(0, 1200, "real", "buy", 0.53, 98),
    T(0, 1800, "dust", "buy", 0.0000, 250),   // debu di harga ekstrem
  ], NOW_MS);
  eq(bars.length, 1, "satu bar");
  eq(bars[0].high, 100, "HIGH hanya dari trade >= 0.001 SOL");
  eq(bars[0].low, 98, "LOW hanya dari trade >= 0.001 SOL");
  eq(bars[0].highRaw, 250, "high_raw mencatat versi tanpa saringan");
  eq(bars[0].dustTx, 1, "dust_tx menghitung trade debu");
});

// ══ REGRESI LAMA — direkonstruksi dari README v9.2.12 (8 tes warna/kontras) ══

test("10 wallColor tembok BIASA memakai warna kalem (bukan #ef4444)", () => {
  eq(api.wallColor("seller", 0, false), "#77403f", "merah bata teredam");
  eq(api.wallColor("seller", 0.6, false), "#8a4744", "merah bata sedikit lebih hidup");
  eq(api.wallColor("buyer", 0, false), "#3d6b50", "hijau lumut teredam");
  eq(api.wallColor("buyer", 0.6, false), "#457a5a", "hijau lumut sedikit lebih hidup");
});

test("11 wallColor RAKSASA memakai warna menyala penuh", () => {
  eq(api.wallColor("seller", 1, true), "#ff3355", "seller raksasa #ff3355");
  eq(api.wallColor("buyer", 1, true), "#00ff5e", "buyer raksasa #00ff5e");
});

test("12 wallTextColor: versi TERANG dari rona sama utk teks pill/tag", () => {
  eq(api.wallTextColor("seller", 0, false), "#cf8a84");
  eq(api.wallTextColor("buyer", 0, false), "#7fc79a");
  // candle raksasa: warna teks = warna isian (tidak perlu versi terang lagi)
  eq(api.wallTextColor("seller", 1, true), api.wallColor("seller", 1, true));
  eq(api.wallTextColor("buyer", 1, true), api.wallColor("buyer", 1, true));
});

test("13 loncatan luminansi seller biasa -> raksasa >= 2x", () => {
  const biasa = relLum("#8a4744"), raksasa = relLum("#ff3355");
  ok(raksasa / biasa >= 2, "rasio luminansi " + (raksasa / biasa).toFixed(2) + "x < 2x");
});

test("14 loncatan luminansi buyer biasa -> raksasa >= 4x", () => {
  const biasa = relLum("#457a5a"), raksasa = relLum("#00ff5e");
  ok(raksasa / biasa >= 4, "rasio luminansi " + (raksasa / biasa).toFixed(2) + "x < 4x");
});

test("15 kontras teks wallTextColor terhadap latar gelap #0b1220 >= 6.5x", () => {
  ok(contrast("#cf8a84", "#0b1220") >= 6.5, "seller " + contrast("#cf8a84", "#0b1220").toFixed(2) + "x");
  ok(contrast("#7fc79a", "#0b1220") >= 6.5, "buyer " + contrast("#7fc79a", "#0b1220").toFixed(2) + "x");
});

test("16 wallGlow: 0 di bawah R_BAND_WALL, non-grade dibatasi 0.6, grade penuh 0..1", () => {
  eq(api.wallGlow(3.9, true), 0, "di bawah tembok tidak menyala");
  eq(api.wallGlow(200, false), 0.6, "tembok bukan kandidat sinyal tidak pernah penuh");
  near(api.wallGlow(api.R_BAND_BLAZE, true), 1, 1e-9, "grade mencapai 1 di 12x");
  ok(api.wallGlow(100, true) === 1, "jenuh di atas 12x (logaritmik lalu clamp)");
  ok(api.wallGlow(6, true) > api.wallGlow(5, true), "monoton naik antara 4x..12x");
});

test("17 skema warna tidak berubah: konstanta band + isian raksasa = teks raksasa", () => {
  eq(api.R_BAND_WALL, 4);
  eq(api.R_BAND_BLAZE, 12);
  eq(api.R_BAND_ABSORB, 1.5);
  eq(api.R_BAND_FREE, 0.5);
  eq(api.wallTextColor("seller", 0.3, true), api.wallColor("seller", 0.3, true), "raksasa: teks = isian");
  eq(api.wallTextColor("buyer", 0.9, true), api.wallColor("buyer", 0.9, true), "raksasa: teks = isian");
});

// ══ REGRESI BARU — v9.2.15 konsentrasi order + level RAPUH (6 tes) ═══════════

test("18 concentration_ratio benar: 1 wallet dominan vs banyak wallet merata", () => {
  // Bar dominan: whale 30 SOL + 9 wallet 1 SOL -> 30/39 = 0.769
  const dom = api.buildBars([
    T(0, 600, "w", "buy", 30, 100),
    ...Array.from({ length: 9 }, (_, i) => T(0, 1200 + i * 100, "s" + i, "buy", 1, 101)),
  ], NOW_MS);
  near(dom[0].concentrationRatio, 30 / 39, 1e-9, "dominan");
  near(dom[0].maxTradeSol, 30, 1e-9, "max_trade_sol = volume wallet terbesar");
  near(dom[0].volSol, 39, 1e-9, "vol_sol bar");
  // Bar merata: 10 wallet 1 SOL -> 1/10 = 0.1
  const flat = api.buildBars(
    Array.from({ length: 10 }, (_, i) => T(0, 600 + i * 100, "m" + i, "buy", 1, 100 + i * 0.1)),
    NOW_MS);
  near(flat[0].concentrationRatio, 0.1, 1e-9, "merata");
  // Skenario penuh: whale -> ~0.88, tersebar -> ~0.09
  near(barsWhale[8].concentrationRatio, 30 / 34, 1e-9, "bar penyerapan whale");
  near(barsDist[8].concentrationRatio, 3 / 34, 1e-9, "bar penyerapan terdistribusi");
});

test("19 level RAKSASA-grade + konsentrasi tinggi -> fragile=TRUE + tag judul + narasi", () => {
  const ev = lvlEvent(scanWhale);
  ok(ev, "skenario whale harus menghasilkan sinyal TERBENTUK");
  eq(ev.signal, "RESISTANCE TERBENTUK", "nama kanonik tidak berubah");
  eq(ev.level.fragile, true, "RAKSASA (36.7x acuan) + conc 0.88 >= 0.6 -> fragile");
  near(ev.level.concentrationRatio, 30 / 34, 1e-9, "konsentrasi tersimpan di level");
  ok(api.signalTitle(ev).indexOf("(RAPUH — whale tunggal)") >= 0, "judul diberi tag RAPUH");
  const nar = api.buildNarrative(ev);
  ok(nar.indexOf("didominasi satu wallet") >= 0 && nar.indexOf("88% dari volume bar") >= 0,
     "narasi memuat kalimat whale tunggal + persentase");
  // v9.2.17: tidak ada sinyal retest lagi — harga yang balik menyentuh garis
  // (bar 12) tidak menambah event, tapi level rapuh tetap membawa penandanya.
  eq(scanWhale.events.length, 1, "satu candle penyerapan = satu sinyal, tanpa retest");
});

test("20 level RAKSASA-grade tapi konsentrasi rendah -> fragile=FALSE", () => {
  const ev = lvlEvent(scanDist);
  ok(ev, "skenario terdistribusi tetap melahirkan level (syarat tidak berubah)");
  eq(ev.level.fragile, false, "conc 0.09 < 0.6 -> tidak rapuh walaupun RAKSASA");
  eq(api.signalTitle(ev), ev.signal, "judul tanpa tag");
  ok(api.buildNarrative(ev).indexOf("RAPUH") < 0, "narasi tanpa penanda RAPUH");
  eq(scanDist.events.length, 1, "skenario terdistribusi: satu sinyal, tanpa retest");
});

test("21 level BUKAN RAKSASA-grade -> fragile selalu FALSE meski konsentrasi tinggi", () => {
  // baseR 5 -> rasio penyerapan 11x < 12x: level sah, tembok besar, tapi bukan raksasa.
  const ev = lvlEvent(scanCalm);
  ok(ev, "level tetap terbentuk (penanda RAPUH bukan filter)");
  eq(ev.level.fragile, false, "rasio 11x < 12x -> tidak rapuh walau conc 0.88");
  eq(api.signalTitle(ev), ev.signal, "judul tetap kanonik");
  const bar8 = barsCalm[8];
  const base = api.rBaseline(barsCalm);
  eq(api.isAbsorbGrade(bar8, barsCalm[7]), true, "tetap kandidat sinyal (|R|>=50, >=10x prev)");
  eq(api.isBlazeGrade(bar8, barsCalm[7], base), false, "tapi bukan kelas RAKSASA (12x acuan)");
});

test("22 export CSV: kolom concentration_ratio di BARS + fragile/concentration di LEVEL & SINYAL", () => {
  const header = SRC.split("\n").find(l => l.indexOf("\"bar_wib,cluster,") >= 0);
  ok(header, "header BARS ditemukan");
  ok(header.indexOf("max_trade_sol,concentration_ratio") >= 0,
     "concentration_ratio tepat setelah max_trade_sol");
  ok(SRC.indexOf("fragile=") >= 0 && SRC.indexOf("concentration_ratio_at_formation=") >= 0,
     "baris LEVEL & SINYAL memuat field fragile + concentration_ratio_at_formation");
});

test("23 konstanta: ambang rapuh 0.6, LIVE 4 hari, R MONITOR 24 jam, ambang deteksi tak bergeser", () => {
  eq(api.CONCENTRATION_FRAGILE_THRESHOLD, 0.6, "ambang awal konsentrasi");
  eq(api.LIVE_FETCH_SEC, 4 * 24 * 3600, "fetch awal LIVE = 4 hari");
  eq(api.R_MON_WINDOW_SEC, 24 * 3600, "jendela R MONITOR = 24 jam");
  eq(api.rMonWindowBars(), 24, "TF 1H -> 24 candle terakhir");
  // pengaman: ambang DETEKSI penyerapan tidak boleh bergeser
  eq(api.R_SPIKE_MULT, 10);
  eq(api.R_MIN_ABS, 50);
  eq(api.ABSORB_MIN_CVD, 3);
  eq(api.HL_MIN_SOL, 0.001);
  // (validasi level & retest yang DIHAPUS dijaga oleh tes 35)
});

// ══ REGRESI BARU — v9.2.16 fetch walk / walkTradeRange (11 tes) ═════════════
// Fake API GMGN dengan perilaku persis seperti yang dilaporkan: request hanya
// mengembalikan trade di jendela [max(from, to - W), to] (W ~1 hari) — `from`
// yang lebih tua dari W di depan `to` TIDAK dipakai (dipotong). Ini perilaku
// yang membuat fetch lama berhenti di 1 hari; tes 24 mereproduksi bug itu
// dengan logika v9.2.15, tes 25+ membuktikan walk memperbaikinya.
const NOW_WALK = 1787795132;   // epoch tetap agar tes deterministik
const WALK_BASE = "https://gmgn.ai/vas/api/v1/token_trades/sol/TEST?event=buy&event=sell&limit=200";
function makeFakeGmgnApi({ days, perDay, gaps = [], windowDays = 1, pageLimit = 200 }) {
  const D = 86400;
  const trades = [];
  let id = 0;
  for (let d = days; d >= 1; d--) {               // d = d hari lalu: [now-d*D, now-(d-1)*D)
    const dayStart = NOW_WALK - d * D;
    for (let k = 0; k < perDay; k++) {
      const ts = dayStart + Math.floor((k + 0.5) * D / perDay);
      if (gaps.some(g => ts >= g[0] && ts < g[1])) continue;
      trades.push({ ts, tx_hash: "w" + (++id), event: k % 2 ? "buy" : "sell", maker: "m" + (id % 5), timestamp: ts });
    }
  }
  trades.sort((a, b) => b.ts - a.ts);              // terbaru dulu, seperti API
  const request = (url) => {
    const u = new URL(url, "https://gmgn.ai");
    const from = parseInt(u.searchParams.get("from") || "0", 10);
    const to = parseInt(u.searchParams.get("to") || "0", 10);
    const cursor = u.searchParams.get("cursor");
    const offset = cursor ? parseInt(cursor.slice(1), 10) : 0;
    const lo = Math.max(from, to - windowDays * D); // <- PEMOTONGAN: from > W diabaikan
    const filtered = trades.filter(t => t.ts <= to && t.ts >= lo);
    const slice = filtered.slice(offset, offset + pageLimit);
    const next = offset + pageLimit < filtered.length ? "o" + (offset + pageLimit) : null;
    return Promise.resolve({ code: 0, data: { history: slice, next } });
  };
  const inRange = (s, e) => trades.filter(t => t.ts >= s && t.ts <= e);
  return { request, trades, inRange };
}
const doWalk = (fake, startTs, endTs, extra) => withTimeout(
  api.walkTradeRange(Object.assign({ baseUrl: WALK_BASE, startTs, endTs, request: fake.request }, extra || {})),
  15000);

test("24 REPRODUKSI BUG LAMA: satu rantai from=7hari lalu&to=now berhenti di ~1 hari", async () => {
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500 });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  // Persis logika backgroundFetch v9.2.15: satu URL from/to, ikut cursor sampai null.
  let cursor = null, page = 0, total = 0;
  while (page < 1000) {
    const json = await fake.request(`${WALK_BASE}&from=${startTs}&to=${endTs}` + (cursor ? `&cursor=${cursor}` : ""));
    total += json.data.history.length;
    page++;
    if (!json.data.next) break;
    cursor = json.data.next;
  }
  eq(total, 500, "logika lama hanya dapat 1 hari (500 tx) dari 3500 — bug ter-reproduksi");
});

test("25 walk: 7 hari token RAMAI (500 tx/hari) tertutup penuh — semua 3500 tx", async () => {
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500 });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  const got = new Set();
  const r = await doWalk(fake, startTs, endTs, {
    onProgress: (i) => i.history.forEach(t => got.add(t.tx_hash)),
  });
  const expect = fake.inRange(startTs, endTs);
  eq(r.total, expect.length, "jumlah trade = semua trade di rentang");
  eq(got.size, expect.length, "setiap trade di rentang terkumpul persis sekali");
  ok(r.rangeWalked, "seluruh rentang dijelajahi");
  ok(r.oldest >= startTs && r.oldest <= endTs, "trade terlama sesuai rentang yang diminta");
  ok(r.pages >= 21, "multi-rantai: 500/200 = 3 halaman/hari x 7 (logika lama: 3 lalu berhenti)");
  ok(r.chainRestarts >= 6, "rantai cursor dibuka ulang tiap ~1 hari");
  ok(!r.capped && !r.failed && !r.stopped, "tanpa error");
});

test("26 walk: 3 hari token SEPI (2 tx/hari) tertutup penuh", async () => {
  const fake = makeFakeGmgnApi({ days: 3, perDay: 2 });
  const startTs = NOW_WALK - 3 * 86400, endTs = NOW_WALK;
  const got = new Set();
  const r = await doWalk(fake, startTs, endTs, {
    onProgress: (i) => i.history.forEach(t => got.add(t.tx_hash)),
  });
  const expect = fake.inRange(startTs, endTs);
  eq(r.total, expect.length, "6 trade terkumpul");
  eq(got.size, expect.length, "setiap trade terkumpul persis sekali");
  ok(r.rangeWalked, "rentang dijelajahi sampai awal");
  ok(!r.capped && !r.failed, "tanpa error");
});

test("27 walk: GAP data 2 hari di tengah dilewati dengan step mundur, data dua sisi terkumpul", async () => {
  const gap = [NOW_WALK - 4 * 86400, NOW_WALK - 2 * 86400];   // hari ke-3 s/d ke-4 hening
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500, gaps: [gap] });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  const got = new Set();
  const r = await doWalk(fake, startTs, endTs, {
    onProgress: (i) => i.history.forEach(t => got.add(t.tx_hash)),
  });
  const expect = fake.inRange(startTs, endTs);
  eq(r.total, expect.length, "semua trade di luar gap terkumpul");
  eq(got.size, expect.length, "tidak ada trade hilang / ganda");
  ok(r.rangeWalked, "gap 2 hari tidak menghentikan walk");
});

test("28 walk: token baru listing (2 hari data), diminta 7 hari -> SEMUA yang ada diambil + laporan parsial", async () => {
  const fake = makeFakeGmgnApi({ days: 2, perDay: 100 });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  const r = await doWalk(fake, startTs, endTs);
  eq(r.total, 200, "semua data yang tersedia (2 hari) diambil");
  ok(!r.covered, "data tidak menjangkau awal rentang");
  ok(r.rangeWalked, "rentang tetap dijelajahi penuh");
  ok(r.oldest > startTs && r.oldest >= NOW_WALK - 2 * 86400, "oldest = trade terlama token (±2 hari lalu)");
  const gotDays = (endTs - r.oldest) / 86400;
  ok(gotDays >= 1.9 && gotDays < 2.01, "laporan 'X hari didapat' konsisten: " + gotDays.toFixed(2) + " hari");
  ok(!r.capped && !r.failed, "berhenti karena data habis, bukan error");
});

test("29 walk: cursor API MACET (next berulang) tidak membuat loop tak berhingga", async () => {
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500 });
  const stuck = (url) => fake.request(url).then(j => ({ code: 0, data: { history: j.data.history, next: "o0" } }));
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  const got = new Set();
  const r = await doWalk({ request: stuck }, startTs, endTs, {
    onProgress: (i) => i.history.forEach(t => got.add(t.tx_hash)),
  });
  ok(r.rangeWalked, "walk tetap menyelesaikan rentang (boundary yang maju, bukan cursor)");
  eq(got.size, fake.inRange(startTs, endTs).length, "trade terkumpul lengkap tanpa duplikat");
  ok(r.pages < 200, "jumlah halaman terikat (" + r.pages + ")");
});

test("30 walk: rantai terpotong batas 2 halaman di tengah hari -> rantai baru, data tetap lengkap", async () => {
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500 });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  const got = new Set();
  const r = await doWalk(fake, startTs, endTs, {
    maxChainPages: 2,   // rantai dipotong tiap 2 halaman (400 tx)
    onProgress: (i) => i.history.forEach(t => got.add(t.tx_hash)),
  });
  const expect = fake.inRange(startTs, endTs);
  eq(r.total, expect.length, "data lengkap walau rantai pendek");
  eq(got.size, expect.length, "overlap antar rantai tidak menghasilkan duplikat");
  ok(r.chainRestarts >= 9, "rantai dibuka ulang sering (" + r.chainRestarts + "x)");
  ok(r.rangeWalked, "rentang tertutup");
});

test("31 walk: batas halaman global -> berhenti dengan flag capped (bukan diam-diam)", async () => {
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500 });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  const r = await doWalk(fake, startTs, endTs, { maxPages: 10 });
  ok(r.capped, "flag capped tersambung");
  eq(r.pages, 10, "berhenti tepat di batas 10 halaman");
  ok(r.total > 0 && r.total < 3500, "data yang sempat terkumpul tetap dihitung (" + r.total + ")");
  ok(!r.covered && !r.rangeWalked, "rentang belum tertutup — caller wajib lapor parsial");
});

test("32 walk: shouldStop (user klik STOP / LIVE off) dihormati", async () => {
  const fake = makeFakeGmgnApi({ days: 7, perDay: 500 });
  const startTs = NOW_WALK - 7 * 86400, endTs = NOW_WALK;
  let stopFlag = false;
  const r = await doWalk(fake, startTs, endTs, {
    shouldStop: () => stopFlag,
    onProgress: (i) => { if (i.page >= 4) stopFlag = true; },
  });
  ok(r.stopped, "flag stopped tersambung");
  eq(r.pages, 4, "berhenti setelah halaman 4");
  ok(!r.capped && !r.failed, "bukan error/batas — berhenti karena diminta");
});

test("33 walk: request gagal (network) -> flag failed, tidak menelan error", async () => {
  const r = await doWalk({ request: () => Promise.resolve(null) }, NOW_WALK - 86400, NOW_WALK);
  ok(r.failed, "flag failed tersambung");
  eq(r.pages, 0, "belum ada halaman sukses");
  ok(!r.rangeWalked, "rentang TIDAK dianggap dijelajahi");
});

test("34 tradeTsOf: normalisasi detik/milidetik & input tidak valid", () => {
  eq(api.tradeTsOf({ timestamp: 1787795132 }), 1787795132, "detik utuh");
  eq(api.tradeTsOf({ timestamp: 1787795132000 }), 1787795132, "milidetik -> detik");
  eq(api.tradeTsOf({ timestamp: "1787795132" }), 1787795132, "string angka");
  eq(api.tradeTsOf({ time: 1787795132 }), 1787795132, "field alternatif");
  eq(api.tradeTsOf({ block_time: 1787795132000 }), 1787795132, "block_time ms");
  eq(api.tradeTsOf({}), 0, "tanpa field -> 0");
  eq(api.tradeTsOf(null), 0, "null -> 0");
});

// ══ REGRESI BARU — v9.2.17 + v9.2.18: LEVEL INSTAN, validasi dihapus (2 tes) ══
// Penjaga dua penghapusan terbesar di level engine. Kalau salah satu syarat lama
// "balik" (masa tunggu, R runtuh, arah cumCVD, gerak >=5%, pembatalan penembusan),
// tes di bawah ini yang menjerit.

test("35 RETEST & validasi level DIHAPUS: helper/konstanta tidak di-export lagi", () => {
  // (a) hanya dua konstanta nama sinyal yang dikenal mesin
  const names = SRC.match(/^\s*const SIG_[A-Z]+ = "[^"]+";/gm).map(x => x.trim());
  eq(names.length, 2, "tepat dua nama sinyal: " + JSON.stringify(names));
  ok(names.indexOf('const SIG_RESISTANCE = "RESISTANCE TERBENTUK";') >= 0, "resistance utuh");
  ok(names.indexOf('const SIG_SUPPORT = "SUPPORT TERBENTUK";') >= 0, "support utuh");
  // (b) konstanta retest (v9.2.17) dan validasi level (v9.2.18) harus hilang
  //     dari export MAUPUN dari sumber. Kalau salah satu kembali, berarti
  //     "masa tunggu pembuktian" ikut balik.
  for (const gone of ["LVL_CONFIRM_BARS", "LVL_MIN_CONFIRM_BARS", "LVL_R_DROP",
                      "LVL_FAIL_PCT", "LVL_MIN_MOVE_PCT", "LVL_RETEST_R_MAX",
                      "LVL_RETEST_MIN_GAP", "LVL_LINE_PAD_PCT"]) {
    eq(api[gone], undefined, gone + " tidak boleh di-export lagi");
    ok(SRC.indexOf(gone) < 0, gone + " tidak boleh ada di content.js");
  }
  ok(SRC.indexOf("verifyAbsorption") < 0, "verifyAbsorption() harus hilang permanen");
  // (c) bar yang dulu memicu retest (harga balik menyentuh garis) kini diam:
  //     satu candle penyerapan = satu event, tanpa sinyal susulan
  for (const [tag, scan] of [["whale", scanWhale], ["dist", scanDist], ["calm", scanCalm]]) {
    eq(scan.events.length, 1, tag + ": tepat satu event, tanpa retest");
    for (const e of scan.events) ok(e.signal.indexOf("RETEST") < 0, tag + ": sinyal retest masih muncul");
    eq(scan.pending, null, tag + ": pending harus selalu null (masa tunggu dihapus)");
  }
  eq(api.scanSignals.length, 1, "scanSignals(bars) — tanpa parameter jendela bukti");
});

test("36 LEVEL INSTAN: lahir di bar penyerapan walau TIDAK ada bar sesudahnya", () => {
  // Mesin lama menuntut jendela bukti sesudahnya; sekarang cukup candle-nya.
  const ev = lvlEvent(scanWhale);
  ok(ev, "candle penyerapan harus LANGSUNG menjadi level");
  eq(ev.setupIdx, 8, "setup = bar penyerapan");
  eq(ev.confirmIdx, 8, "LEVEL INSTAN: dikonfirmasi di bar yang sama — tanpa tunggu");
  eq(ev.confirm, ev.setup, "bar yang sama dipakai sebagai setup dan konfirmasi");
  eq(scanWhale.pending, null, "tidak ada kandidat tertunda");
  // Tanpa satu bar pun sesudahnya level tetap ada.
  const onlyBar8 = api.buildBars(
    scenarioTrades({ whale: true, baseR: 1.5 }).filter(t => t.ts < B + 9 * H), NOW_MS);
  eq(api.scanSignals(onlyBar8).events.length, 1, "level tidak menunggu bar berikutnya");
  // dan tanpa pergerakan harga >=5% sesudahnya (v9.2.17: LVL_MIN_MOVE_PCT dihapus)
  const flat = scenarioTrades({ whale: true, baseR: 1.5 }).filter(t => t.ts < B + 9 * H);
  flat.push(...bgBar(9,  "buy", 1.0, 109.0, 109.4));
  flat.push(...bgBar(10, "buy", 1.0, 109.4, 109.8));
  flat.push(...bgBar(11, "buy", 1.0, 109.8, 110.2));
  const barsFlat = api.buildBars(flat, NOW_MS);
  const movePct = (barsFlat[11].close / barsFlat[8].close - 1) * 100;
  ok(Math.abs(movePct) < 5, "skenario memang <5% (movePct=" + movePct.toFixed(2) + "%)");
  eq(api.scanSignals(barsFlat).events.length, 1,
     "level tetap lahir walau harga nyaris tidak bergerak");
});

test("37 level TIDAK dibatalkan penembusan harga (tidak ada 'penyerapan gagal')", () => {
  // Dulu (<=v9.2.16) harga yang menutup >2% melewati garis sebelum bukti
  // membuat penyerapan dinilai GAGAL dan level dibatalkan. Sekarang tidak ada
  // pembatalan: level tetap lahir dan tetap dilaporkan.
  const trades = scenarioTrades({ whale: true, baseR: 1.5 }).filter(t => t.ts < B + 9 * H);
  trades.push(T(9, 600, "p1", "buy", 5, 110), T(9, 2400, "p2", "buy", 5, 113));
  trades.push(T(10, 600, "p3", "buy", 5, 114), T(10, 2400, "p4", "buy", 5, 116));
  const scan = api.scanSignals(api.buildBars(trades, NOW_MS));
  eq(scan.events.length, 1, "tembus +3~6% melewati garis TIDAK membatalkan level");
  eq(scan.events[0].signal, "RESISTANCE TERBENTUK", "level tetap jadi sinyal aktif");
  eq(scan.events[0].confirmIdx, 8, "tetap lahir di bar penyerapan, bukan gugur di bar 9-10");
});

test("38 tanpa R besar tidak ada level: |R| <50 atau lonjakan <10x -> nol sinyal", () => {
  // (a) lonjakan 20x tapi |R| = 40 < lantai 50  -> bukan penyerapan
  const soft = api.buildBars([
    ...bgBar(0, "buy", 0.30, 100, 100.15),        // R0 = 0.30/0.15 = 2
    ...bgBar(1, "buy", 3.40, 100.15, 100.2351),   // R1 = 3.40/0.085 = 40
  ], NOW_MS);
  eq(api.absorptionAt(soft, 1), null, "|R| di bawah R_MIN_ABS ditolak");
  eq(api.scanSignals(soft).events.length, 0, "tidak ada level tanpa |R| >=50");
  // (b) |R| = 60 (lolos lantai) tapi lonjakan cuma 6x (<10x) -> bukan penyerapan
  const small = api.buildBars([
    ...bgBar(0, "buy", 1.00, 100, 100.10),         // R0 = 1.00/0.10  = 10
    ...bgBar(1, "buy", 3.40, 100.10, 100.15672),   // R1 = 3.40/0.0567 = 60 (>=50, tapi 6x <10x)
  ], NOW_MS);
  eq(api.absorptionAt(small, 1), null, "lonjakan <10x bar sebelumnya ditolak");
  eq(api.scanSignals(small).events.length, 0, "tidak ada level tanpa lonjakan >=10x");
  // (c) lonjakan dan |R| cukup tapi effort < 3 SOL -> tetap ditolak (lantai effort)
  const thin = api.buildBars([
    ...bgBar(0, "buy", 0.30, 100, 100.15),
    ...bgBar(1, "buy", 2.00, 100.15, 100.16),     // R1 = 2.00/0.01 = 200, effort 2 SOL
  ], NOW_MS);
  eq(api.absorptionAt(thin, 1), null, "effort di bawah ABSORB_MIN_CVD ditolak");
  eq(api.scanSignals(thin).events.length, 0, "R besar semu dari bar tipis tidak jadi level");
});


// ── Jalankan & laporkan ─────────────────────────────────────────────────────
(async () => {
  await runTests();
  let pass = 0;
  for (const [good, name, err] of results) {
    if (good) { pass++; console.log("  LULUS  " + name); }
    else console.log("  GAGAL  " + name + "\n         -> " + err);
  }
  console.log("");
  if (pass === results.length) console.log(`${pass}/${results.length} LULUS — regresi penuh lolos (21 warisan + ${results.length - 21} baru: 11 fetch walk + 4 level instan).`);
  else { console.log(`${pass}/${results.length} LULUS — ada yang GAGAL.`); process.exit(1); }
})();
