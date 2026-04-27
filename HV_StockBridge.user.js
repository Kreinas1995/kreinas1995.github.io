// ==UserScript==
// @name         HV Stock Bridge
// @namespace    highvibes
// @version      1.0.0
// @description  Reads daily sold quantities from Torn's stock page and copies them to clipboard for the HighVibes Company Dashboard.
// @author       HighVibes
// @match        https://www.torn.com/companies.php*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BRIDGE_VERSION = 1;
  const BTN_ID = 'hv-bridge-btn';
  const BANNER_ID = 'hv-bridge-banner';

  // ── Helpers ──────────────────────────────────────────────

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
        if (Date.now() - start > (timeout || 15000)) return reject(new Error('Timeout waiting for ' + selector));
        setTimeout(poll, 300);
      })();
    });
  }

  function showBanner(msg, isErr) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = [
        'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
        'padding:10px 20px', 'border-radius:8px', 'font-family:monospace', 'font-size:13px',
        'z-index:99999', 'pointer-events:none', 'transition:opacity .4s',
        'box-shadow:0 4px 20px rgba(0,0,0,.5)'
      ].join(';');
      document.body.appendChild(banner);
    }
    banner.style.background = isErr ? '#3a1010' : '#0d1f14';
    banner.style.border = '1px solid ' + (isErr ? '#cc4444' : '#38c9a0');
    banner.style.color = isErr ? '#ff6b6b' : '#38c9a0';
    banner.style.opacity = '1';
    banner.textContent = msg;
    clearTimeout(banner._t);
    banner._t = setTimeout(() => { banner.style.opacity = '0'; }, 4000);
  }

  // ── Core: read sold-daily values from DOM ────────────────

  function readSoldData() {
    const stockForm = document.querySelector("form[action*='stock']");
    if (!stockForm) return null;

    const list = stockForm.querySelector('.stock-list');
    if (!list) return null;

    const rows = list.querySelectorAll('li:not(.total):not(.quantity)');
    if (!rows.length) return null;

    const items = [];
    rows.forEach(row => {
      // Item name — Torn uses .name or the first text node of the li
      const nameEl = row.querySelector('.name') || row.querySelector('a') || row.querySelector('span');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;

      // sold-daily — TornTools renders this; the raw Torn page may also have it
      const sdEl = row.querySelector('.sold-daily');
      const soldQty = sdEl ? convertToNumber(sdEl.lastChild ? sdEl.lastChild.textContent : sdEl.textContent) : 0;

      // current qty
      const qtyEl = row.querySelector('.qty') || row.querySelector('.quantity-input') || row.querySelector('input[type="number"]');
      const currentQty = qtyEl ? convertToNumber(qtyEl.value || qtyEl.textContent) : null;

      items.push({ name, soldQty, currentQty });
    });

    return items.length ? items : null;
  }

  // ── Button injection ─────────────────────────────────────

  function injectButton(anchor) {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📊 Log to Dashboard';
    btn.title = 'Copy sold quantities to clipboard for HighVibes Dashboard';

    // Match TornTools button style as closely as possible
    btn.className = 'tt-btn';
    btn.style.cssText = 'margin-left:6px;background:#0d4a31;border:1px solid #38c9a0;color:#38c9a0;' +
      'border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:monospace;' +
      'transition:background .15s;white-space:nowrap;';
    btn.addEventListener('mouseenter', () => { btn.style.background = '#134d35'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0d4a31'; });

    btn.addEventListener('click', () => {
      const items = readSoldData();
      if (!items) {
        showBanner('✕ No stock data found. Make sure you are on the Stock tab.', true);
        return;
      }

      const payload = JSON.stringify({ v: BRIDGE_VERSION, ts: Date.now(), items });

      try {
        GM_setClipboard(payload);
        showBanner(`✓ ${items.length} items copied — click PASTE BRIDGE in Dashboard → Stock`);
      } catch (e) {
        // Fallback to navigator.clipboard if GM_setClipboard unavailable
        navigator.clipboard.writeText(payload)
          .then(() => showBanner(`✓ ${items.length} items copied — click PASTE BRIDGE in Dashboard → Stock`))
          .catch(() => showBanner('✕ Clipboard write failed. Check browser permissions.', true));
      }
    });

    // Insert after anchor
    anchor.insertAdjacentElement('afterend', btn);
  }

  // ── Main ─────────────────────────────────────────────────

  async function init() {
    try {
      // Wait for the stock form to appear (user may need to click Stock tab)
      await waitForElement("form[action*='stock']", 20000);

      // Prefer injecting next to TornTools FILL STOCK button
      const ttBtn = document.querySelector('.tt-fill-stock');
      if (ttBtn) {
        injectButton(ttBtn);
        return;
      }

      // Fallback: inject after the first .order link in the stock form
      const orderLink = document.querySelector("form[action*='stock'] .order ~ a, form[action*='stock'] .order");
      if (orderLink) {
        injectButton(orderLink);
        return;
      }

      // Last resort: inject before the stock list
      const stockList = document.querySelector('.stock-list');
      if (stockList) {
        stockList.insertAdjacentElement('beforebegin', (() => {
          const wrap = document.createElement('div');
          wrap.style.marginBottom = '8px';
          return wrap;
        })());
        injectButton(stockList.previousElementSibling);
      }
    } catch (e) {
      // Timeout or missing DOM — user may not be on stock tab yet.
      // Re-observe for hash/tab changes.
    }

    // Re-run on hash change (Torn uses hash navigation for company tabs)
    window.addEventListener('hashchange', () => {
      if (location.hash.includes('option=stock') || location.hash.includes('tab=stock')) {
        setTimeout(init, 800);
      }
    });
  }

  // Torn companies page uses hash fragments for tabs — wait for stock tab
  function onReady() {
    // Check if already on stock tab
    if (location.hash.includes('option=stock') || document.querySelector("form[action*='stock']")) {
      init();
    }
    // Listen for navigation to stock tab
    window.addEventListener('hashchange', () => {
      setTimeout(() => {
        if (!document.getElementById(BTN_ID)) init();
      }, 600);
    });
    // Also observe DOM changes (SPA navigation)
    const obs = new MutationObserver(() => {
      if (document.querySelector("form[action*='stock']") && !document.getElementById(BTN_ID)) {
        init();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

})();
