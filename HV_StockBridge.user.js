// ==UserScript==
// @name         HV Stock Bridge
// @namespace    highvibes
// @version      1.2.0
// @description  Full stock sync to HighVibes Dashboard — qty, sold daily, weekly, buy cost, sell price, RRP, storage. One click, no paste required.
// @author       HighVibes
// @match        https://www.torn.com/companies.php*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BRIDGE_VERSION = 2;
  const BTN_ID = 'hv-bridge-btn';
  const BANNER_ID = 'hv-bridge-banner';
  const DASHBOARD_URL = 'https://kreinas1995.github.io/CompanyDashboard/current/CompanyDashboardv1_3_0.html';
  const DASHBOARD_ORIGIN = 'https://kreinas1995.github.io';
  const IFRAME_TIMEOUT = 12000;
  const HISTORY_KEY = 'hvBridge_history';

  // ── Helpers ──────────────────────────────────────────────

  function toNum(str) {
    if (str == null) return 0;
    return parseInt((str + '').replace(/[^0-9]/g, ''), 10) || 0;
  }

  function toFloat(str) {
    if (str == null) return 0;
    return parseFloat((str + '').replace(/[^0-9.]/g, '')) || 0;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function waitForElement(selector, timeout) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > (timeout || 15000)) return reject(new Error('Timeout: ' + selector));
        setTimeout(poll, 300);
      })();
    });
  }

  function showBanner(msg, isErr) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:8px;font-family:monospace;font-size:13px;z-index:99999;pointer-events:none;transition:opacity .4s;box-shadow:0 4px 20px rgba(0,0,0,.5)';
      document.body.appendChild(banner);
    }
    banner.style.background = isErr ? '#3a1010' : '#0d1f14';
    banner.style.border = '1px solid ' + (isErr ? '#cc4444' : '#38c9a0');
    banner.style.color = isErr ? '#ff6b6b' : '#38c9a0';
    banner.style.opacity = '1';
    banner.textContent = msg;
    clearTimeout(banner._t);
    banner._t = setTimeout(() => { banner.style.opacity = '0'; }, 5000);
  }

  function setBtnState(text, loading) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = loading;
    btn.style.opacity = loading ? '0.6' : '1';
    btn.style.cursor = loading ? 'wait' : 'pointer';
  }

  // ── Local history accumulation ───────────────────────────
  // Stores soldQty per item per day in torn.com localStorage.
  // Enables weekly totals to build up over time.

  function accumulateHistory(items) {
    const td = today();
    let hist = {};
    try { hist = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch (e) {}
    for (const item of items) {
      if (!item.name) continue;
      if (!hist[item.name]) hist[item.name] = {};
      if (item.soldToday > 0 || !hist[item.name][td]) {
        hist[item.name][td] = item.soldToday;
      }
      // Prune to 30 days
      const keys = Object.keys(hist[item.name]).sort();
      if (keys.length > 30) keys.slice(0, keys.length - 30).forEach(k => delete hist[item.name][k]);
    }
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist)); } catch (e) {}
    return hist;
  }

  function calcWeekly(hist, name) {
    if (!hist[name]) return 0;
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    return Object.entries(hist[name])
      .filter(([d]) => d >= cutoff)
      .reduce((a, [, v]) => a + (v || 0), 0);
  }

  // ── Read stock tab ───────────────────────────────────────

  function readStockTab() {
    const stockForm = document.querySelector("form[action*='stock']");
    if (!stockForm) return null;

    const list = stockForm.querySelector('.stock-list');
    if (!list) return null;

    // Storage capacity — TornTools reads [data-initial] on two children
    let storageUsed = 0, storageTotal = 0;
    const capEls = document.querySelectorAll('.storage-capacity > *');
    if (capEls.length >= 2) {
      storageUsed = toNum(capEls[0].dataset.initial || capEls[0].textContent);
      storageTotal = toNum(capEls[1].dataset.initial || capEls[1].textContent);
    }

    const rows = list.querySelectorAll('li:not(.total):not(.quantity):not(.head)');
    if (!rows.length) return null;

    const items = [];
    rows.forEach(row => {
      // Name — try multiple selectors Torn has used over time
      const nameEl = row.querySelector('.name') || row.querySelector('a.t-blue') || row.querySelector('a') || row.querySelector('span.name');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name || name === '') return;

      // Current qty in stock
      const qtyEl = row.querySelector('.qty') || row.querySelector('.stock-qty') || row.querySelector('[class*="qty"]');
      const currentQty = qtyEl ? toNum(qtyEl.dataset.value || qtyEl.textContent) : null;

      // Sold today — native Torn column
      const sdEl = row.querySelector('.sold-daily');
      const soldToday = sdEl ? toNum(sdEl.lastChild ? sdEl.lastChild.textContent : sdEl.textContent) : 0;

      // Order qty input (what the director types to restock)
      const inputEl = row.querySelector('input[type="number"]') || row.querySelector('input.order-qty');
      const orderQty = inputEl ? toNum(inputEl.value) : null;

      // Buy cost — may be in a .cost span or data attribute
      const costEl = row.querySelector('.cost') || row.querySelector('[data-cost]') || row.querySelector('.buy-price');
      const buyCost = costEl ? toNum(costEl.dataset.cost || costEl.textContent) : null;

      // Sell price — may be an editable input or a span on the stock row
      const sellEl = row.querySelector('input.price') || row.querySelector('.sell-price') || row.querySelector('[data-price]');
      const sellPrice = sellEl ? toNum(sellEl.value || sellEl.dataset.price || sellEl.textContent) : null;

      // RRP — shown as reference price
      const rrpEl = row.querySelector('.rrp') || row.querySelector('[data-rrp]') || row.querySelector('.retail-price');
      const rrp = rrpEl ? toNum(rrpEl.dataset.rrp || rrpEl.textContent) : null;

      items.push({ name, currentQty, soldToday, orderQty, buyCost, sellPrice, rrp });
    });

    return items.length ? { items, storageUsed, storageTotal } : null;
  }

  // ── Read pricing tab ─────────────────────────────────────
  // Torn's pricing tab is at #option=pricing — separate DOM

  function readPricingTab() {
    // Pricing table — selectors are best-guesses; may need adjustment
    const rows = document.querySelectorAll('.pricing-list li:not(.head), .stock-pricing li:not(.head), table.pricing tbody tr');
    if (!rows.length) return null;

    const prices = {};
    rows.forEach(row => {
      const nameEl = row.querySelector('.name') || row.querySelector('td:first-child');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;

      const priceEl = row.querySelector('input.price') || row.querySelector('.price input') || row.querySelector('td.price input');
      const rrpEl = row.querySelector('.rrp') || row.querySelector('td.rrp') || row.querySelector('[data-rrp]');

      prices[name] = {
        sellPrice: priceEl ? toNum(priceEl.value) : null,
        rrp: rrpEl ? toNum(rrpEl.dataset.rrp || rrpEl.textContent) : null,
      };
    });

    return Object.keys(prices).length ? prices : null;
  }

  // ── Build full payload ───────────────────────────────────

  function buildPayload() {
    const stockData = readStockTab();
    if (!stockData) return null;

    // Accumulate sold history and compute weekly totals
    const hist = accumulateHistory(stockData.items);

    // Try to enrich with pricing data if we're on that tab
    const pricingData = readPricingTab();

    const items = stockData.items.map(item => {
      const pricing = pricingData ? pricingData[item.name] : null;
      return {
        name: item.name,
        currentQty: item.currentQty,
        soldToday: item.soldToday,
        soldWeekly: calcWeekly(hist, item.name),
        orderQty: item.orderQty,
        buyCost: item.buyCost,
        sellPrice: item.sellPrice ?? (pricing ? pricing.sellPrice : null),
        rrp: item.rrp ?? (pricing ? pricing.rrp : null),
      };
    });

    return {
      v: BRIDGE_VERSION,
      ts: Date.now(),
      storageUsed: stockData.storageUsed,
      storageTotal: stockData.storageTotal,
      items,
    };
  }

  // ── postMessage bridge ───────────────────────────────────

  function sendViaIframe(payload) {
    setBtnState('⏳ Syncing…', true);
    const old = document.getElementById('hv-bridge-iframe');
    if (old) old.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'hv-bridge-iframe';
    iframe.src = DASHBOARD_URL;
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:none;top:-9999px;left:-9999px;';
    document.body.appendChild(iframe);

    let ackReceived = false;

    function onAck(event) {
      if (event.origin !== DASHBOARD_ORIGIN) return;
      if (!event.data || event.data.type !== 'hvBridgeAck') return;
      ackReceived = true;
      window.removeEventListener('message', onAck);
      clearTimeout(timer);
      setBtnState('📊 Log to Dashboard', false);
      const created = event.data.created || 0;
      const matched = event.data.matched || 0;
      const skipped = event.data.skipped || 0;
      let msg = `✓ ${matched} updated`;
      if (created) msg += `, ${created} auto-created`;
      if (skipped) msg += `, ${skipped} skipped`;
      showBanner(msg, false);
      setTimeout(() => { iframe.remove(); }, 3000);
    }

    window.addEventListener('message', onAck);

    iframe.onload = () => {
      setTimeout(() => {
        try {
          iframe.contentWindow.postMessage({ type: 'hvBridge', payload }, DASHBOARD_ORIGIN);
        } catch (e) {
          clearTimeout(timer);
          window.removeEventListener('message', onAck);
          iframe.remove();
          fallbackClipboard(payload, 'postMessage blocked');
        }
      }, 800);
    };

    iframe.onerror = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onAck);
      iframe.remove();
      fallbackClipboard(payload, 'iframe load failed');
    };

    const timer = setTimeout(() => {
      if (!ackReceived) {
        window.removeEventListener('message', onAck);
        iframe.remove();
        fallbackClipboard(payload, 'Dashboard load timed out');
      }
    }, IFRAME_TIMEOUT);
  }

  function fallbackClipboard(payload, reason) {
    setBtnState('📊 Log to Dashboard', false);
    const str = JSON.stringify(payload);
    try {
      GM_setClipboard(str);
      showBanner(`⚠ ${reason} — copied to clipboard, paste in Dashboard → Stock → PASTE BRIDGE`, false);
    } catch (e) {
      navigator.clipboard.writeText(str)
        .then(() => showBanner(`⚠ ${reason} — copied, paste in Dashboard → Stock → PASTE BRIDGE`, false))
        .catch(() => showBanner('✕ Sync failed and clipboard unavailable.', true));
    }
  }

  // ── Button injection ─────────────────────────────────────

  function injectButton(anchor) {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📊 Log to Dashboard';
    btn.title = 'Sync stock qty, sold daily/weekly, costs, prices and RRP to HighVibes Dashboard';
    btn.className = 'tt-btn';
    btn.style.cssText = 'margin-left:6px;background:#0d4a31;border:1px solid #38c9a0;color:#38c9a0;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:monospace;transition:background .15s;white-space:nowrap;';
    btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#134d35'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0d4a31'; });
    btn.addEventListener('click', () => {
      const payload = buildPayload();
      if (!payload) {
        showBanner('✕ No stock data found — visit the Stock tab first.', true);
        return;
      }
      sendViaIframe(payload);
    });
    anchor.insertAdjacentElement('afterend', btn);
  }

  // ── Main ─────────────────────────────────────────────────

  async function init() {
    try {
      await waitForElement("form[action*='stock'], .stock-list, .pricing-list", 20000);
      const ttBtn = document.querySelector('.tt-fill-stock');
      if (ttBtn) { injectButton(ttBtn); return; }
      const orderLink = document.querySelector("form[action*='stock'] .order ~ a, form[action*='stock'] .order");
      if (orderLink) { injectButton(orderLink); return; }
      const stockList = document.querySelector('.stock-list');
      if (stockList) {
        const wrap = document.createElement('div');
        wrap.style.marginBottom = '8px';
        stockList.insertAdjacentElement('beforebegin', wrap);
        injectButton(wrap);
      }
    } catch (e) { /* not on stock/pricing tab yet */ }
  }

  function onReady() {
    const isStockOrPricing = () =>
      location.hash.includes('option=stock') ||
      location.hash.includes('option=pricing') ||
      document.querySelector("form[action*='stock']") ||
      document.querySelector('.stock-list');

    if (isStockOrPricing()) init();

    window.addEventListener('hashchange', () => {
      setTimeout(() => { if (!document.getElementById(BTN_ID) && isStockOrPricing()) init(); }, 600);
    });

    const obs = new MutationObserver(() => {
      if (isStockOrPricing() && !document.getElementById(BTN_ID)) init();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

})();
