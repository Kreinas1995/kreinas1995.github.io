// ==UserScript==
// @name         Torn Chain Coordinator
// @namespace    https://kreinas1995.github.io/
// @version      2.1.0
// @description  Shared real-time chain scheduling board. Faction-isolated, Firebase-backed, draggable panel.
// @author       Kreinas1995
// @match        https://www.torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      firebaseio.com
// @connect      googleapis.com
// @updateURL    https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js
// @downloadURL  https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  CONFIG — fill in after Firebase setup. See FIREBASE_SETUP.md           ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const FIREBASE_DB_URL  = "https://syph-s-war-overhaul-default-rtdb.firebaseio.com";
  const FIREBASE_API_KEY = "AIzaSyATeusVjS6_S0JlSVu6su4jghnTRiy2I5w";

  const POLL_MS = 8000;

  // ─── Timer model ──────────────────────────────────────────────────────────
  // Each hit gets a 5-minute window from when the PREVIOUS hit becomes "due".
  // A hit becomes "due" when the live chain timer on the page drops to ≤ 60s.
  // HIT_WINDOW = how long a claimed hit stays open before the next one is due.
  const HIT_WINDOW_MS   = 5 * 60 * 1000;   // 5 min window per hit
  const DUE_THRESHOLD   = 60 * 1000;        // flag "due" when ≤ 1 min left

  // ─── GM storage keys ──────────────────────────────────────────────────────
  const SK_API_KEY    = "chain_api_key";
  const SK_PANEL_SIZE = "chain_panel_size";
  const SK_MINIMIZED  = "chain_panel_minimized";
  const SK_POS_X      = "chain_pos_x";
  const SK_POS_Y      = "chain_pos_y";

  // ─── State ────────────────────────────────────────────────────────────────
  let tornApiKey  = (GM_getValue(SK_API_KEY, "") || "").trim();
  let panelSize   =  GM_getValue(SK_PANEL_SIZE, 0.5);
  let minimized   = !!GM_getValue(SK_MINIMIZED, false);
  let hitList     = [];
  let ownName     = "Me";
  let ownId       = null;
  let factionId   = null;
  let factionName = "";
  let fbToken     = null;
  let sseSource   = null;

  // ══════════════════════════════════════════════════════════════════════════
  //  CSS
  // ══════════════════════════════════════════════════════════════════════════
  GM_addStyle(`
    /* ── Target claim button — sits inline right of Attack link ─── */
    .chain-target-btn {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      margin-left:4px !important; padding:0 5px !important; height:22px !important; min-width:22px !important;
      border-radius:5px !important; border:1px solid rgba(255,200,0,.5) !important;
      background:rgba(255,180,0,.15) !important; color:#ffd700 !important;
      font-size:13px !important; cursor:pointer !important; vertical-align:middle !important;
      line-height:1 !important; transition:background .12s !important; flex-shrink:0 !important;
      position:relative !important; top:0 !important;
    }
    .chain-target-btn:hover    { background:rgba(255,180,0,.35) !important; }
    .chain-target-btn:disabled { opacity:.4 !important; cursor:default !important; }
    .chain-target-btn.claimed  { background:rgba(68,255,136,.2) !important; border-color:rgba(68,255,136,.6) !important; color:#44ff88 !important; }
    .chain-target-btn.loading  { animation:chain-blink .6s linear infinite !important; }
    @keyframes chain-blink { 0%,100%{opacity:1} 50%{opacity:.3} }

    /* Force attack cell to lay out horizontally */
    .chain-attack-cell {
      display:inline-flex !important; align-items:center !important; flex-wrap:nowrap !important;
      gap:0 !important;
    }

    /* ── Panel ───────────────────────────────────────────────────── */
    #chain-panel {
      position:fixed !important; z-index:999999 !important;
      border-radius:12px !important; background:rgba(16,18,24,.96) !important; color:#e8e8e8 !important;
      box-shadow:0 12px 32px rgba(0,0,0,.6) !important; font-family:Arial,Helvetica,sans-serif !important;
      user-select:none !important; overflow:hidden !important; display:flex !important;
      flex-direction:column !important; min-width:280px !important;
      touch-action:none !important;
    }

    /* ── Header — drag handle ────────────────────────────────────── */
    #chain-panel-header {
      display:flex !important; align-items:center !important; gap:5px !important;
      padding:8px 10px !important; background:rgba(255,255,255,.055) !important;
      border-bottom:1px solid rgba(255,255,255,.08) !important; flex-shrink:0 !important;
      cursor:grab !important;
    }
    #chain-panel-header:active { cursor:grabbing !important; }
    #chain-panel-title {
      font-weight:700 !important; font-size:13px !important; flex:1 !important;
      white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important;
    }

    /* ── Chain timer bar ─────────────────────────────────────────── */
    #chain-timer-bar {
      display:flex !important; align-items:center !important; gap:6px !important;
      padding:5px 10px !important; background:rgba(0,0,0,.25) !important;
      border-bottom:1px solid rgba(255,255,255,.06) !important; flex-shrink:0 !important;
      font-size:11px !important;
    }
    #chain-timer-label { color:#778 !important; white-space:nowrap !important; }
    #chain-timer-value {
      font-family:monospace !important; font-weight:700 !important; font-size:14px !important;
      flex:1 !important; white-space:nowrap !important;
    }
    #chain-timer-value.ct-ok      { color:#44ff88 !important; }
    #chain-timer-value.ct-warn    { color:#ffcc66 !important; }
    #chain-timer-value.ct-danger  { color:#ff5555 !important; animation:chain-pulse 1s ease-in-out infinite alternate !important; }
    #chain-timer-value.ct-none    { color:#445 !important; }
    #chain-count-badge {
      font-size:11px !important; font-weight:700 !important; padding:1px 7px !important;
      border-radius:8px !important; white-space:nowrap !important;
    }
    #chain-count-badge.warming { background:rgba(255,160,0,.18) !important; color:#ffaa44 !important; border:1px solid rgba(255,160,0,.3) !important; }
    #chain-count-badge.running { background:rgba(68,255,136,.12) !important; color:#44ff88 !important; border:1px solid rgba(68,255,136,.25) !important; }
    #chain-count-badge.none    { display:none !important; }
    #chain-warming-msg {
      font-size:10px !important; color:#ffaa44 !important; padding:3px 10px !important;
      background:rgba(255,140,0,.07) !important; border-bottom:1px solid rgba(255,140,0,.12) !important;
      text-align:center !important; flex-shrink:0 !important; letter-spacing:.2px !important;
    }

    /* ── Header buttons ──────────────────────────────────────────── */
    .chain-hbtn {
      background:rgba(255,255,255,.1) !important; border:1px solid rgba(255,255,255,.15) !important;
      color:#ccc !important; border-radius:6px !important; padding:2px 7px !important;
      font-size:11px !important; cursor:pointer !important; line-height:1.4 !important; white-space:nowrap !important;
      flex-shrink:0 !important;
    }
    .chain-hbtn:hover       { background:rgba(255,255,255,.2) !important; }
    .chain-hbtn.danger      { border-color:rgba(255,80,80,.45) !important; color:#ff8888 !important; }
    .chain-hbtn.danger:hover{ background:rgba(255,60,60,.22) !important; }

    /* ── API button ──────────────────────────────────────────────── */
    #chain-api-btn {
      background:rgba(100,160,255,.18) !important; border:1px solid rgba(100,160,255,.4) !important;
      color:#88bbff !important; border-radius:5px !important; padding:2px 6px !important;
      font-size:10px !important; font-weight:700 !important; cursor:pointer !important;
      letter-spacing:.3px !important; line-height:1.5 !important; white-space:nowrap !important; flex-shrink:0 !important;
    }
    #chain-api-btn:hover    { background:rgba(100,160,255,.3) !important; }
    #chain-api-btn.has-key  { background:rgba(68,255,136,.12) !important; border-color:rgba(68,255,136,.35) !important; color:#44ff88 !important; }

    /* ── Sync dot ────────────────────────────────────────────────── */
    #chain-sync-dot {
      width:7px; height:7px; border-radius:50%; flex-shrink:0; background:#334; transition:background .3s;
    }
    #chain-sync-dot.live    { background:#44ff88; }
    #chain-sync-dot.syncing { background:#ffcc66; }
    #chain-sync-dot.error   { background:#ff4444; }

    /* ── API popover ─────────────────────────────────────────────── */
    #chain-api-popover {
      display:none; position:absolute; top:40px; left:8px; z-index:1000001;
      background:rgba(20,22,30,.98); border:1px solid rgba(100,160,255,.3);
      border-radius:10px; padding:12px; box-shadow:0 8px 24px rgba(0,0,0,.65);
      width:240px; flex-direction:column; gap:8px; font-family:Arial,Helvetica,sans-serif;
    }
    #chain-api-popover.open { display:flex !important; }
    #chain-api-popover-title { font-size:11px; font-weight:700; color:#88bbff; }
    #chain-api-input {
      width:100%; box-sizing:border-box; background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.15); border-radius:6px; color:#e8e8e8;
      padding:5px 8px; font-size:11px; font-family:monospace; outline:none;
    }
    #chain-api-input:focus { border-color:rgba(100,160,255,.5) !important; }
    #chain-api-popover-row { display:flex; gap:6px; }
    .chain-api-pop-btn {
      flex:1; padding:4px 0; border-radius:6px; font-size:11px; cursor:pointer;
      border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.08); color:#ccc;
    }
    .chain-api-pop-btn:hover  { background:rgba(255,255,255,.18); }
    .chain-api-pop-btn.save   { background:rgba(68,255,136,.15); border-color:rgba(68,255,136,.4); color:#44ff88; }
    .chain-api-pop-btn.save:hover { background:rgba(68,255,136,.28); }
    .chain-api-pop-btn.clear  { background:rgba(255,80,80,.12); border-color:rgba(255,80,80,.35); color:#ff8888; }
    .chain-api-pop-btn.clear:hover { background:rgba(255,60,60,.25); }
    #chain-api-status { font-size:10px; color:#445; text-align:center; min-height:14px; }

    /* ── Panel body ──────────────────────────────────────────────── */
    #chain-panel-body { display:flex !important; flex-direction:column !important; flex:1 !important; overflow:hidden !important; }

    /* ── Banners ─────────────────────────────────────────────────── */
    .chain-banner { padding:5px 10px !important; font-size:11px !important; text-align:center !important; flex-shrink:0 !important; line-height:1.3 !important; }
    .chain-banner.warn { color:#ff8888; background:rgba(255,60,60,.08); border-bottom:1px solid rgba(255,60,60,.15); }
    .chain-banner.info { color:#88aacc; background:rgba(80,120,200,.08); border-bottom:1px solid rgba(80,120,200,.15); }

    /* ── Column header ───────────────────────────────────────────── */
    #chain-col-header {
      display:grid !important; grid-template-columns:26px 1fr 1fr 58px 20px 20px !important;
      gap:0 5px !important; padding:4px 10px !important; font-size:10px !important;
      text-transform:uppercase !important; letter-spacing:.5px !important; color:#445 !important;
      border-bottom:1px solid rgba(255,255,255,.06) !important; flex-shrink:0 !important;
    }

    /* ── Hit list ────────────────────────────────────────────────── */
    #chain-panel-inner {
      overflow-y:auto !important; flex:1 !important; max-height:380px !important; padding:4px 0 !important;
    }
    #chain-panel-inner::-webkit-scrollbar { width:5px; }
    #chain-panel-inner::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:3px; }

    .chain-hit-row {
      display:grid !important; grid-template-columns:26px 1fr 1fr 58px 20px 20px !important;
      align-items:center !important; gap:0 5px !important; padding:4px 10px !important;
      border-left:3px solid transparent !important; font-size:11px !important; transition:background .1s !important;
    }
    .chain-hit-row:hover   { background:rgba(255,255,255,.04) !important; }
    .chain-hit-row.due     { border-left-color:#44ff88 !important; animation:chain-pulse 1s ease-in-out infinite alternate !important; }
    .chain-hit-row.soon    { border-left-color:#ffcc66 !important; }
    .chain-hit-row.waiting { border-left-color:#445 !important; }
    .chain-hit-row.done    { opacity:.4 !important; text-decoration:line-through !important; border-left-color:#222 !important; }
    .chain-hit-row.hosp-waiting { border-left-color:#6699cc !important; background:rgba(80,120,200,.04) !important; }
    .chain-hit-row.hosp-waiting .chain-hit-target::before { content:"🏥 " !important; }
    .chain-hit-row.hosp-waiting .chain-hit-attack { opacity:.25 !important; pointer-events:none !important; }
    @keyframes chain-pulse { from{background:rgba(68,255,136,.04)} to{background:rgba(68,255,136,.14)} }

    .chain-hit-num     { font-weight:700; font-size:12px; color:#556; text-align:center; }
    .chain-hit-claimer { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9aa8c0; }
    .chain-hit-target  { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; color:#e0e0e0; }
    .chain-hit-timer   { font-family:monospace !important; font-size:12px !important; font-weight:700 !important; text-align:right !important; white-space:nowrap !important; }
    .chain-hit-timer.due  { color:#44ff88 !important; }
    .chain-hit-timer.soon { color:#ffcc66 !important; }
    .chain-hit-timer.wait { color:#556677 !important; }
    .chain-hit-timer.done { color:#333 !important; }
    .chain-hit-hosp-sub {
      grid-column:4 !important; font-size:9px !important; color:#6699cc !important;
      font-family:monospace !important; text-align:right !important; margin-top:-2px !important; white-space:nowrap !important;
    }
    .chain-hit-attack {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      text-decoration:none !important; font-size:13px !important; border-radius:4px !important;
      width:20px !important; height:20px !important; background:rgba(255,80,80,.15) !important;
      border:1px solid rgba(255,80,80,.3) !important; cursor:pointer !important; transition:background .1s !important;
    }
    .chain-hit-attack:hover { background:rgba(255,80,80,.35) !important; }
    .chain-row-btn {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      font-size:11px !important; width:20px !important; height:20px !important; border-radius:4px !important;
      border:1px solid rgba(255,255,255,.12) !important; background:rgba(255,255,255,.06) !important;
      cursor:pointer !important; padding:0 !important; transition:background .1s !important;
    }
    .chain-row-btn:hover { background:rgba(255,255,255,.18) !important; }

    /* ── Footer / slider ─────────────────────────────────────────── */
    #chain-panel-footer {
      padding:6px 10px !important; border-top:1px solid rgba(255,255,255,.06) !important;
      display:flex !important; align-items:center !important; gap:8px !important; flex-shrink:0 !important;
    }
    #chain-size-label  { font-size:10px; color:#445; white-space:nowrap; }
    #chain-size-slider { flex:1 !important; accent-color:#ffcc66 !important; cursor:pointer !important; }
  `);

  // ══════════════════════════════════════════════════════════════════════════
  //  Panel HTML
  // ══════════════════════════════════════════════════════════════════════════
  const panel = document.createElement("div");
  panel.id = "chain-panel";

  // Restore saved position or default to top-right
  const savedX = GM_getValue(SK_POS_X, null);
  const savedY = GM_getValue(SK_POS_Y, null);
  if (savedX !== null && savedY !== null) {
    panel.style.left = savedX + "px";
    panel.style.top  = savedY + "px";
    panel.style.right = "auto";
  } else {
    panel.style.right = "12px";
    panel.style.top   = "60px";
  }

  panel.innerHTML = `
    <div id="chain-panel-header">
      <button id="chain-api-btn" title="Set Torn API key">API</button>
      <span id="chain-panel-title">⛓ Chain Board</span>
      <span id="chain-sync-dot" title="Sync status"></span>
      <button class="chain-hbtn" id="chain-toggle-btn">${minimized ? "＋" : "−"}</button>
      <button class="chain-hbtn danger" id="chain-clear-btn">✕</button>

      <div id="chain-api-popover">
        <div id="chain-api-popover-title">🔑 Torn API Key</div>
        <input id="chain-api-input" type="password" placeholder="Paste your API key here" autocomplete="off" spellcheck="false">
        <div id="chain-api-popover-row">
          <button class="chain-api-pop-btn save" id="chain-api-save">Save</button>
          <button class="chain-api-pop-btn clear" id="chain-api-clear">Clear</button>
          <button class="chain-api-pop-btn" id="chain-api-cancel">Cancel</button>
        </div>
        <div id="chain-api-status"></div>
      </div>
    </div>

    <!-- Always-visible chain timer bar -->
    <div id="chain-timer-bar">
      <span id="chain-timer-label">⛓ Chain</span>
      <span id="chain-timer-value" class="ct-none">—</span>
      <span id="chain-count-badge" class="none">0</span>
    </div>
    <div id="chain-warming-msg" style="display:none">🔥 Chain warming up — keep hitting!</div>

    <div id="chain-panel-body">
      <div id="chain-banner-nokey"  class="chain-banner warn" style="display:none">⚠ No API key — click the API button above.</div>
      <div id="chain-banner-nofb"   class="chain-banner warn" style="display:none">⚠ Firebase not configured — see FIREBASE_SETUP.md.</div>
      <div id="chain-banner-nofact" class="chain-banner info" style="display:none">ℹ Not in a faction — queue unavailable.</div>
      <div id="chain-banner-status" class="chain-banner info" style="display:none"></div>
      <div id="chain-col-header" style="display:none">
        <span>#</span><span>Claimer</span><span>Target</span>
        <span style="text-align:right">Window</span><span></span><span></span>
      </div>
      <div id="chain-panel-inner">
        <div style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.6">
          No hits queued.<br>Click 🎯 next to an attack button to add a target.
        </div>
      </div>
      <div id="chain-panel-footer">
        <span id="chain-size-label">Size</span>
        <input type="range" id="chain-size-slider" min="0" max="100" value="${Math.round(panelSize * 100)}">
      </div>
    </div>`;
  document.body.appendChild(panel);

  // ── Element refs ──────────────────────────────────────────────────────────
  const panelBody    = document.getElementById("chain-panel-body");
  const toggleBtn    = document.getElementById("chain-toggle-btn");
  const clearBtn     = document.getElementById("chain-clear-btn");
  const sizeSlider   = document.getElementById("chain-size-slider");
  const syncDot      = document.getElementById("chain-sync-dot");
  const apiBtn       = document.getElementById("chain-api-btn");
  const apiPopover   = document.getElementById("chain-api-popover");
  const apiInput     = document.getElementById("chain-api-input");
  const apiSave      = document.getElementById("chain-api-save");
  const apiClear     = document.getElementById("chain-api-clear");
  const apiCancel    = document.getElementById("chain-api-cancel");
  const apiStatus    = document.getElementById("chain-api-status");
  const chainTimerVal= document.getElementById("chain-timer-value");
  const chainCountBadge = document.getElementById("chain-count-badge");
  const warmingMsg   = document.getElementById("chain-warming-msg");

  // ── Minimise toggle ───────────────────────────────────────────────────────
  toggleBtn.onclick = () => {
    minimized = !minimized;
    GM_setValue(SK_MINIMIZED, minimized);
    panelBody.style.display = minimized ? "none" : "flex";
    toggleBtn.textContent = minimized ? "＋" : "−";
  };
  if (minimized) panelBody.style.display = "none";

  // ── Clear ─────────────────────────────────────────────────────────────────
  clearBtn.onclick = () => {
    if (!factionId) return;
    if (!confirm("Clear the entire chain list for your faction?")) return;
    fbWrite([]);
  };

  // ── Size slider ───────────────────────────────────────────────────────────
  sizeSlider.oninput = () => {
    panelSize = sizeSlider.value / 100;
    GM_setValue(SK_PANEL_SIZE, panelSize);
    panel.style.width = Math.round(280 + panelSize * 320) + "px";
  };
  panel.style.width = Math.round(280 + panelSize * 320) + "px";

  // ── Sync dot ──────────────────────────────────────────────────────────────
  function setSyncDot(state) {
    syncDot.className = state === "off" ? "" : state;
    syncDot.title = { live:"Live ✓", syncing:"Syncing…", error:"Sync error", off:"Offline" }[state] || "";
  }

  // ── Banner helper ─────────────────────────────────────────────────────────
  function showBanner(id, show, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = show ? "" : "none";
    if (text !== undefined) el.textContent = text;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  API Popover
  // ══════════════════════════════════════════════════════════════════════════
  function openApiPopover() {
    apiInput.value = tornApiKey || "";
    apiStatus.textContent = tornApiKey ? "Key is set ✓" : "No key saved";
    apiStatus.style.color = tornApiKey ? "#44ff88" : "#556";
    apiPopover.classList.add("open");
    setTimeout(() => apiInput.focus(), 50);
  }
  function closeApiPopover() { apiPopover.classList.remove("open"); }

  apiBtn.addEventListener("click", e => {
    e.stopPropagation();
    apiPopover.classList.contains("open") ? closeApiPopover() : openApiPopover();
  });
  apiSave.onclick = () => {
    const val = apiInput.value.trim();
    if (!val) { apiStatus.textContent = "Please enter a key."; apiStatus.style.color="#ff8888"; return; }
    tornApiKey = val;
    GM_setValue(SK_API_KEY, tornApiKey);
    apiStatus.textContent = "Saved — connecting…";
    apiStatus.style.color = "#ffcc66";
    updateApiBtn();
    setTimeout(closeApiPopover, 700);
    fetchOwnProfile();
  };
  apiClear.onclick = () => {
    tornApiKey = "";
    GM_setValue(SK_API_KEY, "");
    apiInput.value = "";
    apiStatus.textContent = "Key cleared.";
    apiStatus.style.color = "#ff8888";
    updateApiBtn();
    showBanner("chain-banner-nokey", true);
  };
  apiCancel.onclick = closeApiPopover;
  apiInput.addEventListener("keydown", e => { if (e.key === "Enter") apiSave.click(); });
  document.addEventListener("click", e => {
    if (!apiPopover.contains(e.target) && e.target !== apiBtn) closeApiPopover();
  });
  function updateApiBtn() {
    apiBtn.classList.toggle("has-key", !!tornApiKey);
    apiBtn.title = tornApiKey
      ? `API key set (${ownName}) — click to change`
      : "Set Torn API key";
  }
  updateApiBtn();

  // ══════════════════════════════════════════════════════════════════════════
  //  Draggable panel (mouse + touch)
  // ══════════════════════════════════════════════════════════════════════════
  (function makeDraggable() {
    const handle = document.getElementById("chain-panel-header");
    let dragging = false, startX, startY, origLeft, origTop;

    function dragStart(cx, cy) {
      dragging = true;
      startX = cx; startY = cy;
      const rect = panel.getBoundingClientRect();
      origLeft = rect.left;
      origTop  = rect.top;
      // Switch from right-anchored to left-anchored so transforms are predictable
      panel.style.right = "auto";
      panel.style.left  = origLeft + "px";
      panel.style.top   = origTop  + "px";
    }
    function dragMove(cx, cy) {
      if (!dragging) return;
      const dx = cx - startX, dy = cy - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  origLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, origTop  + dy));
      panel.style.left = newLeft + "px";
      panel.style.top  = newTop  + "px";
    }
    function dragEnd() {
      if (!dragging) return;
      dragging = false;
      GM_setValue(SK_POS_X, parseInt(panel.style.left));
      GM_setValue(SK_POS_Y, parseInt(panel.style.top));
    }

    // Mouse
    handle.addEventListener("mousedown", e => {
      if (e.target !== handle && !e.target.id.includes("chain-panel-title")) return;
      dragStart(e.clientX, e.clientY);
    });
    document.addEventListener("mousemove", e => dragMove(e.clientX, e.clientY));
    document.addEventListener("mouseup",   dragEnd);

    // Touch
    handle.addEventListener("touchstart", e => {
      if (e.target !== handle && !e.target.id.includes("chain-panel-title")) return;
      const t = e.touches[0];
      dragStart(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener("touchmove", e => {
      if (!dragging) return;
      e.preventDefault();
      const t = e.touches[0];
      dragMove(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener("touchend", dragEnd);
  })();

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain timer — read from the Torn page DOM
  // ══════════════════════════════════════════════════════════════════════════
  // Torn renders the chain timer in elements like:
  //   .chain-timer, [class*="chainTimer"], or a countdown inside the chain widget
  // We read it every second and reflect it in our header bar.

  let liveChainSecs  = null;   // null = not in a chain / not found
  let liveChainCount = null;

  function readTornChainTimer() {
    // Try several selectors Torn uses across page versions
    const timerSelectors = [
      '[class*="chainTimer"] [class*="counter"]',
      '[class*="chain-timer"]',
      '[class*="chainInfo"] [class*="timer"]',
      '.chain-bar [class*="time"]',
      '[class*="chain"] [class*="time"]:not(#chain-panel *)',
    ];
    let timerText = null;
    for (const sel of timerSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.match(/\d+:\d+/)) {
          timerText = el.textContent.trim();
          break;
        }
      } catch { /**/ }
    }

    // Parse mm:ss or hh:mm:ss
    if (timerText) {
      const parts = timerText.match(/(\d+):(\d+)(?::(\d+))?/);
      if (parts) {
        liveChainSecs = parts[3] !== undefined
          ? parseInt(parts[1])*3600 + parseInt(parts[2])*60 + parseInt(parts[3])
          : parseInt(parts[1])*60  + parseInt(parts[2]);
      }
    } else {
      liveChainSecs = null;
    }

    // Chain count
    const countSelectors = [
      '[class*="chainCount"]',
      '[class*="chain"] [class*="count"]:not(#chain-panel *)',
      '[class*="chain-hits"]',
    ];
    for (const sel of countSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && /^\d+$/.test(el.textContent.trim())) {
          liveChainCount = parseInt(el.textContent.trim());
          break;
        }
      } catch { /**/ }
    }

    updateChainTimerUI();
  }

  function updateChainTimerUI() {
    if (liveChainSecs === null) {
      chainTimerVal.textContent = "—";
      chainTimerVal.className   = "ct-none";
      chainCountBadge.className = "none";
      warmingMsg.style.display  = "none";
      return;
    }

    const mm = Math.floor(liveChainSecs / 60);
    const ss = liveChainSecs % 60;
    chainTimerVal.textContent = `${mm}:${String(ss).padStart(2,"0")}`;

    if (liveChainSecs <= 30)      chainTimerVal.className = "ct-danger";
    else if (liveChainSecs <= 90) chainTimerVal.className = "ct-warn";
    else                          chainTimerVal.className = "ct-ok";

    if (liveChainCount !== null) {
      chainCountBadge.textContent = liveChainCount;
      if (liveChainCount < 10) {
        chainCountBadge.className = "warming";
        warmingMsg.style.display  = "";
      } else {
        chainCountBadge.className = "running";
        warmingMsg.style.display  = "none";
      }
    } else {
      chainCountBadge.className = "none";
      warmingMsg.style.display  = "none";
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ══════════════════════════════════════════════════════════════════════════
  function escHtml(s) {
    return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function formatTime(ms) {
    if (ms <= 0) return "NOW";
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
  }
  function isHospStillIn(hit) { return !!(hit.hospReleaseAt && hit.hospReleaseAt > Date.now()); }

  // A hit is "due" = its window is open (trigged by chain timer ≤ 1 min)
  // We store windowStart on each hit (set when it becomes active).
  // Window closes after HIT_WINDOW_MS.
  function hitTimerClass(rem, status) {
    if (status==="done") return "done";
    if (rem<=0)          return "due";
    if (rem<=60000)      return "soon";
    return "wait";
  }
  function hitRowClass(rem, status, hosp) {
    if (status==="done") return "done";
    if (hosp)            return "hosp-waiting";
    if (rem<=0)          return "due";
    if (rem<=60000)      return "soon";
    return "waiting";
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Panel render
  // ══════════════════════════════════════════════════════════════════════════
  function renderPanel() {
    const inner   = document.getElementById("chain-panel-inner");
    const colHead = document.getElementById("chain-col-header");
    const titleEl = document.getElementById("chain-panel-title");
    if (!inner) return;

    if (titleEl) titleEl.textContent = factionName ? `⛓ ${factionName}` : "⛓ Chain Board";

    if (!hitList.length) {
      colHead.style.display = "none";
      inner.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.6">No hits queued.<br>Click 🎯 next to an attack button to add a target.</div>`;
      return;
    }

    colHead.style.display = "";
    const now = Date.now();
    let html  = "";

    for (const hit of hitList) {
      // Window timer: countdown from windowStart+HIT_WINDOW_MS, or scheduledAt if not yet started
      const windowEnd = hit.windowStart ? (hit.windowStart + HIT_WINDOW_MS) : hit.scheduledAt;
      const rem       = windowEnd - now;
      const hosp      = isHospStillIn(hit);
      const tc        = hitTimerClass(rem, hit.status);
      const rc        = hitRowClass(rem, hit.status, hosp);
      const timer     = hit.status === "done" ? "Done" : formatTime(rem);
      const hospSub   = hosp
        ? `<span class="chain-hit-hosp-sub" data-hosp-id="${hit.id}">out in ${formatTime(hit.hospReleaseAt - now)}</span>`
        : "";

      html += `
        <div class="chain-hit-row ${rc}" data-hit-id="${hit.id}">
          <span class="chain-hit-num">${hit.hitNumber}</span>
          <span class="chain-hit-claimer" title="${escHtml(hit.claimedBy)}">${escHtml(hit.claimedBy)}</span>
          <span class="chain-hit-target"  title="${escHtml(hit.targetName)}">${escHtml(hit.targetName)}</span>
          <span class="chain-hit-timer ${tc}" data-timer-id="${hit.id}" data-window-end="${windowEnd}">${timer}</span>
          <a class="chain-hit-attack" href="${escHtml(hit.attackUrl)}" target="_blank" title="Attack ${escHtml(hit.targetName)}">⚔</a>
          <button class="chain-row-btn chain-done-btn" data-hit-id="${hit.id}">${hit.status==="done" ? "↩" : "✓"}</button>
          ${hospSub}
        </div>`;
    }

    inner.innerHTML = html;

    inner.querySelectorAll(".chain-done-btn").forEach(btn => {
      btn.onclick = () => {
        const id      = btn.dataset.hitId;
        const updated = hitList.map(h =>
          h.id === id ? { ...h, status: h.status === "done" ? "pending" : "done" } : h
        );
        fbWrite(updated);
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Timer tick — 1s interval
  //  Also checks if the live chain timer hits ≤ 60s to open the next hit window
  // ══════════════════════════════════════════════════════════════════════════
  let chainDueTriggered = false;  // prevent repeated triggers in the same ≤60s window

  setInterval(() => {
    const now = Date.now();

    // ── Read chain timer from page ────────────────────────────────
    readTornChainTimer();

    // ── Open next hit window when chain timer ≤ 60s ───────────────
    // Find the first pending hit that hasn't had its window started yet
    if (liveChainSecs !== null && liveChainSecs <= 60 && !chainDueTriggered) {
      chainDueTriggered = true;
      const nextPending = hitList
        .filter(h => h.status === "pending" && !h.windowStart)
        .sort((a, b) => a.hitNumber - b.hitNumber)[0];
      if (nextPending) {
        // Open a 5-min window starting now
        const updated = hitList.map(h =>
          h.id === nextPending.id ? { ...h, windowStart: now } : h
        );
        fbWrite(updated);
      }
    }
    // Reset trigger when chain timer climbs back above 90s (fresh hit was made)
    if (liveChainSecs !== null && liveChainSecs > 90) {
      chainDueTriggered = false;
    }
    // Also reset if chain timer disappears (chain ended/reset)
    if (liveChainSecs === null) chainDueTriggered = false;

    // ── Update hit row timers ─────────────────────────────────────
    for (const hit of hitList) {
      if (hit.status === "done") continue;
      const windowEnd = hit.windowStart ? (hit.windowStart + HIT_WINDOW_MS) : hit.scheduledAt;
      const rem       = windowEnd - now;
      const hosp      = isHospStillIn(hit);
      const cell      = document.querySelector(`[data-timer-id="${hit.id}"]`);
      if (cell) {
        cell.textContent = formatTime(rem);
        cell.className   = `chain-hit-timer ${hitTimerClass(rem, hit.status)}`;
        const row = cell.closest(".chain-hit-row");
        if (row) row.className = `chain-hit-row ${hitRowClass(rem, hit.status, hosp)}`;
      }
      const hc = document.querySelector(`[data-hosp-id="${hit.id}"]`);
      if (hc) {
        if (!hosp) hc.remove();
        else hc.textContent = `out in ${formatTime(hit.hospReleaseAt - now)}`;
      }
    }
  }, 1000);

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase
  // ══════════════════════════════════════════════════════════════════════════
  function fbConfigured() {
    return FIREBASE_DB_URL  !== "https://YOUR-PROJECT-default-rtdb.firebaseio.com"
        && FIREBASE_API_KEY !== "YOUR_FIREBASE_WEB_API_KEY";
  }
  function fbPath() {
    return `${FIREBASE_DB_URL}/factions/${factionId}/hits.json${fbToken ? "?auth=" + fbToken : ""}`;
  }
  function fbSignInAnon(cb) {
    GM_xmlhttpRequest({
      method:"POST",
      url:`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify({returnSecureToken:true}),
      timeout:10000,
      onload(r)   { try { cb(JSON.parse(r.responseText).idToken||null); } catch { cb(null); } },
      onerror()   { cb(null); },
      ontimeout() { cb(null); },
    });
  }
  function fbWrite(newList) {
    if (!factionId || !fbConfigured()) return;
    setSyncDot("syncing");
    GM_xmlhttpRequest({
      method:"PUT", url:fbPath(),
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify(newList.length ? newList : null),
      timeout:10000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          hitList = newList;
          setSyncDot("live");
          renderPanel();
        } else { setSyncDot("error"); console.error("[ChainCoord] Write failed", r.status); }
      },
      onerror()   { setSyncDot("error"); },
      ontimeout() { setSyncDot("error"); },
    });
  }
  function fbRead() {
    if (!factionId || !fbConfigured()) return;
    GM_xmlhttpRequest({
      method:"GET", url:fbPath(), timeout:10000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          try {
            const d = JSON.parse(r.responseText);
            hitList = Array.isArray(d) ? d : [];
            setSyncDot("live");
            renderPanel();
          } catch { /**/ }
        }
      },
    });
  }
  function fbStartListener() {
    if (!factionId || !fbConfigured()) return;
    if (sseSource) { try { sseSource.close(); } catch { /**/ } }
    try {
      sseSource = new EventSource(`${FIREBASE_DB_URL}/factions/${factionId}/hits.json${fbToken ? "?auth=" + fbToken : ""}`);
      sseSource.addEventListener("put", e => {
        try {
          const p = JSON.parse(e.data);
          hitList = Array.isArray(p.data) ? p.data : [];
          setSyncDot("live");
          renderPanel();
        } catch { /**/ }
      });
      sseSource.onerror = () => { setSyncDot("error"); setTimeout(fbStartListener, 5000); };
    } catch (err) { console.warn("[ChainCoord] SSE unavailable:", err); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Scheduling
  //  Hits are queued in order. Each hit's "scheduledAt" is its intended
  //  position in the chain queue (used for ordering / hosp logic).
  //  The actual 5-min attack window is opened by the timer tick above
  //  when the live chain timer drops to ≤ 60s.
  // ══════════════════════════════════════════════════════════════════════════
  const HIT_INTERVAL = 5 * 60 * 1000;  // spacing for hosp scheduling purposes

  function scheduleAndWrite(apiData, targetId, targetName, attackUrl, btn) {
    const now            = Date.now();
    const state          = (apiData?.status?.state || "").toLowerCase();
    const hospReleaseSec = apiData?.states?.hospital_timestamp || 0;
    const isInHosp       = state === "hospital" && hospReleaseSec > 0;
    const hospReleaseMs  = isInHosp ? hospReleaseSec * 1000 : 0;
    const earliestAllowed = Math.max(now, hospReleaseMs);

    const activeHits = hitList
      .filter(h => h.status !== "done")
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    let insertSlot = null, insertPos = -1;

    if (activeHits.length === 0) {
      insertSlot = earliestAllowed;
    } else {
      for (let i = 0; i <= activeHits.length; i++) {
        const prev      = i === 0 ? now : activeHits[i - 1].scheduledAt;
        const candidate = Math.max(prev + HIT_INTERVAL, earliestAllowed);
        const next      = i < activeHits.length ? activeHits[i].scheduledAt : Infinity;
        if (candidate + HIT_INTERVAL <= next || i === activeHits.length) {
          insertSlot = candidate; insertPos = i - 1; break;
        }
      }
      if (insertSlot === null) {
        insertSlot = activeHits[activeHits.length - 1].scheduledAt + HIT_INTERVAL;
        insertPos  = activeHits.length - 1;
      }
    }

    for (let i = insertPos + 1; i < activeHits.length; i++) {
      const prevTime = i === 0 ? insertSlot : activeHits[i - 1].scheduledAt;
      const required = prevTime + HIT_INTERVAL;
      if (activeHits[i].scheduledAt < required) activeHits[i].scheduledAt = required;
    }

    const newHit = {
      id:            `hit_${now}_${Math.random().toString(36).slice(2)}`,
      hitNumber:     0,
      targetId,
      targetName:    apiData.name || targetName,
      claimedBy:     ownName,
      claimedAt:     now,
      scheduledAt:   insertSlot,
      hospReleaseAt: hospReleaseMs || null,
      windowStart:   null,   // set by timer tick when chain drops to ≤60s
      attackUrl,
      status:        "pending",
    };

    const merged = [
      ...activeHits, newHit,
      ...hitList.filter(h => h.status === "done"),
    ].sort((a, b) => {
      if (a.status==="done" && b.status!=="done") return 1;
      if (b.status==="done" && a.status!=="done") return -1;
      return a.scheduledAt - b.scheduledAt;
    });

    let counter = 1;
    merged.forEach(h => { if (h.status !== "done") h.hitNumber = counter++; });

    fbWrite(merged);

    btn.textContent = "✓";
    btn.classList.add("claimed");
    btn.title = isInHosp
      ? `Queued as hit #${newHit.hitNumber} — hosp out in ${formatTime(hospReleaseMs - Date.now())}`
      : `Queued as hit #${newHit.hitNumber}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  handleTargetClaim
  // ══════════════════════════════════════════════════════════════════════════
  function handleTargetClaim(btn, targetId, targetName, attackUrl) {
    if (!tornApiKey)    { alert("Click the API button to set your Torn API key first."); return; }
    if (!factionId)     { alert("Could not detect your faction — make sure your API key is set."); return; }
    if (!fbConfigured()){ alert("Firebase is not configured yet — see FIREBASE_SETUP.md."); return; }

    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "⏳";

    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/user/${encodeURIComponent(targetId)}?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout:15000,
      onload(r) {
        btn.disabled = false;
        btn.classList.remove("loading");
        let data = null;
        try { data = JSON.parse(r.responseText); } catch { /**/ }

        if (!data || data.error) {
          btn.textContent = "🎯";
          alert(`Torn API error: ${data?.error?.error || "Unknown"}`);
          return;
        }

        const state = (data?.status?.state || "").toLowerCase();
        if (["abroad","traveling","jail","federal","fallen"].some(s => state.includes(s))) {
          btn.textContent = "🎯";
          alert(`${targetName} is ${state} — cannot be scheduled.`);
          return;
        }

        scheduleAndWrite(data, targetId, targetName, attackUrl, btn);
      },
      onerror()   { btn.disabled=false; btn.classList.remove("loading"); btn.textContent="🎯"; alert("Network error."); },
      ontimeout() { btn.disabled=false; btn.classList.remove("loading"); btn.textContent="🎯"; alert("Request timed out."); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Button injection — inline with Attack link
  // ══════════════════════════════════════════════════════════════════════════
  function extractAttackUrl(a) {
    const h = a?.href || "";
    if (h.includes("loader.php") && h.includes("sid=attack")) return h;
    return h.startsWith("http") ? h : "https://www.torn.com" + h;
  }
  function getTargetId(a) {
    let m = (a?.href||"").match(/user2ID=(\d+)/i);
    if (m) return m[1];
    m = (a.getAttribute("onclick")||"").match(/(\d{4,9})/);
    return m ? m[1] : null;
  }
  function getTargetName(row) {
    const a = row.querySelector('a[href*="profiles.php?XID="]');
    if (a) return (a.textContent||"").trim();
    const el = row.querySelector('[class*="name"]') || row.querySelector("strong") || row.querySelector("b");
    return el ? (el.textContent||"").trim() : "Unknown";
  }

  function injectTargetButtons() {
    document.querySelectorAll('a[href*="loader.php?sid=attack"], a[href*="sid=attack"]').forEach(a => {
      // Skip anything inside our own panel
      if (panel.contains(a)) return;
      if (a.dataset.chainBtnInjected) return;

      const targetId = getTargetId(a);
      if (!targetId) return;
      if (ownId && targetId === ownId) return;

      a.dataset.chainBtnInjected = "1";

      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      const targetName = row ? getTargetName(row) : "Unknown";
      const attackUrl  = extractAttackUrl(a);

      // Wrap attack link + button in an inline-flex container so they sit side by side
      const wrapper = document.createElement("span");
      wrapper.className = "chain-attack-cell";

      // Move the <a> into the wrapper
      a.parentNode.insertBefore(wrapper, a);
      wrapper.appendChild(a);

      const btn = document.createElement("button");
      btn.className   = "chain-target-btn";
      btn.textContent = "🎯";
      btn.title       = `Add ${targetName} to chain queue`;
      btn.onclick     = e => { e.preventDefault(); e.stopPropagation(); handleTargetClaim(btn, targetId, targetName, attackUrl); };
      wrapper.appendChild(btn);
    });
  }

  let injectQueued = false;
  new MutationObserver(() => {
    if (injectQueued) return;
    injectQueued = true;
    setTimeout(() => { injectQueued = false; injectTargetButtons(); }, 150);
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(injectTargetButtons, 3000);

  // ══════════════════════════════════════════════════════════════════════════
  //  Torn API — profile + faction → Firebase boot
  // ══════════════════════════════════════════════════════════════════════════
  function fetchOwnProfile() {
    if (!tornApiKey) { showBanner("chain-banner-nokey", true); return; }
    showBanner("chain-banner-nokey", false);
    showBanner("chain-banner-status", true, "Connecting to Torn API…");

    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout:15000,
      onload(r) {
        try {
          const data = JSON.parse(r.responseText);
          if (!data || data.error) {
            showBanner("chain-banner-status", true, `API error: ${data?.error?.error || "bad key"}`);
            return;
          }
          ownName     = data.name || "Me";
          ownId       = String(data.player_id || "");
          factionId   = data.faction?.faction_id ? String(data.faction.faction_id) : null;
          factionName = data.faction?.faction_name || "";
          updateApiBtn();
          showBanner("chain-banner-status", false);

          if (!factionId || factionId === "0") { showBanner("chain-banner-nofact", true); return; }
          showBanner("chain-banner-nofact", false);

          if (!fbConfigured()) { showBanner("chain-banner-nofb", true); return; }
          showBanner("chain-banner-nofb", false);

          fbSignInAnon(token => {
            fbToken = token;
            fbStartListener();
            fbRead();
            setInterval(fbRead, POLL_MS);
          });
        } catch { showBanner("chain-banner-status", true, "Failed to parse API response."); }
      },
      onerror()   { showBanner("chain-banner-status", true, "Network error reaching Torn API."); },
      ontimeout() { showBanner("chain-banner-status", true, "Torn API timed out."); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Tampermonkey menu
  // ══════════════════════════════════════════════════════════════════════════
  GM_registerMenuCommand("Set Torn API Key", () => { openApiPopover(); });
  GM_registerMenuCommand("Clear Torn API Key", () => {
    tornApiKey = ""; GM_setValue(SK_API_KEY, ""); updateApiBtn(); showBanner("chain-banner-nokey", true);
  });
  GM_registerMenuCommand("Clear Chain List", () => {
    if (!factionId) return alert("Not connected to a faction yet.");
    if (!confirm("Clear the entire chain list for your faction?")) return;
    fbWrite([]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Boot
  // ══════════════════════════════════════════════════════════════════════════
  renderPanel();
  fetchOwnProfile();
  injectTargetButtons();

})();
