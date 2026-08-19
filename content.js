/**
 * SMART SEROK — v9.1.3
 * --------------------------------------------------------------
 * Sinyal:
 *   🔴 WASPADA DUMP / 🟢 SIAP2 PUMP — |R|≥10× prev + |R|≥10 + harga/cumCVD searah
 *   ⚔️ BATTLE TERJADI — hanya setelah setup di atas; buy/sell hampir seimbang
 *                       (gap ≤2,5%) + TX, wallet unik, dan wallet bertag
 *                       fresh_wallet minimal P65 periode aktif.
 *                       Range battle = low–high MARKET CAP candle battle.
 * Tidak ada logika AKTIVASI atau konfirmasi otomatis.
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
  let mcContextSource = "none", holderFetchBusy = false, holderFetchMint = null, holderFetchLastAt = 0;
  let selectedCluster = null;   // null = latest (auto); atau index klaster yg dipilih user
  const captureStats = { requests: 0, seen: 0, recorded: 0, dup: 0, outOfRange: 0,
    noMaker: 0, badEvent: 0, badTs: 0, lastMsg: "IDLE", lastTs: 0 };

  // ── Engine constants ─────────────────────────────────────────────────────
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
  const R_MIN_ABS = 10;                 // lantai |R| — buang spike 0.01→1
  const MIN_SPIKE_CVD = 8;              // SOL — buang R tinggi karena Δharga ~0 + effort kecil
  const BATTLE_MAX_GAP_PCT = 2.5;       // |buy-sell| / (buy+sell) — hampir seimbang
  const BATTLE_ACTIVITY_PCTL = 0.65;    // TX, wallet unik, dan fresh_wallet minimal P65
  const BATTLE_MIN_BARS = 8;            // minimum bar selesai agar ambang aktivitas cukup stabil
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
  function fmtTs(tsSec) { const p = tzParts(tsSec); return `${p.m}-${p.d} ${p.h}:00`; }
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
    if (badge) badge.textContent = `${activeTf.label} · R×${R_SPIKE_MULT} · |R|≥${R_MIN_ABS}`;
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
      const open = priced.length ? priced[0].price : null;
      const close = priced.length ? priced[priced.length - 1].price : null;
      const high = priced.length ? Math.max(...priced.map(p => p.price)) : null;
      const low = priced.length ? Math.min(...priced.map(p => p.price)) : null;
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
      opts.push(`<option value="${k}">cluster ${k} (${p.m}-${p.d}, ${c.length} bar${latest ? " *" : ""})</option>`);
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
  function battleThresholds(bars) {
    const done = (bars || []).filter(b => !b.partial && (b.volSol || 0) > 0);
    if (done.length < BATTLE_MIN_BARS) return null;
    return {
      tx: percentile(done.map(b => b.txCount || 0), BATTLE_ACTIVITY_PCTL),
      makers: percentile(done.map(b => b.uniqueMakers || 0), BATTLE_ACTIVITY_PCTL),
      fresh: percentile(done.map(b => b.freshWallets || 0), BATTLE_ACTIVITY_PCTL),
      freshTagsSeen: done.some(b => (b.freshWallets || 0) > 0),
      samples: done.length
    };
  }
  function battleStats(b, thresholds) {
    if (!b || !thresholds || b.partial || !(b.volSol > 0)) return null;
    const gapPct = Math.abs((b.buySol || 0) - (b.sellSol || 0)) / b.volSol * 100;
    const txFloor = Math.max(activeTf.minTx || 0, thresholds.tx || 0);
    const makersFloor = thresholds.makers || 0;
    const freshFloor = Math.max(1, thresholds.fresh || 0);
    if (!thresholds.freshTagsSeen || gapPct > BATTLE_MAX_GAP_PCT ||
        (b.txCount || 0) < txFloor || (b.uniqueMakers || 0) < makersFloor ||
        (b.freshWallets || 0) < freshFloor) return null;
    return { gapPct, txFloor, makersFloor, freshFloor, samples: thresholds.samples };
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
  function serapTag(b) {
    if (!b || b.signedR == null) return null;
    const chg = Math.abs(b.priceChgPct || 0);
    const effort = Math.abs(b.cvdClean != null ? b.cvdClean : (b.cvd || 0));
    if (chg <= 3 && effort >= 4) {
      return b.signedR > 0
        ? "penyerapan BUY (seller makan beli)"
        : "penyerapan SELL (buyer makan jual)";
    }
    return null;
  }

  function makeEvent(kind, b, i, prev, rMult, bars) {
    const g = gradeFromScore(Math.max(20, Math.min(99, Math.round(36 + Math.min(50, rMult)))));
    return {
      signal: kind,
      side: kind === "SIAP2 PUMP" ? "bottom" : "top",
      conf: Math.min(99, Math.round(rMult)),
      grade: "×" + (rMult >= 100 ? rMult.toFixed(0) : rMult.toFixed(1)),
      gradeLabel: rMult.toFixed(1) + "× R bar sebelumnya",
      gradeColor: kind === "SIAP2 PUMP" ? "#22c55e" : "#ef4444",
      gradeParts: [],
      setup: b, confirm: b, setupIdx: i, confirmIdx: i, spike: true,
      ev: {
        setupR: b.signedR != null ? b.signedR : b.R,
        confirmR: b.R,
        setupChg: b.priceChgPct, confirmChg: b.priceChgPct,
        setupCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        confirmCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        trend: priceTrendPct(bars, i, TREND_BARS),
        dropPct: 0,
        gap: 0,
        rMult: rMult,
        prevR: rAbsOf(prev),
        serap: serapTag(b)
      }
    };
  }

  function makeBattleEvent(b, i, stats, bars, trigger) {
    const balanceQuality = Math.max(0, 1 - stats.gapPct / BATTLE_MAX_GAP_PCT);
    const txRatio = stats.txFloor > 0 ? (b.txCount || 0) / stats.txFloor : 1;
    const makerRatio = stats.makersFloor > 0 ? (b.uniqueMakers || 0) / stats.makersFloor : 1;
    const freshRatio = stats.freshFloor > 0 ? (b.freshWallets || 0) / stats.freshFloor : 1;
    const activityBoost = Math.min(1, (txRatio + makerRatio + freshRatio - 3) / 3);
    const score = Math.max(20, Math.min(99, Math.round(50 + balanceQuality * 30 + activityBoost * 19)));
    const g = gradeFromScore(score);
    return {
      signal: "BATTLE TERJADI",
      side: (b.priceChgPct || 0) < 0 ? "bottom" : "top",
      conf: score,
      grade: stats.gapPct.toFixed(2) + "%",
      gradeLabel: `gap buy/sell ${stats.gapPct.toFixed(2)}% · ${g.grade} ${g.label}`,
      gradeColor: "#fbbf24",
      gradeParts: [],
      setup: b, confirm: b, setupIdx: i, confirmIdx: i, spike: false,
      ev: {
        setupR: b.signedR != null ? b.signedR : b.R,
        confirmR: b.R,
        setupChg: b.priceChgPct,
        confirmChg: b.priceChgPct,
        setupCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        confirmCvd: b.cvdClean != null ? b.cvdClean : b.cvd,
        trend: priceTrendPct(bars, i, TREND_BARS),
        dropPct: 0,
        gap: i - trigger.confirmIdx,
        rMult: null,
        prevR: null,
        serap: serapTag(b),
        balanceGapPct: stats.gapPct,
        txFloor: stats.txFloor,
        makersFloor: stats.makersFloor,
        freshFloor: stats.freshFloor,
        activitySamples: stats.samples,
        rangeLowMc: b.lowMc,
        rangeHighMc: b.highMc,
        triggerSignal: trigger.signal,
        triggerStart: trigger.confirm.start
      }
    };
  }

  function scanSignals(bars) {
    const evs = [];
    const thresholds = battleThresholds(bars);
    let latestSetup = null;
    if (!bars || !bars.length) return { events: evs, pending: null, battleThresholds: thresholds };
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], prev = i > 0 ? bars[i - 1] : null;
      const priorSetup = latestSetup;

      // Logika setup lama tetap sama: spike R + arah harga/cumCVD.
      if (prev && b.priceChgPct != null && b.cumCVD != null && prev.cumCVD != null) {
        const rMult = rSpikeMult(prev, b);
        if (rMult != null && rMult >= R_SPIKE_MULT && rAbsOf(b) >= R_MIN_ABS) {
          let setupEvent = null;
          if (b.priceChgPct > 0 && b.cumCVD > prev.cumCVD) {
            setupEvent = makeEvent("WASPADA DUMP", b, i, prev, rMult, bars);
          } else if (b.priceChgPct < 0 && b.cumCVD < prev.cumCVD) {
            setupEvent = makeEvent("SIAP2 PUMP", b, i, prev, rMult, bars);
          }
          if (setupEvent) { evs.push(setupEvent); latestSetup = setupEvent; }
        }
      }

      // BATTLE hanya boleh muncul jika pada bar SEBELUMNYA sudah ada
      // WASPADA DUMP atau SIAP2 PUMP di klaster aktif. Bar battle wajib selesai.
      const stats = battleStats(b, thresholds);
      if (stats && priorSetup && priorSetup.confirmIdx < i) {
        evs.push(makeBattleEvent(b, i, stats, bars, priorSetup));
      }
    }
    return { events: evs, pending: null, battleThresholds: thresholds };
  }

  function detectEvents(bars) { return scanSignals(bars).events; }

  function detectPending() { return null; }

  function classify(bars) {
    const cb = latestCluster(bars);
    if (!cb.length) return { signal: "NETRAL", phase: "NETRAL", conf: 0, reason: "butuh data bar. Token sepi atau fetch lebih banyak.", bars: cb };
    const scan = scanSignals(cb);
    const evs = scan.events;
    if (!evs.length) {
      const reason = cb.length < BATTLE_MIN_BARS
        ? `NETRAL — battle butuh ≥${BATTLE_MIN_BARS} bar selesai; klaster terakhir ${cb.length} bar.`
        : "NETRAL — belum ada WASPADA DUMP / SIAP2 PUMP / BATTLE TERJADI.";
      return { signal: "NETRAL", phase: "NETRAL", conf: 0, reason, last: cb[cb.length - 1], bars: cb, pending: null, events: evs };
    }
    const c = evs[evs.length - 1];
    c.phase = c.signal;
    c.last = c.confirm;
    c.bars = cb;
    c.events = evs;
    c.pending = null;
    c.reason = buildNarrative(c);
    return c;
  }

  function signalHistory(bars) {
    const cb = latestCluster(bars);
    return detectEvents(cb).map(e => ({
      t: e.confirm.start, signal: e.signal, side: e.side, conf: e.conf || 0, grade: e.grade || "", setupT: e.setup.start
    }));
  }

  function buildNarrative(c) {
    const e = c.ev, s = c.setup;
    const lines = [];
    if (c.signal === "BATTLE TERJADI") {
      lines.push(`⚔️ BATTLE TERJADI — BUY/SELL hampir seimbang; TX, wallet unik, dan fresh_wallet memenuhi ambang aktivitas P65.`);
      lines.push(`pemicu sebelumnya: ${e.triggerSignal} ${fmtTs(e.triggerStart)} WIB · jarak ${e.gap} bar`);
      lines.push(`[BATTLE] ${fmtBar(s)}: BUY ${(s.buySol || 0).toFixed(2)} vs SELL ${(s.sellSol || 0).toFixed(2)} SOL · gap ${e.balanceGapPct.toFixed(2)}%`);
      lines.push(`RANGE BATTLE MC: ${fmtMarketCap(e.rangeLowMc)} — ${fmtMarketCap(e.rangeHighMc)}`);
      lines.push(`aktivitas: ${s.txCount} TX (batas ≥${Math.ceil(e.txFloor)}) · ${s.uniqueMakers} wallet unik (batas ≥${Math.ceil(e.makersFloor)})`);
      lines.push(`fresh_wallet: ${s.freshWallets} unik / ${s.freshWalletPct.toFixed(1)}% (batas ≥${Math.ceil(e.freshFloor)}) · tagged ${s.taggedMakers}/${s.uniqueMakers}`);
      lines.push(`harga candle: ${e.setupChg >= 0 ? "+" : ""}${e.setupChg.toFixed(2)}% · wash ${(s.washPct || 0).toFixed(1)}% · acuan ${e.activitySamples} bar selesai`);
      return lines.join("\n");
    }

    if (c.signal === "WASPADA DUMP") lines.push("🔴 WASPADA DUMP — harga naik + cumCVD naik + R ≥10× sebelumnya + |R|≥10");
    else lines.push("🟢 SIAP2 PUMP — harga turun + cumCVD turun + R ≥10× sebelumnya + |R|≥10");
    if (e.rMult != null) lines.push(`R setup ${e.prevR != null ? e.prevR.toFixed(2) : "—"} → ${Math.abs(e.setupR).toFixed(2)}  (${e.rMult.toFixed(1)}×)`);
    const sR = e.setupR;
    lines.push(`[SETUP] ${fmtBar(s)}: harga ${e.setupChg >= 0 ? "+" : ""}${e.setupChg.toFixed(2)}% · R=${sR >= 0 ? "+" : ""}${Number(sR).toFixed(2)} · CVD ${e.setupCvd >= 0 ? "+" : ""}${Number(e.setupCvd).toFixed(1)} SOL`);
    if (e.serap) lines.push("penyerapan: " + e.serap);
    return lines.join("\n");
  }

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
      const dump = ev.signal === "WASPADA DUMP";
      const battle = ev.signal === "BATTLE TERJADI";
      const col = battle ? "#fbbf24" : dump ? "#ef4444" : "#22c55e";
      if (battle) {
        const lo = fmtMarketCap(ev.ev && ev.ev.rangeLowMc);
        const hi = fmtMarketCap(ev.ev && ev.ev.rangeHighMc);
        s1 += `<polygon points="${px},${py - 8} ${px + 7},${py} ${px},${py + 8} ${px - 7},${py}" fill="${col}" stroke="#fde68a" stroke-width="1.3"><title>${ev.signal} ${fmtBar(b)} | range MC ${lo} — ${hi}</title></polygon>`;
      } else {
        const tip = dump
          ? `${px},${py + 8} ${px - 6},${py - 3} ${px + 6},${py - 3}`
          : `${px},${py - 8} ${px - 6},${py + 3} ${px + 6},${py + 3}`;
        s1 += `<polygon points="${tip}" fill="${col}"><title>${ev.signal} ${fmtBar(b)}</title></polygon>`;
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
  function downloadCSV(filename, csv) { const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  // Export SATU file: recap + BARS (harga & R di depan, siap di-chart) + RAW TRADES.
  function exportAll() {
    const mint = getMintFromUrl(), trades = getSortedTrades();
    if (!trades.length) { alert("Belum ada transaksi. Jalankan Background Fetch."); return; }
    const bars = buildBars(trades), cls = classify(bars), lc = latestCluster(bars);
    const recap = [
      "# === SMART SEROK — LINTASAN CVD ===",
      `# Mint: ${mint}`,
      `# MC context: source=${mcContextSource} current_usd=${cachedMcUsd || ""} effective_supply=${cachedMcPerPrice || ""}`,
      `# Bar: ${bars.length} (${activeTf.label}) | R×${R_SPIKE_MULT} |R|≥${R_MIN_ABS} | klaster: ${bars.length ? bars[bars.length - 1].cluster + 1 : 0} | klaster terakhir: ${lc.length} bar`,
      `# Sinyal: ${cls.signal}${cls.phase ? " (" + cls.phase + ")" : ""} | conf ${cls.conf || 0}`,
      ...((cls.reason || "").split("\n").map(l => "# " + l)),
      "#",
      "# === RIWAYAT SINYAL (klaster terakhir) ===",
      ...(signalHistory(bars).map(h => `#   ${fmtTs(h.t)} WIB  ${h.signal}  grade ${h.grade || "—"}  skor ${h.conf}`)),
      "#",
      "# timezone=WIB (Asia/Jakarta, UTC+7) — sama dengan GMGN",
      "# === BARS (chart: bar_start_wib vs close & R) ===",
      "bar_start_wib,cluster,close,price_chg_pct,R,cvd,cvd_clean,cum_cvd,open,high,low,open_mc_usd,high_mc_usd,low_mc_usd,close_mc_usd,buy_sol,sell_sol,vol_sol,wash_pct,tx,unique_makers,tagged_makers,fresh_wallets,fresh_wallet_pct,fresh_tx,fresh_buy_sol,fresh_sell_sol,top_wallet_pct,partial"
    ];
    const barRows = bars.map(b => [wibIso(b.start), b.cluster, b.close ?? "",
      b.priceChgPct != null ? b.priceChgPct.toFixed(3) : "", b.R != null ? b.R.toFixed(3) : "",
      b.cvd.toFixed(3), b.cvdClean.toFixed(3), b.cumCVD.toFixed(3), b.open ?? "", b.high ?? "", b.low ?? "",
      b.openMc != null ? b.openMc.toFixed(2) : "", b.highMc != null ? b.highMc.toFixed(2) : "",
      b.lowMc != null ? b.lowMc.toFixed(2) : "", b.closeMc != null ? b.closeMc.toFixed(2) : "",
      b.buySol.toFixed(2), b.sellSol.toFixed(2), b.volSol.toFixed(2), b.washPct.toFixed(1),
      b.txCount, b.uniqueMakers, b.taggedMakers, b.freshWallets, b.freshWalletPct.toFixed(1), b.freshTxCount,
      b.freshBuySol.toFixed(2), b.freshSellSol.toFixed(2), b.topWalletPct.toFixed(1), b.partial ? 1 : 0].join(","));
    const txSection = ["#", "# === RAW TRADES ===", "date_wib,ts,event,sol,price,maker,tags,tx_hash"];
    const txRows = trades.map(t => [wibDateOf(t.ts), t.ts, t.event, t.sol.toFixed(6), (t.price || 0).toExponential(8), t.maker, (t.tags || []).join(";"), t.tx_hash].join(","));
    downloadCSV(`SMART_SEROK_${mint.slice(0, 8)}.csv`, [...recap, ...barRows, ...txSection, ...txRows].join("\n"));
  }

  // Export RINGKAS untuk analisa AI: hanya bars + riwayat sinyal (TANPA raw trades).
  // File kecil (KB) — mudah upload banyak. Kolom analisa-focused.
  function exportForAI() {
    const mint = getMintFromUrl(), trades = getSortedTrades();
    if (!trades.length) { alert("Belum ada transaksi. Jalankan Background Fetch."); return; }
    const allBars = buildBars(trades);
    const bars = activeBars(allBars), cls = classify(bars);
    const hist = signalHistory(bars);
    const sigLine = hist.map(h => { const p = tzParts(h.t); return `${p.m}-${p.d} ${p.h}h ${h.signal}(${h.conf})`; }).join(" | ");
    const L = [];
    L.push("# SMART SEROK — ANALISA PACK (bars only, no raw trades) — siap untuk AI");
    L.push("# mint=" + mint);
    L.push("# mc_context_source=" + mcContextSource + " current_mc_usd=" + (cachedMcUsd || "") + " effective_supply=" + (cachedMcPerPrice || ""));
    L.push("# timezone=WIB (Asia/Jakarta, UTC+7) — sama dengan GMGN");
    L.push("# tf=" + activeTf.label + " r_spike=" + R_SPIKE_MULT + "x_prev min_R=" + R_MIN_ABS);
    L.push("# bars=" + bars.length + " | total_clusters=" + (allBars.length ? allBars[allBars.length - 1].cluster + 1 : 0) + " | active_cluster=" + (selectedCluster == null ? "latest" : selectedCluster));
    L.push("# current_signal=" + cls.signal + " conf=" + (cls.conf || 0));
    L.push("# signal_history=" + (sigLine || "(none)"));
    L.push("# NOTE: BATTLE hanya setelah WASPADA DUMP/SIAP2 PUMP; gap buy-sell ≤2.5%; TX, unique makers, dan fresh_wallet ≥P65 periode aktif; range=low-high MARKET CAP. Tanpa AKTIVASI/konfirmasi. Jam=WIB.");
    L.push("bar_wib,cluster,close,close_mc_usd,low_mc_usd,high_mc_usd,chg_pct,R,cvd,cvd_clean,cum_cvd,wash_pct,tx,unique_makers,tagged_makers,fresh_wallets,fresh_wallet_pct,fresh_tx,fresh_buy_sol,fresh_sell_sol,buy_sol,sell_sol,vol_sol");
    for (const b of bars) {
      L.push([
        wibIso(b.start), b.cluster,
        b.close != null ? b.close.toExponential(4) : "",
        b.closeMc != null ? b.closeMc.toFixed(2) : "", b.lowMc != null ? b.lowMc.toFixed(2) : "", b.highMc != null ? b.highMc.toFixed(2) : "",
        b.priceChgPct != null ? b.priceChgPct.toFixed(2) : "",
        b.signedR != null ? b.signedR.toFixed(3) : (b.R != null ? b.R.toFixed(3) : ""),
        b.cvd.toFixed(2), b.cvdClean.toFixed(2), b.cumCVD.toFixed(1),
        b.washPct.toFixed(1), b.txCount, b.uniqueMakers, b.taggedMakers, b.freshWallets, b.freshWalletPct.toFixed(1), b.freshTxCount,
        b.freshBuySol.toFixed(2), b.freshSellSol.toFixed(2), b.buySol.toFixed(2), b.sellSol.toFixed(2), b.volSol.toFixed(2)
      ].join(","));
    }
    downloadCSV(`SMART_SEROK_AI_${mint.slice(0, 8)}.csv`, L.join("\n"));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. UI
  // ══════════════════════════════════════════════════════════════════════════
  function esc(s) { return String(s).replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
  const SIG_META = {
    "WASPADA DUMP": { color: "#ef4444", label: "🔴 WASPADA DUMP" },
    "SIAP2 PUMP": { color: "#22c55e", label: "🟢 SIAP2 PUMP" },
    "BATTLE TERJADI": { color: "#fbbf24", label: "⚔️ BATTLE TERJADI" },
    NETRAL: { color: "#94a3b8", label: "⚪ NETRAL" }
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
      const evs = detectEvents(bars).slice().reverse();
      const sig = evs.map(e => eventKey(e) + ":" + e.conf + ":" + (e.grade || "")).join("|");
      if (shEl._sig !== sig) {
        shEl._sig = sig;
        if (!evs.length) {
          shEl.innerHTML = `<div class="gmgn-hist-empty">Belum ada WASPADA DUMP / SIAP2 PUMP / BATTLE TERJADI.</div>`;
        } else {
          shEl.innerHTML =
            `<div class="gmgn-hist-head"><span>Sinyal</span><span>Detail</span><span>Metric</span></div>` +
            evs.map(e => {
              const m = SIG_META[e.signal] || {};
              const col = m.color || "#94a3b8";
              const key = eventKey(e);
              const open = openDetailKey === key;
              const battle = e.signal === "BATTLE TERJADI";
              const mark = battle ? "⚔️" : e.signal === "WASPADA DUMP" ? "🔴" : "🟢";
              const gc = e.gradeColor || "#94a3b8";
              const sR = e.setup.signedR != null ? e.setup.signedR : e.setup.R;
              const rm = e.ev && e.ev.rMult != null ? e.ev.rMult.toFixed(1) + "×" : "";
              const det = battle
                ? `${fmtTs(e.setup.start)}  ·  MC ${fmtMarketCap(e.ev.rangeLowMc)} — ${fmtMarketCap(e.ev.rangeHighMc)}  ·  fresh ${e.setup.freshWallets}/${e.setup.uniqueMakers}`
                : `${fmtTs(e.setup.start)}  ·  R ${sR != null ? (sR >= 0 ? "+" : "") + sR.toFixed(2) : "—"}  ·  ${rm}`;
              return `<div class="gmgn-hist-item${open ? " is-open" : ""}" data-key="${esc(key)}">
                <div class="gmgn-hist-row">
                  <span class="gmgn-hist-sig" style="color:${col};">${mark} ${e.signal}</span>
                  <span class="gmgn-hist-meta">${det}</span>
                  <span class="gmgn-hist-grade" style="color:${gc};" title="${esc((e.gradeLabel || "") + " · " + e.conf)}">${esc(e.grade || "—")}</span>
                </div>
                <div class="gmgn-hist-tip">${esc(buildNarrative(e))}</div>
                <div class="gmgn-hist-detail"${open ? "" : " hidden"}>${esc(buildNarrative(e))}</div>
              </div>`;
            }).join("");
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

    const chartEl = document.getElementById("gmgn-chart");
    if (chartEl) renderTrajectory(bars, chartEl);

    const dlBtn = document.getElementById("gmgn-btn-dl"); if (dlBtn) dlBtn.disabled = bars.length < 2;
    const aiBtn = document.getElementById("gmgn-btn-ai"); if (aiBtn) aiBtn.disabled = bars.length < 2;
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
      #gmgn-effort-widget .gmgn-hist-head, #gmgn-effort-widget .gmgn-hist-row { display: grid; grid-template-columns: 200px minmax(240px, 1fr) 64px; gap: 10px; align-items: center; }
      #gmgn-effort-widget .gmgn-hist-grade { font-size: 18px; font-weight: 900; letter-spacing: 0.02em; white-space: nowrap; text-align: right; }
      #gmgn-effort-widget .gmgn-hist-meta { font-size: 13px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
      #gmgn-effort-widget .gmgn-hist-item { cursor: pointer; }
      #gmgn-effort-widget .gmgn-btn-live-on { background: #065f46; color: #d1fae5; }
      #gmgn-effort-widget .gmgn-hist-head { font-size: 12px; font-weight: 700; color: #64748b; padding: 6px 8px 8px; border-bottom: 1px solid #1e293b; letter-spacing: .02em; }
      #gmgn-effort-widget .gmgn-hist-item { position: relative; padding: 8px; border-bottom: 1px solid #1e293b; }
      #gmgn-effort-widget .gmgn-hist-item:last-child { border-bottom: none; }
      #gmgn-effort-widget .gmgn-hist-jam { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; color: #cbd5e1; }
      #gmgn-effort-widget .gmgn-hist-sig { font-size: 15px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #gmgn-effort-widget .gmgn-hist-conf { font-size: 14px; font-variant-numeric: tabular-nums; color: #94a3b8; text-align: right; }
      #gmgn-effort-widget .gmgn-btn-detail { cursor: pointer; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; border-radius: 7px; padding: 6px 8px; font-size: 12px; font-weight: 700; font-family: inherit; line-height: 1; white-space: nowrap; }
      #gmgn-effort-widget .gmgn-btn-detail:hover { background: #334155; }
      #gmgn-effort-widget .gmgn-hist-detail { margin-top: 8px; padding: 10px 12px; background: #111827; border: 1px solid #334155; border-radius: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #cbd5e1; }
      #gmgn-effort-widget .gmgn-hist-tip { display: none; }
      #gmgn-effort-widget #gmgn-sig-tip { display: none; position: absolute; left: 14px; right: 14px; z-index: 20; background: #111827; border: 1px solid #475569; border-radius: 10px; padding: 10px 12px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; box-shadow: 0 10px 28px rgba(0,0,0,.5); pointer-events: none; }
      #gmgn-effort-widget #gmgn-sig-tip.is-on { display: block; }
      #gmgn-effort-widget #gmgn-chart { display: block; }
      #gmgn-effort-widget #gmgn-chart svg { display: block; width: 100%; height: auto; }
      #gmgn-effort-widget #gmgn-status-text { display: block; min-height: 1.2em; }
      #gmgn-effort-widget #gmgn-btn-min { flex-shrink: 0; padding: 4px 10px; font-size: 14px; }
      #gmgn-effort-widget #gmgn-done-flag { font-size: 13px; font-weight: 700; color: #10b981; white-space: nowrap; }
    </style>
    <div class="gmgn-card">
      <div class="gmgn-hdr">
        <span class="t">🥄 SMART SEROK v9.1.3</span>
        <span id="gmgn-tf-badge">1H · R×10 · |R|≥10</span>
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
            <button class="gmgn-btn-main gmgn-btn-dl" id="gmgn-btn-dl" disabled>⬇ Export</button>
            <button class="gmgn-btn-main gmgn-btn-dl" id="gmgn-btn-ai" disabled title="Export ringkas (bars+sinyal) untuk analisa AI, tanpa raw trades">⤓ for AI</button>
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
        <div id="gmgn-chart"></div>
        <div id="gmgn-sighist"></div>
        <div id="gmgn-sig-tip"></div>
        <div class="gmgn-note">
          ⚔️ BATTLE hanya setelah 🔴 WASPADA DUMP / 🟢 SIAP2 PUMP. Syarat: gap BUY–SELL ≤2,5% serta TX, wallet unik, dan tag fresh_wallet ≥P65 periode aktif. Range battle memakai LOW–HIGH MARKET CAP. Tanpa aktivasi/konfirmasi otomatis.
        </div>
      </div>
    </div>`;
    document.body.appendChild(host);
    document.getElementById("gmgn-btn-bgfetch").addEventListener("click", () => { bgFetchComplete = false; bgFetchActive ? stopBackgroundFetch() : backgroundFetch(); });
    document.getElementById("gmgn-btn-live").addEventListener("click", toggleLive);
    document.getElementById("gmgn-btn-scroll").addEventListener("click", () => { isAutoScrolling ? stopAutoScroll(false) : startAutoScroll(); });
    document.getElementById("gmgn-btn-reset").addEventListener("click", () => { capturedTrades.clear(); walletTagRegistry.clear(); detectedFromTs = null; detectedToTs = null; selectedCluster = null; cachedMcUsd = 0; cachedSupply = 0; cachedPriceUsd = 0; cachedMcPerPrice = 0; cachedHolderSupply = 0; mcContextSource = "none"; holderFetchMint = null; holderFetchLastAt = 0; Object.assign(captureStats, { requests: 0, seen: 0, recorded: 0, dup: 0, outOfRange: 0, noMaker: 0, badEvent: 0, badTs: 0, lastMsg: "Direset manual", lastTs: Date.now() }); updateUI(); });
    document.getElementById("gmgn-cluster").addEventListener("change", (e) => { selectedCluster = e.target.value === "" ? null : parseInt(e.target.value); updateUI(); });
    document.getElementById("gmgn-btn-dl").addEventListener("click", exportAll);
    document.getElementById("gmgn-btn-ai").addEventListener("click", exportForAI);
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
