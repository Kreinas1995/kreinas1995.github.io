// ==UserScript==
// @name         HV Stock Bridge
// @namespace    highvibes
// @version      1.1.0
// @description  One-click sync of daily sold quantities to the HighVibes Company Dashboard via postMessage. No clipboard required.
// @author       HighVibes
// @match        https://www.torn.com/companies.php*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BRIDGE_VERSION = 1;
  const BTN_ID = 'hv-bridge-btn';
  const BANNER_ID = 'hv-bridge-banner';
  const DASHBOARD_URL = 'https://kreinas1995.github.io/CompanyDashboard/CompanyDashboardv1_2_1.html';
  const DASHBOARD_ORIGIN = 'https://kreinas1995.github.io';
  const IFRAME_TIMEOUT = 10000;

  function convertToNumber(str) {
    if (!str) return 0;
    return parseInt((str + '').replace(/[^0-9]/g, ''), 10) || 0;
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

  function readSoldData() {
    const stockForm = document.querySelector("form[action*='stock']");
    if (!stockForm) return null;
    const list = stockForm.querySelector('.stock-list');
    if (!list) return null;
    const rows = list.querySelectorAll('li:not(.total):not(.quantity)');
    if (!rows.length) return null;
    const items = [];
    rows.forEach(row => {
      const nameEl = row.querySelector('.name') || row.querySelector('a') || row.querySelector('span');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;
      const sdEl = row.querySelector('.sold-daily');
      const soldQty = sdEl ? convertToNumber(sdEl.lastChild ? sdEl.lastChild.textContent : sdEl.textContent) : 0;
      const qtyEl = row.querySelector('.qty') || row.querySelector('.quantity-input') || row.querySelector('input[type="number"]');
      const currentQty = qtyEl ? convertToNumber(qtyEl.value || qtyEl.textContent) : null;
      items.push({ name, soldQty, currentQty });
    });
    return items.length ? items : null;
  }

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
      const matched = event.data.matched || '?';
      const skipped = event.data.skipped || 0;
      showBanner(skipped ? `✓ ${matched} synced, ${skipped} unmatched` : `✓ ${matched} items synced to Dashboard`, false);
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
          fallbackClipboard(payload, 'postMessage blocked — used clipboard instead');
        }
      }, 800);
    };

    iframe.onerror = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onAck);
      iframe.remove();
      fallbackClipboard(payload, 'iframe load failed — used clipboard instead');
    };

    const timer = setTimeout(() => {
      if (!ackReceived) {
        window.removeEventListener('message', onAck);
        iframe.remove();
        fallbackClipboard(payload, 'Dashboard load timed out — used clipboard instead');
      }
    }, IFRAME_TIMEOUT);
  }

  function fallbackClipboard(payload, bannerMsg) {
    setBtnState('📊 Log to Dashboard', false);
    const str = JSON.stringify(payload);
    try {
      GM_setClipboard(str);
      showBanner('⚠ ' + bannerMsg + ' — paste in Dashboard → Stock → PASTE BRIDGE', false);
    } catch (e) {
      navigator.clipboard.writeText(str)
        .then(() => showBanner('⚠ ' + bannerMsg + ' — paste in Dashboard → Stock → PASTE BRIDGE', false))
        .catch(() => showBanner('✕ Sync failed and clipboard unavailable.', true));
    }
  }

  function injectButton(anchor) {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📊 Log to Dashboard';
    btn.title = 'One-click sync sold quantities to HighVibes Dashboard';
    btn.className = 'tt-btn';
    btn.style.cssText = 'margin-left:6px;background:#0d4a31;border:1px solid #38c9a0;color:#38c9a0;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:monospace;transition:background .15s;white-space:nowrap;';
    btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#134d35'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0d4a31'; });
    btn.addEventListener('click', () => {
      const items = readSoldData();
      if (!items) { showBanner('✕ No stock data found — make sure you are on the Stock tab.', true); return; }
      sendViaIframe({ v: BRIDGE_VERSION, ts: Date.now(), items });
    });
    anchor.insertAdjacentElement('afterend', btn);
  }

  async function init() {
    try {
      await waitForElement("form[action*='stock']", 20000);
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
    } catch (e) { /* not on stock tab yet */ }
  }

  function onReady() {
    if (location.hash.includes('option=stock') || document.querySelector("form[action*='stock']")) init();
    window.addEventListener('hashchange', () => { setTimeout(() => { if (!document.getElementById(BTN_ID)) init(); }, 600); });
    const obs = new MutationObserver(() => {
      if (document.querySelector("form[action*='stock']") && !document.getElementById(BTN_ID)) init();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

})();
