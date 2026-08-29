/* Smoke test AKD ENGINE — ekstrak blok fungsi dari content.js lalu uji.
   Jalankan: node tests/akd_smoke.js
   Tidak bergantung DOM: fungsi yang diuji murni (bars -> events). */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// ── util uji ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  LULUS:", msg); }
  else { fail++; console.log("  GAGAL:", msg); }
}

// Bar sintetis: open/close menentukan chg; cvdClean menentukan CVD.
function mkBars(spec, opts = {}) {
  const BAR = opts.barSec || 3600;
  let basePrice = opts.price || 1;
  const bars = [];
  let cum = 0;
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i];
    const chgPct = s.chg || 0;
    const open = basePrice;
    const close = open * (1 + chgPct / 100);
    const high = Math.max(open, close) * (1 + (s.wickHi || 0));
    const low = Math.min(open, close) * (1 - (s.wickLo || 0));
    const cvdClean = s.cvd != null ? s.cvd : -chgPct * (s.rMult || 5);
    cum += cvdClean;
    const buy = cvdClean >= 0 ? (s.vol || 10) / 2 + cvdClean / 2 : (s.vol || 10) / 2 - 0;
    const sell = cvdClean >= 0 ? (s.vol || 10) / 2 - cvdClean / 2 : (s.vol || 10) / 2 + (-cvdClean) / 2;
    const vol = (s.vol || 10);
    bars.push({
      start: (opts.t0 || 1756000000) + i * BAR, end: (opts.t0 || 1756000000) + (i + 1) * BAR,
      open, close, high, low, priceChgPct: chgPct,
      cvd: cvdClean, cvdClean,
      buySol: Math.max(0, buy), sellSol: Math.max(0, sell), volSol: vol,
      volUsd: 0, washVol: 0, washPct: s.wash || 0,
      txCount: s.tx || 40, uniqueMakers: 20, taggedMakers: 0,
      freshWallets: 0, freshWalletPct: 0, freshTxCount: 0, freshBuySol: 0, freshSellSol: 0,
      topWalletPct: 5, R: s.r != null ? s.r : Math.abs(cvdClean) / Math.max(Math.abs(chgPct), 0.2),
      signedR: null, highRaw: high, lowRaw: low,
      highMc: high * 1e6, lowMc: low * 1e6, openMc: open * 1e6, closeMc: close * 1e6,
      highRawMc: high * 1e6, lowRawMc: low * 1e6, mcPerPrice: 1e6,
      dustTx: 0, maxTradeSol: vol / 4, partial: !!s.partial,
      cumCVD: cum, cluster: 0,
    });
    basePrice = close;
  }
  return bars;
}

// ── ekstrak fungsi AKD via blok source ──────────────────────────────────────
function extract(names) {
  const out = {};
  for (const name of names) {
    const re = new RegExp("function " + name + "\\s*\\(", "g");
    const m = re.exec(src);
    if (!m) throw new Error("fungsi " + name + " tidak ditemukan");
    let i = src.indexOf("{", m.index), depth = 0, end = i;
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") { depth--; if (depth === 0) { end++; break; } }
    }
    out[name] = src.slice(m.index, end);
  }
  return out;
}

const F = extract([
  "akdCvd", "akdMedianEffort", "akdWindowStats", "akdNearLevel",
  "akdScoreParts", "akdGrade", "akdDivergence", "makeAkdEvent", "scanAkd",
  "levelLine", "fmtMarketCap",
]);
const CONST_DECLS = src.match(/const (AKD_[A-Z0-9_]+|SIG_AKD_[A-Z0-9_]+)\s*=[^;]+;/g).join("\n");
const runner = new Function(
  CONST_DECLS + "\n" +
  Object.values(F).join("\n") +
  "\nreturn { akdWindowStats, scanAkd, akdDivergence, makeAkdEvent, akdGrade };"
);
const api = runner();

