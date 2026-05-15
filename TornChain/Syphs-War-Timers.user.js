// ==UserScript==
// @name         Syph's War Timers
// @namespace    https://torn.com/
// @version      2.8.6
// @description  Hospital timers + abroad labels with directionality, multi-tier war sorting, color-coded urgency, ALIVE on release.
// @author       Sypharius [2348580]
// @match        https://www.torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/Syphs-War-Timers.user.js
// @updateURL    https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/Syphs-War-Timers.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ── Cross-script shared window ───────────────────────────────────────────────
  // Tampermonkey on Firefox sandboxes each script's `window`. Use unsafeWindow
  // so SWT and TCC can see each other's properties.
  const _xw = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

  // ─── Storage keys ────────────────────────────────────────────────────────────
  const STORAGE_API_KEY      = "torn_public_api_key";
  const STORAGE_SHOW_KEY     = "hospital_show_key_anyfaction";
  const STORAGE_MINIMIZED    = "hospital_minimized_anyfaction";
  const STORAGE_SORT         = "hospital_sort_enabled";
  const STORAGE_ENABLED      = "swt_enabled";
  const STORAGE_SHOW_FRIENDLY = "swt_show_friendly";
  const STORAGE_SHOW_ENEMY   = "swt_show_enemy";

  let apiKey       = (GM_getValue(STORAGE_API_KEY,       "") || "").trim();
  let showKey      = !!GM_getValue(STORAGE_SHOW_KEY,     false);
  let minimized    = !!GM_getValue(STORAGE_MINIMIZED,    false);
  let sortEnabled  = !!GM_getValue(STORAGE_SORT,         false);
  let enabled      = GM_getValue(STORAGE_ENABLED,        true)  !== false;
  let showFriendly = GM_getValue(STORAGE_SHOW_FRIENDLY,  true)  !== false;
  let showEnemy    = GM_getValue(STORAGE_SHOW_ENEMY,     true)  !== false;

  // ─── Page context helpers ────────────────────────────────────────────────────
  function getViewedFactionId() {
    const m = location.search.match(/viewFaction=(\d+)/i);
    return m ? m[1] : null;
  }
  function isEnemyPage() { return !!getViewedFactionId(); }

  // ─── Bridge (exposed for TCC integration) ────────────────────────────────────
  // TCC reads/writes settings via this object rather than calling GM APIs directly.
  function syncBridge() {
    if (!_xw.__swtBridge) return;
    _xw.__swtBridge.enabled      = enabled;
    _xw.__swtBridge.showKey      = showKey;
    _xw.__swtBridge.sortEnabled  = sortEnabled;
    _xw.__swtBridge.showFriendly = showFriendly;
    _xw.__swtBridge.showEnemy    = showEnemy;
    _xw.__swtBridge.apiKey       = apiKey;
  }

  _xw.__swtBridge = {
    installed:    true,
    version:      "2.8.6",
    enabled,
    showKey,
    sortEnabled,
    showFriendly,
    showEnemy,
    apiKey,

    setEnabled(v) {
      enabled = !!v;
      GM_setValue(STORAGE_ENABLED, enabled);
      syncBridge();
      if (!enabled) restoreAllCells();
    },
    setSort(v) {
      sortEnabled = !!v;
      GM_setValue(STORAGE_SORT, sortEnabled);
      syncBridge();
      if (!sortEnabled) restoreOriginalOrder();
      // sync sort bar checkbox if present
      const cb = document.getElementById("hosp-sort-cb");
      if (cb) cb.checked = sortEnabled;
    },
    setShowFriendly(v) {
      showFriendly = !!v;
      GM_setValue(STORAGE_SHOW_FRIENDLY, showFriendly);
      syncBridge();
      if (!showFriendly && !isEnemyPage()) restoreAllCells();
    },
    setShowEnemy(v) {
      showEnemy = !!v;
      GM_setValue(STORAGE_SHOW_ENEMY, showEnemy);
      syncBridge();
      if (!showEnemy && isEnemyPage()) restoreAllCells();
    },
    setShowKey(v) {
      showKey = !!v;
      GM_setValue(STORAGE_SHOW_KEY, showKey);
      syncBridge();
      refreshKeyDisplay();
    },
    setApiKey(key) {
      apiKey = String(key || "").trim();
      GM_setValue(STORAGE_API_KEY, apiKey);
      syncBridge();
      for (const k of Object.keys(playerCache)) delete playerCache[k];
      refreshKeyDisplay();
    },
    getApiKeyMasked() { return maskKey(apiKey); },
  };

  // ─── Cache ──────────────────────────────────────────────────────────────────
  // { [userId]: { state, until, country, traveling, respect, ts } }
  // state: "hospital" | "okay" | "abroad" | "unknown"
  // traveling: "returning" | "leaving" | null
  const playerCache  = Object.create(null);
  const inFlight     = new Set();

  // ─── Styles ─────────────────────────────────────────────────────────────────
  GM_addStyle(`
    .hospital-timer {
      font-family: monospace !important;
      font-weight: 700 !important;
      font-size: 12px !important;
      letter-spacing: -0.5px !important;
      white-space: nowrap !important;
      display: block !important;
      vertical-align: middle !important;
      text-align: center !important;
    }

    .hospital-timer.abroad-label {
      font-size: 9px !important;
      letter-spacing: 0px !important;
      white-space: normal !important;
      word-break: normal !important;
      overflow-wrap: break-word !important;
      line-height: 1.1 !important;
      text-align: center !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      vertical-align: middle !important;
    }

    /* Center the status cell itself when we own it */
    [data-orig-html] {
      text-align: center !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    }

    #hospital-box {
      position: fixed;
      left: 12px;
      bottom: 12px;
      width: 280px;
      padding: 10px;
      border-radius: 12px;
      background: rgba(20,20,25,.92);
      color: #fff;
      z-index: 99999;
      font-family: Arial, Helvetica, sans-serif;
      box-shadow: 0 10px 26px rgba(0,0,0,.35);
      user-select: none;
    }
    #hospital-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
    }
    #hospital-sub   { font-size:12px; opacity:.9; margin-top:4px; }
    #hospital-body  { margin-top:8px; }
    #hospital-key {
      width:100%; margin-top:6px; padding:7px; border-radius:10px;
      border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.08);
      color:#fff; font-size:12px; cursor:default; box-sizing:border-box;
    }
    #hospital-status { margin-top:6px; font-size:11px; opacity:.9; line-height:1.25; }
    #hospital-steps {
      margin-top:8px; font-size:11px; opacity:.78; line-height:1.3;
      padding-top:8px; border-top:1px solid rgba(255,255,255,.10);
    }
    #hospital-tip   { margin-top:8px; font-size:11px; opacity:.82; line-height:1.3; }
    #hospital-button {
      margin-top:8px; width:100%; padding:7px; border-radius:10px;
      border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.12);
      color:#fff; font-size:12px; cursor:pointer; transition:background .15s ease;
    }
    #hospital-button:hover { background:rgba(255,255,255,.22); }
    .hidden { display:none; }
  `);

  // ─── Floating box ───────────────────────────────────────────────────────────
  const box = document.createElement("div");
  box.id = "hospital-box";
  box.innerHTML = `
    <div id="hospital-header">
      <span>Syph's War Timers</span>
      <span id="hospital-toggle">${minimized ? "＋" : "−"}</span>
    </div>
    <div id="hospital-body" class="${minimized ? "hidden" : ""}">
      <div id="hospital-sub">Hospital timers, abroad tracking &amp; war sorting for faction pages</div>
      <input id="hospital-key" readonly>
      <div id="hospital-status">Idle</div>
      <div id="hospital-steps">
        <div><strong>Steps:</strong></div>
        <div>Step 1: Add Public API key in Tampermonkey menu.</div>
      </div>
      <div id="hospital-tip">
        If it helps, feel free to send <strong>1 Xanax</strong> as a thanks to
        <strong>Sypharius [2348580]</strong>.
      </div>
      <button id="hospital-button">Sypharius</button>
    </div>
  `;
  document.body.appendChild(box);

  const keyInput = document.getElementById("hospital-key");
  const statusEl = document.getElementById("hospital-status");
  const bodyEl   = document.getElementById("hospital-body");
  const toggleEl = document.getElementById("hospital-toggle");

  function setStatus(msg) { statusEl.textContent = msg; }

  function maskKey(k) {
    if (!k) return "";
    if (k.length <= 8) return "••••••••";
    return `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
  }
  function refreshKeyDisplay() {
    keyInput.value = apiKey
      ? (showKey ? apiKey : maskKey(apiKey))
      : "No API key set (use Tampermonkey menu)";
  }

  document.getElementById("hospital-header").onclick = () => {
    minimized = !minimized;
    GM_setValue(STORAGE_MINIMIZED, minimized);
    bodyEl.classList.toggle("hidden", minimized);
    toggleEl.textContent = minimized ? "＋" : "−";
  };
  document.getElementById("hospital-button").onclick = () => {
    window.open("https://www.torn.com/profiles.php?XID=2348580", "_blank");
  };

  // ─── Tampermonkey menu ──────────────────────────────────────────────────────
  GM_registerMenuCommand("Set Public API Key", () => {
    const input = prompt("Enter your Torn Public API key:", apiKey || "");
    if (input === null) return;
    apiKey = String(input).trim();
    GM_setValue(STORAGE_API_KEY, apiKey);
    for (const k of Object.keys(playerCache)) delete playerCache[k];
    refreshKeyDisplay();
    setStatus(apiKey ? "API key saved" : "API key cleared");
  });
  GM_registerMenuCommand("Clear API Key", () => {
    apiKey = "";
    GM_setValue(STORAGE_API_KEY, "");
    for (const k of Object.keys(playerCache)) delete playerCache[k];
    refreshKeyDisplay();
    setStatus("API key cleared");
  });
  GM_registerMenuCommand(showKey ? "Hide API Key" : "Show API Key", () => {
    showKey = !showKey;
    GM_setValue(STORAGE_SHOW_KEY, showKey);
    refreshKeyDisplay();
  });

  // ─── Timer helpers ──────────────────────────────────────────────────────────
  function formatTime(seconds) {
    const sec = Math.max(0, Math.floor(seconds));
    const h   = Math.floor(sec / 3600);
    const m   = Math.floor((sec % 3600) / 60);
    const s   = sec % 60;
    const mm  = String(m).padStart(2, "0");
    const ss  = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function getTimerColor(seconds) {
    if (seconds > 2700) return "#ff4444";   // > 45m
    if (seconds > 900)  return "#ff8c00";   // 15–45m
    if (seconds > 300)  return "#ffcc66";   // 5–15m
    return "#44ff88";                        // < 5m
  }

  function formatCountryLabel(cached) {
    const country = (cached.country || "Abroad").trim();
    if (cached.traveling === "leaving")   return `➡️ ${country}`;   // Torn → Destination
    if (cached.traveling === "returning") return `${country} ⬅️`;   // Destination → Torn
    return country;
  }

  // ─── DOM helpers ────────────────────────────────────────────────────────────
  function getUserIdFromProfileLink(a) {
    const m = a?.href?.match(/XID=(\d+)/);
    return m ? m[1] : null;
  }

  function findStatusNodeForRow(row) {
    return (
      row.querySelector(".status") ||
      row.querySelector('[class*="status"]') ||
      row.querySelector('span[title*="Status"]') ||
      null
    );
  }

  // ─── Span inject / restore ──────────────────────────────────────────────────
  // Strategy: save raw innerHTML once, replace entire cell with just our span,
  // restore innerHTML to undo. Simple, no CSS fights.

  function injectSpan(statusNode, span) {
    if (!("origHtml" in statusNode.dataset)) {
      statusNode.dataset.origHtml = statusNode.innerHTML;
    }
    // Replace cell content with our span every time — idempotent and always correct
    if (statusNode.firstChild !== span || statusNode.childNodes.length !== 1) {
      statusNode.innerHTML = "";
      statusNode.appendChild(span);
    }
  }

  function restoreCell(statusNode) {
    if ("origHtml" in statusNode.dataset) {
      statusNode.innerHTML = statusNode.dataset.origHtml;
      delete statusNode.dataset.origHtml;
    }
  }

  function restoreAllCells() {
    for (const a of document.querySelectorAll('a[href*="profiles.php?XID="]')) {
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row) continue;
      const statusNode = findStatusNodeForRow(row);
      if (statusNode) restoreCell(statusNode);
    }
  }

  function getOrCreateSpan(statusNode) {
    // Reuse existing span if present
    return statusNode.querySelector(".hospital-timer") || (() => {
      const s = document.createElement("span");
      s.className = "hospital-timer";
      return s;
    })();
  }

  // ─── Sort bar ───────────────────────────────────────────────────────────────
  let sortBarInjected = false;

  function injectSortBar() {
    if (sortBarInjected || document.getElementById("hosp-sort-bar")) return;

    const links = Array.from(document.querySelectorAll('a[href*="profiles.php?XID="]'));
    let firstRow = null;
    for (const a of links) {
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr");
      if (!row) continue;
      if (!findStatusNodeForRow(row)) continue;
      firstRow = row;
      break;
    }
    if (!firstRow) return;

    const parent = firstRow.parentElement;
    if (!parent) return;

    const bar = document.createElement(firstRow.tagName);
    bar.id = "hosp-sort-bar";
    bar.className = firstRow.className;
    bar.style.cssText = `
      display:flex !important; align-items:center !important;
      padding:6px 10px !important; gap:8px !important;
      font-family:Arial,Helvetica,sans-serif !important;
      font-size:12px !important; color:#fff !important;
      cursor:default !important; box-sizing:border-box !important;
    `;
    bar.innerHTML = `
      <input type="checkbox" id="hosp-sort-cb" ${sortEnabled ? "checked" : ""}
        style="width:15px;height:15px;margin:0;cursor:pointer;accent-color:#ffcc66;flex-shrink:0;">
      <label for="hosp-sort-cb" style="cursor:pointer;line-height:1;white-space:nowrap;">
        War Sorting
      </label>
      <div style="margin-left:auto;display:flex;gap:6px;font-size:11px;font-weight:700;font-family:monospace;">
        <span style="color:#ff4444">&gt;45m</span>
        <span style="color:#ff8c00">15-45m</span>
        <span style="color:#ffcc66">5-15m</span>
        <span style="color:#44ff88">&lt;5m</span>
      </div>
    `;
    parent.insertBefore(bar, firstRow);
    sortBarInjected = true;

    document.getElementById("hosp-sort-cb").addEventListener("change", e => {
      sortEnabled = e.target.checked;
      GM_setValue(STORAGE_SORT, sortEnabled);
      if (!sortEnabled) restoreOriginalOrder();
    });
  }

  // ─── Original order stamping ────────────────────────────────────────────────
  function stampOriginalOrder() {
    const links = Array.from(document.querySelectorAll('a[href*="profiles.php?XID="]'));
    for (const a of links) {
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row || row.id === "hosp-sort-bar" || row.dataset.originalIndex !== undefined) continue;
      // Only stamp member roster rows
      if (!findStatusNodeForRow(row)) continue;
      const parent = row.parentElement;
      if (!parent) continue;
      row.dataset.originalIndex = Array.from(parent.children).indexOf(row);
    }
  }

  // ─── Sort ───────────────────────────────────────────────────────────────────
  function getRowSortKey(userId) {
    const now    = Date.now() / 1000;
    const cached = playerCache[userId];

    // No data yet — use DOM state as fallback for rough ordering
    if (!cached) {
      const a = document.querySelector(`a[href*="XID=${userId}"]`);
      const row = a && (a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement);
      const domState = getTornDomState(findStatusNodeForRow(row));
      if (domState === "okay")    return { tier: 0, val: 0 };
      if (domState === "hospital") return { tier: 1, val: 99999 };
      if (domState === "abroad")   return { tier: 2, val: 0 };
      return { tier: 99, val: 0 };
    }

    // Tier 0: Okay (attackable now) — sorted by score desc if available
    if (cached.state === "okay") {
      return { tier: 0, val: 0 };
    }

    // Tier 1: Hospital — sorted by time remaining asc (soonest out = top)
    if (cached.state === "hospital") {
      const rem = cached.until ? (cached.until - now) : 0;
      if (rem <= 0) return { tier: 0, val: 0 }; // timer expired = effectively okay
      return { tier: 1, val: rem };
    }

    // Tier 2: Abroad — returning first, then leaving, then static
    if (cached.state === "abroad") {
      const sub = cached.traveling === "returning" ? 0
                : cached.traveling === "leaving"   ? 1
                : 2;
      return { tier: 2, val: sub };
    }

    // Tier 3: Federal jail, fallen, or unknown — last
    return { tier: 3, val: 0 };
  }

  function sortAllRows() {
    const links    = Array.from(document.querySelectorAll('a[href*="profiles.php?XID="]'));
    const byParent = new Map();

    for (const a of links) {
      const userId = getUserIdFromProfileLink(a);
      if (!userId) continue;
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row || row.id === "hosp-sort-bar") continue;
      // Only sort rows that have a status cell — excludes chain log, attack log, etc.
      if (!findStatusNodeForRow(row)) continue;
      const parent = row.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push({ row, userId });
    }

    for (const [parent, group] of byParent) {
      const ranked = group.map(e => ({ ...e, ...getRowSortKey(e.userId) }));
      ranked.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : a.val - b.val);

      const indices    = ranked.map(e => Array.from(parent.children).indexOf(e.row));
      const anchorIndex = Math.min(...indices.filter(i => i >= 0));

      for (let i = 0; i < ranked.length; i++) {
        const refNode = parent.children[anchorIndex + i] || null;
        if (refNode !== ranked[i].row) parent.insertBefore(ranked[i].row, refNode);
      }
    }
  }

  function restoreOriginalOrder() {
    const links    = Array.from(document.querySelectorAll('a[href*="profiles.php?XID="]'));
    const byParent = new Map();
    for (const a of links) {
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row || row.dataset.originalIndex === undefined) continue;
      // Only restore rows that have a status cell
      if (!findStatusNodeForRow(row)) continue;
      const parent = row.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push({ row, idx: parseInt(row.dataset.originalIndex, 10) });
    }
    for (const [parent, group] of byParent) {
      group.sort((a, b) => a.idx - b.idx);
      for (const { row } of group) parent.appendChild(row);
    }
  }

  // ─── API fetch ──────────────────────────────────────────────────────────────
  function fetchUser(userId) {
    return new Promise(resolve => {
      // Only use `profile` — public access, works on any user ID
      // travel + personalstats require minimal/limited key on own ID only
      const url = `https://api.torn.com/user/${encodeURIComponent(userId)}` +
                  `?selections=profile&key=${encodeURIComponent(apiKey)}`;
      GM_xmlhttpRequest({
        method: "GET", url, timeout: 15000,
        onload(r) {
          let data = null;
          try { data = JSON.parse(r.responseText); } catch { /**/ }

          // status.state: "Okay" | "Hospital" | "Traveling" | "Abroad" | "Jail" | "Fallen" | "Federal"
          const rawState = (data?.status?.state || "").toLowerCase();
          let state = "unknown";
          if      (rawState === "hospital")                    state = "hospital";
          else if (rawState === "okay")                        state = "okay";
          else if (rawState === "abroad" || rawState === "traveling") state = "abroad";

          // Hospital release time is in profile.states.hospital_timestamp
          // status.until is 0 when not applicable, not null
          const until = data?.states?.hospital_timestamp || 0;

          // Abroad: direction inferred from status.description
          // Torn description formats (may vary by version):
          // Leaving:   "Traveling to Switzerland"
          //            "Traveling from Torn to South Africa"
          // Returning: "Returning to Torn from Switzerland"
          //            "Traveling from Canada to Torn"
          // Static:    "In Switzerland"
          const desc = (data?.status?.description || "").toLowerCase();
          const rawDesc = data?.status?.description || "";
          let traveling = null;
          let country   = null;
          if (state === "abroad") {
            // Returning: ends with "to Torn" or contains "returning"
            if (desc.includes("returning") || /to torn$/i.test(desc)) {
              traveling = "returning";
              // "Traveling from Canada to Torn" → extract between "from" and "to Torn"
              // "Returning to Torn from Switzerland" → extract after last "from"
              const m1 = rawDesc.match(/from\s+(.+?)\s+to\s+torn/i);
              const m2 = rawDesc.match(/from\s+(.+)$/i);
              country = (m1 ? m1[1] : m2 ? m2[1] : null);
              if (country) country = country.replace(/\s*to\s+torn\s*$/i, "").trim();
              if (!country) country = "Abroad";
            } else if (desc.includes("traveling") || desc.includes("to ")) {
              traveling = "leaving";
              // "Traveling to Switzerland" → after last "to "
              // "Traveling from Torn to South Africa" → after last "to "
              const m = rawDesc.match(/to\s+(?!torn\b)(.+)$/i);
              country = m ? m[1].trim() : null;
              if (!country) country = rawDesc.replace(/traveling.*?to\s*/i, "").trim() || "Abroad";
            } else if (desc.startsWith("in ")) {
              traveling = null;
              const m = rawDesc.match(/^in\s+(.+)$/i);
              country = m ? m[1].trim() : null;
            }
            if (!country) country = rawDesc || "Abroad";
          }

          // Respect: profile doesn't expose faction respect for other users
          // Use 0 — sort by respect is a nice-to-have, not critical
          const respect = 0;

          playerCache[userId] = { state, until, country, traveling, respect, ts: Date.now() };
          resolve();
        },
        onerror()   { playerCache[userId] = { state:"unknown", until:0, country:null, traveling:null, respect:0, ts:Date.now() }; resolve(); },
        ontimeout() { playerCache[userId] = { state:"unknown", until:0, country:null, traveling:null, respect:0, ts:Date.now() }; resolve(); },
      });
    });
  }

  const CACHE_TTL_MS   = 60_000;
  const CHUNK_SIZE     = 15;
  const CHUNK_DELAY_MS = 4_000;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchChunked(userIds, label) {
    const chunks = [];
    for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
      chunks.push(userIds.slice(i, i + CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      setStatus(`${label}: ${i + 1}/${chunks.length} (${chunk.length})...`);
      for (const id of chunk) inFlight.add(id);
      await Promise.all(chunk.map(id => fetchUser(id)));
      for (const id of chunk) inFlight.delete(id);
      if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
    }
  }

  async function batchFetch(userIds) {
    if (!userIds.length) return;
    const now = Date.now();

    const priority   = [];
    const background = [];

    for (const id of userIds) {
      if (inFlight.has(id)) continue;
      const c = playerCache[id];
      if (c && (now - c.ts) < CACHE_TTL_MS) continue;

      const a = document.querySelector(`a[href*="XID=${id}"]`);
      const row = a && (a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement);
      const statusNode = row && findStatusNodeForRow(row);
      const domState = getTornDomState(statusNode);

      if (domState === "hospital" || domState === "abroad") {
        priority.push(id);
      } else {
        background.push(id);
      }
    }

    if (!priority.length && !background.length) return;

    if (priority.length) {
      await fetchChunked(priority, `Hosp/Abroad ${priority.length}`);
      const tracked = Object.values(playerCache).filter(c => c.state === "hospital" || c.state === "abroad").length;
      setStatus(`${tracked} hosp/abroad — fetching ${background.length} okay...`);
    }

    if (background.length) {
      fetchChunked(background, `Okay ${background.length}`).then(() => {
        const tracked = Object.values(playerCache).filter(c => c.state === "hospital" || c.state === "abroad").length;
        setStatus(`${tracked} hosp/abroad — all loaded`);
      });
    }
  }

  // ─── Collect all member user IDs on the page ────────────────────────────────
  // Also reads Torn's live DOM status text per user so we can detect state changes
  function getTornDomState(statusNode) {
    if (!statusNode) return "unknown";
    // Read raw DOM text — if we've injected, origHtml has the original
    const html = statusNode.dataset.origHtml || statusNode.innerHTML;
    const tmp  = document.createElement("div");
    tmp.innerHTML = html;
    const t = tmp.textContent.trim().toLowerCase();
    if (t.includes("hospital")) return "hospital";
    if (t.includes("abroad") || t.includes("traveling")) return "abroad";
    if (t.includes("okay"))    return "okay";
    return "other";
  }

  function collectAllUsers() {
    const seen    = new Set();
    const userIds = [];
    for (const a of document.querySelectorAll('a[href*="profiles.php?XID="]')) {
      const userId = getUserIdFromProfileLink(a);
      if (!userId || seen.has(userId)) continue;
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row || row.id === "hosp-sort-bar") continue;
      const statusNode = findStatusNodeForRow(row);
      if (!statusNode) continue;
      seen.add(userId);
      userIds.push(userId);

      // Bust cache if DOM state doesn't match cached state — catches revives,
      // re-hospitalizations, and returns from abroad within the cache TTL window
      const domState    = getTornDomState(statusNode);
      const cachedState = playerCache[userId]?.state;
      if (cachedState && domState !== "other" && domState !== "unknown" && domState !== cachedState) {
        delete playerCache[userId];
      }
    }
    return userIds;
  }

  // ─── Tick: update displays ──────────────────────────────────────────────────
  function updatePageTimers() {
    if (!enabled) return;
    if (isEnemyPage() && !showEnemy) return;
    if (!isEnemyPage() && !showFriendly) return;
    const now = Date.now() / 1000;

    for (const a of document.querySelectorAll('a[href*="profiles.php?XID="]')) {
      const userId = getUserIdFromProfileLink(a);
      if (!userId) continue;
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row || row.id === "hosp-sort-bar") continue;
      const statusNode = findStatusNodeForRow(row);
      if (!statusNode) continue;

      const cached  = playerCache[userId];
      const domState = getTornDomState(statusNode);

      // No cache yet but Torn shows hospital/abroad — show spinner
      if (!cached) {
        if (domState === "hospital" || domState === "abroad") {
          const span = getOrCreateSpan(statusNode);
          span.className    = "hospital-timer";
          span.textContent  = "⏳";
          span.style.color  = "#aaaaaa";
          injectSpan(statusNode, span);
        } else {
          restoreCell(statusNode);
        }
        continue;
      }

      const { state, until } = cached;

      // Okay / unknown — restore Torn's text
      if (state === "okay" || state === "unknown") {
        restoreCell(statusNode);
        continue;
      }

      // Hospital or abroad — take over the cell
      const span = getOrCreateSpan(statusNode);
      injectSpan(statusNode, span);

      if (state === "hospital") {
        span.className = "hospital-timer";
        const remaining = until ? (until - now) : 0;
        if (remaining <= 0) {
          span.textContent = "ALIVE";
          span.style.color  = "#44ff88";
        } else {
          span.textContent = formatTime(remaining);
          span.style.color  = getTimerColor(remaining);
        }
        continue;
      }

      if (state === "abroad") {
        span.className = "hospital-timer abroad-label";
        span.innerHTML = formatCountryLabel(cached);
        span.style.color  = cached.traveling === "returning" ? "#ffcc66" : "#88aacc";
        continue;
      }
    }

    if (sortEnabled) sortAllRows();
  }

  // ─── Main loop ──────────────────────────────────────────────────────────────
  let scanRunning = false;

  async function scan() {
    if (scanRunning) return;
    // Bail early if disabled or page type is filtered out
    if (!enabled) { restoreAllCells(); return; }
    if (isEnemyPage() && !showEnemy) { restoreAllCells(); return; }
    if (!isEnemyPage() && !showFriendly) { restoreAllCells(); return; }
    scanRunning = true;
    try {
      if (!apiKey) { setStatus("No API key set (use Tampermonkey menu)"); return; }
      // Do DOM work immediately — don't wait for fetch
      injectSortBar();
      stampOriginalOrder();
      const userIds = collectAllUsers();
      if (!userIds.length) { setStatus("No members found"); return; }
      // Fetch runs async — UI already set up above
      await batchFetch(userIds);
    } finally {
      scanRunning = false;
    }
  }

  // Try injecting the sort bar early on boot before first scan completes
  function tryEarlyInject() {
    injectSortBar();
    stampOriginalOrder();
    if (!sortBarInjected) setTimeout(tryEarlyInject, 500);
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  refreshKeyDisplay();
  setStatus(apiKey ? "Running..." : "No API key set");

  // Write cross-page installed signal so TCC can detect SWT on any Torn page
  try { localStorage.setItem("swt_installed", "1"); } catch(e) {}

  // Hide SWT's own floating box when TCC is detected — TCC owns the UI.
  // Poll until TCC is detected — no timeout.
  (function hideSwtBoxIfTcc() {
    function tryHide() {
      try {
        if (_xw.__tccRunning) {
          const b = document.getElementById("hospital-box");
          if (b) b.style.display = "none";
          return true;
        }
      } catch(e) {}
      return false;
    }
    if (tryHide()) return;
    const iv = setInterval(() => {
      try { if (tryHide()) clearInterval(iv); } catch(e) { clearInterval(iv); }
    }, 500);
  })();

  // Inherit TCC's API key after a short delay — gives TCC time to write it first.
  // Only runs if SWT has no key of its own.
  setTimeout(() => {
    try {
      if (!apiKey) {
        const inherited = (localStorage.getItem("tcc_api_key") || "").trim();
        if (inherited) {
          apiKey = inherited;
          GM_setValue(STORAGE_API_KEY, apiKey);
          if (_xw.__swtBridge) _xw.__swtBridge.apiKey = apiKey;
          refreshKeyDisplay();
          setStatus("Running...");
        }
      }
    } catch(e) {}
  }, 3000);

  tryEarlyInject();  // inject sort bar as soon as DOM is ready, no fetch delay
  scan();
  setInterval(() => { try { scan(); } catch(e) { console.warn("[SWT] scan error", e); } }, 5000);
  setInterval(() => { try { updatePageTimers(); } catch(e) { console.warn("[SWT] timer error", e); } }, 1000);

})();
