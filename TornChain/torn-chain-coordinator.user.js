// ==UserScript==
// @name         Torn Chain Coordinator
// @namespace    https://kreinas1995.github.io/
// @version      3.0.2
// @description  Multi-faction shared chain board. Keyed Firebase writes, single SSE per client, presence display, faction-scoped auth.
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
  // ║  CONFIG                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const FIREBASE_DB_URL  = "https://syph-s-war-overhaul-default-rtdb.firebaseio.com";
  const FIREBASE_API_KEY = "AIzaSyATeusVjS6_S0JlSVu6su4jghnTRiy2I5w";

  // ─── Timing constants ─────────────────────────────────────────────────────
  const CHAIN_POLL_MS        = 5000;   // faction→chain API interval
  const PRESENCE_HEARTBEAT   = 15000;  // write own lastSeen every 15s
  const PRESENCE_TIMEOUT     = 35000;  // members not seen in 35s = offline
  const HIT_DELAY_MS         = 4 * 60 * 1000;
  const HIT_INTERVAL         = 5 * 60 * 1000;
  const CHAIN_CONFIRM_HITS   = 10;
  const CHAIN_END_DEBOUNCE   = 8000;
  const TIMER_FUDGE_SEC      = 1;

  // ─── GM storage ───────────────────────────────────────────────────────────
  const SK_API_KEY   = "chain_api_key";
  const SK_PANEL_W   = "chain_panel_w";
  const SK_PANEL_H   = "chain_panel_h";
  const SK_VIEW_MODE = "chain_view_mode";
  const SK_POS_X     = "chain_pos_x";
  const SK_POS_Y     = "chain_pos_y";

  // ─── App state ────────────────────────────────────────────────────────────
  let tornApiKey    = (GM_getValue(SK_API_KEY, "") || "").trim();
  let panelW        = GM_getValue(SK_PANEL_W, 360);
  let panelH        = GM_getValue(SK_PANEL_H, null);
  let viewMode      = GM_getValue(SK_VIEW_MODE, 1);

  let ownName       = "Me";
  let ownId         = null;
  let factionId     = null;
  let factionName   = "";
  let factionLeader = null;
  let factionCoLeader = null;
  let factionMembers  = {};
  let isLeaderOrCoLeader = false;

  // ─── Firebase state ───────────────────────────────────────────────────────
  let fbToken       = null;
  let fbUid         = null;       // anonymous auth UID (used for auth rules)
  let mainSse       = null;       // single SSE on /factions/{id}
  let hitMap        = new Map();  // hitId → hitObject  (keyed, not array)
  let permissions   = {};         // { tornUserId: true }
  let canClear      = false;
  let presenceMap   = new Map();  // fbUid → { name, lastSeen }

  // ─── Chain state ──────────────────────────────────────────────────────────
  let liveChainSecs    = null;
  let lastTimerReadAt  = null;
  let liveChainCount   = null;
  let lastKnownCount   = null;
  let chainConfirmed   = false;
  let chainHit1Time    = null;
  let scrapedHitIds    = new Set();
  let chainSessionId   = null;
  let chainStartTime   = null;
  let chainEndDebounce = null;
  let chainTimerObserver = null;
  // sessionMinHitNum: the lowest chainHitNum confirmed to belong to this session.
  // Set to 1 when we first see a #1 hit after chainStartTime.
  // Until this is set, ALL scraped hits are rejected — prevents hits from
  // previous chains (e.g. #2, #3) being accepted before we anchor on #1.
  let sessionMinHitNum = null;

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase path helpers
  // ══════════════════════════════════════════════════════════════════════════
  const auth = () => fbToken ? `?auth=${fbToken}` : "";
  const fBase = () => `${FIREBASE_DB_URL}/factions/${factionId}`;

  // All paths under /factions/{id}
  const P = {
    root:        () => `${fBase()}.json${auth()}`,
    hits:        () => `${fBase()}/hits.json${auth()}`,
    hit:         id => `${fBase()}/hits/${id}.json${auth()}`,
    hitField:    (id, f) => `${fBase()}/hits/${id}/${f}.json${auth()}`,
    session:     () => `${fBase()}/session.json${auth()}`,
    perms:       () => `${fBase()}/permissions.json${auth()}`,
    perm:        uid => `${fBase()}/permissions/${uid}.json${auth()}`,
    members:     () => `${fBase()}/members.json${auth()}`,
    member:      uid => `${fBase()}/members/${uid}.json${auth()}`,
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  CSS
  // ══════════════════════════════════════════════════════════════════════════
  GM_addStyle(`
    .chain-target-btn {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      margin-left:4px !important; padding:0 5px !important; height:22px !important; min-width:22px !important;
      border-radius:5px !important; border:1px solid rgba(255,200,0,.5) !important;
      background:rgba(255,180,0,.15) !important; color:#ffd700 !important;
      font-size:13px !important; cursor:pointer !important; vertical-align:middle !important;
      line-height:1 !important; transition:background .12s !important; flex-shrink:0 !important;
    }
    .chain-target-btn:hover    { background:rgba(255,180,0,.35) !important; }
    .chain-target-btn:disabled { opacity:.4 !important; cursor:default !important; }
    .chain-target-btn.claimed  { background:rgba(68,255,136,.2) !important; border-color:rgba(68,255,136,.6) !important; color:#44ff88 !important; }
    .chain-target-btn.loading  { animation:chain-blink .6s linear infinite !important; }
    @keyframes chain-blink { 0%,100%{opacity:1} 50%{opacity:.3} }

    #chain-panel {
      position:fixed !important; z-index:999999 !important;
      border-radius:12px !important; background:rgba(16,18,24,.96) !important; color:#e8e8e8 !important;
      box-shadow:0 12px 32px rgba(0,0,0,.6) !important; font-family:Arial,Helvetica,sans-serif !important;
      user-select:none !important; overflow:visible !important; display:flex !important;
      flex-direction:column !important; touch-action:none !important; transition:border-radius .15s !important;
    }

    /* ── View modes ── */
    #chain-panel.view-pill {
      border-radius:50px !important; box-shadow:0 4px 16px rgba(0,0,0,.55) !important;
      min-width:0 !important; width:auto !important; height:auto !important;
    }
    #chain-panel.view-pill #chain-panel-header { padding:8px 12px !important; border-bottom:none !important; }
    #chain-panel.view-pill #chain-panel-title,
    #chain-panel.view-pill #chain-clear-btn,
    #chain-panel.view-pill #chain-manage-btn,
    #chain-panel.view-pill #chain-presence-btn,
    #chain-panel.view-pill #chain-api-btn,
    #chain-panel.view-pill #chain-timer-bar,
    #chain-panel.view-pill #chain-warming-msg,
    #chain-panel.view-pill #chain-panel-body { display:none !important; }
    #chain-pill-content { display:none; align-items:center; gap:6px; white-space:nowrap; }
    #chain-panel.view-pill #chain-pill-content { display:flex !important; }
    #chain-pill-icon  { font-size:16px; line-height:1; }
    #chain-pill-timer { font-family:monospace; font-weight:700; font-size:13px; }
    #chain-pill-timer.ct-ok     { color:#44ff88; }
    #chain-pill-timer.ct-warn   { color:#ffcc66; }
    #chain-pill-timer.ct-danger { color:#ff5555; }
    #chain-pill-timer.ct-none   { color:#556; }
    #chain-pill-badge {
      background:#ff5555; color:#fff; font-size:9px; font-weight:700;
      border-radius:8px; padding:1px 5px; min-width:14px; text-align:center;
      line-height:14px; display:none;
    }
    #chain-pill-badge.visible { display:inline-block !important; }

    #chain-panel.view-next #chain-panel-body { display:flex !important; }
    #chain-panel.view-next #chain-col-header,
    #chain-panel.view-next #chain-panel-inner { display:none !important; }
    #chain-next-strip {
      display:none; align-items:center; gap:6px; padding:5px 10px;
      border-top:1px solid rgba(255,255,255,.06); font-size:11px; flex-shrink:0;
    }
    #chain-panel.view-next #chain-next-strip { display:flex !important; }
    #chain-next-num   { font-weight:700; color:#556; font-size:11px; flex-shrink:0; }
    #chain-next-name  { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    #chain-next-timer { font-family:monospace; font-weight:700; font-size:12px; flex-shrink:0; }
    #chain-next-timer.due  { color:#44ff88; }
    #chain-next-timer.soon { color:#ffcc66; }
    #chain-next-timer.wait { color:#556677; }

    /* ── Header ── */
    #chain-panel-header {
      display:flex !important; align-items:center !important; gap:5px !important;
      padding:8px 10px !important; background:rgba(255,255,255,.055) !important;
      border-bottom:1px solid rgba(255,255,255,.08) !important; flex-shrink:0 !important;
      cursor:grab !important; position:relative !important; border-radius:12px 12px 0 0 !important;
      overflow:visible !important;
    }
    #chain-panel-header:active { cursor:grabbing !important; }
    #chain-panel-title {
      font-weight:700 !important; font-size:13px !important; flex:1 !important;
      white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important;
    }

    /* ── Header buttons ── */
    .chain-hbtn {
      background:rgba(255,255,255,.1) !important; border:1px solid rgba(255,255,255,.15) !important;
      color:#ccc !important; border-radius:6px !important; padding:2px 7px !important;
      font-size:11px !important; cursor:pointer !important; line-height:1.4 !important;
      white-space:nowrap !important; flex-shrink:0 !important;
    }
    .chain-hbtn:hover        { background:rgba(255,255,255,.2) !important; }
    .chain-hbtn.danger       { border-color:rgba(255,80,80,.45) !important; color:#ff8888 !important; }
    .chain-hbtn.danger:hover { background:rgba(255,60,60,.22) !important; }
    .chain-hbtn.leader       { border-color:rgba(255,200,0,.45) !important; color:#ffd700 !important; }
    .chain-hbtn.leader:hover { background:rgba(255,200,0,.15) !important; }
    #chain-api-btn {
      background:rgba(100,160,255,.18) !important; border:1px solid rgba(100,160,255,.4) !important;
      color:#88bbff !important; border-radius:5px !important; padding:2px 6px !important;
      font-size:10px !important; font-weight:700 !important; cursor:pointer !important;
      letter-spacing:.3px !important; line-height:1.5 !important; white-space:nowrap !important; flex-shrink:0 !important;
    }
    #chain-api-btn:hover   { background:rgba(100,160,255,.3) !important; }
    #chain-api-btn.has-key { background:rgba(68,255,136,.12) !important; border-color:rgba(68,255,136,.35) !important; color:#44ff88 !important; }

    /* ── Sync dot ── */
    #chain-sync-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; background:#334; transition:background .3s; }
    #chain-sync-dot.live    { background:#44ff88; }
    #chain-sync-dot.syncing { background:#ffcc66; }
    #chain-sync-dot.error   { background:#ff4444; }

    /* ── Chain timer bar ── */
    #chain-timer-bar {
      display:flex !important; align-items:center !important; gap:6px !important;
      padding:5px 10px !important; background:rgba(0,0,0,.25) !important;
      border-bottom:1px solid rgba(255,255,255,.06) !important; flex-shrink:0 !important; font-size:11px !important;
    }
    #chain-timer-label { color:#778 !important; white-space:nowrap !important; }
    #chain-timer-value { font-family:monospace !important; font-weight:700 !important; font-size:14px !important; flex:1 !important; }
    #chain-timer-value.ct-ok     { color:#44ff88 !important; }
    #chain-timer-value.ct-warn   { color:#ffcc66 !important; }
    #chain-timer-value.ct-danger { color:#ff5555 !important; animation:chain-pulse 1s ease-in-out infinite alternate !important; }
    #chain-timer-value.ct-none   { color:#445 !important; }
    #chain-count-badge { font-size:11px !important; font-weight:700 !important; padding:1px 7px !important; border-radius:8px !important; white-space:nowrap !important; }
    #chain-count-badge.warming { background:rgba(255,160,0,.18) !important; color:#ffaa44 !important; border:1px solid rgba(255,160,0,.3) !important; }
    #chain-count-badge.running { background:rgba(68,255,136,.12) !important; color:#44ff88 !important; border:1px solid rgba(68,255,136,.25) !important; }
    #chain-count-badge.none    { display:none !important; }
    #chain-warming-msg {
      font-size:10px !important; color:#ffaa44 !important; padding:3px 10px !important;
      background:rgba(255,140,0,.07) !important; border-bottom:1px solid rgba(255,140,0,.12) !important;
      text-align:center !important; flex-shrink:0 !important; letter-spacing:.2px !important;
    }
    @keyframes chain-pulse { from{background:rgba(255,85,85,.04)} to{background:rgba(255,85,85,.14)} }

    /* ── Popovers (API, Manage, Presence) ── */
    .chain-popover {
      display:none; position:absolute; top:42px; z-index:1000001;
      background:rgba(20,22,30,.98); border-radius:10px;
      padding:12px; box-shadow:0 8px 24px rgba(0,0,0,.65);
      flex-direction:column; gap:8px; font-family:Arial,Helvetica,sans-serif;
    }
    .chain-popover.open { display:flex !important; }

    #chain-api-popover  { left:8px; width:240px; border:1px solid rgba(100,160,255,.3); }
    #chain-api-popover-title { font-size:11px; font-weight:700; color:#88bbff; }
    #chain-api-input {
      width:100%; box-sizing:border-box; background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.15); border-radius:6px; color:#e8e8e8;
      padding:5px 8px; font-size:11px; font-family:monospace; outline:none;
    }
    #chain-api-input:focus { border-color:rgba(100,160,255,.5) !important; }
    #chain-api-popover-row { display:flex; gap:6px; }
    .chain-api-pop-btn { flex:1; padding:4px 0; border-radius:6px; font-size:11px; cursor:pointer; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.08); color:#ccc; }
    .chain-api-pop-btn:hover  { background:rgba(255,255,255,.18); }
    .chain-api-pop-btn.save   { background:rgba(68,255,136,.15); border-color:rgba(68,255,136,.4); color:#44ff88; }
    .chain-api-pop-btn.save:hover { background:rgba(68,255,136,.28); }
    .chain-api-pop-btn.clear  { background:rgba(255,80,80,.12); border-color:rgba(255,80,80,.35); color:#ff8888; }
    .chain-api-pop-btn.clear:hover { background:rgba(255,60,60,.25); }
    #chain-api-status { font-size:10px; color:#445; text-align:center; min-height:14px; }

    #chain-manage-popover { right:8px; width:220px; max-height:320px; border:1px solid rgba(255,200,0,.3); }
    #chain-manage-title    { font-size:11px; font-weight:700; color:#ffd700; }
    #chain-manage-subtitle { font-size:10px; color:#556; margin-top:-4px; }
    #chain-manage-list { overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:4px; max-height:200px; }
    #chain-manage-list::-webkit-scrollbar { width:4px; }
    #chain-manage-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:2px; }
    .chain-manage-row { display:flex; align-items:center; gap:8px; padding:3px 4px; border-radius:5px; cursor:pointer; font-size:11px; color:#ccc; }
    .chain-manage-row:hover { background:rgba(255,255,255,.06); }
    .chain-manage-row input[type=checkbox] { accent-color:#ffd700; cursor:pointer; flex-shrink:0; }
    #chain-manage-close { padding:4px 0; border-radius:6px; font-size:11px; cursor:pointer; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.08); color:#ccc; }
    #chain-manage-close:hover { background:rgba(255,255,255,.18); }

    /* ── Presence popover ── */
    #chain-presence-popover { left:50%; transform:translateX(-50%); width:200px; border:1px solid rgba(100,200,255,.3); }
    #chain-presence-title   { font-size:11px; font-weight:700; color:#88ccff; }
    #chain-presence-list    { display:flex; flex-direction:column; gap:4px; max-height:180px; overflow-y:auto; }
    .chain-presence-row     { display:flex; align-items:center; gap:7px; font-size:11px; color:#ccc; padding:2px 0; }
    .chain-presence-dot     { width:6px; height:6px; border-radius:50%; background:#44ff88; flex-shrink:0; }
    .chain-presence-name    { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

    /* ── Panel body + banners ── */
    #chain-panel-body { display:flex !important; flex-direction:column !important; flex:1 !important; overflow:hidden !important; border-radius:0 0 12px 12px; }
    .chain-banner { padding:5px 10px !important; font-size:11px !important; text-align:center !important; flex-shrink:0 !important; line-height:1.3 !important; }
    .chain-banner.warn { color:#ff8888; background:rgba(255,60,60,.08); border-bottom:1px solid rgba(255,60,60,.15); }
    .chain-banner.info { color:#88aacc; background:rgba(80,120,200,.08); border-bottom:1px solid rgba(80,120,200,.15); }

    /* ── Column header ── */
    #chain-col-header {
      display:grid !important; grid-template-columns:26px 1fr 1fr 58px 20px !important;
      gap:0 5px !important; padding:4px 10px !important; font-size:10px !important;
      text-transform:uppercase !important; letter-spacing:.5px !important; color:#445 !important;
      border-bottom:1px solid rgba(255,255,255,.06) !important; flex-shrink:0 !important;
    }

    /* ── Hit list ── */
    #chain-panel-inner { overflow-y:auto !important; flex:1 !important; max-height:380px !important; padding:4px 0 !important; }
    #chain-panel-inner::-webkit-scrollbar { width:5px; }
    #chain-panel-inner::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:3px; }

    .chain-hit-row {
      display:grid !important; grid-template-columns:26px 1fr 1fr 58px 20px !important;
      align-items:center !important; gap:0 5px !important; padding:4px 10px !important;
      border-left:3px solid transparent !important; font-size:11px !important; transition:background .1s !important;
    }
    .chain-hit-row:hover        { background:rgba(255,255,255,.04) !important; }
    .chain-hit-row.due          { border-left-color:#44ff88 !important; animation:chain-row-pulse 1s ease-in-out infinite alternate !important; }
    .chain-hit-row.soon         { border-left-color:#ffcc66 !important; }
    .chain-hit-row.waiting      { border-left-color:#445 !important; }
    .chain-hit-row.done         { opacity:.35 !important; border-left-color:#222 !important; }
    .chain-hit-row.hosp-waiting { border-left-color:#6699cc !important; background:rgba(80,120,200,.04) !important; }
    .chain-hit-row.hosp-waiting .chain-hit-target::before { content:"🏥 " !important; }
    .chain-hit-row.hosp-waiting .chain-hit-attack { opacity:.25 !important; pointer-events:none !important; }
    .chain-hit-row.untracked    { border-left-color:#ff8c00 !important; opacity:.5 !important; font-style:italic !important; }
    @keyframes chain-row-pulse { from{background:rgba(68,255,136,.04)} to{background:rgba(68,255,136,.14)} }

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

    /* ── Resize handle ── */
    #chain-resize-handle {
      position:absolute !important; bottom:0 !important; right:0 !important;
      width:18px !important; height:18px !important; cursor:se-resize !important;
      z-index:10 !important; opacity:0 !important; transition:opacity .2s !important;
    }
    #chain-panel:hover #chain-resize-handle { opacity:1 !important; }
    #chain-resize-handle::after {
      content:"" !important; position:absolute !important; bottom:3px !important; right:3px !important;
      width:8px !important; height:8px !important;
      border-right:2px solid rgba(255,255,255,.35) !important;
      border-bottom:2px solid rgba(255,255,255,.35) !important;
      border-radius:1px !important;
    }
  `);

  // ══════════════════════════════════════════════════════════════════════════
  //  Panel HTML
  // ══════════════════════════════════════════════════════════════════════════
  const panel = document.createElement("div");
  panel.id = "chain-panel";
  const savedX = GM_getValue(SK_POS_X, null), savedY = GM_getValue(SK_POS_Y, null);
  if (savedX !== null && savedY !== null) {
    panel.style.left = savedX+"px"; panel.style.top = savedY+"px"; panel.style.right = "auto";
  } else { panel.style.right = "12px"; panel.style.top = "60px"; }
  panel.style.width = panelW+"px";
  if (panelH) panel.style.height = panelH+"px";

  panel.innerHTML = `
    <div id="chain-panel-header">
      <button id="chain-api-btn" title="Set Torn API key">API</button>
      <span id="chain-panel-title">⛓ Chain Board</span>
      <span id="chain-pill-content">
        <span id="chain-pill-icon">⛓</span>
        <span id="chain-pill-timer" class="ct-none">—</span>
        <span id="chain-pill-badge">0</span>
      </span>
      <span id="chain-sync-dot" title="Sync status"></span>
      <button id="chain-presence-btn" class="chain-hbtn" title="Who's online">👥</button>
      <button id="chain-view-btn" class="chain-hbtn" title="Cycle view">▦</button>
      <button id="chain-manage-btn" class="chain-hbtn leader" style="display:none" title="Manage clear permissions">⚙</button>
      <button id="chain-clear-btn" class="chain-hbtn danger" style="display:none" title="Clear chain list">✕</button>

      <!-- API popover -->
      <div id="chain-api-popover" class="chain-popover">
        <div id="chain-api-popover-title">🔑 Torn API Key</div>
        <input id="chain-api-input" type="password" placeholder="Paste your API key here" autocomplete="off" spellcheck="false">
        <div id="chain-api-popover-row">
          <button class="chain-api-pop-btn save" id="chain-api-save">Save</button>
          <button class="chain-api-pop-btn clear" id="chain-api-clear">Clear</button>
          <button class="chain-api-pop-btn" id="chain-api-cancel">Cancel</button>
        </div>
        <div id="chain-api-status"></div>
      </div>

      <!-- Manage permissions popover -->
      <div id="chain-manage-popover" class="chain-popover">
        <div id="chain-manage-title">⚙ Clear Permissions</div>
        <div id="chain-manage-subtitle">Members who can clear the list</div>
        <div id="chain-manage-list"></div>
        <button id="chain-manage-close">Done</button>
      </div>

      <!-- Presence popover -->
      <div id="chain-presence-popover" class="chain-popover">
        <div id="chain-presence-title">👥 Online Now</div>
        <div id="chain-presence-list"></div>
      </div>
    </div>

    <div id="chain-timer-bar">
      <span id="chain-timer-label">⛓ Chain</span>
      <span id="chain-timer-value" class="ct-none">—</span>
      <span id="chain-count-badge" class="none">0</span>
    </div>
    <div id="chain-warming-msg" style="display:none">🔥 Chain warming up — keep hitting!</div>

    <div id="chain-panel-body">
      <div id="chain-banner-nokey"  class="chain-banner warn" style="display:none">⚠ No API key — click API above.</div>
      <div id="chain-banner-nofb"   class="chain-banner warn" style="display:none">⚠ Firebase not configured — see FIREBASE_SETUP.md.</div>
      <div id="chain-banner-nofact" class="chain-banner info" style="display:none">ℹ Not in a faction — queue unavailable.</div>
      <div id="chain-banner-status" class="chain-banner info" style="display:none"></div>
      <div id="chain-col-header" style="display:none">
        <span>#</span><span>Claimer</span><span>Target</span>
        <span style="text-align:right">Window</span><span></span>
      </div>
      <div id="chain-panel-inner">
        <div style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.6">
          No hits queued.<br>Click 🎯 next to an attack button.
        </div>
      </div>
      <div id="chain-next-strip">
        <span id="chain-next-num">#1</span>
        <span id="chain-next-name">—</span>
        <span id="chain-next-timer" class="wait">—</span>
        <a id="chain-next-attack" class="chain-hit-attack" href="#" target="_blank">⚔</a>
      </div>
    </div>
    <div id="chain-resize-handle"></div>`;
  document.body.appendChild(panel);

  // ── Element refs ──────────────────────────────────────────────────────────
  const panelBody       = document.getElementById("chain-panel-body");
  const viewBtn         = document.getElementById("chain-view-btn");
  const clearBtn        = document.getElementById("chain-clear-btn");
  const manageBtn       = document.getElementById("chain-manage-btn");
  const presenceBtn     = document.getElementById("chain-presence-btn");
  const syncDot         = document.getElementById("chain-sync-dot");
  const apiBtn          = document.getElementById("chain-api-btn");
  const apiPopover      = document.getElementById("chain-api-popover");
  const apiInput        = document.getElementById("chain-api-input");
  const apiSave         = document.getElementById("chain-api-save");
  const apiClear        = document.getElementById("chain-api-clear");
  const apiCancel       = document.getElementById("chain-api-cancel");
  const apiStatus       = document.getElementById("chain-api-status");
  const chainTimerVal   = document.getElementById("chain-timer-value");
  const chainCountBadge = document.getElementById("chain-count-badge");
  const warmingMsg      = document.getElementById("chain-warming-msg");
  const resizeHandle    = document.getElementById("chain-resize-handle");
  const managePopover   = document.getElementById("chain-manage-popover");
  const manageList      = document.getElementById("chain-manage-list");
  const manageClose     = document.getElementById("chain-manage-close");
  const presencePopover = document.getElementById("chain-presence-popover");
  const presenceList    = document.getElementById("chain-presence-list");
  const pillTimer       = document.getElementById("chain-pill-timer");
  const pillBadge       = document.getElementById("chain-pill-badge");
  const nextNum         = document.getElementById("chain-next-num");
  const nextName        = document.getElementById("chain-next-name");
  const nextTimer       = document.getElementById("chain-next-timer");
  const nextAttack      = document.getElementById("chain-next-attack");

  // ══════════════════════════════════════════════════════════════════════════
  //  View mode cycling
  // ══════════════════════════════════════════════════════════════════════════
  const VIEW_CLASSES = ["view-next","view-full","view-pill"];
  const VIEW_ICONS   = ["▤","▦","◉"];
  const VIEW_TIPS    = ["Next hit","Full board","Minimised"];
  let lastExpandedMode = viewMode === 2 ? 1 : viewMode;

  function applyViewMode() {
    VIEW_CLASSES.forEach(c => panel.classList.remove(c));
    panel.classList.add(VIEW_CLASSES[viewMode]);
    viewBtn.textContent = VIEW_ICONS[viewMode];
    viewBtn.title = `View: ${VIEW_TIPS[viewMode]} — click to cycle`;
    if (viewMode === 1) {
      panel.style.width = panelW+"px";
      if (panelH) panel.style.height = panelH+"px";
    } else { panel.style.width = ""; panel.style.height = ""; }
    panel.style.cursor = viewMode === 2 ? "pointer" : "";
  }

  viewBtn.onclick = e => {
    e.stopPropagation();
    if (viewMode !== 2) lastExpandedMode = viewMode;
    viewMode = (viewMode+1)%3;
    GM_setValue(SK_VIEW_MODE, viewMode);
    applyViewMode();
  };

  panel.addEventListener("click", e => {
    if (viewMode !== 2) return;
    if (e.target.tagName==="BUTTON" || e.target.closest("button")) return;
    viewMode = lastExpandedMode;
    GM_setValue(SK_VIEW_MODE, viewMode);
    applyViewMode();
  });

  applyViewMode();

  // ── Sync dot ──────────────────────────────────────────────────────────────
  function setSyncDot(s) {
    syncDot.className = s==="off" ? "" : s;
    syncDot.title = {live:"Live ✓",syncing:"Syncing…",error:"Sync error",off:"Offline"}[s]||"";
  }

  // ── Banners ───────────────────────────────────────────────────────────────
  function showBanner(id, show, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = show ? "" : "none";
    if (text !== undefined) el.textContent = text;
  }

  // ── Close all popovers ────────────────────────────────────────────────────
  function closeAllPopovers() {
    [apiPopover, managePopover, presencePopover].forEach(p => p.classList.remove("open"));
  }

  document.addEventListener("click", e => {
    if (!panel.contains(e.target)) closeAllPopovers();
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Draggable
  // ══════════════════════════════════════════════════════════════════════════
  (function makeDraggable() {
    const handle = document.getElementById("chain-panel-header");
    const DRAG_IDS = new Set(["chain-panel-header","chain-panel-title","chain-sync-dot","chain-pill-content","chain-pill-timer","chain-pill-icon","chain-pill-badge"]);
    let dragging=false, sx,sy,ol,ot;
    function start(cx,cy) {
      dragging=true; sx=cx; sy=cy;
      const r=panel.getBoundingClientRect(); ol=r.left; ot=r.top;
      panel.style.right="auto"; panel.style.left=ol+"px"; panel.style.top=ot+"px";
    }
    function move(cx,cy) {
      if(!dragging) return;
      panel.style.left=Math.max(0,Math.min(window.innerWidth-panel.offsetWidth,ol+cx-sx))+"px";
      panel.style.top=Math.max(0,Math.min(window.innerHeight-panel.offsetHeight,ot+cy-sy))+"px";
    }
    function end() {
      if(!dragging) return; dragging=false;
      GM_setValue(SK_POS_X,parseInt(panel.style.left));
      GM_setValue(SK_POS_Y,parseInt(panel.style.top));
    }
    handle.addEventListener("mousedown",e=>{if(DRAG_IDS.has(e.target.id)||e.target===handle)start(e.clientX,e.clientY);});
    document.addEventListener("mousemove",e=>move(e.clientX,e.clientY));
    document.addEventListener("mouseup",end);
    handle.addEventListener("touchstart",e=>{if(DRAG_IDS.has(e.target.id)||e.target===handle){const t=e.touches[0];start(t.clientX,t.clientY);}},{passive:true});
    document.addEventListener("touchmove",e=>{if(!dragging)return;e.preventDefault();const t=e.touches[0];move(t.clientX,t.clientY);},{passive:false});
    document.addEventListener("touchend",end);
  })();

  // ══════════════════════════════════════════════════════════════════════════
  //  Corner resize
  // ══════════════════════════════════════════════════════════════════════════
  (function makeResizable() {
    const MIN_W=260,MAX_W=700,MIN_H=120,MAX_H=900;
    let resizing=false,sx,sy,sw,sh;
    function start(cx,cy){resizing=true;sx=cx;sy=cy;sw=panel.offsetWidth;sh=panel.offsetHeight;document.body.style.cursor="se-resize";}
    function move(cx,cy){if(!resizing)return;panel.style.width=Math.min(MAX_W,Math.max(MIN_W,sw+cx-sx))+"px";panel.style.height=Math.min(MAX_H,Math.max(MIN_H,sh+cy-sy))+"px";}
    function end(){if(!resizing)return;resizing=false;document.body.style.cursor="";panelW=panel.offsetWidth;panelH=panel.offsetHeight;GM_setValue(SK_PANEL_W,panelW);GM_setValue(SK_PANEL_H,panelH);}
    resizeHandle.addEventListener("mousedown",e=>{e.preventDefault();e.stopPropagation();start(e.clientX,e.clientY);});
    document.addEventListener("mousemove",e=>move(e.clientX,e.clientY));
    document.addEventListener("mouseup",end);
    resizeHandle.addEventListener("touchstart",e=>{e.stopPropagation();const t=e.touches[0];start(t.clientX,t.clientY);},{passive:true});
    document.addEventListener("touchmove",e=>{if(!resizing)return;e.preventDefault();const t=e.touches[0];move(t.clientX,t.clientY);},{passive:false});
    document.addEventListener("touchend",end);
  })();

  // ══════════════════════════════════════════════════════════════════════════
  //  API Popover
  // ══════════════════════════════════════════════════════════════════════════
  function openApiPopover() {
    closeAllPopovers();
    apiInput.value = tornApiKey || "";
    apiStatus.textContent = tornApiKey ? "Key is set ✓" : "No key saved";
    apiStatus.style.color = tornApiKey ? "#44ff88" : "#556";
    apiPopover.classList.add("open");
    setTimeout(() => apiInput.focus(), 50);
  }
  apiBtn.addEventListener("click", e => { e.stopPropagation(); apiPopover.classList.contains("open") ? closeAllPopovers() : openApiPopover(); });
  apiSave.onclick = () => {
    const val = apiInput.value.trim();
    if (!val) { apiStatus.textContent="Please enter a key."; apiStatus.style.color="#ff8888"; return; }
    tornApiKey = val; GM_setValue(SK_API_KEY, tornApiKey);
    apiStatus.textContent="Saved — connecting…"; apiStatus.style.color="#ffcc66";
    updateApiBtn(); setTimeout(closeAllPopovers, 700); fetchOwnProfile();
  };
  apiClear.onclick = () => { tornApiKey=""; GM_setValue(SK_API_KEY,""); apiInput.value=""; apiStatus.textContent="Key cleared."; apiStatus.style.color="#ff8888"; updateApiBtn(); showBanner("chain-banner-nokey",true); };
  apiCancel.onclick = closeAllPopovers;
  apiInput.addEventListener("keydown", e => { if(e.key==="Enter") apiSave.click(); });
  function updateApiBtn() {
    apiBtn.classList.toggle("has-key", !!tornApiKey);
    apiBtn.title = tornApiKey ? `API key set (${ownName}) — click to change` : "Set Torn API key";
  }
  updateApiBtn();

  // ══════════════════════════════════════════════════════════════════════════
  //  Manage Permissions Popover
  // ══════════════════════════════════════════════════════════════════════════
  function openManagePopover() {
    closeAllPopovers();
    manageList.innerHTML = "";
    Object.entries(factionMembers).forEach(([uid, name]) => {
      const checked = !!permissions[uid];
      const row = document.createElement("label");
      row.className = "chain-manage-row";
      row.innerHTML = `<input type="checkbox" data-uid="${uid}" ${checked?"checked":""}> ${escHtml(name)}`;
      row.querySelector("input").addEventListener("change", ev => {
        const id = ev.target.dataset.uid;
        if (ev.target.checked) permissions[id] = true; else delete permissions[id];
        fbPut(P.perm(id), ev.target.checked ? "true" : null);
        updateClearBtn();
      });
      manageList.appendChild(row);
    });
    managePopover.classList.add("open");
  }
  manageBtn.addEventListener("click", e => { e.stopPropagation(); managePopover.classList.contains("open") ? closeAllPopovers() : openManagePopover(); });
  manageClose.onclick = closeAllPopovers;

  function updateClearBtn() {
    canClear = isLeaderOrCoLeader || !!permissions[ownId];
    clearBtn.style.display = canClear ? "" : "none";
    manageBtn.style.display = isLeaderOrCoLeader ? "" : "none";
  }

  clearBtn.onclick = () => {
    if (!canClear || !factionId) return;
    if (!confirm("Clear the entire chain list for your faction?")) return;
    fbClearHits();
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  Presence Popover
  // ══════════════════════════════════════════════════════════════════════════
  presenceBtn.addEventListener("click", e => {
    e.stopPropagation();
    if (presencePopover.classList.contains("open")) { closeAllPopovers(); return; }
    closeAllPopovers();
    renderPresence();
    presencePopover.classList.add("open");
  });

  function renderPresence() {
    const now = Date.now();
    presenceList.innerHTML = "";
    const online = [...presenceMap.entries()]
      .filter(([, m]) => (now - (m.lastSeen||0)) < PRESENCE_TIMEOUT)
      .sort((a,b) => a[1].name.localeCompare(b[1].name));

    if (!online.length) {
      presenceList.innerHTML = `<div style="font-size:11px;color:#445;text-align:center;padding:4px">No one else online</div>`;
      return;
    }
    online.forEach(([uid, m]) => {
      const row = document.createElement("div");
      row.className = "chain-presence-row";
      const isMe = fbUid === uid;
      row.innerHTML = `<span class="chain-presence-dot"></span><span class="chain-presence-name">${escHtml(m.name)}${isMe?" (you)":""}</span>`;
      presenceList.appendChild(row);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ══════════════════════════════════════════════════════════════════════════
  function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function formatTime(ms) {
    if (ms<=0) return "NOW";
    const s=Math.floor(ms/1000);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
  }
  function isHospStillIn(hit) { return !!(hit.hospReleaseAt && hit.hospReleaseAt>Date.now()); }
  function hitTimerClass(rem) { if(rem<=0)return"due"; if(rem<=60000)return"soon"; return"wait"; }
  function hitRowClass(rem, hosp, untracked) {
    if(untracked) return"untracked";
    if(hosp)      return"hosp-waiting";
    if(rem<=0)    return"due";
    if(rem<=60000)return"soon";
    return"waiting";
  }

  // Position-based countdown: pos=0 → NOW, pos=1 → ChC, pos=k → ChC+(k-1)*HIT_DELAY
  function pendingCountdownMs(pos) {
    if (pos===0) return 0;
    const chcMs = liveChainSecs!==null && lastTimerReadAt!==null
      ? Math.max(0,(liveChainSecs-(performance.now()-lastTimerReadAt)/1000))*1000
      : 0;
    return chcMs + (pos-1)*HIT_DELAY_MS;
  }

  // Get sorted pending hits from hitMap
  function getPendingHits() {
    return [...hitMap.values()].filter(h=>h.status!=="done").sort((a,b)=>a.hitNumber-b.hitNumber);
  }
  function getDoneHits() {
    return [...hitMap.values()].filter(h=>h.status==="done").sort((a,b)=>(b.doneAt||0)-(a.doneAt||0));
  }
  function getHighestDoneHitNum() {
    return [...hitMap.values()].filter(h=>h.status==="done"&&h.chainHitNum).reduce((m,h)=>Math.max(m,h.chainHitNum),0);
  }

  // Renumber pending hits from (highestDone + 1) in scheduledAt order
  function reNumberPending() {
    const highest = getHighestDoneHitNum();
    const pending = [...hitMap.values()].filter(h=>h.status!=="done").sort((a,b)=>a.scheduledAt-b.scheduledAt);
    pending.forEach((h,i)=>{ h.hitNumber = highest+i+1; });
  }

  function fbConfigured() {
    return FIREBASE_DB_URL!=="https://YOUR-PROJECT-default-rtdb.firebaseio.com"
        && FIREBASE_API_KEY!=="YOUR_FIREBASE_WEB_API_KEY";
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase low-level HTTP helpers
  //  All writes are targeted — never overwrite the whole hits object.
  // ══════════════════════════════════════════════════════════════════════════
  function fbPut(url, data, onDone) {
    if (!fbConfigured()) return;
    setSyncDot("syncing");
    GM_xmlhttpRequest({
      method:"PUT", url,
      headers:{"Content-Type":"application/json"},
      data: data===null ? "null" : JSON.stringify(data),
      timeout:10000,
      onload(r) {
        if(r.status>=200&&r.status<300){ setSyncDot("live"); if(onDone)onDone(); }
        else setSyncDot("error");
      },
      onerror()  { setSyncDot("error"); },
      ontimeout(){ setSyncDot("error"); },
    });
  }

  function fbDelete(url, onDone) {
    if (!fbConfigured()) return;
    GM_xmlhttpRequest({
      method:"DELETE", url,
      timeout:10000,
      onload(r) { if(r.status>=200&&r.status<300&&onDone)onDone(); },
      onerror(){}, ontimeout(){},
    });
  }

  function fbGet(url, onData) {
    if (!fbConfigured()) return;
    GM_xmlhttpRequest({
      method:"GET", url, timeout:10000,
      onload(r) {
        try { if(r.status>=200&&r.status<300) onData(JSON.parse(r.responseText)); } catch { /**/ }
      },
      onerror(){}, ontimeout(){},
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase anonymous auth
  // ══════════════════════════════════════════════════════════════════════════
  function fbSignInAnon(cb) {
    GM_xmlhttpRequest({
      method:"POST",
      url:`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify({returnSecureToken:true}),
      timeout:10000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);
          cb(d.idToken||null, d.localId||null);
        } catch { cb(null,null); }
      },
      onerror()  { cb(null,null); },
      ontimeout(){ cb(null,null); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase member registration (faction-scoped auth)
  //  Writes own UID + name + lastSeen under /factions/{id}/members/{fbUid}
  //  This both authenticates the user to the faction path AND registers presence.
  // ══════════════════════════════════════════════════════════════════════════
  function fbRegisterMember() {
    if (!factionId || !fbUid || !fbConfigured()) return;
    fbPut(P.member(fbUid), { name: ownName, lastSeen: Date.now() });
  }

  function fbHeartbeat() {
    if (!factionId || !fbUid || !fbConfigured()) return;
    fbPut(`${fBase()}/members/${fbUid}/lastSeen.json${auth()}`, Date.now());
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Single SSE listener on /factions/{id}
  //  Firebase sends path + data for every change under this node.
  //  We route by path prefix — no extra connections.
  // ══════════════════════════════════════════════════════════════════════════
  function fbStartMainListener() {
    if (!factionId || !fbConfigured()) return;
    if (mainSse) { try { mainSse.close(); } catch { /**/ } }

    try {
      mainSse = new EventSource(P.root());

      mainSse.addEventListener("put", e => {
        try {
          const ev = JSON.parse(e.data);
          applyPatch(ev.path, ev.data);
        } catch { /**/ }
      });

      mainSse.addEventListener("patch", e => {
        try {
          const ev = JSON.parse(e.data);
          // patch delivers an object of sub-paths at ev.path
          if (ev.data && typeof ev.data === "object") {
            Object.entries(ev.data).forEach(([k,v]) => applyPatch(`${ev.path}/${k}`, v));
          }
        } catch { /**/ }
      });

      mainSse.onerror = () => {
        setSyncDot("error");
        setTimeout(fbStartMainListener, 5000);
      };

    } catch (err) { console.warn("[ChainCoord] SSE unavailable:", err); }
  }

  // Route a Firebase patch to the right handler
  function applyPatch(path, data) {
    // /hits  — full hits object replacement
    if (path === "/hits") {
      hitMap.clear();
      if (data && typeof data === "object") {
        Object.entries(data).forEach(([id, h]) => { if(h) hitMap.set(id, h); });
      }
      reNumberPending();
      setSyncDot("live");
      renderPanel();
      return;
    }

    // /hits/{id}  — single hit added or replaced
    const hitMatch = path.match(/^\/hits\/([^/]+)$/);
    if (hitMatch) {
      const id = hitMatch[1];
      if (data === null) { hitMap.delete(id); }
      else { hitMap.set(id, data); }
      reNumberPending();
      setSyncDot("live");
      renderPanel();
      return;
    }

    // /hits/{id}/{field}  — single field update (e.g. status, chainHitNum)
    const hitFieldMatch = path.match(/^\/hits\/([^/]+)\/(.+)$/);
    if (hitFieldMatch) {
      const [,id,field] = hitFieldMatch;
      if (hitMap.has(id)) {
        hitMap.get(id)[field] = data;
        reNumberPending();
        setSyncDot("live");
        renderPanel();
      }
      return;
    }

    // /session  — chain session changed
    if (path === "/session") {
      handleRemoteSession(data);
      return;
    }

    // /permissions  — full permissions object
    if (path === "/permissions") {
      permissions = (data && typeof data === "object") ? data : {};
      updateClearBtn();
      return;
    }

    // /permissions/{uid}  — single permission changed
    const permMatch = path.match(/^\/permissions\/([^/]+)$/);
    if (permMatch) {
      const uid = permMatch[1];
      if (data === null || data === false) delete permissions[uid];
      else permissions[uid] = true;
      updateClearBtn();
      return;
    }

    // /members  — full presence object (initial load)
    if (path === "/members") {
      presenceMap.clear();
      if (data && typeof data === "object") {
        Object.entries(data).forEach(([uid, m]) => { if(m) presenceMap.set(uid, m); });
      }
      return; // no renderPanel — silent
    }

    // /members/{uid}  — single member presence update
    const memberMatch = path.match(/^\/members\/([^/]+)$/);
    if (memberMatch) {
      const uid = memberMatch[1];
      if (data === null) presenceMap.delete(uid);
      else presenceMap.set(uid, data);
      return; // silent — no renderPanel
    }

    // /members/{uid}/lastSeen  — heartbeat update (most frequent)
    const heartbeatMatch = path.match(/^\/members\/([^/]+)\/lastSeen$/);
    if (heartbeatMatch) {
      const uid = heartbeatMatch[1];
      if (presenceMap.has(uid)) presenceMap.get(uid).lastSeen = data;
      else presenceMap.set(uid, { lastSeen: data });
      return; // silent
    }

    // / (root) — initial full load
    if (path === "/") {
      if (data && typeof data === "object") {
        // hits
        hitMap.clear();
        if (data.hits && typeof data.hits === "object") {
          Object.entries(data.hits).forEach(([id,h]) => { if(h) hitMap.set(id,h); });
        }
        // session
        if (data.session) handleRemoteSession(data.session);
        // permissions
        permissions = (data.permissions && typeof data.permissions==="object") ? data.permissions : {};
        // members (presence)
        presenceMap.clear();
        if (data.members && typeof data.members==="object") {
          Object.entries(data.members).forEach(([uid,m]) => { if(m) presenceMap.set(uid,m); });
        }
        reNumberPending();
        updateClearBtn();
        setSyncDot("live");
        renderPanel();
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Hit write operations — targeted, never overwrites full hit list
  // ══════════════════════════════════════════════════════════════════════════

  // Write a single new hit node
  function fbWriteHit(hit) {
    fbPut(P.hit(hit.id), hit);
    hitMap.set(hit.id, hit);
    reNumberPending();
    renderPanel();
  }

  // Update a single field on a hit
  function fbUpdateHitField(hitId, field, value) {
    fbPut(P.hitField(hitId, field), value);
    if (hitMap.has(hitId)) {
      hitMap.get(hitId)[field] = value;
      reNumberPending();
      renderPanel();
    }
  }

  // Write multiple field updates on a hit (e.g. marking done with name+chainHitNum)
  function fbUpdateHit(hitId, updates) {
    if (!hitMap.has(hitId)) return;
    const hit = { ...hitMap.get(hitId), ...updates };
    fbPut(P.hit(hitId), hit);
    hitMap.set(hitId, hit);
    reNumberPending();
    renderPanel();
  }

  // Clear all hits — DELETE the hits node entirely
  function fbClearHits() {
    fbDelete(P.hits());
    hitMap.clear();
    renderPanel();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Session management
  // ══════════════════════════════════════════════════════════════════════════
  function onChainStart(startMs) {
    chainStartTime = startMs || Date.now();
    chainSessionId = `s_${chainStartTime}_${Math.random().toString(36).slice(2,7)}`;
    fbPut(P.session(), { id: chainSessionId, startTime: chainStartTime });
  }

  function onChainEnd() {
    if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
    if (!chainSessionId) return;
    chainSessionId    = null;
    chainStartTime    = null;
    lastTimerReadAt   = null;
    liveChainSecs     = null;
    liveChainCount    = null;
    lastKnownCount    = null;
    chainConfirmed    = false;
    chainHit1Time     = null;
    scrapedHitIds.clear();
    hitMap.clear();
    fbClearHits();
    fbDelete(P.session());
    renderPanel();
    updateChainTimerUI();
  }

  function handleRemoteSession(data) {
    if (!data) {
      // Session cleared by another client
      if (chainSessionId) {
        chainSessionId = null; chainStartTime = null; chainConfirmed = false;
        chainHit1Time = null; sessionMinHitNum = null; scrapedHitIds.clear();
        hitMap.clear(); renderPanel();
      }
    } else if (data.id && data.id !== chainSessionId) {
      chainSessionId   = data.id;
      chainStartTime   = data.startTime || Date.now();
      sessionMinHitNum = null;  // reset anchor for new session
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain timer — MutationObserver for sub-second accuracy
  // ══════════════════════════════════════════════════════════════════════════
  function parseTimerText(txt) {
    const m = (txt||"").match(/(\d+):(\d+)(?::(\d+))?/);
    if (!m) return null;
    return m[3]!==undefined
      ? parseInt(m[1])*3600+parseInt(m[2])*60+parseInt(m[3])
      : parseInt(m[1])*60+parseInt(m[2]);
  }

  function findChainTimerEl() {
    const sels = [
      '[class*="chainTimer"] [class*="counter"]',
      '[class*="chain-timer"]',
      '[class*="chainInfo"] [class*="timer"]',
      '[class*="chain"] [class*="time"]:not(#chain-panel *)',
    ];
    for (const sel of sels) {
      try { const el=document.querySelector(sel); if(el&&parseTimerText(el.textContent)!==null) return el; } catch {/**/ }
    }
    const cw = document.querySelector('[class*="chain"]:not(#chain-panel)');
    if (cw) { for(const el of cw.querySelectorAll("*")){if(el.children.length>0)continue;if(parseTimerText(el.textContent)!==null)return el;} }
    return null;
  }

  function onDomTimerUpdate(rawSecs) {
    if (rawSecs === null) {
      liveChainSecs = null; lastTimerReadAt = null;
    } else if (rawSecs === 0) {
      liveChainSecs = null; lastTimerReadAt = null;
      if (chainSessionId) {
        if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
        onChainEnd();
      }
    } else {
      liveChainSecs   = Math.max(0, rawSecs - TIMER_FUDGE_SEC);
      lastTimerReadAt = performance.now();
    }
    updateChainTimerUI();
  }

  function startChainTimerObserver() {
    if (chainTimerObserver) { chainTimerObserver.disconnect(); chainTimerObserver = null; }
    const timerEl = findChainTimerEl();
    if (!timerEl) { setTimeout(startChainTimerObserver, 1000); return; }
    onDomTimerUpdate(parseTimerText(timerEl.textContent));
    chainTimerObserver = new MutationObserver(() => {
      const secs = parseTimerText(timerEl.textContent);
      if (secs === null) {
        onDomTimerUpdate(null);
        chainTimerObserver.disconnect(); chainTimerObserver = null;
        setTimeout(startChainTimerObserver, 2000);
      } else { onDomTimerUpdate(secs); }
    });
    chainTimerObserver.observe(timerEl, { characterData:true, childList:true, subtree:true });
  }

  new MutationObserver(() => { if (!chainTimerObserver) startChainTimerObserver(); })
    .observe(document.body, { childList:true, subtree:true });

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain API poll — count + session detection every 5s
  // ══════════════════════════════════════════════════════════════════════════
  function pollFactionChain() {
    if (!tornApiKey || !factionId) return;
    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/faction/${factionId}?selections=chain&key=${encodeURIComponent(tornApiKey)}`,
      timeout:8000,
      onload(r) { try { const d=JSON.parse(r.responseText); if(d&&!d.error) onChainApiData(d.chain||{}); } catch {/**/ } },
      onerror(){}, ontimeout(){},
    });
  }

  function onChainApiData(chain) {
    const newCount   = chain.current || 0;
    const newTimeout = chain.timeout || 0;
    const chainStart = chain.start   || 0;

    // Cooldown or no chain: wipe immediately
    if (newTimeout === 0 && chainSessionId) {
      if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
      onChainEnd(); return;
    }

    liveChainCount = newCount > 0 ? newCount : null;

    if (liveChainCount !== null && liveChainCount >= CHAIN_CONFIRM_HITS) chainConfirmed = true;

    if (liveChainCount !== null && lastKnownCount !== null && liveChainCount > lastKnownCount) {
      reNumberPending();
      renderPanel();
    }
    lastKnownCount = liveChainCount;

    const chainNowActive = newCount > 0 && newTimeout > 0;
    if (chainNowActive) {
      if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
      const apiStartMs = chainStart > 0 ? chainStart*1000 : null;
      if (!chainSessionId) {
        onChainStart(apiStartMs || Date.now());
      } else if (apiStartMs && chainStartTime && Math.abs(apiStartMs-chainStartTime) > 10000) {
        onChainEnd();
        setTimeout(() => onChainStart(apiStartMs), 500);
        return;
      }
      if (!chainTimerObserver) startChainTimerObserver();
    } else {
      if (chainSessionId && !chainEndDebounce) {
        chainEndDebounce = setTimeout(onChainEnd, CHAIN_END_DEBOUNCE);
      }
      chainConfirmed = false; chainHit1Time = null; scrapedHitIds.clear();
    }
    updateChainTimerUI();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain timer UI
  // ══════════════════════════════════════════════════════════════════════════
  function updateChainTimerUI() {
    const count = liveChainCount;
    if (liveChainSecs===null || lastTimerReadAt===null) {
      chainTimerVal.textContent="—"; chainTimerVal.className="ct-none";
      chainCountBadge.className="none"; warmingMsg.style.display="none";
      pillTimer.textContent="—"; pillTimer.className="ct-none";
    } else {
      const elapsed = (performance.now()-lastTimerReadAt)/1000;
      const disp    = Math.max(0, Math.round(liveChainSecs-elapsed));
      const txt     = `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}`;
      chainTimerVal.textContent = txt; pillTimer.textContent = txt;
      const cls = disp<=30?"ct-danger":disp<=90?"ct-warn":"ct-ok";
      chainTimerVal.className=cls; pillTimer.className=cls;
    }
    if (count!==null) {
      chainCountBadge.textContent=count;
      chainCountBadge.className = chainConfirmed?"running":"warming";
      warmingMsg.style.display  = chainConfirmed?"none":"";
    } else {
      chainCountBadge.className="none"; warmingMsg.style.display="none";
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Recent attacks scraper — marks queued hits done, adds untracked entries
  // ══════════════════════════════════════════════════════════════════════════
  function scrapeRecentAttacks() {
    if (!chainStartTime) return;  // no session — reject everything

    const containerSels = ['[class*="recentAttacks"]','[class*="recent-attacks"]','[class*="attackLog"]','[class*="attack-log"]'];
    let container = null;
    for (const sel of containerSels) { try { container=document.querySelector(sel); if(container)break; } catch {/**/ } }
    if (!container) return;

    const rowSels = ['[class*="attackLogRow"]','[class*="attack-log-row"]','[class*="log-row"]','li[class*="attack"]','li'];
    let rows = [];
    for (const sel of rowSels) { try { rows=Array.from(container.querySelectorAll(sel)); if(rows.length)break; } catch {/**/ } }
    if (!rows.length) return;

    const now          = Date.now();
    const apiCount     = liveChainCount || 0;
    let earliestHitTime = chainHit1Time;

    // ── Phase 1: collect all valid candidate rows from the DOM ───────────────
    // We need to look at ALL rows first to establish the anchor before
    // processing any hits — this handles mid-chain join (walk-back).
    const candidates = [];

    for (const row of rows) {
      const chainNumEl = (() => {
        for (const el of row.querySelectorAll("*")) {
          if (/^#\d+$/.test((el.textContent||"").trim()) && el.children.length===0) return el;
        }
        return null;
      })();
      if (!chainNumEl) continue;

      const chainHitNum = parseInt(chainNumEl.textContent.trim().replace("#",""));
      if (isNaN(chainHitNum) || chainHitNum < 1) continue;

      // Hard ceiling: chainHitNum must be ≤ liveChainCount + 1 (API lag buffer)
      // If API says count=1, hits #2, #3, #4 are impossible for this chain
      if (apiCount > 0 && chainHitNum > apiCount + 1) continue;

      const profileLinks = row.querySelectorAll('a[href*="profiles.php?XID="]');
      if (profileLinks.length < 2) continue;
      const targetProfileA = profileLinks[profileLinks.length-1];
      const targetIdMatch  = (targetProfileA.href||"").match(/XID=(\d+)/i);
      if (!targetIdMatch) continue;

      const tMatch = (row.textContent||"").match(/(\d+)\s*m\b/);
      const hMatch = (row.textContent||"").match(/(\d+)\s*h\b/);
      let minsAgo = tMatch ? parseInt(tMatch[1]) : 0;
      if (hMatch && !tMatch) minsAgo = parseInt(hMatch[1])*60;
      const attackTime = now - minsAgo*60000;

      // Must be after this chain session started — subtract 60s buffer
      // because DOM time display rounds to whole minutes ("4 m" could be 3m59s)
      if (attackTime < chainStartTime - 60000) continue;

      candidates.push({
        chainHitNum,
        targetId:    targetIdMatch[1],
        targetName:  (targetProfileA.textContent||"").trim() || `Player #${targetIdMatch[1]}`,
        attackerName:(profileLinks[0].textContent||"").trim() || "Unknown",
        attackUrl:   `https://www.torn.com/loader.php?sid=attack&user2ID=${targetIdMatch[1]}`,
        attackTime,
        row,
      });
    }

    if (!candidates.length) return;

    // ── Phase 2: establish sessionMinHitNum anchor ───────────────────────────
    // The anchor is the LOWEST chainHitNum in a consecutive sequence
    // that includes or is consistent with liveChainCount.
    //
    // Strategy:
    //   - Sort candidates by chainHitNum ascending
    //   - Find the highest chainHitNum ≤ apiCount+1 (the "top" of this chain)
    //   - Walk backwards through candidates to find the longest
    //     consecutive sequence ending at that top
    //   - The bottom of that sequence becomes sessionMinHitNum
    //
    // This handles mid-chain join: if chain is at 15 and we see
    // hits #12,#13,#14,#15 in recent attacks, anchor = 12.

    if (sessionMinHitNum === null) {
      const sorted = [...candidates].sort((a,b) => a.chainHitNum - b.chainHitNum);
      const hitNums = new Set(sorted.map(c => c.chainHitNum));

      // Find the top of the current chain in our candidates
      let top = 0;
      for (const c of sorted) {
        if (c.chainHitNum <= apiCount + 1) top = c.chainHitNum;
      }

      if (top > 0) {
        // Walk backwards from top to find the lowest consecutive hit
        let anchor = top;
        while (anchor > 1 && hitNums.has(anchor - 1)) anchor--;
        sessionMinHitNum = anchor;
      } else if (candidates.some(c => c.chainHitNum === 1)) {
        // Fallback: if we see a #1, anchor at 1
        sessionMinHitNum = 1;
      }
      // If we still can't anchor, we reject everything this tick
    }

    if (sessionMinHitNum === null) return;  // couldn't anchor — wait for more data

    // ── Phase 3: process validated candidates ────────────────────────────────
    for (const c of candidates) {
      // Reject hits below our anchor — they belong to a previous chain
      if (c.chainHitNum < sessionMinHitNum) continue;

      const dedupKey = `${chainSessionId||"nosession"}_hit_${c.chainHitNum}`;
      if (scrapedHitIds.has(dedupKey)) continue;
      scrapedHitIds.add(dedupKey);

      // Warm-up tracking
      if (c.chainHitNum === 1 && (!earliestHitTime || c.attackTime < earliestHitTime)) {
        earliestHitTime = c.attackTime;
      }
      if (c.chainHitNum >= CHAIN_CONFIRM_HITS && earliestHitTime !== null) {
        if (c.attackTime - earliestHitTime <= 5*60000) chainConfirmed = true;
      }

      // Match against queued pending hit
      const matchedEntry = [...hitMap.entries()].find(([,h]) =>
        h.status==="pending" && String(h.targetId)===String(c.targetId)
      );

      if (matchedEntry) {
        const [matchId] = matchedEntry;
        fbUpdateHit(matchId, {
          status:"done", doneAt:c.attackTime,
          hitNumber:c.chainHitNum, chainHitNum:c.chainHitNum,
          claimedBy:c.attackerName, targetId:c.targetId, targetName:c.targetName,
        });
      } else {
        const untrackedId = `scraped_${dedupKey}`;
        if (!hitMap.has(untrackedId)) {
          fbWriteHit({
            id:untrackedId, hitNumber:c.chainHitNum, chainHitNum:c.chainHitNum,
            targetId:c.targetId, targetName:c.targetName, claimedBy:c.attackerName,
            claimedAt:c.attackTime, scheduledAt:c.attackTime,
            hospReleaseAt:null, attackUrl:c.attackUrl,
            status:"done", doneAt:c.attackTime,
            untracked:true, scraped:true, sessionId:chainSessionId,
          });
        }
      }
    }

    chainHit1Time = earliestHitTime;
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

    // Refresh 🎯 button states
    document.querySelectorAll(".chain-target-btn").forEach(btn => {
      const profileA = btn.nextElementSibling;
      if (!profileA) return;
      const m = (profileA.href||"").match(/XID=(\d+)/i);
      if (!m) return;
      const queued = [...hitMap.values()].find(h=>h.status==="pending"&&h.targetId===m[1]);
      if (queued) { btn.textContent="✓"; btn.classList.add("claimed"); btn.title=`${profileA.textContent.trim()} queued as hit #${queued.hitNumber}`; }
      else if (btn.classList.contains("claimed")) { btn.textContent="🎯"; btn.classList.remove("claimed"); }
    });

    const pendingHits = getPendingHits();
    const doneHits    = getDoneHits();

    // Pill badge
    pillBadge.textContent = pendingHits.length;
    pillBadge.classList.toggle("visible", pendingHits.length > 0);

    // Next-hit strip
    const nextHit = pendingHits[0] || null;
    if (nextHit) {
      nextNum.textContent  = `#${nextHit.hitNumber}`;
      nextName.textContent = nextHit.targetName;
      nextName.style.color = "";
      nextTimer.textContent = "NOW"; nextTimer.className = "due";
      nextAttack.href = nextHit.attackUrl; nextAttack.style.display = "";
    } else {
      const nextSlot = getHighestDoneHitNum()+1;
      nextNum.textContent  = `#${nextSlot}`;
      nextName.textContent = "Unclaimed"; nextName.style.color = "#ff8888";
      nextAttack.style.display = "none";
      const chcMs = pendingCountdownMs(1);
      const disp  = Math.round(chcMs/1000);
      nextTimer.textContent = liveChainSecs!==null ? `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}` : "—";
      nextTimer.className   = disp<=30?"due":disp<=90?"soon":"wait";
    }

    // Full list
    const allHits = [...doneHits, ...pendingHits];
    if (!allHits.length) {
      colHead.style.display = "none";
      inner.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.6">No hits queued.<br>Click 🎯 next to an attack button.</div>`;
      return;
    }

    colHead.style.display = "";
    const now = Date.now();
    let html = "", queuePos = 0;

    for (const hit of allHits) {
      const hosp = isHospStillIn(hit);
      let rem, timerText, tc, rc;

      if (hit.status === "done") {
        rem=0; timerText="Done"; tc="done"; rc=hit.untracked?"untracked":"done";
      } else {
        rem       = pendingCountdownMs(queuePos);
        timerText = queuePos===0 ? "NOW" : formatTime(rem);
        tc        = queuePos===0 ? "due" : hitTimerClass(rem);
        rc        = queuePos===0 ? "due" : hitRowClass(rem, hosp, hit.untracked);
        queuePos++;
      }

      const hospSub = hosp
        ? `<span class="chain-hit-hosp-sub" data-hosp-id="${hit.id}">out in ${formatTime(hit.hospReleaseAt-now)}</span>`
        : "";

      html += `
        <div class="chain-hit-row ${rc}" data-hit-id="${hit.id}" data-queue-pos="${hit.status==="done"?-1:queuePos-1}">
          <span class="chain-hit-num">${hit.chainHitNum||hit.hitNumber}</span>
          <span class="chain-hit-claimer" title="${escHtml(hit.claimedBy)}">${hit.status==="done"?"✓ ":""}${escHtml(hit.claimedBy)}</span>
          <span class="chain-hit-target" title="${escHtml(hit.targetName)}">${escHtml(hit.targetName)}</span>
          <span class="chain-hit-timer ${tc}" data-pos="${hit.status==="done"?-1:queuePos-1}">${timerText}</span>
          <a class="chain-hit-attack" href="${escHtml(hit.attackUrl)}" target="_blank"
             ${hit.status==="done"||!hit.attackUrl||hit.attackUrl==="#"?'style="opacity:.2;pointer-events:none"':''}>⚔</a>
          ${hospSub}
        </div>`;
    }
    inner.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  1-second tick
  // ══════════════════════════════════════════════════════════════════════════
  setInterval(() => {
    const now = Date.now();
    updateChainTimerUI();
    scrapeRecentAttacks();

    // Live-update timer cells without full re-render
    document.querySelectorAll(".chain-hit-timer[data-pos]").forEach(cell => {
      const pos = parseInt(cell.dataset.pos);
      if (pos < 0) return;
      const rem = pendingCountdownMs(pos);
      cell.textContent = pos===0 ? "NOW" : formatTime(rem);
      cell.className   = `chain-hit-timer ${pos===0?"due":hitTimerClass(rem)}`;
      const row = cell.closest(".chain-hit-row");
      if (row) row.className = `chain-hit-row ${pos===0?"due":hitRowClass(rem,false,false)}`;
    });

    // Next-hit strip timer
    const nh = getPendingHits()[0];
    if (nh) { nextTimer.textContent="NOW"; nextTimer.className="due"; }
    else if (liveChainSecs !== null) {
      const rem  = pendingCountdownMs(1);
      const disp = Math.round(rem/1000);
      nextTimer.textContent = `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}`;
      nextTimer.className   = disp<=30?"due":disp<=90?"soon":"wait";
    }

    // Hosp sub-timers
    document.querySelectorAll("[data-hosp-id]").forEach(hc => {
      const hit = hitMap.get(hc.dataset.hospId);
      if (!hit) { hc.remove(); return; }
      if (!isHospStillIn(hit)) hc.remove();
      else hc.textContent = `out in ${formatTime(hit.hospReleaseAt-now)}`;
    });
  }, 1000);

  // ══════════════════════════════════════════════════════════════════════════
  //  Scheduling — queue a new pending hit
  // ══════════════════════════════════════════════════════════════════════════
  function scheduleAndWrite(apiData, targetId, targetName, attackUrl, btn) {
    const now            = Date.now();
    const state          = (apiData?.status?.state||"").toLowerCase();
    const hospReleaseSec = apiData?.states?.hospital_timestamp||0;
    const isInHosp       = state==="hospital"&&hospReleaseSec>0;
    const hospReleaseMs  = isInHosp ? hospReleaseSec*1000 : 0;
    const earliest       = Math.max(now, hospReleaseMs);

    const activeHits = [...hitMap.values()].filter(h=>h.status!=="done").sort((a,b)=>a.scheduledAt-b.scheduledAt);

    let insertSlot=null, insertPos=-1;
    if (!activeHits.length) {
      insertSlot = earliest;
    } else {
      for (let i=0; i<=activeHits.length; i++) {
        const prev=i===0?now:activeHits[i-1].scheduledAt;
        const cand=Math.max(prev+HIT_INTERVAL, earliest);
        const next=i<activeHits.length?activeHits[i].scheduledAt:Infinity;
        if (cand+HIT_INTERVAL<=next||i===activeHits.length) { insertSlot=cand; insertPos=i-1; break; }
      }
      if (insertSlot===null) { insertSlot=activeHits[activeHits.length-1].scheduledAt+HIT_INTERVAL; insertPos=activeHits.length-1; }
    }
    for (let i=insertPos+1; i<activeHits.length; i++) {
      const pt=i===0?insertSlot:activeHits[i-1].scheduledAt;
      if (activeHits[i].scheduledAt<pt+HIT_INTERVAL) activeHits[i].scheduledAt=pt+HIT_INTERVAL;
    }

    const newHit = {
      id:            `hit_${now}_${Math.random().toString(36).slice(2)}`,
      hitNumber:     0,
      targetId,
      targetName:    apiData.name||targetName,
      claimedBy:     ownName,
      claimedAt:     now,
      scheduledAt:   insertSlot,
      hospReleaseAt: hospReleaseMs||null,
      attackUrl,
      status:        "pending",
      sessionId:     chainSessionId,
    };

    fbWriteHit(newHit);  // writes to Firebase + hitMap + re-renders

    btn.textContent = "✓"; btn.classList.add("claimed");
    btn.title = isInHosp
      ? `Queued as hit #${newHit.hitNumber} — hosp out in ${formatTime(hospReleaseMs-Date.now())}`
      : `Queued as hit #${newHit.hitNumber}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Target claim handler
  // ══════════════════════════════════════════════════════════════════════════
  function handleTargetClaim(btn, targetId, targetName, attackUrl) {
    if (!tornApiKey)    { alert("Click the API button to set your Torn API key first."); return; }
    if (!factionId)     { alert("Could not detect your faction — make sure your API key is set."); return; }
    if (!fbConfigured()){ alert("Firebase is not configured yet — see FIREBASE_SETUP.md."); return; }

    // Duplicate check
    const already = [...hitMap.values()].find(h=>h.status==="pending"&&h.targetId===targetId);
    if (already) { alert(`${targetName} is already queued as hit #${already.hitNumber}.`); return; }

    btn.disabled=true; btn.classList.add("loading"); btn.textContent="⏳";

    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/user/${encodeURIComponent(targetId)}?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout:15000,
      onload(r) {
        btn.disabled=false; btn.classList.remove("loading");
        let data=null; try{data=JSON.parse(r.responseText);}catch{/**/ }
        if(!data||data.error){btn.textContent="🎯";alert(`Torn API error: ${data?.error?.error||"Unknown"}`);return;}
        const state=(data?.status?.state||"").toLowerCase();
        if(["abroad","traveling","jail","federal","fallen"].some(s=>state.includes(s))){btn.textContent="🎯";alert(`${targetName} is ${state} — cannot be scheduled.`);return;}
        scheduleAndWrite(data,targetId,targetName,attackUrl,btn);
      },
      onerror()  { btn.disabled=false;btn.classList.remove("loading");btn.textContent="🎯";alert("Network error."); },
      ontimeout(){ btn.disabled=false;btn.classList.remove("loading");btn.textContent="🎯";alert("Request timed out."); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  War list button injection
  // ══════════════════════════════════════════════════════════════════════════
  function extractAttackUrl(a) {
    const h=a?.href||"";
    if(h.includes("loader.php")&&h.includes("sid=attack")) return h;
    return h.startsWith("http")?h:"https://www.torn.com"+h;
  }

  function isInsideWarList(el) {
    const WAR_SELS='[class*="rankedWar"],[class*="ranked-war"],[class*="warFilter"],[class*="war-filter"],[class*="memberList"],[class*="member-list"],[class*="factionMembers"],[class*="members-list"],[class*="membersTable"]';
    let node=el.parentElement;
    while(node&&node!==document.body){try{if(node.matches&&node.matches(WAR_SELS))return true;}catch{/**/ }node=node.parentElement;}
    return false;
  }

  function injectTargetButtons() {
    document.querySelectorAll('a[href*="profiles.php?XID="]').forEach(profileA => {
      if(panel.contains(profileA))return;
      if(profileA.dataset.chainBtnInjected)return;
      if(!isInsideWarList(profileA))return;
      const m=(profileA.href||"").match(/XID=(\d+)/i);
      if(!m)return;
      const targetId=m[1];
      if(ownId&&targetId===ownId)return;
      profileA.dataset.chainBtnInjected="1";
      const targetName=(profileA.textContent||"").trim()||"Unknown";
      const row=profileA.closest("li")||profileA.closest('[class*="member"]')||profileA.closest("tr")||profileA.parentElement;
      let attackUrl=`https://www.torn.com/loader.php?sid=attack&user2ID=${targetId}`;
      if(row){const al=row.querySelector('a[href*="loader.php?sid=attack"]');if(al)attackUrl=extractAttackUrl(al);}
      const btn=document.createElement("button");
      btn.className="chain-target-btn";
      const queued=[...hitMap.values()].find(h=>h.status==="pending"&&h.targetId===targetId);
      if(queued){btn.textContent="✓";btn.classList.add("claimed");btn.title=`${targetName} queued as hit #${queued.hitNumber}`;}
      else{btn.textContent="🎯";btn.title=`Add ${targetName} to chain queue`;}
      btn.onclick=e=>{e.preventDefault();e.stopPropagation();handleTargetClaim(btn,targetId,targetName,attackUrl);};
      profileA.parentNode.insertBefore(btn,profileA);
    });
  }

  let injectQueued=false;
  new MutationObserver(()=>{if(injectQueued)return;injectQueued=true;setTimeout(()=>{injectQueued=false;injectTargetButtons();},150);})
    .observe(document.body,{childList:true,subtree:true});
  setInterval(injectTargetButtons,3000);

  // ══════════════════════════════════════════════════════════════════════════
  //  Torn API — profile + faction boot
  // ══════════════════════════════════════════════════════════════════════════
  function fetchFactionBasic() {
    if (!factionId || !tornApiKey) return;
    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/faction/${factionId}?selections=basic&key=${encodeURIComponent(tornApiKey)}`,
      timeout:15000,
      onload(r) {
        try {
          const d=JSON.parse(r.responseText);
          if(!d||d.error) return;
          factionLeader   = String(d.leader||"");
          factionCoLeader = String(d["co-leader"]||"0");
          factionMembers  = {};
          if(d.members) Object.entries(d.members).forEach(([uid,m])=>{factionMembers[uid]=m.name;});
          isLeaderOrCoLeader=(ownId===factionLeader)||(factionCoLeader!=="0"&&ownId===factionCoLeader);
          updateClearBtn();
        } catch {/**/ }
      },
    });
  }

  function fetchOwnProfile() {
    if (!tornApiKey) { showBanner("chain-banner-nokey",true); return; }
    showBanner("chain-banner-nokey",false);
    showBanner("chain-banner-status",true,"Connecting…");

    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout:15000,
      onload(r) {
        try {
          const data=JSON.parse(r.responseText);
          if(!data||data.error){showBanner("chain-banner-status",true,`API error: ${data?.error?.error||"bad key"}`);return;}
          ownName     = data.name||"Me";
          ownId       = String(data.player_id||"");
          factionId   = data.faction?.faction_id ? String(data.faction.faction_id) : null;
          factionName = data.faction?.faction_name||"";
          updateApiBtn();
          showBanner("chain-banner-status",false);

          if(!factionId||factionId==="0"){showBanner("chain-banner-nofact",true);return;}
          showBanner("chain-banner-nofact",false);

          if(!fbConfigured()){showBanner("chain-banner-nofb",true);return;}
          showBanner("chain-banner-nofb",false);

          fetchFactionBasic();

          fbSignInAnon((token,uid)=>{
            fbToken = token;
            fbUid   = uid;

            // Register presence + start heartbeat
            fbRegisterMember();
            setInterval(fbHeartbeat, PRESENCE_HEARTBEAT);

            // Start single SSE listener on faction root
            fbStartMainListener();

            // Chain API poll
            pollFactionChain();
            setInterval(pollFactionChain, CHAIN_POLL_MS);

            // DOM timer observer
            startChainTimerObserver();
          });
        } catch { showBanner("chain-banner-status",true,"Failed to parse API response."); }
      },
      onerror()  { showBanner("chain-banner-status",true,"Network error reaching Torn API."); },
      ontimeout(){ showBanner("chain-banner-status",true,"Torn API timed out."); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Tampermonkey menu
  // ══════════════════════════════════════════════════════════════════════════
  GM_registerMenuCommand("Set Torn API Key", openApiPopover);
  GM_registerMenuCommand("Clear Torn API Key", () => {
    tornApiKey=""; GM_setValue(SK_API_KEY,""); updateApiBtn(); showBanner("chain-banner-nokey",true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Boot
  // ══════════════════════════════════════════════════════════════════════════
  renderPanel();
  fetchOwnProfile();
  injectTargetButtons();

})();