// ── 1. ABSORPSI JUAL (akumulasi): CVD turun tajam, harga tertahan ───────────
console.log("\n[1] ABSORPSI JUAL DI SUPPORT (akumulasi)");
{
  // 14 bar: harga flat (±0), cvdClean -15 tiap bar → CVD window sangat negatif.
  const spec = [];
  for (let i = 0; i < 14; i++) spec.push({ chg: 0, cvd: -15, vol: 40, tx: 60 });
  const bars = mkBars(spec);
  const res = api.scanAkd(bars, []);
  const sigs = res.events.map(e => e.signal);
  ok(sigs.some(s => s.includes("AKUMULASI")), "sinyal AKUMULASI muncul: " + sigs.join(" | "));
  const e = res.events.find(x => x.signal.includes("ABSORPSI"));
  ok(!!e, "pola ABSORPSI terpilih");
  if (e) {
    ok(e.ev.cvdWin < 0, "CVD window negatif (" + e.ev.cvdWin.toFixed(0) + " SOL)");
    ok(e.ev.chgTotal > -3 && e.ev.chgTotal < 3, "harga tertahan (chg " + e.ev.chgTotal.toFixed(2) + "%)");
    ok(e.side === "bottom", "side = bottom (sinyal beli)");
    console.log("     conf:", e.conf, e.grade, "| ratio:", e.ev.ratio.toFixed(2), "| bar:", e.ev.winBars);
  }
}

// ── 2. ABSORPSI BELI (distribusi): CVD naik tajam, harga mentok ─────────────
console.log("\n[2] ABSORPSI BELI DI RESISTANCE (distribusi)");
{
  const spec = [];
  for (let i = 0; i < 14; i++) spec.push({ chg: 0, cvd: +15, vol: 40, tx: 60 });
  const bars = mkBars(spec);
  const res = api.scanAkd(bars, []);
  const sigs = res.events.map(e => e.signal);
  ok(sigs.some(s => s.includes("DISTRIBUSI")), "sinyal DISTRIBUSI muncul: " + sigs.join(" | "));
  const e = res.events.find(x => x.signal.includes("ABSORPSI") && x.signal.includes("DISTRIBUSI"));
  ok(!!e, "pola ABSORPSI BELI terpilih");
  if (e) {
    ok(e.ev.cvdWin > 0, "CVD window positif (" + e.ev.cvdWin.toFixed(0) + " SOL)");
    ok(e.side === "top", "side = top (sinyal jual)");
    console.log("     conf:", e.conf, e.grade, "| ratio:", e.ev.ratio.toFixed(2));
  }
}

// ── 3. BELI BERTAHAP: flat sempit, bar-bar net beli konsisten kecil ─────────
console.log("\n[3] BELI BERTAHAP SAAT HARGA FLAT (akumulasi)");
{
  const spec = [];
  for (let i = 0; i < 16; i++) {
    // harga oscillation kecil ±0.3%; mayoritas bar net beli kecil.
    spec.push({ chg: i % 2 === 0 ? 0.25 : -0.2, cvd: i < 13 ? 2 : -3, vol: 12, tx: 30 });
  }
  const bars = mkBars(spec);
  const res = api.scanAkd(bars, []);
  const sigs = res.events.map(e => e.signal);
  // Boleh ABSORPSI atau BERTAHAP; yang penting AKUMULASI dan bercorak slope konsisten.
  const acc = res.events.filter(e => e.signal.includes("AKUMULASI"));
  ok(acc.length > 0, "sinyal AKUMULASI muncul: " + sigs.join(" | "));
  const step = res.events.find(e => e.signal.includes("BERTAHAP"));
  if (step) {
    ok(step.ev.fracPos >= 0.55, "mayoritas bar net beli (" + (step.ev.fracPos * 100).toFixed(0) + "%)");
    ok(step.ev.rangePct <= 4.0, "rentang harga sempit (" + step.ev.rangePct.toFixed(2) + "%)");
    console.log("     conf:", step.conf, step.grade, "| CVD:", step.ev.cvdWin.toFixed(1));
  }
}

