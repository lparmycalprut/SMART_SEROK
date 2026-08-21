/**
 * SMART SEROK — v9.2.13
 * --------------------------------------------------------------
 * LEVEL ENGINE — hanya 4 sinyal, semua sinyal lama dihapus.
 *
 *   1. RESISTANCE TERBENTUK — candle penyerapan BUY (spike +R) yang TERBUKTI:
 *      beberapa jam sesudahnya R runtuh, cumCVD turun, dan harga turun.
 *   2. SUPPORT TERBENTUK — kebalikannya (spike -R lalu R runtuh, cumCVD naik,
 *      harga naik).
 *   3. RETEST RESISTANCE — harga kembali ke zona resistance tetapi R hanya
 *      normal dan cumCVD naik: seller penjaga level sudah tidak hadir.
 *   4. RETEST SUPPORT — harga kembali ke zona support dengan R normal dan
 *      cumCVD turun: buyer penjaga level sudah tidak hadir.
 *
 * Level dinyatakan sebagai HIGH-LOW candle penyerapan dalam MARKET CAP.
 * Penyerapan yang harganya justru menembus lebih jauh dianggap GAGAL dan tidak
 * memunculkan level maupun sinyal.
 */

(function () {
  'use strict';
  if (window.__gmgnEffortInjected) return;
  window.__gmgnEffortInjected = true;

  // ── State ────────────────────────────────────────────────────────────────
  const capturedTrades = new Map();
  const walletTagRegistry = new Map(); // tag holder/trader list, dipakai untuk memperkaya trade history
  let isAutoScrolling = false, scrollInterval = null;
  let detectedFromTs = null, detectedToTs = null, lastSeenMint = null;
  let isResetting = false, bgFetchActive = false, bgFetchComplete = false;
  let bypassRangeFilter = false;
  let liveMode = false, liveTimer = null, liveBusy = false, liveNextAt = 0;
  let cachedMcUsd = 0, cachedSupply = 0, cachedPriceUsd = 0, cachedMcPerPrice = 0;
  let cachedHolderSupply = 0;
  let cachedTokenSymbol = "";     // simbol token untuk penamaan file export
  let mcContextSource = "none", holderFetchBusy = false, holderFetchMint = null, holderFetchLastAt = 0;
  let selectedCluster = null;   // null = latest (auto); atau index klaster yg dipilih user
  const captureStats = { requests: 0, seen: 0, recorded: 0, dup: 0, outOfRange: 0,
    noMaker: 0, badEvent: 0, badTs: 0, lastMsg: "IDLE", lastTs: 0 };

  // ── Engine constants ─────────────────────────────────────────────────────
const EXT_VER = "9.2.13";             // dipakai di header file export
  let BAR_SEC = 3600;                   // diisi dari TF aktif GMGN
  const WASH_WINDOW_SEC = 60;
  const NOISE_TAGS = ["sandwich_bot", "mev_bot", "mev"];
  const FRESH_TAGS = ["fresh_wallet"];
  const CHART_BARS = 48;
  const MAX_BARS = 168;
  let CLUSTER_GAP = 6 * 3600;
  const MIN_CLUSTER_BARS = 4;

  // Akumulasi / Distribusi — SERAP_R bergantung TF
  let SERAP_R = 2.5;
  const FREE_R = 0.6;
  const R_COLLAPSE = 0.30;
  const TREND_BARS = 4;
  let DEFENSE_R = SERAP_R;
  const CONFIRM_MAX_BARS = 12;          // konfirmasi boleh beberapa candle kemudian

  const R_SPIKE_MULT = 10;              // |R| vs bar sebelumnya
  const R_MIN_ABS = 50;                 // lantai |R| — di bawah ini bukan penyerapan
  const ABSORB_MIN_CVD = 3;             // SOL — lantai effort agar R tidak artefak

  // ── LEVEL ENGINE (v9.2.0) ────────────────────────────────────────────────
  // Hanya 4 sinyal. Semua sinyal lama dihapus.
  //   1. RESISTANCE TERBENTUK   2. SUPPORT TERBENTUK
  //   3. RETEST SUPPORT         4. RETEST RESISTANCE
  //
  // Resistance = candle penyerapan BUY (spike +R) yang TERBUKTI: beberapa jam
  // sesudahnya R turun drastis, cumCVD turun, dan harga turun. Level = HIGH–LOW
  // candle penyerapan itu, dinyatakan dalam MARKET CAP.
  // Support = kebalikannya (spike −R lalu R turun, cumCVD naik, harga naik).
  // Penyerapan yang harganya justru menembus lebih jauh = GAGAL, tidak jadi level.
  const LVL_CONFIRM_BARS = 12;          // jendela bar untuk membuktikan penyerapan
  const LVL_MIN_CONFIRM_BARS = 2;       // minimal bar sesudahnya agar bisa dinilai
  const LVL_R_DROP = 0.5;               // R sesudahnya harus ≤50% R candle penyerapan
  const LVL_MIN_MOVE_PCT = 5;           // harga wajib bergerak ≥5% ke arah yang benar
  const LVL_FAIL_PCT = 2;               // tembus >2% melewati level = penyerapan gagal
  // Retest = harga kembali ke GARIS level, bukan ke pita LOW-HIGH.
  //   resistance -> garisnya HIGH candle penyerapan
  //   support    -> garisnya LOW  candle penyerapan
  const LVL_LINE_PAD_PCT = 0.5;         // toleransi sentuhan garis (% dari harga garis)
  // Harga wajib PERGI dulu sebelum boleh dihitung "kembali". Tanpa syarat ini,
  // harga yang masih berkeliaran di sekitar level baru ikut terhitung retest.
  // 2% cukup membedakan "harga benar-benar pergi" dari "masih menempel di level",
  // tanpa mematikan retest pada token yang bergerak rapat.
  const LVL_EXIT_PCT = 2;               // % menjauh dari garis agar level "armed"
  const LVL_RETEST_MIN_GAP = 2;         // jeda minimal (bar) sebelum retest dihitung
  // Harus SAMA dengan batas "normal" di R MONITOR (R_BAND_ABSORB = 1,5).
  // Kalau lebih ketat, ada bar yang dibaca "normal" oleh R MONITOR tapi ditolak
  // sebagai retest — membingungkan dan membuat sinyal retest hilang.
  const LVL_RETEST_R_MAX = 1.5;         // retest valid bila |R| <1,5× acuan (= band normal)
  const SIG_RESISTANCE = "RESISTANCE TERBENTUK";
  const SIG_SUPPORT = "SUPPORT TERBENTUK";
  const SIG_RETEST_RES = "RETEST RESISTANCE — KEMUNGKINAN BREAKOUT";
  const SIG_RETEST_SUP = "RETEST SUPPORT — KEMUNGKINAN BREAKDOWN";
  // ── R MONITOR ─────────────────────────────────────────────────────────────
  // Mode baca R murni: tanpa sinyal, tanpa chart harga/CVD. Tujuannya hanya
  // menjawab dua hal secara manual:
  //   1. Saat harga bergerak — apakah ada perlawanan? (R kecil = tembus bersih)
  //   2. Saat harga di support/resistance — apakah pihak lawan masuk? (R melonjak)
  const R_MON_BARS = 40;                // candle terakhir yang ditampilkan
  const R_MON_TABLE_BARS = 12;          // candle terakhir yang masuk tabel
  // |R| dinormalisasi ke median |R| klaster aktif, karena skala R berbeda tiap
  // token/likuiditas. Angka mentah tidak bisa dibandingkan lintas token.
  const R_BAND_FREE = 0.5;              // < 0,5× acuan → BEBAS (tanpa perlawanan)
  const R_BAND_ABSORB = 1.5;            // ≥ 1,5× acuan → SERAP (perlawanan muncul)
  const R_BAND_WALL = 4;                // ≥ 4×   acuan → TEMBOK (perlawanan kuat)
  const R_BAND_BLAZE = 12;              // ≥ 12×  acuan → tembok EKSTREM (hanya menyala penuh bila lolos ambang sinyal)
  const R_MON_MIN_EFFORT = 1;           // SOL — di bawah ini R tidak bermakna (bar sepi)
  const HL_MIN_SOL = 0.001;             // SOL — trade di bawah ini tidak boleh menentukan HIGH/LOW
  const R_MON_MOVE_PCT = 3;             // |chg| ≥ ini dianggap "harga benar-benar bergerak"
  let rMonitorMode = true;              // default: tampilkan R MONITOR

  const LVL_MIN_BARS = 8;               // minimum bar selesai agar acuan R stabil
  const SETUP_WASH_MAX = 30;            // % — tidak dipakai sinyal
  const TF_PRESETS = {
    "1h": { id: "1h", label: "1H", sec: 3600,  serap: 2.5, minCvd: 6,  minTx: 20 },
    "4h": { id: "4h", label: "4H", sec: 14400, serap: 5,   minCvd: 12, minTx: 20 },
    "1d": { id: "1d", label: "D1", sec: 86400, serap: 10,  minCvd: 25, minTx: 20 }
  };
  let detectedTfId = "1h";
  let activeTf = TF_PRESETS["1h"];
  let openDetailKey = null;
  function eventKey(e) { return String(e.confirm.start) + ":" + e.signal; }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. SNIFFER — intercept fetch/XHR token_trades (DIPERTAHANKAN)
  // ══════════════════════════════════════════════════════════════════════════
  function getMintFromUrl() {
    const m = window.location.pathname.match(/\/token\/([a-zA-Z0-9]{32,44})/i);
    return m ? m[1] : "GMGN";
  }
  function ensurePageTokenContext() {
    const pageMint = getMintFromUrl();
    if (!pageMint || pageMint === "GMGN") return pageMint;
    if (lastSeenMint && lastSeenMint !== pageMint) {
      capturedTrades.clear(); walletTagRegistry.clear();
      detectedFromTs = null; detectedToTs = null; selectedCluster = null;
      cachedMcUsd = 0; cachedSupply = 0; cachedPriceUsd = 0; cachedMcPerPrice = 0; cachedHolderSupply = 0;
      cachedTokenSymbol = "";
      mcContextSource = "none"; holderFetchMint = null; holderFetchLastAt = 0;
      Object.assign(captureStats, { requests: 0, seen: 0, recorded: 0, dup: 0, outOfRange: 0, noMaker: 0, badEvent: 0, badTs: 0, lastMsg: "Pindah token — direset", lastTs: Date.now() });
    }
    lastSeenMint = pageMint;
    return pageMint;
  }
  function handleInterceptionData(json, url) {
    if (!json || typeof json !== "object") return;
    const pageMint = ensurePageTokenContext();
    captureStats.requests++;
    const urlMintMatch = String(url || "").match(/token_trades\/sol\/([A-Za-z0-9]{32,44})/);
    if (urlMintMatch && pageMint && pageMint !== "GMGN" && urlMintMatch[1] !== pageMint) return;
    try {
      const urlObj = new URL(url, window.location.origin);
      const fromParam = urlObj.searchParams.get("from"), toParam = urlObj.searchParams.get("to"), cursorParam = urlObj.searchParams.get("cursor");
      let newFrom = fromParam && parseInt(fromParam) > 0 ? parseInt(fromParam) : null;
      let newTo = toParam && parseInt(toParam) > 0 ? parseInt(toParam) : null;
      if (newFrom && newFrom > 1e12) newFrom = Math.floor(newFrom / 1000);
      if (newTo && newTo > 1e12) newTo = Math.floor(newTo / 1000);
      if (!cursorParam && newFrom !== null && newTo !== null && (newFrom !== detectedFromTs || newTo !== detectedToTs)) {
        detectedFromTs = newFrom; detectedToTs = newTo;   // JANGAN clear — dedup (tx_hash) menangani overlap; clear di sini mengosongkan data saat GMGN refresh range (multi-tab/SPA)
      }
    } catch (e) {}
    const history = extractTradeHistory(json);
    if (history && history.length) processHistoryItems(history);
  }
  function extractTradeHistory(json) {
    if (!json || typeof json !== "object") return [];
    if (Array.isArray(json)) return json;
    const d = json.data && typeof json.data === "object" ? json.data : {};
    return d.history || d.list || d.trades || d.records || d.items || d.transactions || d.result || json.history || json.list || json.trades || [];
  }
  function isTokenContextUrl(url) {
    return /token[_\/-]?(?:info|stat|detail)|tokens\/sol\/|\/v1\/token\/info/i.test(String(url || ""));
  }
  function extractMc(json) {
    try {
      ensurePageTokenContext();
      if (!json || typeof json !== "object") return false;
      const d = (json.data && typeof json.data === "object") ? json.data : json;
      const token = (d.token && typeof d.token === "object") ? d.token
        : (d.token_info && typeof d.token_info === "object") ? d.token_info
        : (d.base_token_info && typeof d.base_token_info === "object") ? d.base_token_info : d;
      const priceObj = token.price && typeof token.price === "object" ? token.price : {};
      let mc = parseFloat(token.market_cap ?? token.usd_market_cap ?? token.market_cap_usd ?? token.market_value ?? 0);
      const px = parseFloat(priceObj.price ?? priceObj.price_usd ?? token.price_usd ?? token.usd_price ?? (typeof token.price !== "object" ? token.price : 0) ?? 0);
      const supply = parseFloat(token.circulating_supply ?? token.total_supply ?? token.supply ?? token.max_supply ?? 0);
      if ((!isFinite(mc) || mc <= 0) && isFinite(px) && px > 0 && isFinite(supply) && supply > 0) mc = px * supply;
      const sym = token.symbol ?? token.token_symbol ?? token.ticker ?? token.name ?? "";
      if (typeof sym === "string" && sym.trim() && !cachedTokenSymbol) cachedTokenSymbol = sym.trim();
      if (isFinite(mc) && mc > 0) cachedMcUsd = mc;
      if (isFinite(px) && px > 0) cachedPriceUsd = px;
      if (isFinite(supply) && supply > 0) cachedSupply = supply;
      if (cachedHolderSupply > 0) cachedMcPerPrice = cachedHolderSupply;
      else if (cachedSupply > 0) cachedMcPerPrice = cachedSupply;
      else if (cachedMcUsd > 0 && cachedPriceUsd > 0) cachedMcPerPrice = cachedMcUsd / cachedPriceUsd;
      if (cachedMcPerPrice > 0) {
        if (mcContextSource === "none") mcContextSource = "token_info";
        captureStats.lastMsg = `MC aktif dari ${mcContextSource}`;
        captureStats.lastTs = Date.now();
        return true;
      }
      return false;
    } catch (e) { return false; }
  }
  function isWalletListUrl(url) {
    return /holder|top[_-]?trader|token[_-]?trader|wallet[_-]?(?:rank|list)/i.test(String(url || ""));
  }
  function holderListFromJson(json) {
    if (!json || typeof json !== "object") return null;
    const roots = [json, json.data, json.data && json.data.data].filter(x => x && typeof x === "object");
    for (const root of roots) {
      const candidates = Array.isArray(root) ? [root]
        : [root.list, root.holders, root.traders, root.items, root.records, root.rank, root.result];
      for (const list of candidates) {
        if (!Array.isArray(list) || !list.length) continue;
        const looksHolder = list.some(item => item && typeof item === "object" &&
          item.amount_percentage != null && (item.amount_cur != null || item.balance != null) && item.usd_value != null);
        if (looksHolder) return list;
      }
    }
    return null;
  }

  function extractHolderMarketContext(json) {
    try {
      ensurePageTokenContext();
      const list = holderListFromJson(json);
      if (!list) return false;
      const mcVals = [], supplyVals = [], priceVals = [];
      const seenAddresses = new Set();
      const normTag = raw => String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      const collect = (v, out) => {
        if (!v) return;
        if (Array.isArray(v)) { v.forEach(x => collect(x, out)); return; }
        if (typeof v === "string") { v.split(/[;,]/).forEach(x => { const t = normTag(x); if (t) out.add(t); }); return; }
        if (typeof v === "object") {
          if (v.tag || v.name || v.id) { const t = normTag(v.tag || v.name || v.id); if (t) out.add(t); }
          else for (const [k, enabled] of Object.entries(v)) if (enabled) { const t = normTag(k); if (t) out.add(t); }
        }
      };
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const addr = item.address || item.maker || item.wallet || item.account_address;
        if (addr) {
          const tags = new Set(walletTagRegistry.get(addr) || []);
          for (const k of ["tags", "maker_tags", "maker_token_tags", "maker_event_tags", "tag"]) collect(item[k], tags);
          if (item.is_new === true) tags.add("fresh_wallet");
          if (tags.size) walletTagRegistry.set(addr, [...tags]);
          seenAddresses.add(addr);
        }
        const pct = parseFloat(item.amount_percentage ?? item.hold_percentage ?? 0);
        const usd = parseFloat(item.usd_value ?? item.value_usd ?? 0);
        const amount = parseFloat(item.amount_cur ?? item.balance ?? item.amount ?? 0);
        if (pct > 0 && usd > 0) mcVals.push(usd / pct);
        if (pct > 0 && amount > 0) supplyVals.push(amount / pct);
        if (amount > 0 && usd > 0) priceVals.push(usd / amount);
      }
      const median = vals => {
        const a = vals.filter(v => isFinite(v) && v > 0).sort((x, y) => x - y);
        if (!a.length) return 0;
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
      };
      const mc = median(mcVals), supply = median(supplyVals), px = median(priceVals);
      if (mc > 0) cachedMcUsd = mc;
      if (supply > 0) { cachedSupply = supply; cachedHolderSupply = supply; }
      if (px > 0) cachedPriceUsd = px;
      // amount_percentage = amount/supply, jadi supply holder adalah pengali
      // historis paling akurat untuk mengubah price_usd menjadi market cap.
      if (cachedHolderSupply > 0) cachedMcPerPrice = cachedHolderSupply;
      else if (cachedSupply > 0) cachedMcPerPrice = cachedSupply;
      else if (cachedMcUsd > 0 && cachedPriceUsd > 0) cachedMcPerPrice = cachedMcUsd / cachedPriceUsd;

      // Jika holder list datang setelah trade history, perkaya trade yang sudah tersimpan.
      if (seenAddresses.size) {
        for (const [key, t] of capturedTrades.entries()) {
          const reg = walletTagRegistry.get(t.maker);
          if (!reg || !reg.length) continue;
          const merged = Array.from(new Set([...(t.tags || []), ...reg]));
          if (merged.length !== (t.tags || []).length) capturedTrades.set(key, { ...t, tags: merged });
        }
      }
      const ok = mc > 0 || supply > 0 || seenAddresses.size > 0;
      if (mc > 0 || supply > 0) {
        mcContextSource = "holder";
        captureStats.lastMsg = `MC holder aktif · ${Math.round(cachedMcUsd).toLocaleString("en-US")}`;
        captureStats.lastTs = Date.now();
      }
      return ok;
    } catch (e) { return false; }
  }
  function inspectApiContext(json, url) {
    if (holderListFromJson(json)) return extractHolderMarketContext(json);
    const mint = getMintFromUrl();
    if (isTokenContextUrl(url) || (mint && mint !== "GMGN" && String(url || "").includes(mint))) return extractMc(json);
    return false;
  }

  function normalizeTradeItem(item) {
    if (!item || typeof item !== "object") return { ok: false, reason: "noMaker" };
    const makerInfo = (item.maker_info && typeof item.maker_info === "object") ? item.maker_info : {};
    const walletInfo = (item.wallet_info && typeof item.wallet_info === "object") ? item.wallet_info : {};
    const maker = item.maker || item.maker_address || item.wallet || item.address || item.from_address || item.owner || item.trader || makerInfo.address || walletInfo.address;
    if (!maker) return { ok: false, reason: "noMaker" };
    let rawEvent = item.event || item.trade_type || item.type || item.direction || item.side || item.action || "";
    if (!rawEvent && item.is_buy !== undefined) rawEvent = item.is_buy ? "buy" : "sell";
    rawEvent = String(rawEvent).toLowerCase().trim();
    let event = null;
    if (rawEvent.includes("buy") && !rawEvent.includes("buyback")) event = "buy";
    else if (rawEvent.includes("sell")) event = "sell";
    else if (item.is_buy !== undefined) event = item.is_buy ? "buy" : "sell";
    if (!event) return { ok: false, reason: "badEvent" };
    let ts = parseInt(item.timestamp ?? item.time ?? item.ts ?? item.created_at ?? item.create_time ?? item.block_time ?? item.trade_time ?? 0);
    if (!isFinite(ts) || ts <= 0) return { ok: false, reason: "badTs" };
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    let sol = parseFloat(item.quote_amount ?? item.amount_sol ?? item.sol_amount ?? item.quote_volume ?? item.sol ?? item.quote ?? 0);
    if (!isFinite(sol) || sol < 0) sol = 0;
    const baseAmount = parseFloat(item.base_amount ?? item.token_amount ?? item.amount ?? item.token_volume ?? item.token ?? 0) || 0;
    let amountUsd = parseFloat(item.amount_usd ?? item.usd_amount ?? item.cost_usd ?? item.usd ?? item.quote_value ?? 0) || 0;
    const priceUsd = parseFloat(item.price_usd ?? item.price ?? 0) || 0;
    if (amountUsd <= 0 && baseAmount > 0 && priceUsd > 0) amountUsd = baseAmount * priceUsd;
    if (amountUsd > 0 && sol > 0) { const implied = amountUsd / sol; if (implied < 10.0 || implied > 500.0) sol = amountUsd / 160.0; }
    const txHash = item.tx_hash || item.tx_id || item.signature || item.hash || `id_${item.id || Math.random()}`;
    const tags = [];
    const addTag = (raw) => {
      const tag = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (tag) tags.push(tag);
    };
    const addTags = (v) => {
      if (!v) return;
      if (Array.isArray(v)) { v.forEach(addTags); return; }
      if (typeof v === "string") { v.split(/[;,]/).forEach(addTag); return; }
      if (typeof v === "object") {
        if (v.tag || v.name || v.id) addTag(v.tag || v.name || v.id);
        else for (const [k, enabled] of Object.entries(v)) if (enabled) addTag(k);
      }
    };
    for (const src of [item, makerInfo, walletInfo]) {
      for (const k of ["maker_tags", "maker_token_tags", "maker_event_tags", "tags", "tag"]) addTags(src[k]);
    }
    addTags(walletTagRegistry.get(maker));
    if (item.is_new === true || makerInfo.is_new === true || walletInfo.is_new === true) addTag("fresh_wallet");
    return { ok: true, trade: { maker, event, sol, price: priceUsd, ts, tx_hash: txHash, token: baseAmount, usd: amountUsd, tags: Array.from(new Set(tags)) } };
  }
  function processHistoryItems(history) {
    captureStats.seen += Array.isArray(history) ? history.length : 0;
    if (isResetting || !Array.isArray(history) || !history.length) return 0;
    const { endTs } = getBoundaryForFetch();
    let added = 0;
    for (const item of history) {
      const norm = normalizeTradeItem(item);
      if (!norm.ok) { captureStats[norm.reason] = (captureStats[norm.reason] || 0) + 1; continue; }
      const t = norm.trade;
      if (!bypassRangeFilter && endTs > 0 && t.ts > endTs) { captureStats.outOfRange++; continue; }
      const key = `${t.tx_hash}_${t.event}_${t.ts}_${t.maker}`;
      if (capturedTrades.has(key)) {
        // Respons duplikat kadang membawa tag wallet yang sebelumnya kosong.
        const old = capturedTrades.get(key);
        const mergedTags = Array.from(new Set([...(old.tags || []), ...(t.tags || [])]));
        if (mergedTags.length !== (old.tags || []).length) capturedTrades.set(key, { ...old, tags: mergedTags });
        captureStats.dup++; continue;
      }
      capturedTrades.set(key, t); added++; captureStats.recorded++;
    }
    if (added > 0) { captureStats.lastMsg = `${added} tx direkam`; captureStats.lastTs = Date.now(); updateUI(); }
    return added;
  }
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      if (isWalletListUrl(url)) response.clone().json().then(d => extractHolderMarketContext(d)).catch(() => {});
      else if (url.includes("token_trades") || url.includes("trades")) response.clone().json().then(d => handleInterceptionData(d, url)).catch(() => {});
      else if (isTokenContextUrl(url)) response.clone().json().then(d => extractMc(d)).catch(() => {});
      else if (/\/api\/|quotation|\/vas\//i.test(url)) response.clone().json().then(d => inspectApiContext(d, url)).catch(() => {});
      if (/interval=|resolution=|\/kline/i.test(url)) noteTfFromUrl(url);
    } catch (e) {}
    return response;
  };
  const originalXhrOpen = XMLHttpRequest.prototype.open, originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this._url = url; return originalXhrOpen.apply(this, [method, url, ...rest]); };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (this._url && isWalletListUrl(this._url)) extractHolderMarketContext(JSON.parse(this.responseText));
        else if (this._url && (this._url.includes("token_trades") || this._url.includes("trades"))) handleInterceptionData(JSON.parse(this.responseText), this._url);
        else if (this._url && isTokenContextUrl(this._url)) extractMc(JSON.parse(this.responseText));
        else if (this._url && /\/api\/|quotation|\/vas\//i.test(this._url)) inspectApiContext(JSON.parse(this.responseText), this._url);
        if (this._url && /interval=|resolution=|\/kline/i.test(this._url)) noteTfFromUrl(this._url);
      } catch (e) {}
    });
    return originalXhrSend.apply(this, args);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 2. HELPERS TANGGAL & FETCH (DIPERTAHANKAN)
  // ══════════════════════════════════════════════════════════════════════════
  function pad(n) { return String(n).padStart(2, "0"); }
  // Jam tampilan = GMGN WIB (Asia/Jakarta, UTC+7, tanpa DST).
  // Batas jam UTC ≡ batas jam WIB, jadi bucket 1-jam sudah sejajar candle GMGN.
  const DISPLAY_TZ = "Asia/Jakarta";
  function tzParts(tsSec) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(tsSec * 1000));
    const g = {};
    for (const p of parts) if (p.type !== "literal") g[p.type] = p.value;
    return { y: g.year, m: g.month, d: g.day, h: g.hour, min: g.minute };
  }
  const MONTH_NAMES_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  function fmtDateId(parts) {
    const month = MONTH_NAMES_ID[parseInt(parts.m, 10) - 1] || parts.m;
    return `${parseInt(parts.d, 10)} ${month}`;
  }
  function fmtTs(tsSec) { const p = tzParts(tsSec); return `${fmtDateId(p)} ${p.h}:00`; }
  function fmtBar(b) { return fmtTs(b.start); }
  function wibDateOf(ts) { const p = tzParts(ts); return `${p.y}-${p.m}-${p.d}`; }
  function wibIso(ts) { const p = tzParts(ts); return `${p.y}-${p.m}-${p.d}T${p.h}:${p.min}`; }

  function normalizeTf(raw) {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim().toLowerCase();
    if (["1d", "d1", "d", "1day", "day", "daily", "1440", "24h"].includes(s)) return "1d";
    if (["4h", "h4", "4hr", "4hour", "240"].includes(s)) return "4h";
    if (["1h", "h1", "1hr", "1hour", "60"].includes(s)) return "1h";
    return null;
  }
  function applyTf(id) {
    const tf = TF_PRESETS[id] || TF_PRESETS["1h"];
    activeTf = tf;
    detectedTfId = tf.id;
    BAR_SEC = tf.sec;
    CLUSTER_GAP = 6 * tf.sec;
    return tf;
  }
  function noteTfFromUrl(url) {
    try {
      const u = new URL(String(url), window.location.origin);
      for (const k of ["interval", "resolution", "res", "tf", "timeframe", "period"]) {
        const n = normalizeTf(u.searchParams.get(k));
        if (n) { detectedTfId = n; return n; }
      }
      const m = String(url).match(/(?:resolution|interval|period)[=/](\w+)/i);
      if (m) {
        const n = normalizeTf(m[1]);
        if (n) { detectedTfId = n; return n; }
      }
    } catch (e) {}
    return null;
  }
  function detectTfFromDom() {
    const nodes = document.querySelectorAll("button, [role='button'], [role='tab'], [aria-pressed], a");
    for (const el of nodes) {
      const t = (el.textContent || "").replace(/\s+/g, "").toUpperCase();
      if (!/^(1H|H1|4H|H4|1D|D1)$/.test(t)) continue;
      const on = el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true" ||
        el.dataset.state === "active" || el.dataset.active === "true" ||
        /active|selected|checked|current|is-active/i.test(el.className || "");
      if (on) {
        const n = normalizeTf(t);
        if (n) return n;
      }
    }
    return null;
  }
  function detectActiveTf() {
    try {
      const u = new URL(window.location.href);
      for (const k of ["interval", "resolution", "tf", "timeframe", "period"]) {
        const n = normalizeTf(u.searchParams.get(k));
        if (n) return n;
      }
      const hm = (window.location.hash || "").match(/(?:interval|resolution|tf)=([a-z0-9]+)/i);
      if (hm) { const n = normalizeTf(hm[1]); if (n) return n; }
    } catch (e) {}
    const fromDom = detectTfFromDom();
    if (fromDom) return fromDom;
    try {
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k || !/interval|resolution|timeframe|kline/i.test(k)) continue;
          const n = normalizeTf(store.getItem(k));
          if (n) return n;
        }
      }
    } catch (e) {}
    return detectedTfId || "1h";
  }
  function syncTimeframe() {
    const id = detectActiveTf();
    const prev = activeTf && activeTf.id;
    applyTf(id);
    if (prev && prev !== id) {
      openDetailKey = null;
      const sh = document.getElementById("gmgn-sighist");
      if (sh) sh._sig = "";
    }
    const badge = document.getElementById("gmgn-tf-badge");
    if (badge) badge.textContent = `${activeTf.label} · LEVEL ENGINE`;
    return activeTf;
  }

  function getFilterRange() {
    const fromInput = document.getElementById("gmgn-filter-from")?.value, toInput = document.getElementById("gmgn-filter-to")?.value;
    let fromTs = fromInput ? Math.floor(new Date(fromInput).getTime() / 1000) : (detectedFromTs || null);
    let toTs = toInput ? Math.floor(new Date(toInput).getTime() / 1000) : (detectedToTs || null);
    return { fromTs, toTs };
  }
  function getBoundaryForFetch() { const { fromTs, toTs } = getFilterRange(); return { startTs: fromTs || 0, endTs: toTs || 0 }; }
  function getCooldownMs() { const el = document.getElementById("gmgn-cooldown"); return el ? parseInt(el.value) : 800; }

  async function refreshHolderContext(force) {
    const mint = ensurePageTokenContext();
    if (!mint || mint === "GMGN" || holderFetchBusy) return false;
    const sameFresh = holderFetchMint === mint && Date.now() - holderFetchLastAt < 2 * 60 * 1000;
    if (!force && sameFresh) return cachedMcPerPrice > 0;
    holderFetchBusy = true; holderFetchMint = mint; holderFetchLastAt = Date.now();
    try {
      const url = `${window.location.origin}/vas/api/v1/token_holders/sol/${mint}?orderby=amount_percentage&direction=desc&limit=100`;
      const resp = await originalFetch.apply(window, [url, { credentials: "include", headers: { "accept": "application/json, text/plain, */*" } }]);
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      if (resp.ok && json && extractHolderMarketContext(json)) {
        console.log("[SMART SEROK] MC holder context aktif", { mc: cachedMcUsd, supply: cachedHolderSupply });
        updateUI();
        return true;
      }
      captureStats.lastMsg = `MC holder gagal · HTTP ${resp.status}${json && json.code != null ? " · code " + json.code : ""}`;
      captureStats.lastTs = Date.now();
      console.warn("[SMART SEROK] holder context gagal", resp.status, json);
      return false;
    } catch (e) {
      captureStats.lastMsg = `MC holder gagal · ${e && e.message ? e.message : e}`;
      captureStats.lastTs = Date.now();
      console.warn("[SMART SEROK] holder context error", e);
      return false;
    } finally { holderFetchBusy = false; }
  }

  // ── CACHE (incremental) ──
  function cacheKey(mint) { return "gmgn_effort_" + mint; }
  async function loadCache(mint) { try { const r = await chrome.storage.local.get(cacheKey(mint)); const c = r && r[cacheKey(mint)]; if (c && Array.isArray(c.trades) && c.trades.length) return c; } catch (e) {} return null; }
  async function saveCache(mint, trades) { try { const p = {}; p[cacheKey(mint)] = { trades, savedAt: Date.now() }; await chrome.storage.local.set(p); } catch (e) {} }
  function seedFromCache(cached) { let added = 0; for (const t of (cached.trades || [])) { if (!t || !t.ts) continue; const key = `${t.tx_hash}_${t.event}_${t.ts}_${t.maker}`; if (!capturedTrades.has(key)) { capturedTrades.set(key, t); added++; } } return added; }
  function getSortedTrades() { const a = Array.from(capturedTrades.values()); a.sort((x, y) => x.ts - y.ts); return a; }

  // ── Background fetch (jeda adaptif dari v6.1) ──
  async function backgroundFetch() {
    const mint = getMintFromUrl();
    if (!mint || mint === "GMGN") { alert("Token mint tidak terdeteksi di URL."); return; }
    if (bgFetchActive) { stopBackgroundFetch(); return; }
    bgFetchActive = true;
    await refreshHolderContext(true);
    const btn = document.getElementById("gmgn-btn-bgfetch"), st = document.getElementById("gmgn-status-text");
    if (btn) { btn.className = "gmgn-btn-main gmgn-btn-stop"; btn.innerHTML = `<span>⏹ STOP Fetch</span>`; }
    const delay = getCooldownMs(); let { startTs, endTs } = getBoundaryForFetch();
    const cached = await loadCache(mint);
    if (cached) { const seeded = seedFromCache(cached); let lastCachedTs = 0; for (const t of cached.trades) if (t.ts > lastCachedTs) lastCachedTs = t.ts; if (lastCachedTs > 0) { startTs = Math.max(startTs, lastCachedTs + 1); } }
    const base = `https://gmgn.ai/vas/api/v1/token_trades/sol/${mint}?event=buy&event=sell&limit=200`;
    console.log("[SMART SEROK] backgroundFetch start, mint=", mint);
    if (st) { st.innerText = `FETCH mint ${mint.slice(0, 8)}…`; st.style.color = "#38bdf8"; }
    let cursor = null, page = 0; const maxPages = 1000;
    while (bgFetchActive && page < maxPages) {
      let url = base; if (startTs > 0) url += `&from=${startTs}`; if (endTs > 0) url += `&to=${endTs}`; if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      let json = null, ok = false, attemptsUsed = 0, lastErr = "";
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        attemptsUsed = attempt;
        try {
          console.log("[SMART SEROK] GET", url);
          const resp = await originalFetch.apply(window, [url, { credentials: "include" }]);
          const txt = await resp.text();
          try { json = JSON.parse(txt); } catch (pe) { json = null; lastErr = `HTTP ${resp.status} — respon bukan JSON (kemungkinan Cloudflare challenge)`; }
          if (json && json.code === 0) ok = true;
          else { lastErr = json ? `code=${json.code} (${json.reason || json.msg || "?"})` : (lastErr || `HTTP ${resp.status}`); if (attempt < 3) await new Promise(r => setTimeout(r, delay * (attempt + 2))); }
        } catch (e) { lastErr = "ERR " + (e && e.message ? e.message : e); console.error("[SMART SEROK] fetch err", e); if (attempt < 3) await new Promise(r => setTimeout(r, delay * (attempt + 2))); }
      }
      if (!ok || !json) { if (st) { st.innerText = `❌ Gagal hal ${page}: ${lastErr}`; st.style.color = "#ef4444"; } console.error("[SMART SEROK] abort:", lastErr, "|", url); break; }
      const d = json.data || {}, history = d.history || [], nxt = d.next;
      if (history.length) processHistoryItems(history);
      page++;
      if (st) { st.innerText = `FETCH hal ${page} · ${capturedTrades.size} TX`; st.style.color = "#10b981"; }
      updateUI();
      if (!nxt) { bgFetchComplete = true; break; }
      cursor = nxt;
      if (attemptsUsed > 0) await new Promise(r => setTimeout(r, delay));   // jeda adaptif
    }
    bgFetchActive = false;
    if (btn) { btn.className = "gmgn-btn-main gmgn-btn-start"; btn.innerHTML = `<span>🌐 Background Fetch</span>`; }
    if (bgFetchComplete) saveCache(mint, getSortedTrades());
    if (st) { st.innerText = bgFetchComplete ? `✅ DONE (${capturedTrades.size} TX)` : `⏸ ${capturedTrades.size} TX`; st.style.color = bgFetchComplete ? "#10b981" : "#f59e0b"; }
    updateUI();
  }
  function stopBackgroundFetch() { bgFetchActive = false; const btn = document.getElementById("gmgn-btn-bgfetch"); if (btn) { btn.className = "gmgn-btn-main gmgn-btn-start"; btn.innerHTML = `<span>🌐 Background Fetch</span>`; } const st = document.getElementById("gmgn-status-text"); if (st) { st.innerText = `PAUSED (${capturedTrades.size} TX)`; st.style.color = "#f59e0b"; } }
  function findScrollContainer() { const c = document.querySelectorAll('div, main, section, [class*="table"], [class*="list"], [class*="virtual"], [class*="body"]'); let best = null, max = 0; for (const el of c) { const s = window.getComputedStyle(el); const sc = (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 50; if (sc && el.scrollHeight > max) { max = el.scrollHeight; best = el; } } return best || window; }
  function startAutoScroll() {
    refreshHolderContext(false);
    isAutoScrolling = true; let noNew = 0, lastSize = capturedTrades.size;
    const btn = document.getElementById("gmgn-btn-scroll"); if (btn) { btn.className = "gmgn-btn-main gmgn-btn-stop"; btn.innerHTML = `<span>⏹ STOP</span>`; }
    const st = document.getElementById("gmgn-status-text"); if (st) { st.innerText = "SCROLLING..."; st.style.color = "#10b981"; }
    if (scrollInterval) clearInterval(scrollInterval);
    const cd = getCooldownMs();
    scrollInterval = setInterval(() => {
      if (!isAutoScrolling) { clearInterval(scrollInterval); return; }
      const t = findScrollContainer(); if (t === window) window.scrollBy({ top: 450, behavior: "smooth" }); else t.scrollTop += 450;
      if (capturedTrades.size === lastSize) { noNew++; window.scrollTo(0, document.body.scrollHeight); if (noNew >= 16) stopAutoScroll(true); } else { noNew = 0; lastSize = capturedTrades.size; }
      updateUI();
    }, cd);
  }
  function stopAutoScroll(m) { isAutoScrolling = false; if (scrollInterval) { clearInterval(scrollInterval); scrollInterval = null; } const btn = document.getElementById("gmgn-btn-scroll"); if (btn) { btn.className = "gmgn-btn-main gmgn-btn-start"; btn.innerHTML = `<span>⚡ Auto-Scroll</span>`; } const st = document.getElementById("gmgn-status-text"); if (st) { st.innerText = m ? `SELESAI (${capturedTrades.size} TX)` : `PAUSED`; st.style.color = m ? "#38bdf8" : "#f59e0b"; } updateUI(); }


  const LIVE_EVERY_MS = 15 * 60 * 1000;
  const LIVE_WINDOW_SEC = 48 * 3600;
  function maxTradeTs() { let m = 0; for (const t of capturedTrades.values()) if (t.ts > m) m = t.ts; return m; }
  function paintLiveBtn() {
    const btn = document.getElementById("gmgn-btn-live");
    if (!btn) return;
    if (liveMode) {
      btn.className = "gmgn-btn-main gmgn-btn-live-on";
      const left = liveNextAt ? Math.max(0, Math.ceil((liveNextAt - Date.now()) / 60000)) : 0;
      btn.innerHTML = `<span>🟢 LIVE${left ? " · " + left + "m" : ""}</span>`;
    } else {
      btn.className = "gmgn-btn-main gmgn-btn-dl";
      btn.innerHTML = `<span>📡 LIVE</span>`;
    }
  }
  function toggleLive() { liveMode ? stopLive() : startLive(); }
  function startLive() {
    liveMode = true;
    liveBusy = false;
    paintLiveBtn();
    liveFetchOnce(true);
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (liveMode) liveFetchOnce(false); }, LIVE_EVERY_MS);
  }
  function stopLive() {
    liveMode = false;
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    paintLiveBtn();
    const st = document.getElementById("gmgn-status-text");
    if (st && !bgFetchActive && !isAutoScrolling) { st.innerText = "LIVE off"; st.style.color = "#94a3b8"; }
  }
  async function liveFetchOnce(fullWindow) {
    if (liveBusy || bgFetchActive || !liveMode) return;
    const mint = getMintFromUrl();
    if (!mint || mint === "GMGN") {
      const st = document.getElementById("gmgn-status-text");
      if (st) { st.innerText = "LIVE: buka halaman token"; st.style.color = "#f59e0b"; }
      return;
    }
    liveBusy = true;
    await refreshHolderContext(false);
    bypassRangeFilter = true;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - LIVE_WINDOW_SEC;
    let startTs = windowStart;
    const last = maxTradeTs();
    if (!fullWindow && last > startTs) startTs = last + 1;
    const endTs = now + 60;
    const st = document.getElementById("gmgn-status-text");
    if (st) { st.innerText = fullWindow ? "LIVE · muat 48 jam…" : "LIVE · sync baru…"; st.style.color = "#38bdf8"; }
    const delay = getCooldownMs();
    const base = `https://gmgn.ai/vas/api/v1/token_trades/sol/${mint}?event=buy&event=sell&limit=200`;
    let added = 0;
    async function pullPages(fromSec, toSec, maxPages) {
      let cursor = null, page = 0, oldest = Infinity;
      while (liveMode && page < maxPages) {
        let url = base;
        if (fromSec > 0) url += `&from=${fromSec}`;
        if (toSec > 0) url += `&to=${toSec}`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
        let json = null, ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const resp = await originalFetch.apply(window, [url, { credentials: "include" }]);
            const txt = await resp.text();
            try { json = JSON.parse(txt); } catch (e) { json = null; }
            if (json && json.code === 0) ok = true;
            else if (attempt < 2) await new Promise(r => setTimeout(r, delay * (attempt + 2)));
          } catch (e) {
            if (attempt < 2) await new Promise(r => setTimeout(r, delay * (attempt + 2)));
          }
        }
        if (!ok || !json) break;
        const history = (json.data || {}).history || [];
        if (history.length) added += processHistoryItems(history);
        page++;
        for (const item of history) {
          let ts = parseInt(item.timestamp ?? item.time ?? item.ts ?? item.block_time ?? 0);
          if (ts > 1e12) ts = Math.floor(ts / 1000);
          if (ts > 0 && ts < oldest) oldest = ts;
        }
        if (oldest < windowStart) break;
        if (!(json.data && json.data.next)) break;
        cursor = json.data.next;
      }
      return oldest;
    }
    try {
      // from/to detik (sama seperti Background Fetch). Jangan milidetik — API GMGN menolak, LIVE 0 TX.
      // full window: tanpa from, mundur dari now sampai 48 jam (from 48 jam sering dipotong API).
      if (fullWindow) {
        const oldest = await pullPages(0, endTs, 200);
        if (liveMode && oldest > windowStart) await pullPages(windowStart, Math.max(windowStart + 1, oldest - 1), 80);
      } else {
        await pullPages(startTs, endTs, 80);
      }
      liveNextAt = Date.now() + LIVE_EVERY_MS;
      if (st) {
        const nxt = new Date(liveNextAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false });
        st.innerText = `LIVE · +${added} TX · next ${nxt}`;
        st.style.color = "#10b981";
      }
      try { saveCache(mint, getSortedTrades()); } catch (e) {}
    } finally {
      bypassRangeFilter = false;
      liveBusy = false;
      paintLiveBtn();
      updateUI();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. ENGINE — wash matcher, bar aggregator, trajectory, classifier, narasi
  // ══════════════════════════════════════════════════════════════════════════

  // Wash/round-trip matcher per-wallet (FIFO window). Idempoten.
  function annotateMatchedAmounts(trades) {
    for (const t of trades) t.matched = 0;
    const byW = new Map();
    for (const t of trades) { if (!byW.has(t.maker)) byW.set(t.maker, []); byW.get(t.maker).push(t); }
    const W = WASH_WINDOW_SEC;
    for (const lots of byW.values()) {
      lots.sort((a, b) => a.ts - b.ts);
      const open = []; let head = 0;
      for (const tr of lots) {
        let rem = (tr.sol || 0) - tr.matched;
        while (head < open.length) { const f = open[head]; if ((f.sol - f.matched) <= 1e-9 || (tr.ts - f.ts) > W) head++; else break; }
        for (let i = head; i < open.length && rem > 1e-9; i++) {
          const lot = open[i]; const av = (lot.sol || 0) - lot.matched; if (av <= 1e-9) continue;
          if ((tr.event === "buy") === (lot.event === "buy")) continue;
          const m = Math.min(rem, av); lot.matched += m; tr.matched += m; rem -= m;
        }
        if ((tr.sol || 0) - tr.matched > 1e-9) open.push(tr);
      }
    }
  }

  // Bucket sejajar WIB: 1H = jam, 4H = 00/04/08/12/16/20 WIB, D1 = 00:00 WIB.
  const WIB_OFF = 7 * 3600;
  function barFloor(ts) {
    const sec = BAR_SEC || 3600;
    if (sec === 3600) return Math.floor(ts / 3600) * 3600;
    const local = ts + WIB_OFF;
    return Math.floor(local / sec) * sec - WIB_OFF;
  }
  function hasFreshTag(tags) {
    return (tags || []).some(t => {
      const x = String(t || "").toLowerCase().replace(/[\s-]+/g, "_");
      return FRESH_TAGS.includes(x);
    });
  }

  function buildBars(trades, nowTs) {
    const arr = trades.slice().sort((a, b) => a.ts - b.ts);
    annotateMatchedAmounts(arr);
    if (!arr.length) return [];
    // Gabungkan tag per maker karena sebagian respons GMGN hanya menempelkan tag
    // pada salah satu trade wallet yang sama.
    const makerTags = new Map();
    for (const t of arr) {
      if (!t.maker) continue;
      if (!makerTags.has(t.maker)) makerTags.set(t.maker, new Set());
      for (const tag of (t.tags || [])) makerTags.get(t.maker).add(tag);
    }
    const now = Math.floor((nowTs != null ? nowTs : Date.now()) / 1000);
    const buckets = new Map();
    for (const t of arr) {
      const b = barFloor(t.ts);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(t);
    }
    let bars = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([start, list]) => {
      list.sort((a, b) => a.ts - b.ts);
      const priced = list.filter(t => t.price > 0);
      // HIGH/LOW hanya dari trade bernilai nyata. Trade debu (≈0 SOL) sering
      // tercetak di harga ekstrem dan menarik wick ke level yang tidak pernah
      // benar-benar diperdagangkan — garis level jadi salah dan retest tak pernah
      // kena. Kasus nyata BABYSHIB 20 Agu 01:00: satu trade 0,0000 SOL membuat
      // HIGH $250,5K padahal harga nyata tertinggi $121,8K.
      const real = priced.filter(t => t.sol >= HL_MIN_SOL);
      const hlSrc = real.length ? real : priced;
      const open = priced.length ? priced[0].price : null;
      const close = priced.length ? priced[priced.length - 1].price : null;
      const high = hlSrc.length ? Math.max(...hlSrc.map(p => p.price)) : null;
      const low = hlSrc.length ? Math.min(...hlSrc.map(p => p.price)) : null;
      // Jejak forensik: high/low kalau trade debu IKUT dihitung. Selisihnya
      // membuat anomali wick tetap terlacak di file ekspor tanpa perlu
      // menyertakan raw trades (yang membengkakkan file ~100x).
      const highRaw = priced.length ? Math.max(...priced.map(p => p.price)) : null;
      const lowRaw = priced.length ? Math.min(...priced.map(p => p.price)) : null;
      const dustTx = priced.length - real.length;
      let cvd = 0, cvdClean = 0, washVol = 0, buySol = 0, sellSol = 0, volUsd = 0;
      let freshTxCount = 0, freshBuySol = 0, freshSellSol = 0;
      const mv = new Map(), taggedMakers = new Set(), freshMakers = new Set();
      for (const t of list) {
        const signed = t.event === "buy" ? 1 : -1;
        cvd += signed * t.sol;
        const unionTags = t.maker && makerTags.has(t.maker) ? [...makerTags.get(t.maker)] : (t.tags || []);
        const isNoise = unionTags.some(tg => NOISE_TAGS.indexOf(tg) >= 0);
        const removed = isNoise ? t.sol : (t.matched || 0);
        cvdClean += signed * (t.sol - removed);
        washVol += removed;
        if (t.event === "buy") buySol += t.sol; else sellSol += t.sol;
        if (t.usd) volUsd += t.usd;
        if (t.maker) {
          mv.set(t.maker, (mv.get(t.maker) || 0) + t.sol);
          if (unionTags.length) taggedMakers.add(t.maker);
          if (hasFreshTag(unionTags)) {
            freshMakers.add(t.maker); freshTxCount++;
            if (t.event === "buy") freshBuySol += t.sol; else freshSellSol += t.sol;
          }
        }
      }
      const volSol = buySol + sellSol;
      const washPct = volSol > 0 ? (washVol / volSol) * 100 : 0;
      const freshWallets = freshMakers.size;
      const freshWalletPct = mv.size > 0 ? (freshWallets / mv.size) * 100 : 0;
      let top1 = 0; for (const v of mv.values()) if (v > top1) top1 = v;
      const priceChgPct = (open && close && open > 0) ? (close / open - 1) * 100 : null;
      // R bertanda dari cvdClean: + = serap BUY, − = serap SELL
      const effortCvd = cvdClean;
      const rAbs = (priceChgPct != null && Math.abs(priceChgPct) > 1e-9) ? Math.abs(effortCvd) / Math.abs(priceChgPct) : null;
      const signedR = rAbs == null ? null : (effortCvd >= 0 ? rAbs : -rAbs);
      const R = rAbs;
      return { start, end: start + BAR_SEC, open, high, low, close, priceChgPct,
        cvd, cvdClean, buySol, sellSol, volSol, volUsd, washVol, washPct,
        txCount: list.length, uniqueMakers: mv.size, taggedMakers: taggedMakers.size,
        freshWallets, freshWalletPct, freshTxCount, freshBuySol, freshSellSol,
        topWalletPct: volSol > 0 ? (top1 / volSol) * 100 : 0, R, signedR,
        highRaw, lowRaw, dustTx, maxTradeSol: top1,
        partial: (start + BAR_SEC) > now };
    });
    if (bars.length > MAX_BARS) bars = bars.slice(-MAX_BARS);
    // Konversi price historis menjadi market cap. Prioritas: rasio MC/price dari
    // token_info, lalu total supply, lalu inferensi MC terkini / close terbaru.
    const latestPriced = bars.slice().reverse().find(b => b.close != null && b.close > 0);
    const inferred = (cachedMcUsd > 0 && latestPriced) ? cachedMcUsd / latestPriced.close : 0;
    const mcPerPrice = cachedMcPerPrice > 0 ? cachedMcPerPrice : cachedSupply > 0 ? cachedSupply : inferred;
    for (const b of bars) {
      b.mcPerPrice = mcPerPrice > 0 ? mcPerPrice : null;
      b.openMc = mcPerPrice > 0 && b.open != null ? b.open * mcPerPrice : null;
      b.highMc = mcPerPrice > 0 && b.high != null ? b.high * mcPerPrice : null;
      b.lowMc = mcPerPrice > 0 && b.low != null ? b.low * mcPerPrice : null;
      b.closeMc = mcPerPrice > 0 && b.close != null ? b.close * mcPerPrice : null;
      b.highRawMc = mcPerPrice > 0 && b.highRaw != null ? b.highRaw * mcPerPrice : null;
      b.lowRawMc = mcPerPrice > 0 && b.lowRaw != null ? b.lowRaw * mcPerPrice : null;
    }
    let cum = 0, cl = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i > 0 && bars[i].start - bars[i - 1].start > CLUSTER_GAP) cl++;
      bars[i].cluster = cl;
      cum += bars[i].cvdClean; bars[i].cumCVD = cum;
    }
    return bars;
  }

  // Klaster aktivitas TERAKHIR: putus saat gap antar bar > CLUSTER_GAP. Dipakai
  // classifier supaya data lampau (token mati lama lalu nyala) tak mencemari sinyal.
  function latestCluster(bars) {
    if (!bars || bars.length <= 1) return (bars || []).slice();
    // index awal tiap klaster (break pada gap > CLUSTER_GAP)
    const breaks = [0];
    for (let i = 1; i < bars.length; i++) if (bars[i].start - bars[i - 1].start > CLUSTER_GAP) breaks.push(i);
    let startIdx = breaks[breaks.length - 1];
    // jika klaster terakhir terlalu kecil (bar lepas/1 trade) & ada klaster sebelumnya -> pakai klaster sebelumnya
    if (bars.length - startIdx < MIN_CLUSTER_BARS && breaks.length >= 2) startIdx = breaks[breaks.length - 2];
    return bars.slice(startIdx);
  }

  // Bar aktif utk tampil/analisa: klaster terpilih, atau latest (auto).
  function activeBars(bars) {
    if (selectedCluster == null) return latestCluster(bars);
    const f = bars.filter(b => b.cluster === selectedCluster);
    return f.length ? f : latestCluster(bars);
  }

  // Isi dropdown klaster (rebuild hanya jika berubah, agar tak reset saat dipakai).
  function populateClusterSelect(bars) {
    const sel = document.getElementById("gmgn-cluster");
    if (!sel) return;
    const cl = {}; bars.forEach(b => { (cl[b.cluster] = cl[b.cluster] || []).push(b); });
    const keys = Object.keys(cl).map(Number).sort((a, b) => a - b);
    const opts = [`<option value="">latest (auto)</option>`];
    keys.forEach((k, i) => {
      const c = cl[k]; const p = tzParts(c[0].start);
      const latest = (i === keys.length - 1);
      opts.push(`<option value="${k}">cluster ${k} (${fmtDateId(p)}, ${c.length} bar${latest ? " *" : ""})</option>`);
    });
    const sig = opts.join("");
    if (sel._sig !== sig) { sel.innerHTML = opts.join(""); sel._sig = sig; }
    sel.value = selectedCluster == null ? "" : String(selectedCluster);
  }

  // ── helper ──
  function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  function percentile(values, p) {
    const a = (values || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    if (a.length === 1) return a[0];
    const pos = (a.length - 1) * Math.max(0, Math.min(1, p));
    const lo = Math.floor(pos), hi = Math.ceil(pos), w = pos - lo;
    return a[lo] + (a[hi] - a[lo]) * w;
  }
  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a === 0) return "0";
    if (a < 0.000001) return v.toExponential(6);
    if (a < 0.01) return v.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    if (a < 1) return v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
  }
  function fmtMarketCap(v) {
    if (v == null || !isFinite(v) || v <= 0) return "MC belum tersedia";
    const n = Math.abs(v);
    if (n >= 1e9) return "$" + (v / 1e9).toFixed(n >= 1e10 ? 1 : 2).replace(/\.0+$/, "") + "B";
    if (n >= 1e6) return "$" + (v / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/, "") + "M";
    if (n >= 1e3) return "$" + (v / 1e3).toFixed(n >= 1e5 ? 1 : 2).replace(/\.0+$/, "") + "K";
    return "$" + v.toFixed(0);
  }

  function priceTrendPct(bars, i, n) {
    const j = Math.max(0, i - n);
    const a = bars[j] && bars[j].close, b = bars[i] && bars[i].close;
    if (a == null || b == null || !(a > 0)) return 0;
    return (b / a - 1) * 100;
  }
  // Konfirmasi hanya di TITIK BEBAS: |R| < FREE_R
  function rFree(nowR) {
    if (nowR == null) return false;
    return Math.abs(nowR) < FREE_R;
  }
  function gradeFromScore(score) {
    if (score >= 88) return { grade: "A+", label: "sangat yakin", color: "#34d399" };
    if (score >= 78) return { grade: "A",  label: "yakin", color: "#10b981" };
    if (score >= 68) return { grade: "B+", label: "cukup yakin", color: "#a3e635" };
    if (score >= 58) return { grade: "B",  label: "sedang", color: "#fbbf24" };
    if (score >= 48) return { grade: "C",  label: "lemah", color: "#fb923c" };
    return { grade: "D", label: "spekulatif", color: "#94a3b8" };
  }

  // Conviksi: setup (R vs batas TF + pin). Konfirmasi beda untuk
  // serapan berhasil (R ambruk / CVD absorber) vs breakout (tembus + CVD penyerang).
  function scoreConviction(s, c, setupIdx, confirmIdx, kind) {
    const parts = [];
    let score = 36;
    const isBrk = kind === "BREAKOUT BUY" || kind === "BREAKOUT SELL";
    const sCvd = s.cvdClean != null ? s.cvdClean : (s.cvd || 0);
    const cCvd = c.cvdClean != null ? c.cvdClean : (c.cvd || 0);

    const rMult = SERAP_R > 0 ? s.R / SERAP_R : 1;
    let rPts = rMult >= 12 ? 28 : rMult >= 8 ? 24 : rMult >= 5 ? 20 : rMult >= 3 ? 15 : rMult >= 2 ? 10 : 5;
    score += rPts;
    parts.push(`serapan R ${s.R.toFixed(1)} = ${rMult.toFixed(1)}× batas ${SERAP_R}  ${fmtPts(rPts)}`);

    const chg = Math.abs(s.priceChgPct || 0);
    const effort = Math.abs(sCvd);
    let pinPts = 0;
    if (chg <= 1.5 && effort >= 8) pinPts = 12;
    else if (chg <= 3 && effort >= 4) pinPts = 8;
    else if (chg <= 5) pinPts = 4;
    score += pinPts;
    parts.push(`pin ${chg.toFixed(2)}% · effort ${effort.toFixed(1)} SOL  ${fmtPts(pinPts)}`);

    if (isBrk) {
      let brkPct = 0;
      if (kind === "BREAKOUT BUY" && s.high > 0 && c.close != null) brkPct = ((c.close / s.high) - 1) * 100;
      else if (kind === "BREAKOUT SELL" && s.low > 0 && c.close != null) brkPct = ((s.low - c.close) / s.low) * 100;
      const brkPts = brkPct >= 8 ? 14 : brkPct >= 4 ? 10 : brkPct >= 1.5 ? 6 : 3;
      score += brkPts;
      parts.push(`tembus ${brkPct.toFixed(1)}%  ${fmtPts(brkPts)}`);

      const att = Math.abs(cCvd);
      const attPts = att >= 20 ? 12 : att >= 8 ? 8 : att >= 4 ? 4 : 2;
      score += attPts;
      parts.push(`CVD penyerang ${cCvd >= 0 ? "+" : ""}${cCvd.toFixed(1)}  ${fmtPts(attPts)}`);

      const nowR = c.R;
      const absNowR = nowR == null ? null : Math.abs(nowR);
      const freePts = (absNowR != null && absNowR < FREE_R) ? 8 : (absNowR != null && absNowR < SERAP_R * 0.5) ? 4 : 0;
      score += freePts;
      parts.push(`R konfirm ${nowR != null ? nowR.toFixed(2) : "—"} (keluar zona serap)  ${fmtPts(freePts)}`);
    } else {
      const drop = s.R > 0 && c.R != null ? 1 - c.R / s.R : 0;
      let dropPts = (c.R < FREE_R && drop >= 0.9) ? 16 : drop >= 0.85 ? 12 : drop >= 0.7 ? 8 : 3;
      score += dropPts;
      parts.push(`R anjlok ${(drop * 100).toFixed(0)}% → ${c.R != null ? c.R.toFixed(2) : "—"}  ${fmtPts(dropPts)}`);

      const dCvd = cCvd - sCvd;
      const flip = (sCvd <= 0 && cCvd > 0) || (sCvd >= 0 && cCvd < 0);
      const mag = Math.abs(dCvd);
      let cvdPts = (flip && mag >= 20) ? 12 : (flip && mag >= 8) ? 9 : mag >= 20 ? 7 : mag >= 5 ? 4 : 2;
      score += cvdPts;
      parts.push(`ΔCVD ${dCvd >= 0 ? "+" : ""}${dCvd.toFixed(1)}${flip ? " flip" : ""}  ${fmtPts(cvdPts)}`);

      const move = Math.abs(c.priceChgPct || 0);
      let mvPts = move >= 20 ? 10 : move >= 10 ? 7 : move >= 5 ? 4 : 1;
      score += mvPts;
      parts.push(`follow-through ${c.priceChgPct >= 0 ? "+" : ""}${(c.priceChgPct || 0).toFixed(1)}%  ${fmtPts(mvPts)}`);
    }

    const vol = s.volSol || 0, tx = s.txCount || 0;
    let volPts = (vol < 2 || tx < 10) ? -10 : (vol < 8 || tx < 25) ? -4 : (vol >= 80 && tx >= 80) ? 8 : vol >= 25 ? 4 : 0;
    score += volPts;
    parts.push(`vol ${vol.toFixed(1)} SOL / ${tx} tx  ${fmtPts(volPts)}`);

    const wash = Math.max(s.washPct || 0, c.washPct || 0);
    let washPts = wash >= 30 ? -8 : wash >= 18 ? -4 : 0;
    score += washPts;
    if (washPts) parts.push(`wash ${wash.toFixed(0)}%  ${fmtPts(washPts)}`);

    const gap = confirmIdx - setupIdx;
    let gapPts = gap === 1 ? 4 : gap <= 3 ? 2 : gap >= 8 ? -3 : 0;
    score += gapPts;
    parts.push(`jarak konfirmasi ${gap} bar  ${fmtPts(gapPts)}`);

    score = Math.max(20, Math.min(99, Math.round(score)));
    const g = gradeFromScore(score);
    return { score, grade: g.grade, gradeLabel: g.label, gradeColor: g.color, parts };
  }
  function fmtPts(n) { return (n > 0 ? "+" : "") + n; }

  // Skor HANYA bar setup — dipakai WASPADA (tanpa nunggu konfirmasi).
  // A+ (≥88) hampir mustahil tanpa R ≥ ~12× batas + pin + volume.
  function scoreSetup(s) {
    const parts = [];
    let score = 40;
    const sCvd = s.cvdClean != null ? s.cvdClean : (s.cvd || 0);
    const rMult = SERAP_R > 0 && s.R != null ? s.R / SERAP_R : 0;
    const rPts = rMult >= 12 ? 32 : rMult >= 8 ? 26 : rMult >= 5 ? 20 : rMult >= 3 ? 14 : rMult >= 2 ? 8 : 4;
    score += rPts;
    parts.push(`serapan R ${s.R != null ? s.R.toFixed(1) : "—"} = ${rMult.toFixed(1)}× batas ${SERAP_R}  ${fmtPts(rPts)}`);
    const chg = Math.abs(s.priceChgPct || 0);
    const effort = Math.abs(sCvd);
    let pinPts = 0;
    if (chg <= 1.5 && effort >= 8) pinPts = 12;
    else if (chg <= 3 && effort >= 4) pinPts = 8;
    else if (chg <= 5) pinPts = 4;
    score += pinPts;
    parts.push(`pin ${chg.toFixed(2)}% · effort ${effort.toFixed(1)} SOL  ${fmtPts(pinPts)}`);
    const vol = s.volSol || 0, tx = s.txCount || 0;
    const volPts = (vol < 2 || tx < 10) ? -10 : (vol < 8 || tx < 25) ? -4 : (vol >= 80 && tx >= 80) ? 8 : vol >= 25 ? 4 : 0;
    score += volPts;
    parts.push(`vol ${vol.toFixed(1)} SOL / ${tx} tx  ${fmtPts(volPts)}`);
    const wash = s.washPct || 0;
    const washPts = wash >= 30 ? -8 : wash >= 18 ? -4 : 0;
    score += washPts;
    if (washPts) parts.push(`wash ${wash.toFixed(0)}%  ${fmtPts(washPts)}`);
    score = Math.max(20, Math.min(99, Math.round(score)));
    const g = gradeFromScore(score);
    return { score, grade: g.grade, gradeLabel: g.label, gradeColor: g.color, parts };
  }

  function rAbsOf(b) {
    if (!b || b.R == null) return null;
    return Math.abs(b.R);
  }
  function rSpikeMult(prev, now) {
    const a = rAbsOf(prev), b = rAbsOf(now);
    if (a == null || b == null || !(a > 1e-9)) return null;
    return b / a;
  }
  function effortAbs(b) {
    return Math.abs(b.cvdClean != null ? b.cvdClean : (b.cvd || 0));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LEVEL ENGINE — resistance/support dari penyerapan yang TERBUKTI
  // ══════════════════════════════════════════════════════════════════════════
  // Alur:
  //   1. cari candle penyerapan (spike |R| ≥10× bar sebelumnya dan |R| ≥10)
  //   2. buktikan pada beberapa bar sesudahnya: R runtuh + cumCVD & harga
  //      bergerak menjauh ke arah yang benar
  //   3. penyerapan terbukti -> level lahir (HIGH-LOW candle itu, dalam MC)
  //      penyerapan gagal    -> tidak ada level, tidak ada sinyal
  //   4. saat harga kembali ke GARIS level dengan R normal -> sinyal retest

  // Candle penyerapan: R melonjak dan effort cukup besar untuk dipercaya.
  function absorptionAt(bars, i) {
    const b = bars[i], prev = i > 0 ? bars[i - 1] : null;
    if (!b || !prev || b.priceChgPct == null || b.R == null) return null;
    if (effortAbs(b) < ABSORB_MIN_CVD) return null;
    const mult = rSpikeMult(prev, b);
    if (mult == null || mult < R_SPIKE_MULT || rAbsOf(b) < R_MIN_ABS) return null;
    const cvd = b.cvdClean != null ? b.cvdClean : (b.cvd || 0);
    // +R (net BUY diserap seller) -> kandidat RESISTANCE
    // -R (net SELL diserap buyer) -> kandidat SUPPORT
    return { kind: cvd >= 0 ? "resistance" : "support", mult, bar: b, idx: i };
  }

  // Pembuktian: cek bar sesudah penyerapan. Mengembalikan objek hasil dengan
  // status "confirmed" atau "failed", atau null bila data belum cukup.
  function verifyAbsorption(bars, cand) {
    const i = cand.idx, b = cand.bar;
    const isRes = cand.kind === "resistance";
    const after = [];
    for (let j = i + 1; j < bars.length && after.length < LVL_CONFIRM_BARS; j++) {
      if (bars[j].partial) break;
      after.push(bars[j]);
    }
    if (after.length < LVL_MIN_CONFIRM_BARS) return null;   // belum bisa dinilai

    const refClose = b.close;
    if (refClose == null || !(refClose > 0)) return null;
    const lvlHigh = b.high, lvlLow = b.low;

    const rBase = rAbsOf(b);

    // Berjalan MAJU bar per bar. Di tiap langkah dinilai dua hal berurutan:
    //   1. apakah bukti sudah lengkap sampai titik ini -> CONFIRMED, berhenti;
    //   2. kalau belum, apakah harga menembus level -> FAILED, berhenti.
    //
    // Urutannya penting. Versi lama memindai SELURUH jendela 12 bar mencari
    // penembusan lebih dulu, jadi level yang sudah terbukti berjam-jam
    // sebelumnya tetap dibatalkan oleh pantulan yang datang belakangan.
    // Kasus nyata Plumber 21 Agu 01:00: harga jatuh -18,6% dalam 4 bar
    // (bukti lengkap), baru di bar ke-5 memantul menembus HIGH. Itu level
    // resistance yang sah lalu ditembus — bukan penyerapan gagal.
    // Prinsipnya sama dengan pengukuran titik terjauh: begitu terbukti,
    // level tidak bisa dibatalkan oleh apa yang terjadi sesudahnya.
    let extreme = refClose, extIdx = 0;
    let best = null;

    for (let k = 0; k < after.length; k++) {
      const a = after[k];
      const v = isRes ? a.low : a.high;
      if (v != null && v > 0 && (isRes ? v < extreme : v > extreme)) { extreme = v; extIdx = k; }

      // --- 1. cukup bukti sampai bar ini? ---
      if (k + 1 >= LVL_MIN_CONFIRM_BARS) {
        const movePct = (extreme / refClose - 1) * 100;
        const atExt = after[extIdx];
        const cvdDelta = (atExt && atExt.cumCVD != null && b.cumCVD != null) ? atExt.cumCVD - b.cumCVD : 0;
        const span = after.slice(0, extIdx + 1);
        const rAfter = percentile(span.map(x => rAbsOf(x)).filter(v2 => v2 != null), 0.5);
        const rCollapsed = rBase > 0 && rAfter != null && rAfter <= rBase * LVL_R_DROP;
        const info = { movePct, cvdDelta, rAfter, rBase, bars: k + 1, moveBars: extIdx + 1 };
        const ok = isRes
          ? (rCollapsed && cvdDelta < 0 && movePct <= -LVL_MIN_MOVE_PCT)
          : (rCollapsed && cvdDelta > 0 && movePct >= LVL_MIN_MOVE_PCT);
        if (ok) return Object.assign({ status: "confirmed" }, info);
        best = info;
      }

      // --- 2. belum terbukti dan harga sudah menembus level -> gagal ---
      if (a.close != null) {
        if (isRes && lvlHigh > 0 && (a.close / lvlHigh - 1) * 100 > LVL_FAIL_PCT) {
          return { status: "failed", why: "harga menembus HIGH level sebelum terbukti" };
        }
        if (!isRes && lvlLow > 0 && (lvlLow / a.close - 1) * 100 > LVL_FAIL_PCT) {
          return { status: "failed", why: "harga menembus LOW level sebelum terbukti" };
        }
      }
    }

    if (best) return Object.assign({ status: "pending" }, best);
    const movePct = (extreme / refClose - 1) * 100;
    return { status: "pending", movePct, cvdDelta: 0, rAfter: null, rBase,
             bars: after.length, moveBars: extIdx + 1 };
  }

  function makeLevelEvent(cand, proof, bars) {
    const isRes = cand.kind === "resistance";
    const b = cand.bar;
    return {
      signal: isRes ? SIG_RESISTANCE : SIG_SUPPORT,
      side: isRes ? "top" : "bottom",
      conf: Math.min(99, Math.round(50 + Math.min(cand.mult, 40) + Math.abs(proof.movePct))),
      grade: isRes ? "R" : "S",
      gradeLabel: (isRes ? "resistance" : "support") + " terbukti",
      gradeColor: isRes ? "#ef4444" : "#22c55e",
      gradeParts: [],
      setup: b, confirm: b, setupIdx: cand.idx, confirmIdx: cand.idx, spike: true,
      level: {
        kind: cand.kind,
        lowMc: b.lowMc, highMc: b.highMc,
        low: b.low, high: b.high,
        start: b.start, idx: cand.idx
      },
      ev: {
        setupR: b.signedR != null ? b.signedR : b.R,
        confirmR: b.R,
        setupChg: b.priceChgPct, confirmChg: b.priceChgPct,
        setupCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        confirmCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        rMult: cand.mult,
        prevR: rAbsOf(bars[cand.idx - 1]),
        proofMove: proof.movePct,
        proofCvd: proof.cvdDelta,
        proofRAfter: proof.rAfter,
        proofBars: proof.bars,
        proofMoveBars: proof.moveBars,
        rangeLowMc: b.lowMc,
        rangeHighMc: b.highMc,
        lineMc: isRes ? b.highMc : b.lowMc,
        linePrice: isRes ? b.high : b.low
      }
    };
  }

  // Retest: harga kembali menyentuh GARIS level, tetapi R hanya normal.
  // Artinya pihak yang dulu mempertahankan level sudah tidak hadir lagi.
  function makeRetestEvent(level, b, i, rNorm, base) {
    const isRes = level.kind === "resistance";
    return {
      signal: isRes ? SIG_RETEST_RES : SIG_RETEST_SUP,
      side: isRes ? "top" : "bottom",
      conf: Math.max(20, Math.min(99, Math.round(90 - rNorm * 30))),
      grade: rNorm.toFixed(2) + "×",
      gradeLabel: "R normal saat retest",
      gradeColor: isRes ? "#38bdf8" : "#f59e0b",
      gradeParts: [],
      setup: b, confirm: b, setupIdx: i, confirmIdx: i, spike: false,
      level,
      ev: {
        setupR: b.signedR != null ? b.signedR : b.R,
        confirmR: b.R,
        setupChg: b.priceChgPct, confirmChg: b.priceChgPct,
        setupCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        confirmCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        rNorm, rBaseline: base,
        levelStart: level.start,
        rangeLowMc: level.lowMc,
        rangeHighMc: level.highMc,
        lineMc: level.kind === "resistance" ? level.highMc : level.lowMc,
        linePrice: levelLine(level),
        cumCvdDelta: b.cumCVD
      }
    };
  }

  // Garis level: HIGH untuk resistance, LOW untuk support.
  function levelLine(level) {
    if (!level) return null;
    return level.kind === "resistance" ? level.high : level.low;
  }
  // Apakah candle menyentuh GARIS level (bukan pita LOW-HIGH)?
  function touchesLine(b, level) {
    const line = levelLine(level);
    if (line == null || !(line > 0)) return false;
    if (b.high == null || b.low == null) return false;
    const pad = line * (LVL_LINE_PAD_PCT / 100);
    return b.high >= line - pad && b.low <= line + pad;
  }

  // Ringkasan kenapa retest belum muncul untuk sebuah level.
  function retestDiagText(lv) {
    const d = lv && lv.diag;
    const isRes = lv && lv.kind === "resistance";
    const what = isRes ? "RETEST RESISTANCE" : "RETEST SUPPORT";
    if (!d) return `${what}: belum ada bar sesudah level.`;
    if (!d.touch) {
      const n = d.near === Infinity ? null : d.near;
      return n == null
        ? `${what}: harga belum pernah kembali ke garis.`
        : `${what}: harga belum menyentuh garis — terdekat ${n.toFixed(2)}% (toleransi ${LVL_LINE_PAD_PCT}%).`;
    }
    const parts = [];
    if (d.rHigh) parts.push(`R masih tinggi ${d.rHighVal != null ? "(" + d.rHighVal.toFixed(2) + "× > " + LVL_RETEST_R_MAX + "×)" : ""} ${d.rHigh}×`);
    if (d.wrongDir) parts.push(`cumCVD arah salah ${d.wrongDir}×`);
    if (d.notArmed) parts.push(`level belum ter-arm (harga belum menjauh ${LVL_EXIT_PCT}%) ${d.notArmed}×`);
    if (d.lowEffort) parts.push(`volume terlalu sepi ${d.lowEffort}×`);
    if (d.gap) parts.push(`terlalu dekat dgn level (<${LVL_RETEST_MIN_GAP} bar) ${d.gap}×`);
    if (d.noData) parts.push(`data cumCVD/R kosong ${d.noData}×`);
    if (!parts.length) return `${what}: sudah menyentuh garis ${d.touch}× — sinyal seharusnya muncul.`;
    return `${what}: menyentuh garis ${d.touch}× tapi ditahan — ${parts.join(" · ")}.`;
  }

  function scanSignals(bars) {
    const evs = [];
    if (!bars || !bars.length) return { events: evs, pending: null, levels: [] };
    const base = rBaseline(bars);
    const levels = [];

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];

      // 1-2. penyerapan -> pembuktian -> level lahir
      const cand = absorptionAt(bars, i);
      if (cand) {
        const proof = verifyAbsorption(bars, cand);
        if (proof && proof.status === "confirmed") {
          const ev = makeLevelEvent(cand, proof, bars);
          evs.push(ev);
          levels.push(ev.level);
        }
        // status "failed" / "pending" sengaja tidak memunculkan sinyal apa pun
      }

      // 3-4. retest: harga kembali ke GARIS level dengan R normal.
      //
      // ARMING dijalankan LEBIH DULU dan TERPISAH dari syarat kualitas candle.
      // Alasannya: bar-bar saat harga "pergi" biasanya justru ber-R tinggi
      // (dump/pump keras) atau sepi. Kalau arming ikut disaring oleh R normal
      // dan effort, level tidak pernah ter-arm dan retest hilang sama sekali.
      if (b.partial || b.close == null) continue;
      // Arming dievaluasi dari bar SEBELUMNYA (lv.pendingArm), bukan bar ini.
      // Kalau bar yang menjauhkan harga juga boleh langsung memicu retest, satu
      // candle breakout yang wick bawahnya masih menyerempet garis akan
      // menghasilkan sinyal duplikat. Kasus nyata BABYSHIB 20 Agu 20:00.
      for (const lv of levels) {
        if (lv.idx >= i) continue;
        if (lv.pendingArm) { lv.armed = true; lv.pendingArm = false; }
      }

      // DIAGNOSA: catat pendekatan terdekat & gerbang mana yang menahan retest.
      // Murni pencatatan, tidak mengubah keputusan sinyal.
      {
        const dAbsR = rAbsOf(b);
        const dRNorm = (base != null && base > 1e-9 && dAbsR != null) ? dAbsR / base : null;
        const dPrev = i > 0 ? bars[i - 1] : null;
        const dCvdUp = (dPrev && dPrev.cumCVD != null && b.cumCVD != null) ? b.cumCVD > dPrev.cumCVD : null;
        for (const lv of levels) {
          if (lv.idx >= i) continue;
          const ln = levelLine(lv);
          if (ln == null || !(ln > 0)) continue;
          const d = lv.diag || (lv.diag = { near: Infinity, nearAt: null, touch: 0,
            gap: 0, notArmed: 0, rHigh: 0, lowEffort: 0, wrongDir: 0, noData: 0, rHighVal: null });
          const inside = b.high != null && b.low != null && b.high >= ln && b.low <= ln;
          const dist = inside ? 0 : Math.min(
            b.high != null ? Math.abs(b.high / ln - 1) : Infinity,
            b.low != null ? Math.abs(b.low / ln - 1) : Infinity) * 100;
          if (dist < d.near) { d.near = dist; d.nearAt = b.start; }
          if (!touchesLine(b, lv)) continue;
          d.touch++;
          if (i - lv.idx < LVL_RETEST_MIN_GAP) { d.gap++; continue; }
          if (!lv.armed) { d.notArmed++; continue; }
          if (dRNorm == null) { d.noData++; continue; }
          if (dRNorm > LVL_RETEST_R_MAX) { d.rHigh++; d.rHighVal = dRNorm; continue; }
          if (effortAbs(b) < ABSORB_MIN_CVD) { d.lowEffort++; continue; }
          if (dCvdUp == null) { d.noData++; continue; }
          if (lv.kind === "resistance" && !dCvdUp) { d.wrongDir++; continue; }
          if (lv.kind === "support" && dCvdUp) { d.wrongDir++; continue; }
        }
      }

      // Saringan kualitas candle hanya untuk MEMUNCULKAN sinyal, bukan arming.
      if (b.R == null || base == null) continue;
      const absR = rAbsOf(b);
      const rNorm = base > 1e-9 ? absR / base : null;
      if (rNorm == null || rNorm > LVL_RETEST_R_MAX) continue;
      if (effortAbs(b) < ABSORB_MIN_CVD) continue;
      const prev = i > 0 ? bars[i - 1] : null;
      if (!prev || prev.cumCVD == null || b.cumCVD == null) continue;
      const cvdUp = b.cumCVD > prev.cumCVD;

      for (const lv of levels) {
        if (i - lv.idx < LVL_RETEST_MIN_GAP) continue;
        if (!lv.armed) continue;              // harus pernah pergi dulu
        if (!touchesLine(b, lv)) continue;
        // resistance: retest valid bila cumCVD NAIK (buyer datang lagi)
        // support:    retest valid bila cumCVD TURUN (seller datang lagi)
        // Arah salah = bukan retest yang kita cari; level TETAP armed supaya
        // kunjungan berikutnya masih bisa memicu sinyal.
        if (lv.kind === "resistance" && !cvdUp) continue;
        if (lv.kind === "support" && cvdUp) continue;
        // Satu alert per kunjungan: kunci level sampai harga pergi lagi.
        lv.armed = false;
        evs.push(makeRetestEvent(lv, b, i, rNorm, base));
        break;   // satu retest per candle
      }

      // Setelah emisi: catat kalau bar ini membuat harga menjauh dari garis.
      // Efeknya baru berlaku di bar berikutnya.
      for (const lv of levels) {
        if (lv.idx >= i) continue;
        const ln2 = levelLine(lv);
        if (ln2 == null || !(ln2 > 0)) continue;
        if (Math.abs(b.close / ln2 - 1) * 100 >= LVL_EXIT_PCT) lv.pendingArm = true;
      }
    }
    evs.sort((a, b) => a.confirm.start - b.confirm.start);
    return { events: evs, pending: null, levels };
  }

  function detectEvents(bars) { return scanSignals(bars).events; }

  function detectPending() { return null; }

  function classify(bars) {
    const cb = latestCluster(bars);
    if (!cb.length) return { signal: "NETRAL", phase: "NETRAL", conf: 0, reason: "butuh data bar. Token sepi atau fetch lebih banyak.", bars: cb };
    const scan = scanSignals(cb);
    const evs = scan.events;
    if (!evs.length) {
      const reason = cb.length < LVL_MIN_BARS
        ? `NETRAL — butuh ≥${LVL_MIN_BARS} bar selesai untuk acuan R; klaster terakhir ${cb.length} bar.`
        : "NETRAL — belum ada level terbukti. Penyerapan yang gagal tidak dihitung.";
      return { signal: "NETRAL", phase: "NETRAL", conf: 0, reason, last: cb[cb.length - 1], bars: cb, pending: null, events: evs, levels: scan.levels };
    }
    const c = evs[evs.length - 1];
    c.phase = c.signal;
    c.last = c.confirm;
    c.bars = cb;
    c.events = evs;
    c.levels = scan.levels;
    c.pending = null;
    c.reason = buildNarrative(c);
    return c;
  }

  function signalHistory(bars) {
    const cb = latestCluster(bars);
    return detectEvents(cb).map(e => ({
      t: e.confirm.start, signal: e.signal, side: e.side, conf: e.conf || 0,
      grade: e.grade || "", setupT: e.setup.start,
      lowMc: e.level ? e.level.lowMc : null, highMc: e.level ? e.level.highMc : null
    }));
  }

  function buildNarrative(c) {
    const e = c.ev, s = c.setup, lines = [];
    const isLevel = c.signal === SIG_RESISTANCE || c.signal === SIG_SUPPORT;
    const isRetest = c.signal === SIG_RETEST_RES || c.signal === SIG_RETEST_SUP;

    if (isLevel) {
      const res = c.signal === SIG_RESISTANCE;
      lines.push(res
        ? "🔴 RESISTANCE TERBENTUK — penyerapan BUY terbukti: harga gagal naik dan berbalik turun."
        : "🟢 SUPPORT TERBENTUK — penyerapan SELL terbukti: harga gagal turun dan berbalik naik.");
      lines.push(`${res ? "RESISTANCE" : "SUPPORT"} MC: ${fmtMarketCap(e.lineMc)}   (${res ? "HIGH" : "LOW"} candle penyerapan)`);
      lines.push(`rentang candle: ${fmtMarketCap(e.rangeLowMc)} — ${fmtMarketCap(e.rangeHighMc)}`);
      lines.push(`terbentuk: ${fmtBar(s)} WIB`);
      lines.push(`penyerapan: R ${e.prevR != null ? e.prevR.toFixed(2) : "—"} → ${Math.abs(e.setupR).toFixed(2)} (${e.rMult.toFixed(1)}×) · CVD ${e.setupCvd >= 0 ? "+" : ""}${Number(e.setupCvd).toFixed(1)} SOL · harga ${e.setupChg >= 0 ? "+" : ""}${e.setupChg.toFixed(2)}%`);
      lines.push(`pembuktian: harga ${e.proofMove >= 0 ? "+" : ""}${e.proofMove.toFixed(1)}% ke titik terjauh dalam ${e.proofMoveBars} bar · R turun ke ${e.proofRAfter != null ? e.proofRAfter.toFixed(1) : "—"} · cumCVD ${e.proofCvd >= 0 ? "+" : ""}${e.proofCvd.toFixed(1)}`);
      return lines.join("\n");
    }

    if (isRetest) {
      const res = c.signal === SIG_RETEST_RES;
      lines.push(res
        ? "🔵 RETEST RESISTANCE — KEMUNGKINAN TEMBUS KE ATAS. Harga balik ke garis ini tetapi seller yang dulu menahan sudah tidak muncul."
        : "🟠 RETEST SUPPORT — KEMUNGKINAN JEBOL KE BAWAH. Harga balik ke garis ini tetapi buyer yang dulu menahan sudah tidak muncul.");
      lines.push(`GARIS MC: ${fmtMarketCap(e.lineMc)}   (${res ? "HIGH resistance" : "LOW support"})`);
      lines.push(`level asal: ${fmtTs(e.levelStart)} WIB · retest: ${fmtBar(s)} WIB`);
      lines.push(`R saat retest ${Math.abs(e.setupR).toFixed(2)} = ${e.rNorm.toFixed(2)}× acuan (${e.rBaseline.toFixed(1)}) → tidak ada perlawanan berarti`);
      lines.push(`cumCVD ${res ? "naik" : "turun"} · harga ${e.setupChg >= 0 ? "+" : ""}${e.setupChg.toFixed(2)}% · CVD ${e.setupCvd >= 0 ? "+" : ""}${Number(e.setupCvd).toFixed(1)} SOL`);
      return lines.join("\n");
    }

    return "NETRAL";
  }

  // 3b. R MONITOR — pembacaan R murni, tanpa sinyal & tanpa chart harga/CVD
  // ══════════════════════════════════════════════════════════════════════════
  // Filosofi: R = effort / result. Ekstensi TIDAK menyimpulkan arah dan TIDAK
  // memberi sinyal. Ia hanya melaporkan "seberapa keras harga dilawan di candle
  // ini", lalu user yang menyimpulkan sendiri.

  // Acuan skala: median |R| dari bar selesai di klaster aktif. Median dipakai
  // supaya satu candle ekstrem tidak menggeser seluruh acuan.
  function rBaseline(bars) {
    const vals = (bars || [])
      .filter(b => !b.partial && b.R != null && Math.abs(effortOf(b)) >= R_MON_MIN_EFFORT)
      .map(b => Math.abs(b.R));
    if (vals.length < 4) return null;
    return percentile(vals, 0.5);
  }
  function effortOf(b) {
    return b.cvdClean != null ? b.cvdClean : (b.cvd || 0);
  }

  // Klasifikasi satu bar menjadi kondisi R yang bisa dibaca langsung.
  // Intensitas visual tembok. 4× baru "ada tembok"; makin jauh di atas itu,
  // blok makin menyala supaya serapan kecil dan serapan raksasa terbedakan
  // sekilas pandang. Skala logaritmik agar 200× tidak membuat 12× terlihat pucat.
  // Rasio besar saja TIDAK cukup untuk menyala. Yang boleh menyala penuh hanya
  // candle yang benar-benar bisa melahirkan sinyal (waspada dump / siap pump),
  // yaitu kandidat penyerapan: |R| >= R_MIN_ABS DAN lonjakan >= R_SPIKE_MULT×
  // bar sebelumnya — syarat yang sama persis dipakai absorptionAt().
  // Contoh nyata Plumber 19 Agu 08:00: rasio 30× acuan tapi |R| cuma 45,8
  // (di bawah lantai 50), jadi tidak pernah bisa jadi sinyal — tidak boleh
  // ditandai RAKSASA.
  function isAbsorbGrade(b, prev) {
    const absR = rAbsOf(b);
    if (absR == null || absR < R_MIN_ABS) return false;
    if (!prev) return true;                 // prev tak tersedia: jangan gugurkan
    const mult = rSpikeMult(prev, b);
    return mult != null && mult >= R_SPIKE_MULT;
  }
  function wallGlow(ratio, absorbGrade) {
    if (ratio == null || ratio < R_BAND_WALL) return 0;
    const lo = Math.log(R_BAND_WALL), hi = Math.log(R_BAND_BLAZE);
    const t = (Math.log(Math.min(ratio, R_BAND_BLAZE)) - lo) / (hi - lo);
    const g = Math.max(0, Math.min(1, t));
    // Tembok yang bukan kandidat sinyal dibatasi agar tidak pernah mencapai
    // warna menyala (ramp tertinggi butuh >= 0,66).
    return absorbGrade ? g : Math.min(g, 0.6);
  }
  // Warna tembok DUA TINGKAT yang sengaja dibuat berjarak jauh:
  //
  //   TEMBOK BIASA  -> merah/hijau kalem (redup, tidak berteriak). Ini cuma
  //                    catatan "ada perlawanan di sini", bukan peringatan.
  //   RAKSASA       -> merah/hijau menyala penuh. Hanya candle yang lolos
  //                    ambang sinyal yang boleh sampai ke sini.
  //
  // Sebelumnya tingkat terendah pun sudah #ef4444 (merah terang), jadi tembok
  // sepele terlihat hampir sama bahayanya dengan serapan raksasa. Sekarang
  // tingkat biasa diturunkan ke merah bata / hijau lumut yang jelas teredam.
  function wallColor(side, glow, blaze) {
    // Merah/hijau MENYALA hanya di sini. Loncatan kecerahan dari tingkat biasa
    // ke raksasa sengaja dibuat besar (seller ~2,4x, buyer ~4,5x luminansi)
    // supaya beda kelasnya tertangkap mata tanpa membandingkan berdampingan.
    if (blaze) return side === "seller" ? "#ff3355" : "#00ff5e";
    const ramp = side === "seller"
      ? ["#77403f", "#8a4744"]     // merah bata teredam -> sedikit lebih hidup
      : ["#3d6b50", "#457a5a"];    // hijau lumut teredam -> sedikit lebih hidup
    return glow >= 0.5 ? ramp[1] : ramp[0];
  }
  // Warna ISIAN di atas sengaja gelap supaya tembok biasa tidak berteriak di
  // grafik. Tapi warna yang sama dipakai juga sebagai warna TEKS pill/tag, dan
  // di sana kontrasnya cuma ~2,3-3,7x terhadap latar — teksnya jadi susah
  // dibaca. Jadi teks memakai versi terang dari rona yang sama: nuansanya tetap
  // satu keluarga, keterbacaannya aman (>=6,5x).
  function wallTextColor(side, glow, blaze) {
    if (blaze) return side === "seller" ? "#ff3355" : "#00ff5e";
    return side === "seller" ? "#cf8a84" : "#7fc79a";
  }

  function readR(b, base, prev) {
    const chg = b.priceChgPct;
    const effort = effortOf(b);
    const absEffort = Math.abs(effort);
    const absR = b.R != null ? Math.abs(b.R) : null;

    if (absR == null || chg == null) {
      return { code: "NA", label: "—", desc: "harga tidak tersedia", color: "#475569", ratio: null };
    }
    // Bar sepi: R tinggi di sini hanyalah artefak pembagian, bukan perlawanan.
    if (absEffort < R_MON_MIN_EFFORT) {
      return { code: "SEPI", label: "SEPI", desc: `effort ${absEffort.toFixed(1)} SOL — R tidak bermakna`,
               color: "#475569", ratio: null };
    }
    const ratio = base && base > 1e-9 ? absR / base : null;
    const naik = chg > 0, turun = chg < 0;
    const chgTxt = `${Math.abs(chg).toFixed(1)}%`;
    // effort = CVD bersih. Positif -> net BUY, tapi harga tidak ikut naik
    // sebanding: berarti SELLER yang menyerap. Negatif -> sebaliknya.
    // Kalimat harus menyatukan arah harga + siapa yang menahan, kalau tidak
    // hasilnya rancu seperti "harga turun · BUY diserap seller".
    const netBuy = effort >= 0;
    function kalimat(kuat) {
      const lvl = kuat ? "kuat" : "";
      if (netBuy) {
        // net BUY masuk
        if (naik) return `beli masuk tapi harga cuma naik ${chgTxt} — seller menahan${lvl ? " " + lvl : ""} di atas`;
        if (turun) return `beli masuk tapi harga malah turun ${chgTxt} — seller menekan${lvl ? " " + lvl : ""}, permintaan diserap habis`;
        return `beli masuk tapi harga diam — seller menahan${lvl ? " " + lvl : ""} di atas`;
      }
      // net SELL keluar
      if (turun) return `jual keluar tapi harga cuma turun ${chgTxt} — buyer menahan${lvl ? " " + lvl : ""} di bawah`;
      if (naik) return `jual keluar tapi harga malah naik ${chgTxt} — buyer menyerap${lvl ? " " + lvl : ""}, tekanan jual ditelan`;
      return `jual keluar tapi harga diam — buyer menahan${lvl ? " " + lvl : ""} di bawah`;
    }

    if (ratio == null) {
      return { code: "RAW", label: absR.toFixed(1), desc: "acuan belum cukup (≥4 bar)",
               color: "#94a3b8", ratio: null };
    }
    if (ratio >= R_BAND_WALL) {
      // +R (batang di ATAS garis) = order SELL yang menahan  -> TEMBOK SELLER (merah)
      // −R (batang di BAWAH garis) = order BUY yang menahan  -> TEMBOK BUYER  (hijau)
      const side = netBuy ? "seller" : "buyer";
      const grade = isAbsorbGrade(b, prev);
      const glow = wallGlow(ratio, grade);
      const blaze = grade && ratio >= R_BAND_BLAZE;
      return { code: "TEMBOK", side, glow, blaze,
               label: (netBuy ? "TEMBOK SELLER" : "TEMBOK BUYER") + (blaze ? " 🔥" : ""),
               ratio, desc: kalimat(true) + (blaze ? ` · serapan RAKSASA ${ratio.toFixed(0)}× acuan` : ""),
               color: wallColor(side, glow, blaze),
               textColor: wallTextColor(side, glow, blaze) };
    }
    if (ratio >= R_BAND_ABSORB) {
      return { code: "SERAP", label: "SERAP", ratio,
               desc: kalimat(false), color: "#fbbf24" };
    }
    if (ratio < R_BAND_FREE) {
      const clear = Math.abs(chg) >= R_MON_MOVE_PCT;
      const arah = naik ? "naik" : turun ? "turun" : "datar";
      return { code: clear ? "BEBAS" : "TIPIS", label: clear ? "BEBAS" : "tipis", ratio,
               desc: clear
                 ? `harga ${arah} ${chgTxt} nyaris tanpa perlawanan`
                 : `R rendah tapi harga hampir diam (${chg.toFixed(2)}%)`,
               color: clear ? "#22c55e" : "#64748b" };
    }
    return { code: "NORMAL", label: "normal", ratio,
             desc: `perlawanan wajar · ${netBuy ? "net beli" : "net jual"}`, color: "#94a3b8" };
  }

  // Ringkasan bar terakhir yang sudah selesai — kesimpulan tetap di tangan user.
  function rMonitorSummary(bars) {
    const base = rBaseline(bars);
    const done = (bars || []).filter(b => !b.partial);
    const last = done.length ? done[done.length - 1] : null;
    if (!last) return { base, last: null, read: null, text: "Belum ada candle selesai." };
    const lastPrev = done.length > 1 ? done[done.length - 2] : null;
    const read = readR(last, base, lastPrev);
    const chg = last.priceChgPct;
    let text;
    switch (read.code) {
      case "BEBAS":
        text = `Candle ${fmtBar(last)}: harga ${chg > 0 ? "naik" : "turun"} ${Math.abs(chg).toFixed(1)}% dengan perlawanan minim. Gerakan bersih.`;
        break;
      case "TEMBOK":
        text = `Candle ${fmtBar(last)}: ${read.label} (${read.ratio.toFixed(1)}× normal). `
          + (read.side === "seller"
              ? "Order SELL menahan kuat di atas — harga sulit naik."
              : "Order BUY menahan kuat di bawah — harga sulit turun.")
          + (read.blaze ? " Serapan RAKSASA — blok menyala penuh." : "");
        break;
      case "SERAP":
        text = `Candle ${fmtBar(last)}: perlawanan mulai muncul (${read.ratio.toFixed(1)}× normal).`;
        break;
      case "SEPI":
        text = `Candle ${fmtBar(last)}: terlalu sepi (${Math.abs(effortOf(last)).toFixed(1)} SOL) — R belum bisa dibaca.`;
        break;
      default:
        text = `Candle ${fmtBar(last)}: perlawanan pada level wajar.`;
    }
    return { base, last, read, text };
  }

  function renderRMonitor(bars, container) {
    const data = (bars || []).slice(-R_MON_BARS);
    if (data.length < 2) {
      container.innerHTML = `<div class="gmgn-rm-empty">Butuh ≥2 candle. Jalankan Background Fetch.</div>`;
      return;
    }
    const base = rBaseline(bars);
    const sum = rMonitorSummary(bars);

    // ---- panel ringkas: kondisi candle terakhir ----
    let head = `<div class="gmgn-rm-head">`;
    if (sum.read) {
      head += `<span class="gmgn-rm-tag" style="background:${sum.read.color}22;color:${sum.read.textColor || sum.read.color};border-color:${(sum.read.textColor || sum.read.color)}66;">${esc(sum.read.label)}</span>`;
    }
    head += `<span class="gmgn-rm-sum">${esc(sum.text)}</span>`;
    head += `<span class="gmgn-rm-base">acuan |R| ${base != null ? base.toFixed(1) : "—"}</span>`;
    head += `</div>`;

    // ---- grafik batang R ternormalisasi ----
    // Batang ke ATAS  = +R (BUY diserap seller — tekanan jual pasif di atas)
    // Batang ke BAWAH = −R (SELL diserap buyer — tekanan beli pasif di bawah)
    const W = 1000, padL = 46, padR = 74, padT = 16, padB = 34;
    const H = 300, ih = H - padT - padB, iw = W - padL - padR;
    const n = data.length;
    const slot = iw / n;
    const bw = Math.max(3, Math.min(20, slot * 0.62));
    const ratios = data.map((b, i) => {
      const r = readR(b, base, i > 0 ? data[i - 1] : null);
      return r.ratio != null ? Math.min(r.ratio, R_BAND_WALL * 2.5) : 0;
    });
    const peak = Math.max(R_BAND_WALL * 1.2, ...ratios);
    const y0 = padT + ih / 2;
    const yv = v => y0 - (Math.max(-peak, Math.min(peak, v)) / peak) * (ih / 2);

    let s = "";
    // pita zona
    // Pita atas dan bawah digambar terpisah supaya zona TEMBOK bisa berbeda
    // warna: atas = tembok SELLER (merah), bawah = tembok BUYER (hijau).
    const bandUp = (lo, hi, col, op) => {
      const yA = yv(hi), yB = yv(lo);
      s += `<rect x="${padL}" y="${yA}" width="${iw}" height="${Math.abs(yB - yA)}" fill="${col}" opacity="${op}"/>`;
    };
    const bandDn = (lo, hi, col, op) => {
      const yA = yv(-hi), yB = yv(-lo);
      s += `<rect x="${padL}" y="${Math.min(yA, yB)}" width="${iw}" height="${Math.abs(yB - yA)}" fill="${col}" opacity="${op}"/>`;
    };
    const band = (lo, hi, col, op) => { bandUp(lo, hi, col, op); bandDn(lo, hi, col, op); };
    band(0, R_BAND_FREE, "#22c55e", 0.07);
    band(R_BAND_ABSORB, R_BAND_WALL, "#fbbf24", 0.07);
    bandUp(R_BAND_WALL, peak, "#ef4444", 0.09);   // tembok SELLER
    bandDn(R_BAND_WALL, peak, "#22c55e", 0.09);   // tembok BUYER

    // garis ambang
    [R_BAND_FREE, R_BAND_ABSORB, R_BAND_WALL].forEach(t => {
      [t, -t].forEach(v => {
        s += `<line x1="${padL}" y1="${yv(v)}" x2="${W - padR}" y2="${yv(v)}" stroke="#334155" stroke-width="1" stroke-dasharray="3 4"/>`;
      });
    });
    s += `<line x1="${padL}" y1="${y0}" x2="${W - padR}" y2="${y0}" stroke="#64748b" stroke-width="1.2"/>`;

    // label sumbu kanan
    // Label ambang: TEMBOK diberi nama sesuai sisi, sisanya tetap simetris.
    s += `<text x="${W - padR + 7}" y="${yv(R_BAND_WALL) + 3}" fill="#ef4444" font-size="10" font-weight="700">TEMBOK SELLER ${R_BAND_WALL}×</text>`;
    s += `<text x="${W - padR + 7}" y="${yv(-R_BAND_WALL) + 3}" fill="#22c55e" font-size="10" font-weight="700">TEMBOK BUYER ${R_BAND_WALL}×</text>`;
    [[R_BAND_ABSORB, "SERAP", "#fbbf24"], [R_BAND_FREE, "BEBAS", "#22c55e"]].forEach(([v, t, c]) => {
      s += `<text x="${W - padR + 7}" y="${yv(v) + 3}" fill="${c}" font-size="10" font-weight="700">${t} ${v}×</text>`;
      s += `<text x="${W - padR + 7}" y="${yv(-v) + 3}" fill="${c}" font-size="10" font-weight="700">${t} ${v}×</text>`;
    });
    s += `<text x="${padL - 6}" y="${padT + 10}" fill="#f87171" font-size="10" text-anchor="end">+R</text>`;
    s += `<text x="${padL - 6}" y="${padT + 22}" fill="#64748b" font-size="8" text-anchor="end">order SELL</text>`;
    s += `<text x="${padL - 6}" y="${padT + ih - 12}" fill="#4ade80" font-size="10" text-anchor="end">−R</text>`;
    s += `<text x="${padL - 6}" y="${padT + ih}" fill="#64748b" font-size="8" text-anchor="end">order BUY</text>`;

    data.forEach((b, i) => {
      const r = readR(b, base, i > 0 ? data[i - 1] : null);
      const cx = padL + slot * i + slot / 2;
      if (r.ratio == null) {
        s += `<circle cx="${cx.toFixed(1)}" cy="${y0}" r="2" fill="#334155"><title>${fmtBar(b)} | ${esc(r.desc)}</title></circle>`;
        return;
      }
      const signed = effortOf(b) >= 0 ? r.ratio : -r.ratio;
      const capped = Math.max(-peak, Math.min(peak, signed));
      const yTop = Math.min(y0, yv(capped)), hgt = Math.max(1.5, Math.abs(yv(capped) - y0));
      const chg = b.priceChgPct;
      const tip = `${fmtBar(b)} | ${r.code} ${r.ratio.toFixed(2)}× acuan | R=${b.signedR >= 0 ? "+" : ""}${(b.signedR || 0).toFixed(2)}`
        + ` | harga ${chg >= 0 ? "+" : ""}${(chg || 0).toFixed(2)}% | effort ${effortOf(b).toFixed(1)} SOL | ${r.desc}`;
      // BLOK MENYALA: kolom latar setinggi panel di belakang candle bertembok.
      // Terangnya mengikuti besar serapan, jadi serapan kecil vs raksasa
      // langsung kelihatan tanpa membaca angka.
      if (r.code === "TEMBOK") {
        const g = r.glow != null ? r.glow : 0;
        const half = r.side === "seller" ? padT : y0;
        const hh = r.side === "seller" ? y0 - padT : padT + ih - y0;
        // Blok tembok biasa sengaja dibuat samar (0.06-0.13) supaya hanya
        // terbaca sebagai bayangan. Blok RAKSASA jauh lebih pekat.
        const op = r.blaze ? 0.34 : (0.06 + 0.07 * g);
        s += `<rect x="${(cx - slot / 2).toFixed(1)}" y="${half.toFixed(1)}" width="${slot.toFixed(1)}" height="${hh.toFixed(1)}"`
          + ` fill="${r.color}" opacity="${op.toFixed(3)}"/>`;
      }
      // BADAN BATANG: candle RAKSASA dilebarkan supaya bobotnya terasa,
      // tembok biasa tetap selebar candle lain agar tidak ikut menonjol.
      const bwx = r.blaze ? Math.min(slot * 0.95, bw * 1.9) : bw;
      s += `<rect x="${(cx - bwx / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bwx.toFixed(1)}" height="${hgt.toFixed(1)}"`
        + ` rx="${r.blaze ? 2 : 1.5}" fill="${r.color}" opacity="${b.partial ? 0.42 : (r.blaze ? 1 : 0.8)}"><title>${esc(tip)}</title></rect>`;
      // Candle tembok ekstrem diberi garis tepi terang + penanda, supaya
      // "menyala" benar-benar terbaca walau bar-nya tipis.
      if (r.blaze) {
        s += `<rect x="${(cx - bwx / 2 - 1.5).toFixed(1)}" y="${(yTop - 1.5).toFixed(1)}" width="${(bwx + 3).toFixed(1)}" height="${(hgt + 3).toFixed(1)}"`
          + ` rx="2.5" fill="none" stroke="${r.color}" stroke-width="1.6" opacity="1"><title>${esc(tip)}</title></rect>`;
        const my = r.side === "seller" ? padT + 9 : padT + ih - 2;
        s += `<text x="${cx.toFixed(1)}" y="${my}" fill="${r.color}" font-size="9" text-anchor="middle" font-weight="700">▮</text>`;
      }
      // penanda candle yang harganya benar-benar bergerak
      if (Math.abs(chg || 0) >= R_MON_MOVE_PCT) {
        const my = chg > 0 ? padT + 8 : padT + ih + 10;
        s += `<text x="${cx.toFixed(1)}" y="${my}" fill="${chg > 0 ? "#22c55e" : "#ef4444"}" font-size="8" text-anchor="middle">${chg > 0 ? "▲" : "▼"}</text>`;
      }
    });

    s += `<text x="${padL}" y="${H - 16}" fill="#64748b" font-size="9">${esc(fmtBar(data[0]))}</text>`;
    s += `<text x="${W - padR}" y="${H - 16}" fill="#64748b" font-size="9" text-anchor="end">${esc(fmtBar(data[data.length - 1]))}</text>`;
    s += `<text x="${padL}" y="${H - 4}" fill="#475569" font-size="8">tinggi batang = |R| relatif terhadap median klaster · tembok biasa = warna kalem · RAKSASA = warna menyala + batang lebih lebar (hanya candle yang lolos ambang sinyal) · ▲▼ = harga bergerak ≥${R_MON_MOVE_PCT}% · batang pudar = candle berjalan</text>`;

    // ---- tabel candle terakhir ----
    const tail = data.slice(-R_MON_TABLE_BARS);
    const rows = tail.slice().reverse().map(b => {
      const gi = data.indexOf(b);
      const r = readR(b, base, gi > 0 ? data[gi - 1] : null);
      const chg = b.priceChgPct;
      return `<tr>
        <td class="t">${esc(fmtBar(b))}${b.partial ? ' <span class="run">berjalan</span>' : ""}</td>
        <td class="n" style="color:${(chg || 0) > 0 ? "#22c55e" : (chg || 0) < 0 ? "#ef4444" : "#94a3b8"};">${chg == null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</td>
        <td class="n">${b.signedR == null ? "—" : (b.signedR >= 0 ? "+" : "") + b.signedR.toFixed(1)}</td>
        <td class="n">${r.ratio == null ? "—" : r.ratio.toFixed(2) + "×"}</td>
        <td><span class="pill" style="background:${r.color}22;color:${r.textColor || r.color};">${esc(r.label)}</span></td>
        <td class="d">${esc(r.desc)}</td>
      </tr>`;
    }).join("");

    container.innerHTML = head
      + `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#0b1220;border-radius:8px;">${s}</svg>`
      + `<div class="gmgn-rm-base" style="margin:8px 2px 0;">${R_MON_TABLE_BARS} candle terakhir</div>`
      + `<table class="gmgn-rm-tbl"><thead><tr>
           <th>candle</th><th>harga</th><th>R</th><th>rasio</th><th>kondisi</th><th>bacaan</th>
         </tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. CHART LINTASAN (cumCVD ━ vs harga ┄, point warna = R-regime)
  // ══════════════════════════════════════════════════════════════════════════
  function renderTrajectory(bars, container) {
    if (!bars || bars.length < 2) { container.innerHTML = `<div style="color:#94a3b8;padding:12px;font-size:11px;">Butuh ≥2 bar untuk lintasan.</div>`; return; }
    const data = bars.slice(-CHART_BARS);
    const prices = data.map(b => b.high != null ? b.high : null).filter(v => v != null);
    const cvds = data.map(b => b.cumCVD);
    if (!prices.length) { container.innerHTML = `<div style="color:#94a3b8;padding:12px;font-size:11px;">Harga tak tersedia.</div>`; return; }
    const W = 1000, padL = 76, padR = 62, padT = 18, padB = 24;
    const H1 = 220, H2 = 280;
    const iw = W - padL - padR, n = data.length;
    const x = i => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

    // ---- panel 1: harga ┄ + cumCVD ━ ----
    const ih1 = H1 - padT - padB;
    const pMin = Math.min(...prices), pMax = Math.max(...prices), pSpan = (pMax - pMin) || 1;
    const cMin = Math.min(0, ...cvds), cMax = Math.max(0, ...cvds), cSpan = (cMax - cMin) || 1;
    const yP = v => padT + ih1 - ((v - pMin) / pSpan) * ih1;
    const yC = v => padT + ih1 - ((v - cMin) / cSpan) * ih1;
    let s1 = "";
    for (let g = 0; g <= 4; g++) { const y = padT + (ih1 * g) / 4; s1 += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1e293b" stroke-width="1"/>`; }
    let pp = ""; data.forEach((b, i) => { if (b.high == null) return; pp += (pp ? " L" : "M") + x(i).toFixed(1) + " " + yP(b.high).toFixed(1); });
    s1 += `<path d="${pp}" fill="none" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.9"/>`;
    let cp = ""; data.forEach((b, i) => { cp += (cp ? " L" : "M") + x(i).toFixed(1) + " " + yC(b.cumCVD).toFixed(1); });
    s1 += `<path d="${cp}" fill="none" stroke="#60a5fa" stroke-width="2"/>`;
    s1 += `<text x="${padL - 8}" y="${padT + 10}" fill="#fbbf24" font-size="11" text-anchor="end">harga</text>`;
    s1 += `<text x="${W - padR + 8}" y="${padT + 10}" fill="#60a5fa" font-size="11">cumCVD</text>`;
    s1 += `<text x="${padL}" y="${H1 - 6}" fill="#64748b" font-size="10">${fmtBar(data[0])}</text>`;
    s1 += `<text x="${W - padR}" y="${H1 - 6}" fill="#64748b" font-size="10" text-anchor="end">${fmtBar(data[data.length - 1])}</text>`;
    const evByStart = new Map();
    detectEvents(bars).forEach(e => evByStart.set(e.confirm.start, e));
    data.forEach((b, i) => {
      const ev = evByStart.get(b.start);
      if (!ev) return;
      const px = x(i), py = b.high != null ? yP(b.high) : padT + 10;
      const isRes = ev.signal === SIG_RESISTANCE;
      const isSup = ev.signal === SIG_SUPPORT;
      const isRtRes = ev.signal === SIG_RETEST_RES;
      const isRtSup = ev.signal === SIG_RETEST_SUP;
      const col = isRes ? "#ef4444" : isSup ? "#22c55e" : isRtRes ? "#38bdf8" : "#f59e0b";
      const lineTxt = fmtMarketCap(ev.ev && ev.ev.lineMc);
      const ttl = `${ev.signal} ${fmtBar(b)} | garis MC ${lineTxt}`;
      if (isRes || isSup) {
        // Garis level: HIGH untuk resistance, LOW untuk support.
        const yHi = b.high != null ? yP(b.high) : py, yLo = b.low != null ? yP(b.low) : py;
        const yLine = isRes ? yHi : yLo;
        s1 += `<rect x="${px - 5}" y="${Math.min(yHi, yLo)}" width="10" height="${Math.max(2, Math.abs(yLo - yHi))}" fill="${col}" opacity="0.55" rx="1.5"><title>${ttl}</title></rect>`;
        s1 += `<line x1="${padL}" y1="${yLine}" x2="${W - padR}" y2="${yLine}" stroke="${col}" stroke-width="1.6" stroke-dasharray="5 3" opacity="0.85"><title>${ttl}</title></line>`;
      } else {
        // retest = wajik, digambar tepat di garis level yang dikunjungi
        const lp = ev.ev && ev.ev.linePrice;
        const yr = lp != null && lp > 0 ? yP(lp) : py;
        s1 += `<polygon points="${px},${yr - 7} ${px + 6},${yr} ${px},${yr + 7} ${px - 6},${yr}" fill="${col}" stroke="#0b1220" stroke-width="1"><title>${ttl}</title></polygon>`;
      }
    });

    // ---- panel 2: R bertanda (atas=+R, bawah=−R) ----
    const padT2 = 18, ih2 = H2 - padT2 - padB;
    const rSigned = data.map(b => b.signedR).filter(v => v != null);
    const rPeak = Math.max(6, ...(rSigned.length ? rSigned.map(v => Math.min(Math.abs(v), 48)) : [6]));
    const yR = v => {
      const c = Math.max(-rPeak, Math.min(rPeak, v));
      return padT2 + ih2 - ((c + rPeak) / (2 * rPeak)) * ih2;
    };
    let s2 = "";
    s2 += `<rect x="${padL}" y="${padT2}" width="${iw}" height="${yR(0) - padT2}" fill="#ef4444" opacity="0.06"/>`;
    s2 += `<rect x="${padL}" y="${yR(0)}" width="${iw}" height="${(padT2 + ih2) - yR(0)}" fill="#22c55e" opacity="0.06"/>`;
    for (let g = 0; g <= 4; g++) { const y = padT2 + (ih2 * g) / 4; s2 += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1e293b" stroke-width="1"/>`; }
    s2 += `<line x1="${padL}" y1="${yR(0)}" x2="${W - padR}" y2="${yR(0)}" stroke="#64748b" stroke-width="1"/>`;
    s2 += `<line x1="${padL}" y1="${yR(FREE_R)}" x2="${W - padR}" y2="${yR(FREE_R)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>`;
    s2 += `<line x1="${padL}" y1="${yR(-FREE_R)}" x2="${W - padR}" y2="${yR(-FREE_R)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>`;
    s2 += `<text x="${padL - 6}" y="${yR(0) + 3}" fill="#94a3b8" font-size="9" text-anchor="end">0</text>`;
    s2 += `<text x="${padL - 6}" y="${yR(FREE_R) + 3}" fill="#94a3b8" font-size="9" text-anchor="end">bebas</text>`;
    s2 += `<text x="${padL - 6}" y="${yR(-FREE_R) + 3}" fill="#94a3b8" font-size="9" text-anchor="end">bebas</text>`;
    s2 += `<text x="${W - padR + 6}" y="${padT2 + 12}" fill="#94a3b8" font-size="9">×${R_SPIKE_MULT} |R|≥${R_MIN_ABS}</text>`;
    let rp = "", firstR = true;
    data.forEach((b, i) => { if (b.signedR == null) { firstR = true; return; } rp += (firstR ? "M" : " L") + x(i).toFixed(1) + " " + yR(b.signedR).toFixed(1); firstR = false; });
    s2 += `<path d="${rp}" fill="none" stroke="#f59e0b" stroke-width="2.6"/>`;
    data.forEach((b, i) => {
      if (b.signedR == null) return;
      const absR = Math.abs(b.signedR);
      const serapBuy = b.signedR > 0;
      let col, why;
      const prevAbs = (i > 0 && data[i - 1].signedR != null) ? Math.abs(data[i - 1].signedR) : null;
      const spike = prevAbs != null && prevAbs > 1e-9 && absR >= R_SPIKE_MULT * prevAbs && absR >= R_MIN_ABS;
      if (spike) {
        col = serapBuy ? "#ef4444" : "#22c55e";
        why = serapBuy ? "spike +R" : "spike −R";
      } else {
        col = serapBuy ? "#f87171" : "#4ade80";
        why = "normal";
      }
      const rad = spike ? 6.4 : 4.8;
      s2 += `<circle cx="${x(i).toFixed(1)}" cy="${yR(b.signedR).toFixed(1)}" r="${rad}" fill="${col}" stroke="#0b1220" stroke-width="1"><title>${fmtBar(b)} | R=${b.signedR >= 0 ? "+" : ""}${b.signedR.toFixed(2)} | ${why}</title></circle>`;
    });
    s2 += `<text x="${padL}" y="${H2 - 5}" fill="#64748b" font-size="8">sinyal: |R|≥10× prev dan |R|≥10 · harga & cumCVD searah</text>`;

    container.innerHTML =
      `<svg width="100%" viewBox="0 0 ${W} ${H1}" xmlns="http://www.w3.org/2000/svg" style="background:#0b1220;border-radius:8px;">${s1}</svg>` +
      `<svg width="100%" viewBox="0 0 ${W} ${H2}" xmlns="http://www.w3.org/2000/svg" style="background:#0b1220;border-radius:8px;margin-top:4px;">${s2}</svg>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. EXPORT
  // ══════════════════════════════════════════════════════════════════════════
  // Nama file export memakai SIMBOL token, bukan contract address.
  function exportBaseName() {
    const raw = (cachedTokenSymbol || "").replace(/^\$+/, "").trim();
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return safe || "TOKEN";
  }
  function downloadCSV(filename, csv) { const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  // Export SATU file: recap + BARS (harga & R di depan, siap di-chart) + RAW TRADES.
  // SATU export. Ringkas (KB, bukan MB) tapi cukup untuk analisa ulang:
  // bars lengkap + level & retest yang terdeteksi + jejak forensik wick.
  // Raw trades sengaja TIDAK disertakan — itu yang membuat file ~100x lebih
  // besar. Sebagai gantinya tiap bar membawa high/low versi mentah, jumlah
  // trade debu, dan trade terbesar, sehingga anomali wick tetap bisa dilacak.
  function exportAll() {
    const mint = getMintFromUrl(), trades = getSortedTrades();
    if (!trades.length) { alert("Belum ada transaksi. Jalankan Background Fetch."); return; }
    const allBars = buildBars(trades);
    const bars = activeBars(allBars), cls = classify(bars);
    const rBase = rBaseline(bars);
    const scan = scanSignals(bars);
    const L = [];

    L.push("# SMART SEROK — ANALISA PACK v" + EXT_VER);
    L.push("# mint=" + mint);
    L.push("# mc_context_source=" + mcContextSource + " current_mc_usd=" + (cachedMcUsd || "") + " effective_supply=" + (cachedMcPerPrice || ""));
    L.push("# timezone=WIB (Asia/Jakarta, UTC+7) — sama dengan GMGN");
    L.push("# tf=" + activeTf.label + " bars=" + bars.length
      + " | total_clusters=" + (allBars.length ? allBars[allBars.length - 1].cluster + 1 : 0)
      + " | active_cluster=" + (selectedCluster == null ? "latest" : selectedCluster));
    L.push("# r_baseline_median=" + (rBase != null ? rBase.toFixed(4) : ""));
    L.push("# current_signal=" + cls.signal + " conf=" + (cls.conf || 0));
    L.push("#");

    // ── LEVEL & SINYAL yang terdeteksi, lengkap dengan buktinya ──
    L.push("# === LEVEL & SINYAL ===");
    if (!scan.events.length) {
      L.push("#   (belum ada level terbukti)");
    } else {
      for (const e of scan.events) {
        const ev = e.ev || {};
        const mc = ev.lineMc != null ? fmtMarketCap(ev.lineMc) : "—";
        L.push(`#   ${fmtTs(e.confirm.start)} WIB  ${e.signal}  garis_mc=${mc}`);
        for (const ln of (buildNarrative(e) || "").split("\n")) L.push("#     " + ln);
      }
    }
    L.push("#");
    // Status pemantauan retest: kenapa retest belum muncul untuk tiap level.
    if (scan.levels && scan.levels.length) {
      L.push("# === STATUS RETEST ===");
      for (const lv of scan.levels) {
        const line = lv.kind === "resistance" ? lv.highMc : lv.lowMc;
        L.push(`#   ${lv.kind} ${line != null ? fmtMarketCap(line) : "—"} · armed=${lv.armed ? "ya" : "belum"}`);
        L.push("#     " + retestDiagText(lv));
      }
      L.push("#");
    }

    L.push(`# NOTE: LEVEL ENGINE. RESISTANCE/SUPPORT TERBENTUK = candle penyerapan (|R| >=${R_SPIKE_MULT}x bar sebelumnya DAN |R| >=${R_MIN_ABS}) yang TERBUKTI: dalam <=${LVL_CONFIRM_BARS} bar berikutnya R runtuh <=${LVL_R_DROP * 100}%, cumCVD dan harga bergerak >=${LVL_MIN_MOVE_PCT}% ke arah yang benar (harga diukur ke TITIK TERJAUH, bukan bar terakhir). Bukti dinilai MAJU bar per bar: begitu terbukti level tidak bisa dibatalkan penembusan yang datang belakangan; penembusan >${LVL_FAIL_PCT}% SEBELUM terbukti = GAGAL, tidak jadi level. GARIS LEVEL = HIGH candle (resistance) atau LOW candle (support), dalam MARKET CAP. RETEST = harga kembali menyentuh GARIS itu (toleransi ${LVL_LINE_PAD_PCT}%) dengan |R| <${LVL_RETEST_R_MAX}x acuan; retest resistance butuh cumCVD naik, retest support butuh cumCVD turun.`);
    L.push(`# NOTE: R MONITOR. R = |cvd_clean| / |chg_pct|, dinormalisasi ke r_baseline_median. r_state: BEBAS <${R_BAND_FREE}x, NORMAL, SERAP >=${R_BAND_ABSORB}x, TEMBOK_SELLER/TEMBOK_BUYER >=${R_BAND_WALL}x. Akhiran _RAKSASA hanya untuk candle yang lolos ambang sinyal (|R| >=${R_MIN_ABS} DAN lonjakan >=${R_SPIKE_MULT}x bar sebelumnya) sekaligus >=${R_BAND_BLAZE}x acuan; rasio besar tapi |R| kecil TIDAK dihitung raksasa karena tidak akan pernah jadi sinyal. +R = order SELL menahan, -R = order BUY menahan.`);
    L.push(`# NOTE: FORENSIK WICK. high/low hanya dari trade >=${HL_MIN_SOL} SOL. high_raw/low_raw = versi TANPA saringan itu; kalau berbeda jauh berarti ada trade debu di harga ekstrem (lihat dust_tx). Kolom max_trade_sol = trade terbesar di bar itu.`);
    L.push("#");
    L.push("bar_wib,cluster,close,close_mc_usd,low_mc_usd,high_mc_usd,chg_pct,R,r_ratio,r_state,cvd,cvd_clean,cum_cvd,high_raw_mc,low_raw_mc,dust_tx,max_trade_sol,wash_pct,tx,unique_makers,tagged_makers,fresh_wallets,fresh_wallet_pct,fresh_tx,fresh_buy_sol,fresh_sell_sol,buy_sol,sell_sol,vol_sol,partial");

    for (let bi = 0; bi < bars.length; bi++) {
      const b = bars[bi];
      const r = readR(b, rBase, bi > 0 ? bars[bi - 1] : null);
      // high_raw/low_raw hanya dicetak kalau BEDA dari yang dipakai — kalau sama
      // dikosongkan supaya file tidak membengkak oleh angka berulang.
      const hRaw = (b.highRawMc != null && b.highMc != null && Math.abs(b.highRawMc - b.highMc) > b.highMc * 1e-9) ? b.highRawMc.toFixed(2) : "";
      const lRaw = (b.lowRawMc != null && b.lowMc != null && Math.abs(b.lowRawMc - b.lowMc) > b.lowMc * 1e-9) ? b.lowRawMc.toFixed(2) : "";
      L.push([
        wibIso(b.start), b.cluster,
        b.close != null ? b.close.toExponential(4) : "",
        b.closeMc != null ? b.closeMc.toFixed(2) : "",
        b.lowMc != null ? b.lowMc.toFixed(2) : "",
        b.highMc != null ? b.highMc.toFixed(2) : "",
        b.priceChgPct != null ? b.priceChgPct.toFixed(2) : "",
        b.signedR != null ? b.signedR.toFixed(3) : (b.R != null ? b.R.toFixed(3) : ""),
        r.ratio != null ? r.ratio.toFixed(3) : "",
        r.label.replace(/\s*🔥/g, "").trim().replace(/\s+/g, "_") + (r.blaze ? "_RAKSASA" : ""),
        b.cvd.toFixed(2), b.cvdClean.toFixed(2), b.cumCVD.toFixed(1),
        hRaw, lRaw, b.dustTx || "", b.maxTradeSol != null ? b.maxTradeSol.toFixed(3) : "",
        b.washPct.toFixed(1), b.txCount, b.uniqueMakers, b.taggedMakers,
        b.freshWallets, b.freshWalletPct.toFixed(1), b.freshTxCount,
        b.freshBuySol.toFixed(2), b.freshSellSol.toFixed(2),
        b.buySol.toFixed(2), b.sellSol.toFixed(2), b.volSol.toFixed(2),
        b.partial ? 1 : 0
      ].join(","));
    }
    downloadCSV(`${exportBaseName()}.csv`, L.join("\n"));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. UI
  // ══════════════════════════════════════════════════════════════════════════
  function esc(s) { return String(s).replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
  const SIG_META = {
    [SIG_RESISTANCE]:  { color: "#ef4444", label: "🔴 RESISTANCE TERBENTUK", mark: "🔴" },
    [SIG_SUPPORT]:     { color: "#22c55e", label: "🟢 SUPPORT TERBENTUK", mark: "🟢" },
    [SIG_RETEST_RES]:  { color: "#38bdf8", label: "🔵 RETEST RESISTANCE", mark: "🔵" },
    [SIG_RETEST_SUP]:  { color: "#f59e0b", label: "🟠 RETEST SUPPORT", mark: "🟠" },
    NETRAL: { color: "#94a3b8", label: "⚪ NETRAL", mark: "⚪" }
  };
  function updateUI() {
    ensurePageTokenContext();
    syncTimeframe();
    const allTrades = getSortedTrades();
    const allBars = buildBars(allTrades);
    const freshTaggedTotal = new Set(allTrades.filter(t => hasFreshTag(t.tags || [])).map(t => t.maker)).size;
    populateClusterSelect(allBars);
    const bars = activeBars(allBars);
    const cls = classify(bars);
    const countEl = document.getElementById("gmgn-badge-count"), mcBadge = document.getElementById("gmgn-mc-badge"), doneFlag = document.getElementById("gmgn-done-flag"), statusText = document.getElementById("gmgn-status-text");
    if (doneFlag) doneFlag.style.display = bgFetchComplete ? "" : "none";
    if (countEl) { countEl.innerText = `${capturedTrades.size} TX · ${allBars.length} bar · ${freshTaggedTotal} fresh`; countEl.style.color = bgFetchComplete ? "#10b981" : "#94a3b8"; }
    if (mcBadge) {
      mcBadge.innerText = cachedMcPerPrice > 0 ? `MC ${fmtMarketCap(cachedMcUsd)} · ${mcContextSource}` : (holderFetchBusy ? "MC memuat…" : "MC belum tersedia");
      mcBadge.style.color = cachedMcPerPrice > 0 ? "#10b981" : holderFetchBusy ? "#38bdf8" : "#f59e0b";
    }
    if (statusText && !isAutoScrolling && !bgFetchActive && !liveMode) statusText.innerText = captureStats.lastMsg || "IDLE";
    if (liveMode) paintLiveBtn();

    const shEl = document.getElementById("gmgn-sighist");
    if (shEl) {
      const scanAll = scanSignals(bars);
      const evs = scanAll.events.slice().reverse();
      const lvStatus = (scanAll.levels || []).slice().reverse().map(lv => {
        const line = lv.kind === "resistance" ? lv.highMc : lv.lowMc;
        return { kind: lv.kind, line, txt: retestDiagText(lv), armed: !!lv.armed };
      });
      const sig = evs.map(e => eventKey(e) + ":" + e.conf + ":" + (e.grade || "")).join("|")
        + "||" + lvStatus.map(x => x.txt).join("|");
      if (shEl._sig !== sig) {
        shEl._sig = sig;
        const diagHtml = !lvStatus.length ? "" :
          `<div class="gmgn-diag-box"><div class="gmgn-diag-head">Status pemantauan retest</div>` +
          lvStatus.map(x =>
            `<div class="gmgn-diag-row"><span class="gmgn-diag-dot" style="background:${x.kind === "resistance" ? "#ef4444" : "#22c55e"}"></span>` +
            `<div><b>${x.kind === "resistance" ? "Resistance" : "Support"} ${fmtMarketCap(x.line)}</b>` +
            `<span class="gmgn-diag-arm">${x.armed ? "siap" : "menunggu harga menjauh"}</span>` +
            `<div class="gmgn-diag-why">${esc(x.txt)}</div></div></div>`).join("") +
          `</div>`;
        if (!evs.length) {
          shEl.innerHTML = `<div class="gmgn-hist-empty">Belum ada level terbukti. Penyerapan yang gagal tidak ditampilkan.</div>` + diagHtml;
        } else {
          shEl.innerHTML =
            `<div class="gmgn-hist-head"><span>Sinyal & detail</span><span>Metric</span></div>` +
            evs.map(e => {
              const m = SIG_META[e.signal] || {};
              const col = m.color || "#94a3b8";
              const key = eventKey(e);
              const open = openDetailKey === key;
              const mark = m.mark || "⚪";
              const gc = e.gradeColor || "#94a3b8";
              const isLvl = e.signal === SIG_RESISTANCE || e.signal === SIG_SUPPORT;
              const mcTxt = e.ev && e.ev.lineMc != null
                ? `MC ${fmtMarketCap(e.ev.lineMc)}` : "MC —";
              const det = isLvl
                ? `${fmtTs(e.setup.start)} · ${mcTxt} · R ${Math.abs(e.ev.setupR).toFixed(1)} (${e.ev.rMult.toFixed(0)}×)`
                : `${fmtTs(e.setup.start)} · ${mcTxt} · R ${e.ev.rNorm.toFixed(2)}× acuan`;
              return `<div class="gmgn-hist-item${open ? " is-open" : ""}" data-key="${esc(key)}">
                <div class="gmgn-hist-row">
                  <span class="gmgn-hist-sig" style="color:${col};">${mark} ${e.signal}</span>
                  <span class="gmgn-hist-meta">${det}</span>
                  <span class="gmgn-hist-grade" style="color:${gc};" title="${esc((e.gradeLabel || "") + " · " + e.conf)}">${esc(e.grade || "—")}</span>
                </div>
                <div class="gmgn-hist-tip">${esc(buildNarrative(e))}</div>
                <div class="gmgn-hist-detail"${open ? "" : " hidden"}>${esc(buildNarrative(e))}</div>
              </div>`;
            }).join("") + diagHtml;
          shEl.querySelectorAll(".gmgn-hist-item").forEach(item => {
            item.addEventListener("click", () => {
              const key = item.getAttribute("data-key");
              openDetailKey = openDetailKey === key ? null : key;
              const tip = document.getElementById("gmgn-sig-tip");
              if (tip) { tip.classList.remove("is-on"); tip.textContent = ""; }
              shEl._sig = "";
              updateUI();
            });
          });
          const tip = document.getElementById("gmgn-sig-tip");
          const hostEl = document.getElementById("gmgn-effort-widget");
          shEl.querySelectorAll(".gmgn-hist-item").forEach(item => {
            item.addEventListener("mouseenter", () => {
              if (!tip || !hostEl || item.classList.contains("is-open")) return;
              const d = item.querySelector(".gmgn-hist-detail");
              if (!d) return;
              tip.textContent = d.textContent;
              tip.classList.add("is-on");
              const ir = item.getBoundingClientRect();
              const hr = hostEl.getBoundingClientRect();
              let top = ir.bottom - hr.top + 4;
              tip.style.top = top + "px";
              requestAnimationFrame(() => {
                const tr = tip.getBoundingClientRect();
                if (tr.bottom > hr.bottom - 8) tip.style.top = Math.max(8, ir.top - hr.top - tr.height - 4) + "px";
              });
            });
            item.addEventListener("mouseleave", () => {
              if (tip) { tip.classList.remove("is-on"); tip.textContent = ""; }
            });
          });
        }
      }
    }

    // R MONITOR menggantikan chart harga/CVD + riwayat sinyal saat aktif.
    const rmEl = document.getElementById("gmgn-rmonitor");
    const chartEl = document.getElementById("gmgn-chart");
    if (rmEl) {
      rmEl.style.display = rMonitorMode ? "" : "none";
      if (rMonitorMode) renderRMonitor(bars, rmEl);
    }
    if (chartEl) {
      chartEl.style.display = rMonitorMode ? "none" : "";
      if (!rMonitorMode) renderTrajectory(bars, chartEl);
    }
    if (shEl) shEl.style.display = rMonitorMode ? "none" : "";
    const noteEl = document.getElementById("gmgn-note-sinyal");
    if (noteEl) noteEl.style.display = rMonitorMode ? "none" : "";
    const noteRm = document.getElementById("gmgn-note-rmon");
    if (noteRm) noteRm.style.display = rMonitorMode ? "" : "none";

    const dlBtn = document.getElementById("gmgn-btn-dl"); if (dlBtn) dlBtn.disabled = bars.length < 2;
  }

  function paintModeBtn() {
    const btn = document.getElementById("gmgn-btn-mode");
    if (!btn) return;
    btn.textContent = rMonitorMode ? "📊 R MONITOR" : "🔔 MODE SINYAL";
    btn.classList.toggle("is-sig", !rMonitorMode);
    btn.title = rMonitorMode
      ? "Sedang menampilkan R murni. Klik untuk kembali ke mode sinyal."
      : "Sedang menampilkan sinyal. Klik untuk membaca R murni.";
  }

  function injectUI() {
    if (document.getElementById("gmgn-effort-widget")) return;
    const host = document.createElement("div"); host.id = "gmgn-effort-widget";
    host.innerHTML = `
    <style>
      #gmgn-effort-widget { all: initial; position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: min(1080px, calc(100vw - 16px)); display: block; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e2e8f0; line-height: 1.45; }
      #gmgn-effort-widget *, #gmgn-effort-widget *::before, #gmgn-effort-widget *::after { box-sizing: border-box; }
      #gmgn-effort-widget .gmgn-card { position: relative; background: #0f172a; color: #e2e8f0; border: 1px solid #1e293b; border-radius: 14px; box-shadow: 0 12px 44px rgba(0,0,0,.55); overflow: hidden; }
      #gmgn-effort-widget .gmgn-hdr { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #1e293b; cursor: move; user-select: none; flex-wrap: nowrap; }
      #gmgn-effort-widget .gmgn-hdr .t { font-weight: 800; font-size: 16px; color: #fbbf24; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-badge { margin-left: auto; font-size: 13px; color: #94a3b8; background: #0f172a; padding: 5px 10px; border-radius: 8px; white-space: nowrap; flex-shrink: 0; }
      #gmgn-effort-widget .gmgn-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; height: min(90vh, 920px); overflow-y: auto; overflow-x: hidden; }
      #gmgn-effort-widget .gmgn-toolbar { display: flex; flex-direction: column; gap: 8px; }
      #gmgn-effort-widget .gmgn-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      #gmgn-effort-widget .gmgn-btn-main { cursor: pointer; border: none; border-radius: 8px; padding: 9px 12px; font-weight: 700; font-size: 13px; white-space: nowrap; line-height: 1.2; font-family: inherit; }
      #gmgn-effort-widget .gmgn-btn-start { background: #10b981; color: #06251c; }
      #gmgn-effort-widget .gmgn-btn-stop { background: #ef4444; color: #fff; }
      #gmgn-effort-widget .gmgn-btn-dl { background: #334155; color: #e2e8f0; }
      #gmgn-effort-widget .gmgn-btn-dl:disabled { opacity: .4; cursor: not-allowed; }
      #gmgn-effort-widget .gmgn-inp { background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; line-height: 1.2; max-width: 100%; }
      #gmgn-effort-widget .gmgn-tbl { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
      #gmgn-effort-widget .gmgn-tbl th { background: #1e293b; color: #94a3b8; text-align: left; padding: 8px 8px; font-weight: 600; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-tbl td { padding: 7px 8px; border-top: 1px solid #1e293b; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; }
      #gmgn-effort-widget .gmgn-tbl th:nth-child(1), #gmgn-effort-widget .gmgn-tbl td:nth-child(1) { width: 28%; }
      #gmgn-effort-widget .gmgn-note { font-size: 12px; color: #94a3b8; line-height: 1.55; }
      #gmgn-effort-widget .gmgn-muted { color: #94a3b8; }
      #gmgn-effort-widget .gmgn-nar { display: none; }
      #gmgn-effort-widget #gmgn-phase { display: none; }
      #gmgn-effort-widget #gmgn-tf-badge { font-size: 12px; font-weight: 700; color: #fbbf24; background: #0f172a; border: 1px solid #334155; padding: 4px 8px; border-radius: 7px; white-space: nowrap; }
      #gmgn-effort-widget #gmgn-sighist { background: #0b1220; border: 1px solid #1e293b; border-radius: 10px; padding: 8px 10px 10px; color: #94a3b8; max-height: min(48vh, 520px); min-height: 180px; overflow-y: auto; overflow-x: hidden; }
      #gmgn-effort-widget .gmgn-hist-empty { padding: 14px 8px; font-size: 14px; color: #64748b; }
      #gmgn-effort-widget .gmgn-diag-box { margin-top: 8px; border-top: 1px solid #1e293b; padding-top: 8px; }
      #gmgn-effort-widget .gmgn-diag-head { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
      #gmgn-effort-widget .gmgn-diag-row { display: flex; gap: 7px; align-items: flex-start; padding: 5px 0; font-size: 12px; color: #cbd5e1; }
      #gmgn-effort-widget .gmgn-diag-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; }
      #gmgn-effort-widget .gmgn-diag-arm { margin-left: 6px; font-size: 10px; color: #64748b; }
      #gmgn-effort-widget .gmgn-diag-why { color: #94a3b8; font-size: 11px; margin-top: 2px; line-height: 1.45; }
      #gmgn-effort-widget .gmgn-hist-head { display: grid; grid-template-columns: minmax(0, 1fr) 64px; gap: 10px; align-items: center; }
      #gmgn-effort-widget .gmgn-hist-row { display: grid; grid-template-columns: minmax(0, 1fr) 64px; grid-template-areas: "sig grade" "meta meta"; gap: 3px 10px; align-items: start; }
      #gmgn-effort-widget .gmgn-hist-grade { grid-area: grade; font-size: 18px; font-weight: 900; letter-spacing: 0.02em; white-space: nowrap; text-align: right; }
      #gmgn-effort-widget .gmgn-hist-meta { grid-area: meta; font-size: 13px; color: #cbd5e1; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; word-break: break-word; font-variant-numeric: tabular-nums; }
      #gmgn-effort-widget .gmgn-hist-item { cursor: pointer; }
      #gmgn-effort-widget .gmgn-btn-live-on { background: #065f46; color: #d1fae5; }
      #gmgn-effort-widget .gmgn-hist-head { font-size: 12px; font-weight: 700; color: #64748b; padding: 6px 8px 8px; border-bottom: 1px solid #1e293b; letter-spacing: .02em; }
      #gmgn-effort-widget .gmgn-hist-item { position: relative; padding: 8px; border-bottom: 1px solid #1e293b; }
      #gmgn-effort-widget .gmgn-hist-item:last-child { border-bottom: none; }
      #gmgn-effort-widget .gmgn-hist-jam { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; color: #cbd5e1; }
      #gmgn-effort-widget .gmgn-hist-sig { grid-area: sig; font-size: 15px; font-weight: 800; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; word-break: break-word; }
      #gmgn-effort-widget .gmgn-hist-conf { font-size: 14px; font-variant-numeric: tabular-nums; color: #94a3b8; text-align: right; }
      #gmgn-effort-widget .gmgn-btn-detail { cursor: pointer; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; border-radius: 7px; padding: 6px 8px; font-size: 12px; font-weight: 700; font-family: inherit; line-height: 1; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-btn-detail:hover { background: #334155; }
      #gmgn-effort-widget .gmgn-hist-detail { margin-top: 8px; padding: 10px 12px; background: #111827; border: 1px solid #334155; border-radius: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #cbd5e1; }
      #gmgn-effort-widget .gmgn-hist-tip { display: none; }
      #gmgn-effort-widget #gmgn-sig-tip { display: none; position: absolute; left: 14px; right: 14px; z-index: 20; background: #111827; border: 1px solid #475569; border-radius: 10px; padding: 10px 12px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; box-shadow: 0 10px 28px rgba(0,0,0,.5); pointer-events: none; }
      #gmgn-effort-widget #gmgn-sig-tip.is-on { display: block; }
      #gmgn-effort-widget #gmgn-chart { display: block; }
      #gmgn-effort-widget #gmgn-chart svg { display: block; width: 100%; height: auto; }
      #gmgn-effort-widget #gmgn-rmonitor svg { display: block; width: 100%; height: auto; }
      #gmgn-effort-widget .gmgn-rm-empty { padding: 18px 10px; color: #64748b; font-size: 13px; }
      #gmgn-effort-widget .gmgn-rm-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 9px 10px; margin-bottom: 6px; background: #0f172a; border: 1px solid #1e293b; border-radius: 9px; }
      #gmgn-effort-widget .gmgn-rm-tag { font-size: 12px; font-weight: 800; padding: 3px 9px; border-radius: 6px; border: 1px solid; white-space: nowrap; letter-spacing: .02em; }
      #gmgn-effort-widget .gmgn-rm-sum { font-size: 13px; color: #cbd5e1; flex: 1 1 260px; line-height: 1.45; }
      #gmgn-effort-widget .gmgn-rm-base { font-size: 11px; color: #64748b; font-variant-numeric: tabular-nums; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-rm-tbl { width: 100%; border-collapse: collapse; margin-top: 7px; font-size: 12px; font-variant-numeric: tabular-nums; }
      #gmgn-effort-widget .gmgn-rm-tbl th { text-align: left; color: #64748b; font-weight: 700; font-size: 11px; padding: 5px 7px; border-bottom: 1px solid #1e293b; }
      #gmgn-effort-widget .gmgn-rm-tbl td { padding: 5px 7px; border-bottom: 1px solid #131f36; color: #cbd5e1; }
      #gmgn-effort-widget .gmgn-rm-tbl td.n { text-align: right; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-rm-tbl td.t { white-space: nowrap; color: #94a3b8; }
      #gmgn-effort-widget .gmgn-rm-tbl td.d { color: #94a3b8; font-size: 11.5px; }
      #gmgn-effort-widget .gmgn-rm-tbl .run { color: #38bdf8; font-size: 10px; }
      #gmgn-effort-widget .gmgn-rm-tbl .pill { font-size: 11px; font-weight: 800; padding: 2px 7px; border-radius: 5px; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-btn-mode { background: #1d4ed8; color: #dbeafe; }
      #gmgn-effort-widget .gmgn-btn-mode.is-sig { background: #334155; color: #e2e8f0; }
      #gmgn-effort-widget #gmgn-status-text { display: block; min-height: 1.2em; }
      #gmgn-effort-widget #gmgn-btn-min { flex-shrink: 0; padding: 4px 10px; font-size: 14px; }
      #gmgn-effort-widget #gmgn-done-flag { font-size: 13px; font-weight: 700; color: #10b981; white-space: nowrap; }
    </style>
    <div class="gmgn-card">
      <div class="gmgn-hdr">
        <span class="t">🥄 SMART SEROK v9.2.13</span>
        <span id="gmgn-tf-badge">1H · LEVEL ENGINE</span>
        <span id="gmgn-done-flag" style="display:none;">✅ DONE</span>
        <span class="gmgn-badge" id="gmgn-mc-badge">MC memuat…</span>
        <span class="gmgn-badge" id="gmgn-badge-count">0 TX</span>
        <button class="gmgn-btn-dl gmgn-btn-main" id="gmgn-btn-min" title="Minimalkan">—</button>
      </div>
      <div class="gmgn-body" id="gmgn-body">
        <div class="gmgn-toolbar">
          <div class="gmgn-row">
            <button class="gmgn-btn-main gmgn-btn-start" id="gmgn-btn-bgfetch"><span>🌐 Background Fetch</span></button>
            <button class="gmgn-btn-main gmgn-btn-dl" id="gmgn-btn-live" title="Fetch otomatis 48 jam terakhir, tiap 15 menit"><span>📡 LIVE</span></button>
            <button class="gmgn-btn-main gmgn-btn-start" id="gmgn-btn-scroll"><span>⚡ Auto-Scroll</span></button>
            <button class="gmgn-btn-main gmgn-btn-dl" id="gmgn-btn-dl" disabled title="Export CSV ringkas: bars + level/sinyal + jejak forensik wick (tanpa raw trades)">⬇ Export CSV</button>
            <button class="gmgn-btn-main gmgn-btn-mode" id="gmgn-btn-mode" title="Ganti antara R MONITOR (baca R murni) dan mode sinyal">📊 R MONITOR</button>
            <button class="gmgn-btn-main gmgn-btn-dl" id="gmgn-btn-reset">🧹 Reset</button>
          </div>
          <div class="gmgn-row">
            <select id="gmgn-cluster" class="gmgn-inp" title="Pilih klaster aktivitas untuk chart & analisa"><option value="">latest (auto)</option></select>
            <select id="gmgn-cooldown" class="gmgn-inp">
              <option value="500">500ms</option><option value="800" selected>800ms</option><option value="1200">1.2s</option><option value="2000">2s</option>
            </select>
            <span class="gmgn-note" id="gmgn-status-text">IDLE</span>
          </div>
        </div>
        <div id="gmgn-phase"></div>
        <div id="gmgn-narrative" class="gmgn-nar"></div>
        <div id="gmgn-rmonitor"></div>
        <div id="gmgn-chart"></div>
        <div id="gmgn-sighist"></div>
        <div id="gmgn-sig-tip"></div>
        <div class="gmgn-note" id="gmgn-note-rmon">
          📊 R MONITOR — hanya membaca R, tanpa sinyal dan tanpa kesimpulan otomatis. R = effort (CVD bersih) ÷ result (% harga), dinormalisasi ke median |R| klaster aktif agar bisa dibandingkan antar token.
          🟢 BEBAS (&lt;${R_BAND_FREE}×) = harga bergerak nyaris tanpa perlawanan → jalan bersih.
          🟡 SERAP (≥${R_BAND_ABSORB}×) = perlawanan mulai muncul.
          🔴 TEMBOK SELLER (≥${R_BAND_WALL}× di ATAS garis) = order SELL menahan kuat, harga sulit naik.
          🟢 TEMBOK BUYER (≥${R_BAND_WALL}× di BAWAH garis) = order BUY menahan kuat, harga sulit turun.
          Tembok dibedakan jadi DUA KELAS yang sengaja dibuat berjarak jauh.
          <b>TEMBOK BIASA</b> — warna merah bata / hijau lumut yang kalem, batang selebar candle lain, blok latar samar. Ini cuma catatan "ada perlawanan di sini", bukan peringatan.
          <b>RAKSASA 🔥</b> — merah / hijau MENYALA, batang hampir 2× lebih lebar, blok latar pekat, plus garis tepi dan penanda ▮. Status ini TIDAK bisa diraih hanya dengan rasio besar: candle wajib lolos ambang sinyal lebih dulu — |R| ≥ ${R_MIN_ABS} DAN melonjak ≥ ${R_SPIKE_MULT}× bar sebelumnya — baru boleh menyala di ≥ ${R_BAND_BLAZE}× acuan.
          Sebabnya, candle ber-rasio tinggi tapi |R| kecil tidak akan pernah melahirkan sinyal. Kalau ia ikut menyala, yang paling mencolok di layar justru yang tidak perlu ditindaklanjuti.
          Batang ke ATAS = net BELI masuk tapi harga tertahan → SELLER yang menyerap (tekanan jual pasif di atas). Batang ke BAWAH = net JUAL keluar tapi harga tertahan → BUYER yang menyerap (tekanan beli pasif di bawah). Bar dengan effort &lt;${R_MON_MIN_EFFORT} SOL ditandai SEPI karena R-nya artefak pembagian. Konfirmasi dilakukan manual.
        </div>
        <div class="gmgn-note" id="gmgn-note-sinyal">
          🔴 RESISTANCE / 🟢 SUPPORT TERBENTUK: candle penyerapan (|R| ≥${R_SPIKE_MULT}× bar sebelumnya DAN |R| ≥${R_MIN_ABS}) yang TERBUKTI — dalam ≤${LVL_CONFIRM_BARS} bar berikutnya R runtuh ≤${LVL_R_DROP * 100}%, cumCVD dan harga bergerak ≥${LVL_MIN_MOVE_PCT}% ke arah yang benar. Harga diukur ke TITIK TERJAUH yang dicapai, bukan ke bar terakhir — level tetap sah walau harga memantul balik setelahnya.
          GARIS LEVEL = HIGH candle (resistance) atau LOW candle (support), dinyatakan dalam MARKET CAP. HIGH/LOW hanya dihitung dari trade ≥${HL_MIN_SOL} SOL supaya trade debu tidak menggeser garis.
          Penyerapan yang harganya justru menembus level &gt;${LVL_FAIL_PCT}% dianggap GAGAL: tidak jadi level dan tidak ditampilkan.
          🔵 RETEST RESISTANCE / 🟠 RETEST SUPPORT: harga balik menyentuh GARIS itu (toleransi ${LVL_LINE_PAD_PCT}%) tetapi |R| hanya &lt;${LVL_RETEST_R_MAX}× acuan — penjaga level tidak hadir lagi. Retest resistance butuh cumCVD naik (kemungkinan tembus ke atas); retest support butuh cumCVD turun (kemungkinan jebol ke bawah).
        </div>
      </div>
    </div>`;
    document.body.appendChild(host);
    document.getElementById("gmgn-btn-bgfetch").addEventListener("click", () => { bgFetchComplete = false; bgFetchActive ? stopBackgroundFetch() : backgroundFetch(); });
    document.getElementById("gmgn-btn-live").addEventListener("click", toggleLive);
    document.getElementById("gmgn-btn-mode").addEventListener("click", () => {
      rMonitorMode = !rMonitorMode;
      paintModeBtn();
      const sh = document.getElementById("gmgn-sighist");
      if (sh) sh._sig = "";   // paksa riwayat sinyal render ulang saat kembali
      updateUI();
    });
    paintModeBtn();
    document.getElementById("gmgn-btn-scroll").addEventListener("click", () => { isAutoScrolling ? stopAutoScroll(false) : startAutoScroll(); });
    document.getElementById("gmgn-btn-reset").addEventListener("click", () => { capturedTrades.clear(); walletTagRegistry.clear(); detectedFromTs = null; detectedToTs = null; selectedCluster = null; cachedMcUsd = 0; cachedSupply = 0; cachedPriceUsd = 0; cachedMcPerPrice = 0; cachedHolderSupply = 0; cachedTokenSymbol = ""; mcContextSource = "none"; holderFetchMint = null; holderFetchLastAt = 0; Object.assign(captureStats, { requests: 0, seen: 0, recorded: 0, dup: 0, outOfRange: 0, noMaker: 0, badEvent: 0, badTs: 0, lastMsg: "Direset manual", lastTs: Date.now() }); updateUI(); });
    document.getElementById("gmgn-cluster").addEventListener("change", (e) => { selectedCluster = e.target.value === "" ? null : parseInt(e.target.value); updateUI(); });
    document.getElementById("gmgn-btn-dl").addEventListener("click", exportAll);
    document.getElementById("gmgn-btn-min").addEventListener("click", () => { const body = document.getElementById("gmgn-body"), btn = document.getElementById("gmgn-btn-min"); if (body.style.display === "none") { body.style.display = "flex"; btn.innerText = "—"; } else { body.style.display = "none"; btn.innerText = "+"; } });
    // drag-to-move via header (tombol di header tetap bisa diklik)
    const hdr = host.querySelector(".gmgn-hdr");
    let dragging = false, sx = 0, sy = 0, sLeft = 0, sTop = 0;
    hdr.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const r = host.getBoundingClientRect();
      host.style.left = r.left + "px"; host.style.top = r.top + "px"; host.style.right = "auto"; host.style.bottom = "auto";
      sx = e.clientX; sy = e.clientY; sLeft = r.left; sTop = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => { if (!dragging) return; host.style.left = (sLeft + e.clientX - sx) + "px"; host.style.top = (sTop + e.clientY - sy) + "px"; });
    document.addEventListener("mouseup", () => { dragging = false; });
    updateUI();
    setTimeout(() => refreshHolderContext(true), 1200);
    setInterval(updateUI, 3000);
  }
  function boot() { if (document.body) injectUI(); else document.addEventListener("DOMContentLoaded", injectUI); }
  boot();
})();
