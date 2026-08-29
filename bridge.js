/**
 * SMART SEROK — bridge.js (ISOLATED world)
 * --------------------------------------------------------------
 * content.js berjalan di world "MAIN" supaya bisa membaca response
 * gmgn.ai yang di-hook. Tapi halaman gmgn.ai TIDAK diizinkan CORS
 * memanggil openapi.gmgn.ai. File ini berjalan di ISOLATED world:
 * ia punya hak ekstensi (host permission openapi.gmgn.ai) sehingga
 * fetch lintas-origin diizinkan browser, tanpa CORS preflight yang
 * mengekspos header X-APIKEY ke halaman.
 *
 * Protokol: content.js (MAIN) -> window.postMessage -> sini ->
 *           fetch -> window.postMessage balasan.
 *
 * API Key:
 *   - DEFAULT_API_KEY = key yang ditanam saat ZIP dibuat (dipakai
 *     kalau user belum mengisi apa pun).
 *   - Key kustom user disimpan di chrome.storage.local (autosave,
 *     tidak perlu isi ulang).
 *
 * Catatan: hanya endpoint DATA (exist auth: X-APIKEY + timestamp +
 * client_id). Swap/order butuh tanda tangan private key dan SENGAJA
 * tidak disentuh — SMART SEROK murni alat baca.
 */