// ── 4. BULLISH DIVERGENCE: harga lower-low, CVD membaik ─────────────────────
console.log("\n[4] BULLISH DIVERGENCE");
{
  const spec = [];
  // paruh 1: tekanan jual kuat (cvd negatif besar, harga turun)
  for (let i = 0; i < 9; i++) spec.push({ chg: -1.2, cvd: -20, vol: 30, tx: 50, wickLo: 0.01 });
  // paruh 2: harga lower-low lagi tapi cvd hampir netral (-2) → CVD relatif naik
  for (let i = 0; i < 9; i++) spec.push({ chg: -0.8, cvd: -2, vol: 30, tx: 50, wickLo: 0.02 });
  const bars = mkBars(spec);
  const res = api.scanAkd(bars, []);
  const div = res.events.find(e => e.signal.includes("DIVERGENCE"));
  ok(!!div, "sinyal BULLISH DIVERGENCE muncul: " + res.events.map(e => e.signal).join(" | "));
  if (div) {
    ok(div.signal.includes("BULLISH"), "arah BULLISH");
    console.log("     conf:", div.conf, div.grade, "| priceGap:", div.ev.div.priceGap.toFixed(1), "%, cvdGap:", div.ev.div.cvdGap.toFixed(1));
  }
}

// ── 5. BEARISH DIVERGENCE: harga higher-high, CVD melemah ───────────────────
console.log("\n[5] BEARISH DIVERGENCE");
{
  const spec = [];
  for (let i = 0; i < 9; i++) spec.push({ chg: 1.2, cvd: 20, vol: 30, tx: 50, wickHi: 0.01 });
  for (let i = 0; i < 9; i++) spec.push({ chg: 0.8, cvd: 2, vol: 30, tx: 50, wickHi: 0.02 });
  const bars = mkBars(spec);
  const res = api.scanAkd(bars, []);
  const div = res.events.find(e => e.signal.includes("DIVERGENCE"));
  ok(!!div, "sinyal BEARISH DIVERGENCE muncul: " + res.events.map(e => e.signal).join(" | "));
  if (div) {
    ok(div.signal.includes("BEARISH"), "arah BEARISH");
    console.log("     conf:", div.conf, div.grade);
  }
}

// ── 6. DATA BERSIH TIDAK MEMICU SINYAL PALSU ────────────────────────────────
console.log("\n[6] Harga & CVD sehat beriringan (tren naik wajar) — tidak boleh AKD");
{
  const spec = [];
  for (let i = 0; i < 16; i++) spec.push({ chg: 1.5, cvd: 12, vol: 30, tx: 50 }); // harga naik, CVD naik
  const bars = mkBars(spec);
  const res = api.scanAkd(bars, []);
  const palsu = res.events.filter(e => e.akd);
  ok(palsu.length === 0, "tidak ada sinyal AKD palsu (dapat: " + palsu.map(e => e.signal).join(" | ") + ")");
}

// ── 7. Data terlalu pendek ──────────────────────────────────────────────────
console.log("\n[7] Data pendek — tidak crash, tidak ada sinyal");
{
  const bars = mkBars([{ chg: 0, cvd: -50 }, { chg: 0, cvd: -50 }]);
  let threw = false;
  try { api.scanAkd(bars, []); } catch (e) { threw = true; console.log("     error:", e.message); }
  ok(!threw, "tidak melempar error");
  ok(api.scanAkd(bars, []).events.length === 0, "tidak ada sinyal");
}

// ── 8. wash tinggi menurunkan skor ──────────────────────────────────────────
console.log("\n[8] Wash tinggi -> skor lebih rendah");
{
  const mk = (wash) => {
    const spec = [];
    for (let i = 0; i < 14; i++) spec.push({ chg: 0, cvd: -15, vol: 40, tx: 60, wash });
    return api.scanAkd(mkBars(spec), []).events.find(e => e.signal.includes("ABSORPSI"));
  };
  const bersih = mk(5), washTinggi = mk(40);
  ok(bersih && washTinggi && washTinggi.conf < bersih.conf,
    `skor wash40 (${washTinggi ? washTinggi.conf : "?"}) < skor wash5 (${bersih ? bersih.conf : "?"})`);
}

console.log("\n=== " + pass + " LULUS, " + fail + " GAGAL ===");
process.exit(fail ? 1 : 0);
