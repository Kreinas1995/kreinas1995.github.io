// ==UserScript==
// @name         HV Dashboard Bridge
// @namespace    highvibes
// @version      2.0.0
// @description  Bridges Torn pages to HighVibes dashboards. Stock tab → Company Dashboard. Museum page → FactionBudget inventory counts.
// @author       HighVibes
// @match        https://www.torn.com/companies.php*
// @match        https://www.torn.com/museum.php*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Shared constants ──────────────────────────────────────

  const BRIDGE_VERSION    = 1;
  const BTN_ID_STOCK      = 'hv-bridge-btn';
  const BTN_ID_INV        = 'hv-inv-bridge-btn';
  const BANNER_ID         = 'hv-bridge-banner';

  // ── Canonical museum set item names ──────────────────────
  // Keep in sync with FactionBudget PLUSHIE_SET / FLOWER_SET constants.
  const PLUSHIE_SET = new Set([
    'Camel Plushie','Chamois Plushie','Jaguar Plushie','Kitten Plushie','Lion Plushie',
    'Monkey Plushie','Nessie Plushie','Panda Plushie','Red Fox Plushie','Sheep Plushie',
    'Stingray Plushie','Teddy Bear Plushie','Wolverine Plushie'
  ]);
  const FLOWER_SET = new Set([
    'African Violet','Banana Orchid','Ceibo Flower','Cherry Blossom','Crocus',
    'Dahlia','Edelweiss','Heather','Orchid','Peony','Tribulus Omanense'
  ]);
  const MUSEUM_SET = new Set([...PLUSHIE_SET, ...FLOWER_SET]);

  // ════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ════════════════════════════════════════════════════════

  function toInt(str) {
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
      banner.style.cssText = [
        'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
        'padding:10px 20px', 'border-radius:8px', 'font-family:monospace', 'font-size:13px',
        'z-index:99999', 'pointer-events:none', 'transition:opacity .4s',
        'box-shadow:0 4px 20px rgba(0,0,0,.5)', 'max-width:90vw', 'text-align:center'
      ].join(';');
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

  function makeButton(id, label, title) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = (
      'margin-left:6px;background:#0d4a31;border:1px solid #38c9a0;color:#38c9a0;' +
      'border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:monospace;' +
      'transition:background .15s;white-space:nowrap;'
    );
    btn.addEventListener('mouseenter', () => { btn.style.background = '#134d35'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0d4a31'; });
    return btn;
  }

  function writeClipboard(text, onSuccess, onFail) {
    try {
      GM_setClipboard(text);
      onSuccess();
    } catch (e) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(onFail);
    }
  }

  // ════════════════════════════════════════════════════════
  // MODULE A — STOCK (companies.php)
  // Unchanged from HV Stock Bridge v1.0.0 — backward compatible.
  // ════════════════════════════════════════════════════════

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
      const soldQty = sdEl ? toInt(sdEl.lastChild ? sdEl.lastChild.textContent : sdEl.textContent) : 0;

      const qtyEl = row.querySelector('.qty') || row.querySelector('.quantity-input') || row.querySelector('input[type="number"]');
      const currentQty = qtyEl ? toInt(qtyEl.value || qtyEl.textContent) : null;

      items.push({ name, soldQty, currentQty });
    });

    return items.length ? items : null;
  }

  function injectStockButton(anchor) {
    if (document.getElementById(BTN_ID_STOCK)) return;
    const btn = makeButton(BTN_ID_STOCK, '📊 Log to Dashboard', 'Copy sold quantities to clipboard for HighVibes Company Dashboard');

    btn.addEventListener('click', () => {
      const items = readSoldData();
      if (!items) {
        showBanner('✕ No stock data found. Make sure you are on the Stock tab.', true);
        return;
      }
      // No type field = stock payload (backward compat with CompanyDashboard)
      const payload = JSON.stringify({ v: BRIDGE_VERSION, ts: Date.now(), items });
      writeClipboard(
        payload,
        () => showBanner(`✓ ${items.length} items copied — click PASTE BRIDGE in Company Dashboard → Stock`),
        () => showBanner('✕ Clipboard write failed. Check browser permissions.', true)
      );
    });

    anchor.insertAdjacentElement('afterend', btn);
  }

  async function initStock() {
    try {
      await waitForElement("form[action*='stock']", 20000);

      const ttBtn = document.querySelector('.tt-fill-stock');
      if (ttBtn) { injectStockButton(ttBtn); return; }

      const orderLink = document.querySelector("form[action*='stock'] .order ~ a, form[action*='stock'] .order");
      if (orderLink) { injectStockButton(orderLink); return; }

      const stockList = document.querySelector('.stock-list');
      if (stockList) {
        const wrap = document.createElement('div');
        wrap.style.marginBottom = '8px';
        stockList.insertAdjacentElement('beforebegin', wrap);
        injectStockButton(stockList.previousElementSibling);
      }
    } catch (e) {
      // Timeout — user may not be on stock tab yet; hashchange handler will retry
    }
  }

  function onReadyStock() {
    if (location.hash.includes('option=stock') || document.querySelector("form[action*='stock']")) {
      initStock();
    }
    window.addEventListener('hashchange', () => {
      setTimeout(() => { if (!document.getElementById(BTN_ID_STOCK)) initStock(); }, 600);
    });
    const obs = new MutationObserver(() => {
      if (document.querySelector("form[action*='stock']") && !document.getElementById(BTN_ID_STOCK)) initStock();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ════════════════════════════════════════════════════════
  // MODULE B — INVENTORY (museum.php)
  // Scrapes plushie + flower qtys; writes clipboard payload
  // for FactionBudget → Inventory → PASTE BRIDGE.
  // ════════════════════════════════════════════════════════

  /**
   * Read museum item quantities from the DOM.
   *
   * The Torn museum page renders two exchange sections (Plushie Set, Exotic Flower Set).
   * Each section contains item tiles; each tile has:
   *   - Item name: text label above the tile image card (in a <p> or heading element)
   *   - Quantity: number badge overlaid on the image card (typically bottom-right of the card img)
   *
   * We use a multi-strategy approach because Torn's markup can shift between
   * base page and TornTools-augmented page.
   *
   * Returns [{name, qty}] for all museum set items found, or null if nothing found.
   */
  function readMuseumData() {
    const found = {};

    // ── Strategy 1: TornTools augmented DOM ──
    // TornTools typically renders museum items as list items with
    // a .museum-items__item or similar class, name in a heading/p,
    // qty in a .qty or .amount span.
    const ttItems = document.querySelectorAll(
      '.museum-items__item, .museum-item, [class*="museum"][class*="item"]'
    );
    if (ttItems.length) {
      ttItems.forEach(el => {
        const nameEl = el.querySelector('[class*="name"], p, h3, h4, span');
        const name = nameEl ? nameEl.textContent.trim() : '';
        if (!name || !MUSEUM_SET.has(name)) return;

        const qtyEl = el.querySelector('[class*="qty"], [class*="amount"], [class*="count"], [class*="quantity"]');
        const qty = qtyEl ? toInt(qtyEl.textContent) : 0;
        found[name] = qty;
      });
    }

    // ── Strategy 2: Raw Torn markup ──
    // Base Torn page: item tiles inside an exchange section,
    // each tile is a <li> containing an <img> and a name.
    // Qty badge is a <span> or <div> overlaid on the image cell.
    if (!Object.keys(found).length) {
      // Find all exchange sections by heading text
      const allSections = document.querySelectorAll('.exchange-section, .items-wrap, [class*="exchange"], [class*="items-list"]');
      allSections.forEach(section => {
        const tiles = section.querySelectorAll('li, .item, [class*="item-tile"]');
        tiles.forEach(tile => {
          // Name is usually in the first text node or a dedicated label element
          // above or beside the image
          let name = '';
          const labelEl = tile.querySelector('p, .name, [class*="name"], h3, h4');
          if (labelEl) {
            name = labelEl.textContent.trim();
          } else {
            // Try direct text nodes
            for (const node of tile.childNodes) {
              if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                name = node.textContent.trim();
                break;
              }
            }
          }
          if (!name || !MUSEUM_SET.has(name)) return;

          // Qty badge — overlaid number on the image card
          const qtyEl = tile.querySelector('[class*="qty"], [class*="amount"], [class*="count"], [class*="num"]');
          const qty = qtyEl ? toInt(qtyEl.textContent) : 0;
          found[name] = qty;
        });
      });
    }

    // ── Strategy 3: Broad sweep — find all elements whose text exactly
    //    matches a museum item name, then look at siblings for a number ──
    if (!Object.keys(found).length) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nameNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (MUSEUM_SET.has(text)) nameNodes.push({ name: text, node });
      }
      nameNodes.forEach(({ name, node }) => {
        if (name in found) return; // already captured
        // Look for a number in nearby siblings/parent
        const parent = node.parentElement;
        if (!parent) return;
        const container = parent.closest('li, .item, [class*="tile"], [class*="wrap"]') || parent.parentElement;
        if (!container) return;
        // Find first numeric text content that looks like a quantity
        let qty = 0;
        const all = container.querySelectorAll('*');
        for (const el of all) {
          const t = el.textContent.trim();
          if (/^\d+$/.test(t) && !el.children.length) {
            qty = parseInt(t, 10);
            break;
          }
        }
        found[name] = qty;
      });
    }

    const items = Object.entries(found).map(([name, qty]) => ({ name, qty }));
    return items.length ? items : null;
  }

  function injectInventoryButton() {
    if (document.getElementById(BTN_ID_INV)) return;

    const btn = makeButton(BTN_ID_INV, '📦 Sync to FactionBudget', 'Copy plushie & flower counts to clipboard for FactionBudget → Inventory → PASTE BRIDGE');

    btn.addEventListener('click', () => {
      const items = readMuseumData();
      if (!items) {
        showBanner('✕ No museum items found. Try scrolling the page to let items load, then try again.', true);
        return;
      }

      const plushies = items.filter(i => PLUSHIE_SET.has(i.name));
      const flowers  = items.filter(i => FLOWER_SET.has(i.name));
      const missing  = 24 - items.length;

      const payload = JSON.stringify({
        v: BRIDGE_VERSION,
        type: 'hvInventoryBridge',
        ts: Date.now(),
        items
      });

      writeClipboard(
        payload,
        () => {
          const detail = `${plushies.length}/13 plushies, ${flowers.length}/11 flowers`;
          const warn = missing > 0 ? ` (${missing} items not found in DOM)` : '';
          showBanner(`✓ ${items.length} items copied (${detail})${warn} — click PASTE BRIDGE in FactionBudget → Inventory`);
        },
        () => showBanner('✕ Clipboard write failed. Check browser permissions.', true)
      );
    });

    // Inject into the page: prefer a Torn action bar; fall back to prepending before the first exchange section
    const anchor = (
      document.querySelector('.museum-exchange__header, .exchange-header, .page-head-section') ||
      document.querySelector('.museum-items, .exchange-section, [class*="exchange"]') ||
      document.querySelector('h2, h3')
    );

    if (anchor) {
      anchor.insertAdjacentElement('beforebegin', (() => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin:6px 0 10px;';
        wrap.appendChild(btn);
        return wrap;
      })());
    } else {
      // Nuclear fallback: inject at top of body
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:sticky;top:0;z-index:9000;padding:6px 10px;background:#0a0d0f;';
      wrap.appendChild(btn);
      document.body.insertAdjacentElement('afterbegin', wrap);
    }
  }

  async function initInventory() {
    try {
      // Museum page is not an SPA — items should be present after load.
      // Wait for any recognizable item container.
      await waitForElement(
        '.museum-items__item, .museum-item, [class*="museum"][class*="item"], .exchange-section li, .items-wrap li',
        15000
      );
    } catch (e) {
      // Items didn't appear — inject button anyway so user can try manually
    }
    injectInventoryButton();
  }

  function onReadyInventory() {
    initInventory();
    // Re-inject if TornTools rewrites the DOM after initial load
    const obs = new MutationObserver(() => {
      if (!document.getElementById(BTN_ID_INV)) injectInventoryButton();
    });
    // Only watch for major structural changes (not every text update)
    obs.observe(document.body, { childList: true, subtree: false });
  }

  // ════════════════════════════════════════════════════════
  // ROUTER — dispatch based on current page
  // ════════════════════════════════════════════════════════

  function route() {
    const path = location.pathname;
    if (path.includes('companies.php')) {
      onReadyStock();
    } else if (path.includes('museum.php')) {
      onReadyInventory();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', route);
  } else {
    route();
  }

})();