(() => {
  'use strict';

  const DEFAULT_API_KEY = 'gmgn_cae4e77f99b56e2f1cf02e217424c925';
  const API_HOST = 'https://openapi.gmgn.ai';
  const KEY_STORE = 'gmgn_api_key_v1';
  const REQ_TIMEOUT_MS = 20000;
  const TAG_CACHE_KEY = 'gmgn_smart_tag_registry_v1';
  const TAG_CACHE_TTL_MS = 6 * 3600 * 1000; // 6 jam

  const FROM_PAGE = 'SMART_SEROK_API_REQ';
  const TO_PAGE = 'SMART_SEROK_API_RES';
  const TAG_FROM_PAGE = 'SMART_SEROK_TAG_REQ';
  const TAG_TO_PAGE = 'SMART_SEROK_TAG_RES';

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function getApiKey() {
    try {
      const r = await chrome.storage.local.get(KEY_STORE);
      const k = (r && r[KEY_STORE]) || '';
      if (typeof k === 'string' && k.trim()) return k.trim();
    } catch (e) { /* storage tak tersedia — pakai default */ }
    return DEFAULT_API_KEY;
  }

  async function setApiKey(key) {
    const clean = String(key || '').trim();
    await chrome.storage.local.set({ [KEY_STORE]: clean });
    return clean || DEFAULT_API_KEY;
  }

  function buildUrl(subPath, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)));
      else qs.set(k, String(v));
    }
    return API_HOST + subPath + (qs.toString() ? '?' + qs.toString() : '');
  }

  /**
   * Request ke GMGN OpenAPI. Endpoint data memakai auth "exist":
   * header X-APIKEY + query timestamp (detik, toleransi ±5s) + client_id.
   */
  async function apiRequest(method, subPath, query, bodyObj, useCustomKey) {
    const apiKey = useCustomKey != null ? useCustomKey : await getApiKey();
    const params = Object.assign({
      timestamp: Math.floor(Date.now() / 1000),
      client_id: uuid(),
    }, query || {});
    const url = buildUrl(subPath, params);
    const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: method || 'GET',
        headers: { 'X-APIKEY': apiKey, 'Content-Type': 'application/json' },
        body: body,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: 'network: ' + (e && e.message ? e.message : String(e)) };
    }
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      return { ok: false, http: res.status, error: 'HTTP ' + res.status + (json && json.message ? ' · ' + json.message : '') };
    }
    if (json && json.code !== 0) {
      return { ok: false, http: res.status, apiCode: json.code,
        error: (json.error || 'code=' + json.code) + (json.message ? ' · ' + json.message : ''),
        upgradeUrl: json.upgrade_url || null };
    }
    return { ok: true, http: res.status, data: json ? json.data : null, raw: json };
  }

  // ── Registrasi wallet smart-money / KOL (feed smart tags) ──────────────────
  async function loadTagCache() {
    try {
      const r = await chrome.storage.local.get(TAG_CACHE_KEY);
      const c = r && r[TAG_CACHE_KEY];
      if (c && c.savedAt && Date.now() - c.savedAt < TAG_CACHE_TTL_MS && c.registry) return c;
    } catch (e) { /* abaikan */ }
    return null;
  }

  async function saveTagCache(registry, source) {
    try {
      await chrome.storage.local.set({ [TAG_CACHE_KEY]: { registry, source, savedAt: Date.now() } });
    } catch (e) { /* abaikan */ }
  }

  function walletsFrom(items, tag) {
    const out = {};
    for (const it of items || []) {
      const addr = it.address || it.wallet_address || it.wallet || it.eth_address || it.sol_address;
      if (!addr) continue;
      const name = it.name || it.nickname || it.twitter_username || it.username || '';
      out[String(addr)] = { tag, name: String(name).slice(0, 40) };
    }
    return out;
  }

  async function fetchSmartTagRegistry() {
    const cached = await loadTagCache();
    if (cached) return { ok: true, registry: cached.registry, source: cached.source + ' (cache)', cached: true };
    const registry = {};
    const errors = [];
    const tasks = [
      { sub: '/v1/user/smartmoney', tag: 'smart_money', listPath: (d) => Array.isArray(d) ? d : (d && (d.list || d.wallets || d.data)) || [] },
      { sub: '/v1/user/kol', tag: 'kol', listPath: (d) => Array.isArray(d) ? d : (d && (d.list || d.wallets || d.kols || d.data)) || [] },
    ];
    for (const t of tasks) {
      const r = await apiRequest('GET', t.sub, { chain: 'sol', limit: 200 });
      if (r.ok) {
        Object.assign(registry, walletsFrom(t.listPath(r.data), t.tag));
      } else {
        errors.push(t.tag + ': ' + r.error);
      }
    }
    const count = Object.keys(registry).length;
    if (count) await saveTagCache(registry, errors.length ? 'sebagian' : 'GMGN OpenAPI');
    return { ok: count > 0, registry, count, errors,
      source: errors.length ? ('GMGN OpenAPI (sebagian: ' + errors.join('; ') + ')') : 'GMGN OpenAPI',
      cached: false };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || typeof ev.data !== 'object') return;

    // Ambil / simpan API key.
    if (ev.data.__ss === TAG_FROM_PAGE && ev.data.type === 'key:get') {
      const key = await getApiKey();
      window.postMessage({ __ss: TAG_TO_PAGE, reqId: ev.data.reqId,
        ok: true, key: key, isDefault: key === DEFAULT_API_KEY }, '*');
      return;
    }
    if (ev.data.__ss === TAG_FROM_PAGE && ev.data.type === 'key:set') {
      const key = await setApiKey(ev.data.key || '');
      window.postMessage({ __ss: TAG_TO_PAGE, reqId: ev.data.reqId, ok: true,
        key: key, isDefault: key === DEFAULT_API_KEY }, '*');
      return;
    }

    // Feed smart tags (smart money + KOL) untuk diperkaya ke trade history.
    if (ev.data.__ss === TAG_FROM_PAGE && ev.data.type === 'smart-tags') {
      const r = await fetchSmartTagRegistry();
      window.postMessage({ __ss: TAG_TO_PAGE, reqId: ev.data.reqId,
        ok: r.ok, registry: r.registry || {}, count: r.count || 0,
        source: r.source || '', cached: !!r.cached, error: r.ok ? '' : (r.errors || []).join('; ') }, '*');
      return;
    }

    // Proxy request OpenAPI generik.
    if (ev.data.__ss === FROM_PAGE) {
      const r = await apiRequest(ev.data.method, ev.data.subPath, ev.data.query, ev.data.body);
      window.postMessage({ __ss: TO_PAGE, reqId: ev.data.reqId, ...r }, '*');
    }
  });

  // Tandai bridge sudah hidup (dibaca content.js untuk status UI).
  window.__SMART_SEROK_BRIDGE__ = true;
})();
