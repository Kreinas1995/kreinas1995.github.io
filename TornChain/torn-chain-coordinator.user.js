// ==UserScript==
// @name         Torn Chain Coordinator
// @namespace    https://kreinas1995.github.io/
// @version      4.9.9
// @description  Multi-faction shared chain board. Keyed Firebase writes, single SSE per client, presence display, faction-scoped auth.
// @author       Kreinas1995
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/index.php*
// @match        https://www.torn.com/loader.php*
// @match        https://www.torn.com/page.php*
// @match        https://www.torn.com/messages.php*
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/city.php*
// @match        https://www.torn.com/crimes.php*
// @match        https://www.torn.com/gym.php*
// @match        https://www.torn.com/jailview.php*
// @match        https://www.torn.com/hospitalview.php*
// @match        https://www.torn.com/itemmarket.php*
// @match        https://www.torn.com/bazaar.php*
// @match        https://www.torn.com/properties.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      firebaseio.com
// @connect      googleapis.com
// @connect      securetoken.googleapis.com
// @connect      raw.githubusercontent.com
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
  // OWNER_TORN_ID has been removed from client code — owner identity is verified
  // exclusively by Firebase rules (lobby/{uid}/tornId check server-side). This prevents
  // anyone from editing the script to impersonate the owner.
  const CURRENT_VERSION  = "4.9.9";    // must be near top — used in panel HTML template literal

  // ─── Timing constants ─────────────────────────────────────────────────────
  const CHAIN_POLL_MS        = 5300;  // prime-offset vs fbPollOnce(3000) — avoids 10s collision
  const PRESENCE_HEARTBEAT   = 15000;
  const PRESENCE_TIMEOUT     = 90000;   // 90s — 6× heartbeat interval, tolerates dropped beats
  const HIT_DELAY_MS         = 4 * 60 * 1000;
  const HIT_INTERVAL         = 5 * 60 * 1000;
  const CHAIN_CONFIRM_HITS   = 10;
  const CHAIN_END_DEBOUNCE   = 8000;
  const TIMER_FUDGE_SEC      = 0;

  // ─── GM storage keys ──────────────────────────────────────────────────────
  const SK_API_KEY        = "chain_api_key";
  const SK_PANEL_W        = "chain_panel_w";
  const SK_PANEL_H        = "chain_panel_h";
  const SK_VIEW_MODE      = "chain_view_mode";
  const SK_POS_RIGHT       = "chain_pos_right";   // distance from right viewport edge (px)
  const SK_POS_Y          = "chain_pos_y";
  // Legacy key — read once to migrate, then ignored
  const SK_POS_X          = "chain_pos_x";
  const SK_TRACKER_H      = "chain_tracker_h";
  const SK_ADMIN_H        = "chain_admin_h";
  // Per-mode position memory — each view mode remembers its own last position
  const SK_POS_X_FULL     = "chain_pos_x_full";
  const SK_POS_Y_FULL     = "chain_pos_y_full";
  const SK_POS_X_ICON     = "chain_pos_x_icon";
  const SK_POS_Y_ICON     = "chain_pos_y_icon";
  const SK_POS_X_MINI     = "chain_pos_x_mini";
  const SK_POS_Y_MINI     = "chain_pos_y_mini";
  // FIX #2: persist chain session so reload doesn't lose history
  const SK_SESSION_ID     = "chain_session_id";
  const SK_SESSION_START  = "chain_session_start";
  const SK_SESSION_MIN    = "chain_session_min";
  const SK_CHAIN_COUNT    = "chain_live_count";
  // ─── Settings keys ────────────────────────────────────────────────────────
  const SK_SHOW_DONE_HITS   = "chain_show_done_hits";      // bool: show done hits in list
  const SK_COMPACT_MODE     = "chain_compact_mode";         // bool: reduce row height
  const SK_NOTIFY_SOUND     = "chain_notify_sound";         // bool: play sound when hit due
  const SK_TIMER_FUDGE_USR  = "chain_timer_fudge";          // int: seconds offset on timer
  const SK_PANEL_OPACITY    = "chain_panel_opacity";         // number: 0.6–1.0
  const SK_WARN_THRESHOLD   = "chain_warn_threshold";        // int: seconds for warn color (default 90)
  const SK_DANGER_THRESHOLD = "chain_danger_threshold";      // int: seconds for danger color (default 30)
  const SK_SHOW_BONUS_ALERT = "chain_show_bonus_alert";      // bool: highlight bonus hits
  const SK_MINI_SHOW_COUNT  = "chain_mini_show_count";       // bool: show chain count in mini pill
  const SK_AUTO_EXPAND_DUE  = "chain_auto_expand_due";       // bool: auto-switch to full view when hit is due

  // ─── App state ────────────────────────────────────────────────────────────
  // Read API key: localStorage first (survives TM UUID changes on reinstall /
  // paste-install), fall back to GM storage (works with proper TM auto-updates).
  // TornPDA blocks localStorage — detected early so we skip it on PDA.
  const _ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const isTornPDA = _ua.includes("TornPDA") || _ua.includes("torn_pda") ||
    _ua.includes("Dart") || document.documentElement.dataset.tornpda === "true";

  let tornApiKey = "";
  if (!isTornPDA) {
    try { tornApiKey = (localStorage.getItem("tcc_api_key") || "").trim(); } catch { /**/ }
  }
  if (!tornApiKey) tornApiKey = (GM_getValue(SK_API_KEY, "") || "").trim();
  if (tornApiKey) {
    if (!isTornPDA) { try { localStorage.setItem("tcc_api_key", tornApiKey); } catch { /**/ } }
    GM_setValue(SK_API_KEY, tornApiKey);
  }
  let panelW        = GM_getValue(SK_PANEL_W, 380);
  // Enforce minimum width in case a narrower value was saved previously
  if (panelW < 360) { panelW = 380; GM_setValue(SK_PANEL_W, panelW); }
  let panelH        = GM_getValue(SK_PANEL_H, null);
  let viewMode      = isTornPDA ? 0 : GM_getValue(SK_VIEW_MODE, 1);

  // ─── User settings state ──────────────────────────────────────────────────
  let settShowDoneHits   = GM_getValue(SK_SHOW_DONE_HITS,   true);
  let settCompactMode    = GM_getValue(SK_COMPACT_MODE,     false);
  let settNotifySound    = GM_getValue(SK_NOTIFY_SOUND,     false);
  let settTimerFudge     = GM_getValue(SK_TIMER_FUDGE_USR,  0);
  let settPanelOpacity   = GM_getValue(SK_PANEL_OPACITY,    0.96);
  let settWarnThreshold  = GM_getValue(SK_WARN_THRESHOLD,   90);
  let settDangerThreshold= GM_getValue(SK_DANGER_THRESHOLD, 30);
  let settShowBonusAlert = GM_getValue(SK_SHOW_BONUS_ALERT, true);
  let settMiniShowCount  = GM_getValue(SK_MINI_SHOW_COUNT,  true);
  let settAutoExpandDue  = GM_getValue(SK_AUTO_EXPAND_DUE,  false);
  // Notification sound (AudioContext, created lazily)
  let _notifyAudioCtx    = null;
  function playDueSound() {
    if (!settNotifySound) return;
    try {
      if (!_notifyAudioCtx) _notifyAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _notifyAudioCtx;
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
    } catch { /**/ }
  }

  let ownName       = "Me";
  let ownId         = null;
  let factionId     = null;
  let factionName   = "";
  let factionLeader = null;
  let factionCoLeader = null;
  let factionMembers  = {};
  let isLeaderOrCoLeader = false;
  let inRankedWar         = false;
  let warOpponentFactionIds = new Set();
  let isOwner             = false;

  const BONUS_HITS = new Set([10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);

  // ─── Firebase state ───────────────────────────────────────────────────────
  let fbToken       = null;
  let fbRefreshToken = null;  // used to refresh the ID token before it expires (1hr TTL)
  let fbUid         = null;
  let hitMap        = new Map();
  // BUG FIX: Track notified hit IDs in a separate Set so Firebase re-syncs
  // (which rebuild hitMap and wipe per-object flags) don't re-trigger alerts.
  const _notifiedHitIds = new Set();
  // BUG FIX: Track locally-deleted hit IDs so Firebase syncs don't re-insert them
  // before the DELETE propagates to the server (race condition).
  const _deletedHitIds = new Set();
  let permissions   = {};
  let canClear      = false;
  let presenceMap   = new Map();

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
  let timerRetryInterval = null;   // FIX #2: fallback retry for timer observer
  let sessionMinHitNum = null;
  let chainCooldownSecs   = null;   // seconds remaining on cooldown (from API)
  let chainCooldownReadAt = null;   // performance.now() when cooldown was last read
  let apiTimerSecs        = null;   // chain timeout from last API poll (fallback timer)
  let apiTimerReadAt      = null;   // performance.now() when that poll arrived
  let networkLatestVersion = null;  // highest version seen across all online clients
  let clientVersionMap     = new Map(); // fbUid → version string for all active clients
  let heartbeatFailCount   = 0;     // consecutive heartbeat lobby failures → triggers re-auth

  // Session is restored from Firebase on first poll — do not restore from
  // GM storage as stale chainStartTime causes the scraper to accept hits
  // from the previous chain. Firebase is the single source of truth.

  // ── Persist session state helper ──────────────────────────────────────────
  function persistSession() {
    // Only persist liveChainCount for display purposes.
    // Session ID/start/min are intentionally NOT persisted — Firebase is
    // the source of truth and stale local values cause scraper false positives.
    GM_setValue(SK_CHAIN_COUNT, liveChainCount || "");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase path helpers
  // ══════════════════════════════════════════════════════════════════════════
  const auth = () => fbToken ? `?auth=${fbToken}` : "";
  const fBase = () => `${FIREBASE_DB_URL}/factions/${factionId}`;

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
    memberById:  id  => `${fBase()}/members/torn_${id}.json${auth()}`,
    memberMe:    ()  => ownId ? `${fBase()}/members/torn_${ownId}.json${auth()}` : null,
    // Lobby: keyed by fbUid — auth.uid === $uid is the only reliable identity check in rules
    lobbyBootstrap:  () => fbUid ? `${FIREBASE_DB_URL}/lobby/${fbUid}.json${auth()}` : null,
    lobbyMe:         () => fbUid ? `${FIREBASE_DB_URL}/lobby/${fbUid}.json${auth()}` : null,
    lobbyMeField:    f  => fbUid ? `${FIREBASE_DB_URL}/lobby/${fbUid}/${f}.json${auth()}` : null,
    lobbyAll:        () => `${FIREBASE_DB_URL}/lobby.json${auth()}`,
    whitelist:       () => `${FIREBASE_DB_URL}/whitelist.json${auth()}`,
    whitelistEntry:  fid => `${FIREBASE_DB_URL}/whitelist/${fid}.json${auth()}`,
    // Global client version registry — keyed by torn_{tornId} for dedup across page loads
    clientVersion:   key => `${FIREBASE_DB_URL}/meta/clientVersions/${key}.json${auth()}`,
    clientVersions:  ()  => `${FIREBASE_DB_URL}/meta/clientVersions.json${auth()}`,
    // Canonical latest-release node — written by checkForUpdate, read by all clients
    latestVersion:   ()  => `${FIREBASE_DB_URL}/meta/latestVersion.json${auth()}`,
    // Bug reports (authenticated write, owner read) and public tracker (public read)
    bugReport:    id  => `${FIREBASE_DB_URL}/bugs/${id}.json${auth()}`,
    bugs:         ()  => `${FIREBASE_DB_URL}/bugs.json${auth()}`,
    bugTracker:   ()  => `${FIREBASE_DB_URL}/bugTracker.json${auth()}`,
    bugTrackerEntry: id => `${FIREBASE_DB_URL}/bugTracker/${id}.json${auth()}`,
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
    .chain-target-btn.chain-target-btn-lg {
      height:42px !important; width:42px !important; border-radius:5px !important;
      font-size:20px !important; padding:0 !important; margin:0 12px 12px 0 !important;
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      vertical-align:top !important; flex-shrink:0 !important;
    }
    .mini-profile-wrapper .buttons-list .chain-target-btn,
    .mini-profile-wrapper .buttons-wrap .chain-target-btn,
    [class*="profile-mini-"] .buttons-list .chain-target-btn,
    [class*="profile-mini-"] .buttons-wrap .chain-target-btn {
      width:35px !important; max-width:35px !important; min-width:unset !important;
      height:35px !important; max-height:35px !important;
      padding:0 !important; margin:unset !important; font-size:18px !important;
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      align-self:center !important; flex-shrink:0 !important;
      box-sizing:border-box !important; overflow:hidden !important;
    }

    #chain-panel {
      position:fixed !important; z-index:999999 !important;
      border-radius:12px !important; background:rgba(16,18,24,.96) !important; color:#e8e8e8 !important;
      box-shadow:0 12px 32px rgba(0,0,0,.6) !important; font-family:Arial,Helvetica,sans-serif !important;
      user-select:none !important; overflow:visible !important; display:flex !important;
      flex-direction:column !important; touch-action:none !important;
      /* FIX #5: smooth view mode transitions */
      transition:border-radius .15s, width .15s, height .15s !important;
    }

    /* ══ View modes ══════════════════════════════════════════════════════════ */

    /* ── view-full: complete board ── */
    #chain-panel.view-full { /* default — all children visible */ }

    /* ── view-mini: slim pill — timer + badge only ── */
    #chain-panel.view-mini {
      border-radius:50px !important;
      box-shadow:0 4px 16px rgba(0,0,0,.55) !important;
      min-width:0 !important; width:auto !important; height:auto !important;
    }
    #chain-panel.view-mini #chain-panel-header { padding:6px 10px !important; border-bottom:none !important; }
    #chain-panel.view-mini #chain-panel-title,
    #chain-panel.view-mini #chain-api-cluster,
    #chain-panel.view-mini #chain-presence-btn,
    #chain-panel.view-mini #chain-gear-btn,
    #chain-panel.view-mini #chain-timer-bar,
    #chain-panel.view-mini #chain-warming-msg,
    #chain-panel.view-mini #chain-cooling-msg,
    #chain-panel.view-mini #chain-panel-body,
    #chain-panel.view-mini #chain-resize-handle { display:none !important; }
    #chain-panel.view-icon #chain-whitelist-btn { display:none !important; }
    #chain-panel.view-icon #chain-version-badge { display:none !important; }
    #chain-pill-content { display:none; align-items:center; gap:6px; white-space:nowrap; }
    #chain-panel.view-mini #chain-pill-content { display:flex !important; }
    #chain-pill-icon  { font-size:16px; line-height:1; }
    #chain-pill-timer { font-family:monospace; font-weight:700; font-size:13px; }
    #chain-pill-timer.ct-ok     { color:#44ff88; }
    #chain-pill-timer.ct-warn   { color:#ffcc66; }
    #chain-pill-timer.ct-danger { color:#ff5555; }
    #chain-pill-timer.ct-none   { color:#556; }
    #chain-pill-timer.ct-cool   { color:#7ecfff; font-size:11px; font-weight:600; letter-spacing:.2px; }
    #chain-pill-badge {
      background:#ff5555; color:#fff; font-size:9px; font-weight:700;
      border-radius:8px; padding:1px 5px; min-width:14px; text-align:center;
      line-height:14px; display:none;
    }
    #chain-pill-badge.visible { display:inline-block !important; }

    /* ── view-icon: single ⛓ button, chat-bar height ── */
    #chain-panel.view-icon {
      border-radius:50% !important;
      box-shadow:0 2px 10px rgba(0,0,0,.6) !important;
      min-width:0 !important; width:44px !important; height:44px !important;
      background:rgba(16,18,24,.97) !important;
      border:2px solid rgba(255,255,255,.12) !important;
      display:flex !important; align-items:center !important; justify-content:center !important;
    }
    #chain-panel.view-icon #chain-panel-header { display:none !important; }
    #chain-panel.view-icon #chain-timer-bar,
    #chain-panel.view-icon #chain-warming-msg,
    #chain-panel.view-icon #chain-cooling-msg,
    #chain-panel.view-icon #chain-panel-body,
    #chain-panel.view-icon #chain-resize-handle { display:none !important; }
    #chain-icon-btn {
      display:none; align-items:center; justify-content:center;
      font-size:22px; line-height:1; cursor:pointer; width:100%; height:100%;
      position:relative;
    }
    #chain-panel.view-icon #chain-icon-btn { display:flex !important; }
    #chain-icon-badge {
      position:absolute; top:-4px; right:-4px;
      background:#ff5555; color:#fff; font-size:8px; font-weight:700;
      border-radius:8px; padding:1px 4px; min-width:12px; text-align:center;
      line-height:13px; display:none; pointer-events:none;
    }
    #chain-icon-badge.visible { display:inline-block !important; }

    /* next-strip kept for potential future use but hidden in all new modes */
    #chain-next-strip { display:none !important; }
    #chain-next-num   { font-weight:700; color:#556; font-size:11px; flex-shrink:0; }
    #chain-next-name  { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    #chain-next-timer { font-family:monospace; font-weight:700; font-size:12px; flex-shrink:0; }
    #chain-next-timer.due  { color:#44ff88; }
    #chain-next-timer.soon { color:#ffcc66; }
    #chain-next-timer.wait { color:#556677; }

    /* ── Header ── */
    #chain-panel-header {
      display:flex !important; align-items:center !important; gap:4px !important;
      padding:6px 8px !important; background:rgba(255,255,255,.055) !important;
      border-bottom:1px solid rgba(255,255,255,.08) !important; flex-shrink:0 !important;
      cursor:grab !important; position:relative !important; border-radius:12px 12px 0 0 !important;
      overflow:visible !important; box-sizing:border-box !important; width:100% !important;
    }
    #chain-panel-header:active { cursor:grabbing !important; }
    #chain-panel-title {
      font-weight:700 !important; font-size:13px !important;
      flex:0 0 auto !important; min-width:0 !important; max-width:160px !important; margin-left:6px !important;
      white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important;
    }

    /* ── Header buttons ── */
    .chain-hbtn {
      background:rgba(255,255,255,.1) !important; border:1px solid rgba(255,255,255,.15) !important;
      color:#ccc !important; border-radius:6px !important; padding:4px 10px !important;
      font-size:13px !important; cursor:pointer !important; line-height:1.4 !important;
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

    /* ── Update arrow ── */
    #chain-update-btn {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      width:18px !important; height:18px !important; border-radius:5px !important;
      background:rgba(255,255,255,.06) !important; border:1px solid rgba(255,255,255,.12) !important;
      color:#445 !important; font-size:13px !important; font-weight:700 !important;
      text-decoration:none !important; cursor:pointer !important; flex-shrink:0 !important;
      line-height:1 !important; transition:background .2s, border-color .2s, color .2s !important;
    }
    #chain-update-btn:hover { background:rgba(255,255,255,.14) !important; color:#888 !important; }
    #chain-update-btn.has-update {
      background:rgba(68,255,136,.15) !important; border-color:rgba(68,255,136,.4) !important;
      color:#44ff88 !important;
    }
    #chain-update-btn.has-update:hover { background:rgba(68,255,136,.32) !important; }

    /* ── API cluster (pill stack: [API][↑] / version) ── */
    #chain-api-cluster {
      display:flex !important; flex-direction:column !important; align-items:flex-start !important;
      gap:2px !important; flex-shrink:0 !important;
    }
    #chain-api-cluster-row {
      display:flex !important; align-items:center !important; gap:3px !important;
    }

    /* ── Version badge (tucked under API+update pills) ── */
    #chain-version-badge {
      font-size:8px !important; font-weight:700 !important; color:#334 !important;
      letter-spacing:.3px !important; white-space:nowrap !important;
      font-family:monospace !important; line-height:1 !important; padding:0 1px !important;
      transition:color .2s !important;
    }
    #chain-version-badge.newest  { color:#44ff88 !important; }
    #chain-version-badge.behind  { color:#ffaa44 !important; }

    /* ── Gear dropdown menu ── */
    #chain-gear-menu {
      display:none; position:absolute; top:42px; right:28px; z-index:1000002;
      background:rgba(20,22,30,.98); border:1px solid rgba(255,255,255,.12);
      border-radius:8px; padding:4px; box-shadow:0 8px 24px rgba(0,0,0,.65);
      flex-direction:column; gap:2px; min-width:160px;
    }
    #chain-gear-menu.open { display:flex !important; }
    .chain-gear-menu-item {
      padding:7px 10px !important; font-size:12px !important; color:#ccc !important;
      cursor:pointer !important; border-radius:5px !important; white-space:nowrap !important;
    }
    .chain-gear-menu-item:hover { background:rgba(255,255,255,.1) !important; color:#fff !important; }

    /* ── Sync dot ── */
    #chain-sync-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; background:#334; transition:background .3s; }
    #chain-header-right {
      display:flex !important; align-items:center !important; gap:4px !important;
      margin-left:auto !important; flex-shrink:0 !important; flex-grow:0 !important;
      min-width:max-content !important;
    }
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
    #chain-cooling-msg {
      font-size:10px !important; color:#66ccff !important; padding:3px 10px !important;
      background:rgba(60,160,255,.07) !important; border-bottom:1px solid rgba(60,160,255,.14) !important;
      text-align:center !important; flex-shrink:0 !important; letter-spacing:.2px !important;
    }
    @keyframes chain-pulse { from{background:rgba(255,85,85,.04)} to{background:rgba(255,85,85,.14)} }

    /* ── Popovers ── */
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

    /* ── Whitelist popover ── */
    #chain-whitelist-popover { left:8px; width:230px; max-height:340px; border:1px solid rgba(100,200,255,.35); }
    #chain-whitelist-title   { font-size:11px; font-weight:700; color:#66ccff; }
    #chain-whitelist-subtitle { font-size:10px; color:#556; margin-top:-4px; }
    #chain-whitelist-list    { overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:3px; max-height:180px; }
    #chain-whitelist-list::-webkit-scrollbar { width:4px; }
    #chain-whitelist-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:2px; }
    .chain-whitelist-row { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:5px; font-size:11px; color:#ccc; }
    .chain-whitelist-row span { flex:1; font-family:monospace; }
    .chain-whitelist-row button { background:rgba(255,60,60,.15); border:1px solid rgba(255,60,60,.35); color:#ff8888; border-radius:4px; font-size:10px; padding:1px 5px; cursor:pointer; }
    .chain-whitelist-row button:hover { background:rgba(255,60,60,.32); }
    #chain-whitelist-add-row { display:flex; gap:5px; }
    #chain-whitelist-input { flex:1; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.15); border-radius:6px; color:#e8e8e8; padding:4px 7px; font-size:11px; font-family:monospace; outline:none; }
    #chain-whitelist-input:focus { border-color:rgba(100,200,255,.5) !important; }
    #chain-whitelist-add { padding:4px 8px; border-radius:6px; font-size:11px; cursor:pointer; border:1px solid rgba(100,200,255,.4); background:rgba(60,160,255,.15); color:#66ccff; }
    #chain-whitelist-add:hover { background:rgba(60,160,255,.28); }
    #chain-whitelist-status { font-size:10px; color:#445; text-align:center; min-height:13px; }
    #chain-whitelist-close { padding:4px 0; border-radius:6px; font-size:11px; cursor:pointer; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.08); color:#ccc; }
    #chain-whitelist-close:hover { background:rgba(255,255,255,.18); }

    /* ── Settings panel ── */
    #chain-settings-popover { flex-direction:column; gap:6px; }
    #chain-settings-popover.open { display:flex !important; }
    #chain-settings-body::-webkit-scrollbar { width:4px; }
    #chain-settings-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:2px; }
    .chain-sett-section-hdr {
      font-size:9px; font-weight:700; color:#445; letter-spacing:.5px; text-transform:uppercase;
      padding:8px 0 3px; border-top:1px solid rgba(255,255,255,.06); margin-top:2px;
      flex-shrink:0;
    }
    .chain-sett-section-hdr:first-child { border-top:none; padding-top:2px; margin-top:0; }
    .chain-sett-row {
      display:flex; flex-direction:column; gap:2px;
      padding:6px 0 6px 8px; border-radius:6px; cursor:pointer;
      transition:background .1s; position:relative;
    }
    .chain-sett-row:hover { background:rgba(255,255,255,.04); }
    .chain-sett-row input.chain-sett-toggle {
      position:absolute; right:8px; top:50%; transform:translateY(-50%);
      width:28px; height:16px; appearance:none; -webkit-appearance:none;
      background:#223; border:1px solid rgba(255,255,255,.15); border-radius:8px;
      cursor:pointer; transition:background .15s; flex-shrink:0;
    }
    .chain-sett-row input.chain-sett-toggle:checked { background:#1a6640; border-color:rgba(68,255,136,.5); }
    .chain-sett-row input.chain-sett-toggle::after {
      content:""; position:absolute; width:10px; height:10px; border-radius:50%;
      background:#667; top:2px; left:2px; transition:left .15s, background .15s;
    }
    .chain-sett-row input.chain-sett-toggle:checked::after { left:14px; background:#44ff88; }
    .chain-sett-label { font-size:11px; font-weight:600; color:#ccc; padding-right:42px; }
    .chain-sett-desc  { font-size:9px; color:#445; line-height:1.3; padding-right:42px; }
    .chain-sett-row-slider { cursor:default; }
    .chain-sett-row-slider:hover { background:rgba(255,255,255,.04); }
    .chain-sett-slider-wrap { display:flex; align-items:center; gap:7px; margin-top:4px; padding-right:4px; }
    .chain-sett-slider {
      flex:1; -webkit-appearance:none; appearance:none; height:4px;
      background:rgba(255,255,255,.12); border-radius:2px; outline:none; cursor:pointer;
    }
    .chain-sett-slider::-webkit-slider-thumb {
      -webkit-appearance:none; width:14px; height:14px; border-radius:50%;
      background:#88bbff; border:2px solid rgba(100,160,255,.6); cursor:pointer;
    }
    .chain-sett-slider-val { font-size:10px; font-family:monospace; font-weight:700; color:#88bbff; min-width:30px; text-align:right; flex-shrink:0; }
    .chain-sett-action-btn {
      flex:1; padding:5px 0; border-radius:6px; font-size:10px; font-weight:700;
      cursor:pointer; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.07);
      color:#aaa; letter-spacing:.3px; transition:background .1s;
    }
    .chain-sett-action-btn:hover  { background:rgba(255,255,255,.17); color:#fff; }
    .chain-sett-action-btn.danger { border-color:rgba(255,80,80,.4); color:#ff8888; background:rgba(255,60,60,.08); }
    .chain-sett-action-btn.danger:hover { background:rgba(255,60,60,.22); }

    /* ── Compact mode ── */
    #chain-panel.compact .chain-hit-row { padding:2px 10px !important; }
    #chain-panel.compact #chain-col-header { padding:2px 10px !important; }

    /* ── Presence popover ── */
    #chain-presence-popover { left:50%; transform:translateX(-50%); width:220px; border:1px solid rgba(100,200,255,.3); }
    #chain-presence-title   { font-size:11px; font-weight:700; color:#88ccff; }
    #chain-presence-list    { display:flex; flex-direction:column; gap:4px; max-height:150px; overflow-y:auto; }
    .chain-presence-row     { display:flex; align-items:center; gap:7px; font-size:11px; color:#ccc; padding:2px 0; }
    .chain-presence-dot        { width:6px; height:6px; border-radius:50%; background:#44ff88; flex-shrink:0; }
    .chain-presence-dot.offline{ background:#445 !important; }
    .chain-presence-name    { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chain-presence-ver     { font-size:9px; font-weight:700; font-family:monospace; flex-shrink:0; opacity:.9; }
    #chain-offline-toggle   {
      display:flex; align-items:center; gap:5px; cursor:pointer;
      font-size:10px; font-weight:700; color:#445; padding:4px 0 2px;
      border-top:1px solid rgba(255,255,255,.06); margin-top:4px;
      user-select:none; letter-spacing:.3px;
    }
    #chain-offline-toggle:hover { color:#667; }
    #chain-offline-toggle .chain-offline-arrow { font-size:8px; transition:transform .15s; }
    #chain-offline-toggle.open .chain-offline-arrow { transform:rotate(90deg); }
    #chain-offline-list { display:none; flex-direction:column; gap:3px; margin-top:2px; }
    #chain-offline-list.open { display:flex; }
    .chain-presence-row.offline { opacity:.55; }

    /* ── Panel body + banners ── */
    #chain-panel-body { display:flex !important; flex-direction:column !important; flex:1 !important; overflow:hidden !important; border-radius:0 0 12px 12px; }
    .chain-banner { padding:5px 10px !important; font-size:11px !important; text-align:center !important; flex-shrink:0 !important; line-height:1.3 !important; }
    .chain-banner.warn { color:#ff8888; background:rgba(255,60,60,.08); border-bottom:1px solid rgba(255,60,60,.15); }
    .chain-banner.info { color:#88aacc; background:rgba(80,120,200,.08); border-bottom:1px solid rgba(80,120,200,.15); }

    /* ── Column header ── */
    #chain-col-header {
      display:grid !important; grid-template-columns:48px 1fr 1fr 58px 20px 18px !important;
      gap:0 5px !important; padding:4px 10px !important; font-size:10px !important;
      text-transform:uppercase !important; letter-spacing:.5px !important; color:#445 !important;
      border-bottom:1px solid rgba(255,255,255,.06) !important; flex-shrink:0 !important;
    }

    /* ── Hit list ── */
    /* ── Current hit: sticky on both ends — scrolls naturally in the list
          but is caught at the top and bottom edges of the scroll container ── */
    #chain-panel-inner .chain-hit-row.sticky-now {
      position:sticky !important; top:-4px !important; bottom:0 !important; z-index:2 !important;
      background:rgba(16,18,26,1) !important;
      border-left-color:#44ff88 !important;
      animation:none !important;
      box-shadow:0 2px 6px rgba(0,0,0,.5) !important;
    }

    #chain-panel-inner { overflow-y:auto !important; flex:1 !important; padding:4px 0 !important; }
    #chain-panel-inner::-webkit-scrollbar { width:5px; }
    #chain-panel-inner::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:3px; }

    .chain-hit-row {
      display:grid !important; grid-template-columns:48px 1fr 1fr 58px 20px 18px !important;
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
    /* FIX #4: unclaimed placeholder row */
    .chain-hit-row.unclaimed    { border-left-color:#334 !important; border-left-style:dashed !important; opacity:.5 !important; }
    .chain-hit-row.unclaimed .chain-hit-target { color:#ff8888 !important; }
    /* Bonus chain hit — gold highlight */
    .chain-hit-row.bonus        { background:rgba(255,200,0,.10) !important; border-left-color:#ffd700 !important; }
    .chain-hit-row.bonus .chain-hit-num { color:#ffd700 !important; }
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
      text-decoration:none !important; font-size:14px !important; border-radius:4px !important;
      width:20px !important; height:20px !important; background:rgba(255,80,80,.18) !important;
      border:1px solid rgba(255,80,80,.4) !important; cursor:pointer !important; transition:background .1s !important;
    }
    .chain-hit-attack:hover { background:rgba(255,80,80,.4) !important; }
    .chain-hit-remove {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      font-size:11px !important; border-radius:4px !important; width:18px !important; height:18px !important;
      background:rgba(255,60,60,.12) !important; border:1px solid rgba(255,60,60,.3) !important;
      color:#ff6666 !important; cursor:pointer !important; transition:background .1s !important;
      line-height:1 !important; flex-shrink:0 !important;
    }
    .chain-hit-remove:hover { background:rgba(255,60,60,.35) !important; color:#fff !important; }

    .chain-hit-reorder {
      display:flex !important; flex-direction:column !important; align-items:center !important;
      justify-content:center !important; gap:1px !important; width:16px !important;
    }
    .chain-hit-reorder button {
      display:flex !important; align-items:center !important; justify-content:center !important;
      width:14px !important; height:10px !important; padding:0 !important;
      background:rgba(255,255,255,.07) !important; border:none !important;
      border-radius:2px !important; color:#556 !important; font-size:8px !important;
      cursor:pointer !important; line-height:1 !important;
    }
    .chain-hit-reorder button:hover { background:rgba(255,255,255,.2) !important; color:#ccc !important; }

    /* Inline slot number input (leader/co-leader on pending rows) */
    .chain-hit-num-input {
      width:44px !important; font-size:12px !important; font-weight:700 !important;
      background:transparent !important; border:1px solid transparent !important;
      border-radius:4px !important; color:#556 !important; text-align:center !important;
      padding:0 !important; outline:none !important; font-family:inherit !important;
      cursor:pointer !important;
    }
    .chain-hit-num-input:focus {
      background:rgba(255,200,0,.15) !important; border-color:rgba(255,200,0,.5) !important;
      color:#ffd700 !important; cursor:text !important;
    }

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

    /* ── Bug button & dropdown ── */
    #chain-bug-btn { font-size:14px !important; line-height:1 !important; }
    #chain-panel.view-mini #chain-bug-btn,
    #chain-panel.view-icon #chain-bug-btn { display:none !important; }
    #chain-bug-menu {
      display:none; position:absolute; top:36px; right:50px; z-index:1000002;
      background:rgba(20,22,30,.98); border-radius:8px; border:1px solid rgba(255,255,255,.12);
      box-shadow:0 6px 20px rgba(0,0,0,.6); flex-direction:column; overflow:hidden; min-width:160px;
    }
    #chain-bug-menu.open { display:flex !important; }
    .chain-bug-menu-item {
      padding:8px 14px; font-size:12px; cursor:pointer; color:#ccc;
      display:flex; align-items:center; gap:8px; white-space:nowrap; transition:background .1s;
    }
    .chain-bug-menu-item:hover { background:rgba(255,255,255,.08); color:#fff; }

    /* ── Bug report popover ── */
    #chain-bug-popover {
      position:absolute; top:42px; left:8px; right:8px; z-index:1000001;
      background:rgba(20,22,30,.98); border-radius:10px; border:1px solid rgba(255,120,80,.35);
      padding:12px; box-shadow:0 8px 24px rgba(0,0,0,.65);
      display:none; flex-direction:column; gap:8px;
    }
    #chain-bug-popover.open { display:flex !important; }
    #chain-bug-popover-title { font-size:12px; font-weight:700; color:#ff9966; }
    #chain-bug-title-input {
      width:100%; box-sizing:border-box; background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.15); border-radius:6px; color:#e8e8e8;
      padding:5px 8px; font-size:11px; outline:none; font-family:inherit;
    }
    #chain-bug-title-input:focus { border-color:rgba(255,120,80,.5) !important; }
    #chain-bug-desc-input {
      width:100%; box-sizing:border-box; background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.15); border-radius:6px; color:#e8e8e8;
      padding:5px 8px; font-size:11px; outline:none; font-family:inherit;
      resize:vertical; min-height:70px;
    }
    #chain-bug-desc-input:focus { border-color:rgba(255,120,80,.5) !important; }
    #chain-bug-submit {
      padding:5px 0; border-radius:6px; font-size:11px; cursor:pointer;
      border:1px solid rgba(255,120,80,.45); background:rgba(255,100,60,.15); color:#ff9966; font-weight:700;
    }
    #chain-bug-submit:hover { background:rgba(255,100,60,.3); }
    #chain-bug-report-status { font-size:10px; color:#556; text-align:center; min-height:14px; }
    #chain-bug-cancel {
      padding:4px 0; border-radius:6px; font-size:11px; cursor:pointer;
      border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:#888;
    }

    /* ── Bug tracker popover ── */
    #chain-tracker-popover {
      position:absolute; top:42px; left:8px; right:8px; z-index:1000001;
      background:rgba(20,22,30,.98); border-radius:10px; border:1px solid rgba(100,180,255,.3);
      padding:12px 12px 18px; box-shadow:0 8px 24px rgba(0,0,0,.65);
      display:none; flex-direction:column; gap:8px;
      min-height:200px; max-height:85vh; overflow:hidden;
    }
    #chain-tracker-resize-handle {
      position:absolute; bottom:0; left:0; right:0; height:14px;
      cursor:ns-resize; border-radius:0 0 10px 10px;
      display:flex; align-items:center; justify-content:center;
    }
    #chain-tracker-resize-handle::after {
      content:""; display:block; width:36px; height:3px;
      border-radius:2px; background:rgba(255,255,255,.15);
    }
    #chain-tracker-resize-handle:hover::after { background:rgba(255,255,255,.35); }
    #chain-tracker-popover.open { display:flex !important; }
    #chain-tracker-title { font-size:12px; font-weight:700; color:#88bbff; }
    #chain-tracker-list  { overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:5px; }
    #chain-tracker-list::-webkit-scrollbar  { width:4px; }
    #chain-tracker-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:2px; }
    .chain-tracker-entry { background:rgba(255,255,255,.04); border-radius:7px; padding:8px 10px; border-left:3px solid #334; }
    .chain-tracker-entry.status-new          { border-left-color:#ff4444; }
    .chain-tracker-entry.status-acknowledged { border-left-color:#ffcc44; }
    .chain-tracker-entry.status-in_progress  { border-left-color:#ff9933; }
    .chain-tracker-entry.status-fixed        { border-left-color:#44ff88; }
    .chain-tracker-entry.status-wontfix      { border-left-color:#556; opacity:.6; }
    .chain-tracker-badge { display:inline-block; font-size:9px; font-weight:700; border-radius:4px; padding:1px 6px; margin-left:5px; vertical-align:middle; }
    .chain-tracker-badge.new          { background:rgba(255,60,60,.2);   color:#ff6666; }
    .chain-tracker-badge.acknowledged { background:rgba(255,200,0,.15);  color:#ffcc44; }
    .chain-tracker-badge.in_progress  { background:rgba(255,150,0,.18);  color:#ff9933; }
    .chain-tracker-badge.fixed        { background:rgba(68,255,136,.15); color:#44ff88; }
    .chain-tracker-badge.wontfix      { background:rgba(100,100,100,.2); color:#778; }
    .chain-tracker-entry-title { font-size:11px; font-weight:700; color:#ddd; }
    .chain-tracker-entry-note  { font-size:10px; color:#778; margin-top:3px; font-style:italic; line-height:1.4; }
    #chain-tracker-close { padding:4px 0; border-radius:6px; font-size:11px; cursor:pointer; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:#888; }

    /* ── Admin inbox (owner only) ── */
    #chain-admin-section { display:flex; flex-direction:column; gap:6px; border-top:1px solid rgba(255,255,255,.08); padding-top:8px; }
    #chain-admin-inbox-title { font-size:10px; font-weight:700; color:#ff9966; letter-spacing:.3px; }
    #chain-admin-inbox { overflow-y:auto; display:flex; flex-direction:column; gap:5px; height:200px; min-height:80px; }
    #chain-admin-inbox-resize {
      height:10px; cursor:ns-resize; display:flex; align-items:center; justify-content:center;
      margin: 0 -9px; /* bleed to section edges */
    }
    #chain-admin-inbox-resize::after {
      content:""; display:block; width:28px; height:3px;
      border-radius:2px; background:rgba(255,255,255,.12);
    }
    #chain-admin-inbox-resize:hover::after { background:rgba(255,255,255,.3); }
    #chain-admin-inbox::-webkit-scrollbar { width:4px; }
    #chain-admin-inbox::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:2px; }
    .chain-admin-report { background:rgba(255,255,255,.04); border-radius:7px; padding:7px 9px; border-left:3px solid rgba(255,120,80,.45); }
    .chain-admin-report-header { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
    .chain-admin-report-title  { font-size:11px; font-weight:700; color:#ff9966; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chain-admin-report-meta   { font-size:9px; color:#556; flex-shrink:0; }
    .chain-admin-report-desc   { font-size:10px; color:#aaa; margin-top:4px; line-height:1.4; word-break:break-word; }
    .chain-admin-copy-btn { font-size:9px; padding:2px 7px; border-radius:4px; cursor:pointer; border:1px solid rgba(100,160,255,.35); background:rgba(80,140,255,.1); color:#88bbff; }
    .chain-admin-copy-btn:hover { background:rgba(80,140,255,.25); }
    .chain-admin-status-row { display:flex; gap:4px; margin-top:5px; flex-wrap:wrap; align-items:center; }
    .chain-admin-status-row select { font-size:10px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.15); border-radius:5px; color:#ccc; padding:2px 4px; cursor:pointer; outline:none; }
    .chain-admin-note-input { flex:1; font-size:10px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.15); border-radius:5px; color:#ccc; padding:2px 5px; outline:none; min-width:60px; }
    .chain-admin-publish-btn { font-size:10px; padding:2px 7px; border-radius:5px; cursor:pointer; border:1px solid rgba(68,255,136,.35); background:rgba(68,255,136,.1); color:#44ff88; }
    .chain-admin-publish-btn:hover { background:rgba(68,255,136,.25); }
    .chain-admin-dismiss-btn { font-size:10px; padding:2px 7px; border-radius:5px; cursor:pointer; border:1px solid rgba(255,80,80,.35); background:rgba(255,60,60,.1); color:#ff8888; }
    .chain-admin-dismiss-btn:hover { background:rgba(255,60,60,.25); }
    .chain-admin-title-input { font-size:11px; font-weight:700; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.15); border-radius:5px; color:#ff9966; padding:2px 6px; outline:none; flex:1; min-width:0; }
    .chain-admin-title-input:focus { border-color:rgba(255,150,80,.5) !important; }
    .chain-admin-type-sel { font-size:10px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.15); border-radius:5px; color:#ccc; padding:2px 4px; cursor:pointer; outline:none; }
    /* Type badge on public tracker */
    .chain-tracker-type-bug     { font-size:9px; font-weight:700; border-radius:4px; padding:1px 5px; margin-right:4px; vertical-align:middle; background:rgba(255,60,60,.18); color:#ff8888; }
    .chain-tracker-type-feature { font-size:9px; font-weight:700; border-radius:4px; padding:1px 5px; margin-right:4px; vertical-align:middle; background:rgba(100,160,255,.18); color:#88bbff; }
    /* Tracker section headers */
    .chain-tracker-section-hdr { font-size:10px; font-weight:700; color:#445; letter-spacing:.4px; text-transform:uppercase; padding:4px 2px 2px; margin-top:4px; border-top:1px solid rgba(255,255,255,.06); }
    .chain-tracker-section-hdr:first-child { border-top:none; margin-top:0; }
  `);

  // ══════════════════════════════════════════════════════════════════════════
  //  Panel HTML
  // ══════════════════════════════════════════════════════════════════════════
  const panel = document.createElement("div");
  panel.id = "chain-panel";
  // Boot: restore position for the current viewMode from per-mode keys.
  // Fall back to shared key for users upgrading from older versions.
  // SK_POS_RIGHT migration is also handled here for very old saves.
  {
    const modeKeys = [
      { x: SK_POS_X_FULL, y: SK_POS_Y_FULL },
      { x: SK_POS_X_ICON, y: SK_POS_Y_ICON },
      { x: SK_POS_X_MINI, y: SK_POS_Y_MINI },
    ][viewMode] || { x: SK_POS_X_FULL, y: SK_POS_Y_FULL };
    let bx = GM_getValue(modeKeys.x, null) ?? GM_getValue(SK_POS_X, null);
    let by = GM_getValue(modeKeys.y, null) ?? GM_getValue(SK_POS_Y, null);
    if (bx === null) {
      const legacyRight = GM_getValue(SK_POS_RIGHT, null);
      bx = legacyRight !== null ? Math.max(0, window.innerWidth - legacyRight - panelW) : Math.max(0, window.innerWidth - panelW - 12);
    }
    if (by === null) by = 120;
    panel.style.right = "auto";
    panel.style.left  = bx + "px";
    panel.style.top   = by + "px";
  }
  panel.style.width = panelW+"px";
  if (panelH) panel.style.height = panelH+"px";

  panel.innerHTML = `
    <div id="chain-panel-header">
      <div id="chain-api-cluster">
        <div id="chain-api-cluster-row">
          <button id="chain-api-btn" title="Set Torn API key">API</button>
          <a id="chain-update-btn" href="https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js" target="_blank" title="You are on the latest version">↑</a>
        </div>
        <span id="chain-version-badge" title="Running version">v${CURRENT_VERSION}</span>
      </div>
      <span id="chain-panel-title">⛓ Chain</span>
      <span id="chain-pill-content">
        <span id="chain-pill-icon">⛓</span>
        <span id="chain-pill-timer" class="ct-none">—</span>
        <span id="chain-pill-count" style="font-size:11px;font-weight:700;min-width:18px;text-align:center"></span>
        <span id="chain-pill-sep" style="color:#44aa66;font-size:13px;font-weight:900;line-height:1;text-shadow:0 0 6px rgba(68,255,136,.4)">→</span>
        <span id="chain-pill-next" style="font-size:11px;font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e0e0e0;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px">—</span>
        <span id="chain-pill-badge">0</span>
      </span>
      <div id="chain-header-right">
        <span id="chain-sync-dot" title="Sync status"></span>
        <button id="chain-presence-btn" class="chain-hbtn" title="Who's online" style="display:inline-flex!important;align-items:center!important;gap:3px!important;font-size:13px!important;padding:4px 10px!important;">👥<span id="chain-online-count" style="font-size:13px;color:#44ff88;font-weight:700;min-width:14px;text-align:center;line-height:1;"></span></button>
        <button id="chain-gear-btn" class="chain-hbtn" title="Settings">⚙️</button>
        <button id="chain-view-btn" class="chain-hbtn" title="Cycle view">▦</button>
      </div>

      <!-- Hidden legacy btns kept for JS compat — triggered via gear menu -->
      <button id="chain-manage-btn" style="display:none!important;pointer-events:none!important"></button>
      <button id="chain-whitelist-btn" style="display:none!important;pointer-events:none!important"></button>
      <button id="chain-bug-btn" style="display:none!important;pointer-events:none!important"></button>
      <button id="chain-clear-btn" style="display:none!important;pointer-events:none!important"></button>

      <!-- Gear dropdown menu -->
      <div id="chain-gear-menu">
        <div class="chain-gear-menu-item" id="chain-gmenu-bug">🪲 Bug Report / Tracker</div>
        <div class="chain-gear-menu-item" id="chain-gmenu-whitelist" style="display:none">🔒 Whitelist</div>
        <div class="chain-gear-menu-item" id="chain-gmenu-clear" style="display:none">❌ Wipe Tracker</div>
        <div class="chain-gear-menu-item" id="chain-gmenu-manage" style="display:none">⚙ Permissions</div>
        <div style="height:1px;background:rgba(255,255,255,.08);margin:2px 4px"></div>
        <div class="chain-gear-menu-item" id="chain-gmenu-settings">⚙️ Settings</div>
      </div>

      <!-- Bug dropdown menu (kept for compat) -->
      <div id="chain-bug-menu" style="display:none">
        <div class="chain-bug-menu-item" id="chain-bug-report-item">🪲 Report a Bug</div>
        <div class="chain-bug-menu-item" id="chain-bug-tracker-item">📋 View Bug Tracker</div>
      </div>

      <!-- Bug report popover -->
      <div id="chain-bug-popover" class="chain-popover" style="position:absolute;top:42px;left:8px;right:8px;border:1px solid rgba(255,120,80,.35);">
        <div id="chain-bug-popover-title">🪲 Report a Bug</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <select id="chain-bug-type-sel" style="font-size:11px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#ccc;padding:4px 6px;cursor:pointer;outline:none;flex-shrink:0;">
            <option value="bug">🪲 Bug</option>
            <option value="feature">✨ Feature Request</option>
          </select>
          <input id="chain-bug-title-input" type="text" placeholder="Short title…" maxlength="100" style="flex:1;">
        </div>
        <textarea id="chain-bug-desc-input" placeholder="Describe what happened, what you expected, and what page you were on…"></textarea>
        <button id="chain-bug-submit">Submit Report</button>
        <div id="chain-bug-report-status"></div>
        <button id="chain-bug-cancel">Cancel</button>
      </div>

      <!-- Bug tracker popover -->
      <div id="chain-tracker-popover" class="chain-popover">
        <div id="chain-tracker-title">📋 Bug Tracker</div>
        <div id="chain-tracker-list"></div>
        <div id="chain-admin-section" style="display:none">
          <div id="chain-admin-inbox-title">📥 SUBMITTED REPORTS</div>
          <div id="chain-admin-inbox-resize" title="Drag to resize inbox"></div>
          <div id="chain-admin-inbox"></div>
        </div>
        <button id="chain-tracker-close">Close</button>
        <div id="chain-tracker-resize-handle" title="Drag to resize"></div>
      </div>

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

      <!-- Whitelist popover (owner only) -->
      <div id="chain-whitelist-popover" class="chain-popover">
        <div id="chain-whitelist-title">🔒 Faction Whitelist</div>
        <div id="chain-whitelist-subtitle">Only listed factions can access the board</div>
        <div id="chain-whitelist-list"></div>
        <div id="chain-whitelist-add-row">
          <input id="chain-whitelist-input" type="number" placeholder="Faction ID" min="1">
          <button id="chain-whitelist-add">Add</button>
        </div>
        <div id="chain-whitelist-status"></div>
        <button id="chain-whitelist-close">Done</button>
      </div>

      <!-- Presence popover -->
      <div id="chain-presence-popover" class="chain-popover">
        <div id="chain-presence-title">👥 Online Now</div>
        <div id="chain-presence-list"></div>
        <div id="chain-offline-toggle" title="Members with the extension who are offline">
          <span class="chain-offline-arrow">▶</span>
          <span id="chain-offline-label">OFFLINE (0)</span>
        </div>
        <div id="chain-offline-list"></div>
      </div>

      <!-- Settings popover -->
      <div id="chain-settings-popover" class="chain-popover" style="left:8px;right:8px;border:1px solid rgba(120,160,255,.3);max-height:85vh;overflow:hidden;">
        <div id="chain-settings-title" style="font-size:12px;font-weight:700;color:#88bbff;letter-spacing:.3px;flex-shrink:0;">⚙️ Settings</div>
        <div id="chain-settings-body" style="display:flex;flex-direction:column;gap:0;overflow-y:auto;flex:1;">

          <!-- Section: Display -->
          <div class="chain-sett-section-hdr">🖥 Display</div>

          <label class="chain-sett-row">
            <span class="chain-sett-label">Show done hits</span>
            <span class="chain-sett-desc">Keep completed hits visible in the list</span>
            <input type="checkbox" id="sett-show-done" class="chain-sett-toggle">
          </label>

          <label class="chain-sett-row">
            <span class="chain-sett-label">Compact rows</span>
            <span class="chain-sett-desc">Tighter row height for more hits on screen</span>
            <input type="checkbox" id="sett-compact" class="chain-sett-toggle">
          </label>

          <label class="chain-sett-row">
            <span class="chain-sett-label">Highlight bonus hits</span>
            <span class="chain-sett-desc">Gold row glow at 10, 25, 50, 100… hits</span>
            <input type="checkbox" id="sett-bonus-alert" class="chain-sett-toggle">
          </label>

          <label class="chain-sett-row">
            <span class="chain-sett-label">Show count in mini pill</span>
            <span class="chain-sett-desc">Display chain count number in mini view</span>
            <input type="checkbox" id="sett-mini-count" class="chain-sett-toggle">
          </label>

          <div class="chain-sett-row chain-sett-row-slider">
            <span class="chain-sett-label">Panel opacity</span>
            <span class="chain-sett-desc">Background transparency of the panel</span>
            <div class="chain-sett-slider-wrap">
              <input type="range" id="sett-opacity" class="chain-sett-slider" min="50" max="100" step="5">
              <span id="sett-opacity-val" class="chain-sett-slider-val">96%</span>
            </div>
          </div>

          <!-- Section: Timer -->
          <div class="chain-sett-section-hdr">⏱ Timer</div>

          <div class="chain-sett-row chain-sett-row-slider">
            <span class="chain-sett-label">Warn color threshold</span>
            <span class="chain-sett-desc">Seconds remaining when timer turns yellow</span>
            <div class="chain-sett-slider-wrap">
              <input type="range" id="sett-warn" class="chain-sett-slider" min="30" max="180" step="10">
              <span id="sett-warn-val" class="chain-sett-slider-val">90s</span>
            </div>
          </div>

          <div class="chain-sett-row chain-sett-row-slider">
            <span class="chain-sett-label">Danger color threshold</span>
            <span class="chain-sett-desc">Seconds remaining when timer turns red</span>
            <div class="chain-sett-slider-wrap">
              <input type="range" id="sett-danger" class="chain-sett-slider" min="10" max="90" step="5">
              <span id="sett-danger-val" class="chain-sett-slider-val">30s</span>
            </div>
          </div>

          <div class="chain-sett-row chain-sett-row-slider">
            <span class="chain-sett-label">Timer offset</span>
            <span class="chain-sett-desc">Adjust displayed timer by ±N seconds (latency compensation)</span>
            <div class="chain-sett-slider-wrap">
              <input type="range" id="sett-fudge" class="chain-sett-slider" min="-15" max="15" step="1">
              <span id="sett-fudge-val" class="chain-sett-slider-val">0s</span>
            </div>
          </div>

          <!-- Section: Behaviour -->
          <div class="chain-sett-section-hdr">🎯 Behaviour</div>

          <label class="chain-sett-row">
            <span class="chain-sett-label">Sound alert when hit is due</span>
            <span class="chain-sett-desc">Short beep when your queued hit window opens</span>
            <input type="checkbox" id="sett-sound" class="chain-sett-toggle">
          </label>

          <label class="chain-sett-row">
            <span class="chain-sett-label">Auto-expand to full when due</span>
            <span class="chain-sett-desc">Switch from mini/icon to full view when it's your hit</span>
            <input type="checkbox" id="sett-auto-expand" class="chain-sett-toggle">
          </label>

          <!-- Section: Reset -->
          <div class="chain-sett-section-hdr" style="margin-top:4px;">🔧 Reset</div>
          <div style="display:flex;gap:6px;padding:6px 0 2px;">
            <button id="sett-reset-pos" class="chain-sett-action-btn">Reset Position</button>
            <button id="sett-reset-size" class="chain-sett-action-btn">Reset Size</button>
            <button id="sett-reset-all" class="chain-sett-action-btn danger">Reset All</button>
          </div>
          <div id="chain-sett-status" style="font-size:10px;color:#44ff88;min-height:13px;text-align:center;padding-bottom:2px;"></div>

        </div>
        <button id="chain-settings-close" style="padding:5px 0;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#888;flex-shrink:0;margin-top:6px;">Close</button>
      </div>
    </div>

    <div id="chain-timer-bar">
      <span id="chain-timer-label">⛓ Chain</span>
      <span id="chain-timer-value" class="ct-none">—</span>
      <span id="chain-count-badge" class="none">0</span>
    </div>
    <div id="chain-warming-msg" style="display:none">🔥 Chain warming up — keep hitting!</div>
    <div id="chain-cooling-msg" style="display:none">❄️ Chain cooldown — <span id="chain-cooldown-timer">—</span></div>

    <div id="chain-panel-body">
      <div id="chain-banner-nokey"  class="chain-banner warn" style="display:none">⚠ No API key — click API above.</div>
      <div id="chain-banner-nofb"   class="chain-banner warn" style="display:none">⚠ Firebase not configured — see FIREBASE_SETUP.md.</div>
      <div id="chain-banner-nofact" class="chain-banner info" style="display:none">ℹ Not in a faction — queue unavailable.</div>
      <div id="chain-banner-locked" class="chain-banner warn" style="display:none">🔒 Access Locked — your faction is not whitelisted.</div>
      <div id="chain-banner-status" class="chain-banner info" style="display:none"></div>
      <div id="chain-banner-debug"  class="chain-banner warn" style="display:none;font-size:10px;word-break:break-all"></div>

      <div id="chain-col-header" style="display:none">
        <span>#</span><span>Claimer</span><span>Target</span>
        <span style="text-align:right">Window</span><span></span><span></span>
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
        <a id="chain-next-attack" class="chain-hit-attack" href="#" target="_blank">🗡</a>
      </div>
    </div>
    <div id="chain-outside-bar" style="display:flex;align-items:center;padding:5px 8px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0;gap:6px;">
      <button id="chain-outside-btn" style="flex:1;padding:4px 0;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid rgba(100,180,255,.28);background:rgba(80,140,255,.09);color:#7ab8e8;font-weight:600;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:5px;">🎯 <span style="opacity:.85">Non-War</span></button>
    </div>
    <div id="chain-icon-btn" title="Tap to expand">⛓<span id="chain-icon-badge"></span></div>
    <div id="chain-resize-handle"></div>`;
  document.body.appendChild(panel);

  // ── Element refs ──────────────────────────────────────────────────────────
  const panelBody       = document.getElementById("chain-panel-body");
  const viewBtn         = document.getElementById("chain-view-btn");
  const clearBtn        = document.getElementById("chain-clear-btn");
  const outsideBtn      = document.getElementById("chain-outside-btn");
  const outsideBar      = document.getElementById("chain-outside-bar");
  const iconBadge       = document.getElementById("chain-icon-badge");
  const manageBtn       = document.getElementById("chain-manage-btn");
  const whitelistBtn    = document.getElementById("chain-whitelist-btn");
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
  const coolingMsg      = document.getElementById("chain-cooling-msg");
  const cooldownTimer   = document.getElementById("chain-cooldown-timer");
  const resizeHandle    = document.getElementById("chain-resize-handle");
  const managePopover   = document.getElementById("chain-manage-popover");
  const manageList      = document.getElementById("chain-manage-list");
  const manageClose     = document.getElementById("chain-manage-close");
  const presencePopover = document.getElementById("chain-presence-popover");
  const presenceList    = document.getElementById("chain-presence-list");
  const pillTimer       = document.getElementById("chain-pill-timer");
  const pillNext        = document.getElementById("chain-pill-next");
  const pillSep         = document.getElementById("chain-pill-sep");
  const pillBadge       = document.getElementById("chain-pill-badge");

  // Tapping the target name in mini view navigates to the attack page
  if (pillNext) {
    pillNext.addEventListener("click", e => {
      e.stopPropagation();
      const url = pillNext.dataset.attackUrl;
      if (url) window.open(url, "_blank");
    });
  }
  const nextNum         = document.getElementById("chain-next-num");
  const nextName        = document.getElementById("chain-next-name");
  const nextTimer       = document.getElementById("chain-next-timer");
  const nextAttack      = document.getElementById("chain-next-attack");

  // ══════════════════════════════════════════════════════════════════════════
  //  View modes
  //   0 = full board  (Large)
  //   1 = icon button (Button — just the ⛓ icon)
  //   2 = mini pill   (Mini — timer + badge)
  //  Cycling: full → icon → mini → full
  //  Button icon always shows what the NEXT state looks like.
  // ══════════════════════════════════════════════════════════════════════════
  // NOTE: The 1↔2 remap block that previously appeared here was a one-time migration
  // from an old view-mode ordering. It was removed in 4.6.4 because it ran on every
  // page load, causing icon↔mini to flip on each navigation. The new ordering
  // (0=full, 1=icon, 2=mini) has been stable since 4.6.x — no migration needed.

  // Map mode → SK keys for position memory
  const MODE_POS_KEYS = [
    { x: SK_POS_X_FULL, y: SK_POS_Y_FULL },   // 0 = full
    { x: SK_POS_X_ICON, y: SK_POS_Y_ICON },   // 1 = icon
    { x: SK_POS_X_MINI, y: SK_POS_Y_MINI },   // 2 = mini
  ];

  // Save current pixel position to the given mode's keys
  function savePosForMode(mode) {
    const r = panel.getBoundingClientRect();
    const left = Math.round(r.left);
    const top  = Math.round(r.top);
    const keys = MODE_POS_KEYS[mode];
    if (keys) { GM_setValue(keys.x, left); GM_setValue(keys.y, top); }
    // Always keep the shared keys in sync for endDrag / resize
    GM_setValue(SK_POS_X, left); GM_setValue(SK_POS_Y, top);
  }

  // Restore saved position for mode, clamping to current viewport + new panel size
  function restorePosForMode(mode, w, h) {
    const keys = MODE_POS_KEYS[mode];
    let lx = keys ? GM_getValue(keys.x, null) : null;
    let ly = keys ? GM_getValue(keys.y, null) : null;
    // Fall back to shared key (migration for users without per-mode saves yet)
    if (lx === null) lx = GM_getValue(SK_POS_X, null);
    if (ly === null) ly = GM_getValue(SK_POS_Y, null);
    if (lx === null) lx = Math.max(0, window.innerWidth - (w || 380) - 12);
    if (ly === null) ly = 60;
    // Clamp so the panel is fully on screen with the new dimensions
    const maxX = Math.max(0, window.innerWidth  - (w || panel.offsetWidth  || 44));
    const maxY = Math.max(0, window.innerHeight - (h || panel.offsetHeight || 44));
    return { x: Math.max(0, Math.min(maxX, lx)), y: Math.max(0, Math.min(maxY, ly)) };
  }

  let _prevViewMode = viewMode;   // track what mode we're leaving
  let _bootApply    = true;       // true on the very first applyViewMode() call (boot)

  function applyViewMode() {
    // Save position of the mode we're LEAVING before changing anything
    if (_prevViewMode !== viewMode) {
      savePosForMode(_prevViewMode);
      _prevViewMode = viewMode;
    }

    panel.style.right    = "auto";
    panel.style.overflow = "hidden";
    panel.classList.remove("view-full","view-mini","view-icon");

    if (viewMode !== 0) closeAllPopovers();

    if (viewMode === 0) {
      panel.classList.add("view-full");
      panel.style.width  = panelW+"px";
      panel.style.height = panelH ? panelH+"px" : "";
      panel.style.cursor = "";
      viewBtn.textContent = "●";
      viewBtn.title = "Switch to button view";
      if (outsideBar) outsideBar.style.display = "";
    } else if (viewMode === 1) {
      panel.classList.add("view-icon");
      panel.style.width  = "";
      panel.style.height = "";
      panel.style.cursor = "pointer";
      viewBtn.textContent = "—";
      viewBtn.title = "Switch to mini view";
      if (outsideBar) outsideBar.style.display = "none";
    } else {
      panel.classList.add("view-mini");
      panel.style.width  = "";
      panel.style.height = "";
      panel.style.cursor = "pointer";
      viewBtn.textContent = "▦";
      viewBtn.title = "Switch to full view";
      if (outsideBar) outsideBar.style.display = "none";
    }

    // On the first (boot) call: boot block already placed the panel correctly,
    // just clamp in case viewport changed. On subsequent mode switches: restore
    // the saved position for the new mode.
    const isBoot = _bootApply;
    _bootApply = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isBoot) {
        // Just clamp — don't overwrite the boot position
        const w = panel.offsetWidth || panelW;
        const h = panel.offsetHeight || panelH || 200;
        const cx = Math.max(0, Math.min(window.innerWidth  - w, parseInt(panel.style.left)||0));
        const cy = Math.max(0, Math.min(window.innerHeight - h, parseInt(panel.style.top) ||0));
        panel.style.left = cx+"px"; panel.style.top = cy+"px";
      } else {
        const pos = restorePosForMode(viewMode, panel.offsetWidth, panel.offsetHeight);
        panel.style.left = pos.x+"px";
        panel.style.top  = pos.y+"px";
      }
      setTimeout(() => {
        panel.style.overflow = viewMode === 0 ? "visible" : "hidden";
      }, 160);
    }));
  }

  // View button: full→icon, icon→mini, mini→full
  viewBtn.onclick = e => {
    e.stopPropagation();
    viewMode = (viewMode + 1) % 3;
    GM_setValue(SK_VIEW_MODE, viewMode);
    applyViewMode();
  };

  // Tapping the icon button panel → expand to mini (not full).
  panel.addEventListener("click", e => {
    if (viewMode !== 1) return;
    if (e.target === viewBtn || e.target.closest("#chain-panel-header button")) return;
    if (panel.dataset.justDragged === "1") { delete panel.dataset.justDragged; return; }
    viewMode = 2;
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
    [apiPopover, managePopover, presencePopover,
     document.getElementById("chain-whitelist-popover"),
     document.getElementById("chain-bug-menu"),
     document.getElementById("chain-bug-popover"),
     document.getElementById("chain-tracker-popover"),
     document.getElementById("chain-gear-menu"),
     document.getElementById("chain-settings-popover"),
    ].forEach(p => p && p.classList.remove("open"));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Draggable
  // ══════════════════════════════════════════════════════════════════════════
  (function makeDraggable() {
    const handle = document.getElementById("chain-panel-header");
    const DRAG_IDS = new Set(["chain-panel-header","chain-panel-title","chain-sync-dot","chain-pill-content","chain-pill-timer","chain-pill-icon","chain-pill-badge","chain-pill-next","chain-pill-sep"]);
    let dragging=false, didDrag=false, sx,sy,ol,ot, dragThreshold=6;

    function startDrag(cx,cy) {
      dragging=true; didDrag=false; sx=cx; sy=cy;
      // Snapshot current pixel position; switch to left so transforms work during drag
      const r=panel.getBoundingClientRect(); ol=r.left; ot=r.top;
      panel.style.right="auto"; panel.style.left=ol+"px"; panel.style.top=ot+"px";
    }
    function moveDrag(cx,cy) {
      if(!dragging) return;
      const dx=cx-sx, dy=cy-sy;
      if(!didDrag && Math.sqrt(dx*dx+dy*dy) < dragThreshold) return;
      didDrag=true;
      panel.style.left=Math.max(0,Math.min(window.innerWidth-panel.offsetWidth,ol+dx))+"px";
      panel.style.top=Math.max(0,Math.min(window.innerHeight-panel.offsetHeight,ot+dy))+"px";
    }
    function endDrag() {
      if(!dragging) return;
      dragging=false;
      if(didDrag) {
        // startDrag always converts to left-anchor (sets style.left from getBCR).
        // So after drag the panel is always left-anchored regardless of view mode.
        // Just clamp to viewport and save.
        const maxLeft = Math.max(0, window.innerWidth  - panel.offsetWidth);
        const maxTop  = Math.max(0, window.innerHeight - panel.offsetHeight);
        const cx = Math.max(0, Math.min(maxLeft, parseInt(panel.style.left)||0));
        const cy = Math.max(0, Math.min(maxTop,  parseInt(panel.style.top)||0));
        panel.style.left = cx+"px";
        panel.style.top  = cy+"px";
        // Save position for current mode explicitly — no closure risk
        if      (viewMode === 0) { GM_setValue(SK_POS_X_FULL, cx); GM_setValue(SK_POS_Y_FULL, cy); }
        else if (viewMode === 1) { GM_setValue(SK_POS_X_ICON, cx); GM_setValue(SK_POS_Y_ICON, cy); }
        else if (viewMode === 2) { GM_setValue(SK_POS_X_MINI, cx); GM_setValue(SK_POS_Y_MINI, cy); }
        GM_setValue(SK_POS_X, cx);
        GM_setValue(SK_POS_Y, cy);
        panel.dataset.justDragged = "1";
        setTimeout(()=>{ delete panel.dataset.justDragged; }, 50);
      }
    }

    // Attach move/end listeners only while a drag is in progress — zero cost when idle.
    function attachDragListeners() {
      const mm = e => moveDrag(e.clientX, e.clientY);
      const mu = () => { endDrag(); document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); };
      document.addEventListener("mousemove", mm);
      document.addEventListener("mouseup", mu);
    }
    function attachTouchDragListeners() {
      const tm = e => { if(!dragging) return; e.preventDefault(); const t=e.touches[0]; moveDrag(t.clientX,t.clientY); };
      const te = () => { endDrag(); document.removeEventListener("touchmove", tm); document.removeEventListener("touchend", te); };
      document.addEventListener("touchmove", tm, {passive:false});
      document.addEventListener("touchend", te);
    }

    // Header drag (full + mini modes)
    handle.addEventListener("mousedown",e=>{if(DRAG_IDS.has(e.target.id)||e.target===handle){startDrag(e.clientX,e.clientY);attachDragListeners();}});
    handle.addEventListener("touchstart",e=>{
      if(DRAG_IDS.has(e.target.id)||e.target===handle){
        const t=e.touches[0]; startDrag(t.clientX,t.clientY); attachTouchDragListeners();
      }
    },{passive:true});

    // Icon mode: drag on the whole panel (header is hidden)
    panel.addEventListener("mousedown",e=>{
      if(viewMode===1){startDrag(e.clientX,e.clientY);attachDragListeners();}
    });
    panel.addEventListener("touchstart",e=>{
      if(viewMode===1){
        const t=e.touches[0]; startDrag(t.clientX,t.clientY); attachTouchDragListeners();
      }
    },{passive:true});
  })();

  // ══════════════════════════════════════════════════════════════════════════
  //  Corner resize
  // ══════════════════════════════════════════════════════════════════════════
  (function makeResizable() {
    const MIN_W=360, MAX_W=Math.min(700,window.innerWidth-4), MIN_H=120, MAX_H=Math.min(900,window.innerHeight-60);
    let resizing=false,sx,sy,sw,sh;
    function start(cx,cy){
      resizing=true; sx=cx; sy=cy; sw=panel.offsetWidth; sh=panel.offsetHeight;
      document.body.style.cursor="se-resize";
      // Panel is left-anchored, so growing width expands rightward from the left edge.
      // The resize handle is bottom-right, so dragging right/down naturally grows the panel
      // in the same direction the user is moving. No anchor switching needed.
    }
    function move(cx,cy){
      if(!resizing)return;
      panel.style.width =Math.min(MAX_W,Math.max(MIN_W,sw+cx-sx))+"px";
      panel.style.height=Math.min(MAX_H,Math.max(MIN_H,sh+cy-sy))+"px";
    }
    function end(){
      if(!resizing)return; resizing=false; document.body.style.cursor="";
      panelW=panel.offsetWidth; panelH=panel.offsetHeight;
      GM_setValue(SK_PANEL_W,panelW); GM_setValue(SK_PANEL_H,panelH);
      // Clamp position so resize can't push the panel off screen
      const cx = Math.max(0, Math.min(window.innerWidth  - panelW, parseInt(panel.style.left)||0));
      const cy = Math.max(0, Math.min(window.innerHeight - panelH, parseInt(panel.style.top)||0));
      panel.style.left = cx+"px";
      panel.style.top  = cy+"px";
      GM_setValue(SK_POS_X, cx);
      GM_setValue(SK_POS_Y, cy);
    }
    resizeHandle.addEventListener("mousedown",e=>{
      e.preventDefault();e.stopPropagation();start(e.clientX,e.clientY);
      const mm = e2 => move(e2.clientX,e2.clientY);
      const mu = () => { end(); document.removeEventListener("mousemove",mm); document.removeEventListener("mouseup",mu); };
      document.addEventListener("mousemove",mm);
      document.addEventListener("mouseup",mu);
    });
    resizeHandle.addEventListener("touchstart",e=>{
      e.stopPropagation();const t=e.touches[0];start(t.clientX,t.clientY);
      const tm = e2 => { if(!resizing)return;e2.preventDefault();const t2=e2.touches[0];move(t2.clientX,t2.clientY); };
      const te = () => { end(); document.removeEventListener("touchmove",tm); document.removeEventListener("touchend",te); };
      document.addEventListener("touchmove",tm,{passive:false});
      document.addEventListener("touchend",te);
    },{passive:true});

    // ── Pinch-to-resize (two-finger) ─────────────────────────────────────────
    // Lets users resize the panel without needing to reach the corner handle.
    // Only active in full view (mode 0).
    let pinching=false, pinchDist0=0, pinchW0=0, pinchH0=0;
    function pinchDist(t){ const dx=t[0].clientX-t[1].clientX, dy=t[0].clientY-t[1].clientY; return Math.sqrt(dx*dx+dy*dy); }
    panel.addEventListener("touchstart", e => {
      if (viewMode !== 0 || e.touches.length !== 2) return;
      pinching=true; pinchDist0=pinchDist(e.touches); pinchW0=panel.offsetWidth; pinchH0=panel.offsetHeight;
    }, { passive: true });
    panel.addEventListener("touchmove", e => {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault();
      const ratio = pinchDist(e.touches) / pinchDist0;
      panel.style.width  = Math.min(MAX_W, Math.max(MIN_W, Math.round(pinchW0*ratio)))+"px";
      panel.style.height = Math.min(MAX_H, Math.max(MIN_H, Math.round(pinchH0*ratio)))+"px";
    }, { passive: false });
    panel.addEventListener("touchend", e => {
      if (!pinching) return;
      if (e.touches.length < 2) {
        pinching=false;
        panelW=panel.offsetWidth; panelH=panel.offsetHeight;
        GM_setValue(SK_PANEL_W,panelW); GM_setValue(SK_PANEL_H,panelH);
        // Clamp position after pinch resize
        const maxX=Math.max(0,window.innerWidth-panelW), maxY=Math.max(0,window.innerHeight-panelH);
        const cx=Math.max(0,Math.min(maxX,parseInt(panel.style.left)||0));
        const cy=Math.max(0,Math.min(maxY,parseInt(panel.style.top)||0));
        panel.style.left=cx+"px"; panel.style.top=cy+"px";
        GM_setValue(SK_POS_X,cx); GM_setValue(SK_POS_Y,cy);
      }
    });
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
    if (!isTornPDA) { try { localStorage.setItem("tcc_api_key", tornApiKey); } catch { /**/ } }
    apiStatus.textContent="Saved — connecting…"; apiStatus.style.color="#ffcc66";
    updateApiBtn(); setTimeout(closeAllPopovers, 700); fetchOwnProfile();
  };
  apiClear.onclick = () => { tornApiKey=""; GM_setValue(SK_API_KEY,""); if(!isTornPDA){try{localStorage.removeItem("tcc_api_key");}catch{/**/ }} apiInput.value=""; apiStatus.textContent="Key cleared."; apiStatus.style.color="#ff8888"; updateApiBtn(); showBanner("chain-banner-nokey",true); };
  apiCancel.onclick = closeAllPopovers;
  apiInput.addEventListener("keydown", e => { if(e.key==="Enter") apiSave.click(); });
  function updateApiBtn() {
    apiBtn.classList.toggle("has-key", !!tornApiKey);
    apiBtn.title = tornApiKey ? `API key set (${ownName}) — click to change` : "Set Torn API key";
    if (tornApiKey && !fbToken) {
      showBanner("chain-banner-status", true, "Connecting…");
    }
  }
  updateApiBtn();

  // ══════════════════════════════════════════════════════════════════════════
  //  Manage Permissions Popover
  // ══════════════════════════════════════════════════════════════════════════
  function openManagePopover() {
    closeAllPopovers();
    manageList.innerHTML = "";
    sortMeFirst(Object.entries(factionMembers), ([, name]) => name)
      .forEach(([uid, name]) => {
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
    // Never touch .style.display on the hidden proxy buttons — they must stay
    // display:none / pointer-events:none at all times to avoid invisible tap targets.
    // Only the gear-menu items are shown/hidden to reflect permissions.
    const gClear     = document.getElementById("chain-gmenu-clear");
    const gManage    = document.getElementById("chain-gmenu-manage");
    const gWhitelist = document.getElementById("chain-gmenu-whitelist");
    if (gClear)      gClear.style.display     = canClear ? "" : "none";
    if (gManage)     gManage.style.display     = isLeaderOrCoLeader ? "" : "none";
    if (gWhitelist)  gWhitelist.style.display  = isOwner ? "" : "none";
  }

  // ── Gear menu button ────────────────────────────────────────────────────────────────────────────
  (function wireGearMenu() {
    const gearBtn  = document.getElementById("chain-gear-btn");
    const gearMenu = document.getElementById("chain-gear-menu");
    if (!gearBtn || !gearMenu) return;
    gearBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (gearMenu.classList.contains("open")) { gearMenu.classList.remove("open"); return; }
      closeAllPopovers();
      gearMenu.classList.add("open");
    });
    document.getElementById("chain-gmenu-bug").addEventListener("click", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      document.getElementById("chain-bug-btn").click();
    });
    document.getElementById("chain-gmenu-whitelist").addEventListener("click", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      whitelistBtn.click();
    });
    document.getElementById("chain-gmenu-clear").addEventListener("click", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      clearBtn.click();
    });
    document.getElementById("chain-gmenu-manage").addEventListener("click", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      manageBtn.click();
    });
    document.getElementById("chain-gmenu-settings").addEventListener("click", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      const sp = document.getElementById("chain-settings-popover");
      if (sp) { closeAllPopovers(); sp.classList.add("open"); if (window._chainOpenSettings) window._chainOpenSettings(); }
    });
  })();

  // ── Settings popover close ───────────────────────────────────────────────
  const settingsClose = document.getElementById("chain-settings-close");
  if (settingsClose) settingsClose.onclick = closeAllPopovers;

  // ── Settings: wire all controls ──────────────────────────────────────────
  (function wireSettings() {
    function applyPanelOpacity(v) {
      panel.style.background = `rgba(16,18,24,${v})`;
    }
    function applyCompactMode(on) {
      if (on) {
        panel.style.setProperty("--chain-row-pad", "2px 10px");
      } else {
        panel.style.removeProperty("--chain-row-pad");
      }
      // Toggle a class so CSS can target row padding
      panel.classList.toggle("compact", on);
    }
    function applyMiniCountVisibility(on) {
      const pillCount = document.getElementById("chain-pill-count");
      if (pillCount) pillCount.style.display = on ? "" : "none";
      // Note: pillSep is controlled independently by the pill-next render logic
    }

    function settStatusMsg(msg, color) {
      const el = document.getElementById("chain-sett-status");
      if (!el) return;
      el.textContent = msg; el.style.color = color || "#44ff88";
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.textContent = ""; }, 2000);
    }

    // Populate controls with current values
    function openSettingsPopover() {
      const sd   = document.getElementById("sett-show-done");
      const sc   = document.getElementById("sett-compact");
      const sb   = document.getElementById("sett-bonus-alert");
      const smc  = document.getElementById("sett-mini-count");
      const sop  = document.getElementById("sett-opacity");
      const sopv = document.getElementById("sett-opacity-val");
      const sw   = document.getElementById("sett-warn");
      const swv  = document.getElementById("sett-warn-val");
      const sdg  = document.getElementById("sett-danger");
      const sdgv = document.getElementById("sett-danger-val");
      const sf   = document.getElementById("sett-fudge");
      const sfv  = document.getElementById("sett-fudge-val");
      const ss   = document.getElementById("sett-sound");
      const sae  = document.getElementById("sett-auto-expand");

      if (sd)  sd.checked  = settShowDoneHits;
      if (sc)  sc.checked  = settCompactMode;
      if (sb)  sb.checked  = settShowBonusAlert;
      if (smc) smc.checked = settMiniShowCount;
      if (ss)  ss.checked  = settNotifySound;
      if (sae) sae.checked = settAutoExpandDue;

      if (sop)  { sop.value  = Math.round(settPanelOpacity * 100); }
      if (sopv) { sopv.textContent = Math.round(settPanelOpacity * 100) + "%"; }
      if (sw)   { sw.value   = settWarnThreshold; }
      if (swv)  { swv.textContent  = settWarnThreshold + "s"; }
      if (sdg)  { sdg.value  = settDangerThreshold; }
      if (sdgv) { sdgv.textContent = settDangerThreshold + "s"; }
      if (sf)   { sf.value   = settTimerFudge; }
      if (sfv)  { sfv.textContent  = (settTimerFudge >= 0 ? "+" : "") + settTimerFudge + "s"; }
    }

    // Toggle handlers
    document.getElementById("sett-show-done")?.addEventListener("change", e => {
      settShowDoneHits = e.target.checked; GM_setValue(SK_SHOW_DONE_HITS, settShowDoneHits);
      scheduleRender();
    });
    document.getElementById("sett-compact")?.addEventListener("change", e => {
      settCompactMode = e.target.checked; GM_setValue(SK_COMPACT_MODE, settCompactMode);
      applyCompactMode(settCompactMode);
    });
    document.getElementById("sett-bonus-alert")?.addEventListener("change", e => {
      settShowBonusAlert = e.target.checked; GM_setValue(SK_SHOW_BONUS_ALERT, settShowBonusAlert);
      scheduleRender();
    });
    document.getElementById("sett-mini-count")?.addEventListener("change", e => {
      settMiniShowCount = e.target.checked; GM_setValue(SK_MINI_SHOW_COUNT, settMiniShowCount);
      applyMiniCountVisibility(settMiniShowCount);
    });
    document.getElementById("sett-sound")?.addEventListener("change", e => {
      settNotifySound = e.target.checked; GM_setValue(SK_NOTIFY_SOUND, settNotifySound);
      if (settNotifySound) playDueSound();  // preview sound on enable
    });
    document.getElementById("sett-auto-expand")?.addEventListener("change", e => {
      settAutoExpandDue = e.target.checked; GM_setValue(SK_AUTO_EXPAND_DUE, settAutoExpandDue);
    });

    // Slider handlers
    document.getElementById("sett-opacity")?.addEventListener("input", e => {
      const v = parseInt(e.target.value) / 100;
      settPanelOpacity = v; GM_setValue(SK_PANEL_OPACITY, v);
      applyPanelOpacity(v);
      const sopv = document.getElementById("sett-opacity-val");
      if (sopv) sopv.textContent = Math.round(v * 100) + "%";
    });
    document.getElementById("sett-warn")?.addEventListener("input", e => {
      settWarnThreshold = parseInt(e.target.value); GM_setValue(SK_WARN_THRESHOLD, settWarnThreshold);
      const swv = document.getElementById("sett-warn-val");
      if (swv) swv.textContent = settWarnThreshold + "s";
    });
    document.getElementById("sett-danger")?.addEventListener("input", e => {
      settDangerThreshold = parseInt(e.target.value); GM_setValue(SK_DANGER_THRESHOLD, settDangerThreshold);
      const sdgv = document.getElementById("sett-danger-val");
      if (sdgv) sdgv.textContent = settDangerThreshold + "s";
    });
    document.getElementById("sett-fudge")?.addEventListener("input", e => {
      settTimerFudge = parseInt(e.target.value); GM_setValue(SK_TIMER_FUDGE_USR, settTimerFudge);
      const sfv = document.getElementById("sett-fudge-val");
      if (sfv) sfv.textContent = (settTimerFudge >= 0 ? "+" : "") + settTimerFudge + "s";
    });

    // Reset buttons
    document.getElementById("sett-reset-pos")?.addEventListener("click", () => {
      [SK_POS_X_FULL, SK_POS_Y_FULL, SK_POS_X_ICON, SK_POS_Y_ICON, SK_POS_X_MINI, SK_POS_Y_MINI, SK_POS_X, SK_POS_Y].forEach(k => GM_setValue(k, null));
      const px = Math.max(0, window.innerWidth - panelW - 12);
      panel.style.left = px + "px"; panel.style.top = "120px";
      settStatusMsg("Position reset ✓");
    });
    document.getElementById("sett-reset-size")?.addEventListener("click", () => {
      panelW = 380; panelH = null;
      GM_setValue(SK_PANEL_W, panelW); GM_setValue(SK_PANEL_H, null);
      panel.style.width = panelW + "px"; panel.style.height = "";
      settStatusMsg("Size reset ✓");
    });
    document.getElementById("sett-reset-all")?.addEventListener("click", () => {
      if (!confirm("Reset ALL settings to defaults?")) return;
      [SK_SHOW_DONE_HITS, SK_COMPACT_MODE, SK_NOTIFY_SOUND, SK_TIMER_FUDGE_USR,
       SK_PANEL_OPACITY, SK_WARN_THRESHOLD, SK_DANGER_THRESHOLD, SK_SHOW_BONUS_ALERT,
       SK_MINI_SHOW_COUNT, SK_AUTO_EXPAND_DUE, SK_PANEL_W, SK_PANEL_H,
       SK_POS_X_FULL, SK_POS_Y_FULL, SK_POS_X_ICON, SK_POS_Y_ICON, SK_POS_X_MINI, SK_POS_Y_MINI
      ].forEach(k => GM_setValue(k, null));
      settShowDoneHits = true; settCompactMode = false; settNotifySound = false;
      settTimerFudge = 0; settPanelOpacity = 0.96; settWarnThreshold = 90;
      settDangerThreshold = 30; settShowBonusAlert = true; settMiniShowCount = true;
      settAutoExpandDue = false;
      applyPanelOpacity(0.96); applyCompactMode(false); applyMiniCountVisibility(true);
      panelW = 380; panelH = null; panel.style.width = panelW + "px"; panel.style.height = "";
      openSettingsPopover();
      settStatusMsg("All settings reset ✓");
      scheduleRender();
    });

    // Apply initial settings on boot
    applyPanelOpacity(settPanelOpacity);
    applyCompactMode(settCompactMode);
    applyMiniCountVisibility(settMiniShowCount);

    // Expose openSettingsPopover for gear menu wiring
    window._chainOpenSettings = openSettingsPopover;
  })();

  clearBtn.onclick = () => {
    if (!canClear || !factionId) return;
    if (!confirm("Clear the entire chain list for your faction?")) return;
    fbClearHits();
  };

  // ── Outside Hit button — one tap, no input needed ───────────────────────
  outsideBtn.addEventListener("click", e => {
    e.stopPropagation();
    if (!factionId)     { alert("Could not detect your faction."); return; }
    if (!fbConfigured()){ alert("Firebase not configured."); return; }

    const now2 = Date.now();
    const activeHits = [...hitMap.values()].filter(h => h.status !== "done").sort((a,b) => a.scheduledAt - b.scheduledAt);
    const scheduledAt = activeHits.length
      ? activeHits[activeHits.length - 1].scheduledAt + HIT_INTERVAL
      : now2;

    const outsideHit = {
      id:           `hit_${now2}_${Math.random().toString(36).slice(2)}`,
      hitNumber:    0,
      targetId:     null,
      targetName:   "Unspecified",
      claimedBy:    ownName,
      claimedAt:    now2,
      scheduledAt,
      hospReleaseAt:null,
      attackUrl:    null,
      status:       "pending",
      sessionId:    chainSessionId,
      outside:      true,
    };
    hitMap.set(outsideHit.id, outsideHit);
    reNumberPending(true);  // skipWrite: fbWriteHit writes the full object below
    fbWriteHit(outsideHit);
  });

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

  // ── Shared sort: own name first, then A→Z ─────────────────────────────────
  function sortMeFirst(arr, getName) {
    return arr.sort((a, b) => {
      const na = getName(a), nb = getName(b);
      const aMe = na === ownName, bMe = nb === ownName;
      if (aMe && !bMe) return -1;
      if (!aMe && bMe) return  1;
      return na.localeCompare(nb);
    });
  }

  function updateOnlineCount() {
    const now = Date.now();
    const seen = new Set();
    const count = [...presenceMap.values()]
      .filter(m => (now - (m.lastSeen||0)) < PRESENCE_TIMEOUT)
      .filter(m => { if(seen.has(m.name)) return false; seen.add(m.name); return true; })
      .length;
    const badge = document.getElementById("chain-online-count");
    if (badge) badge.textContent = count > 0 ? count : "";
  }

  // ── Version colour for presence list ─────────────────────────────────────
  // v(major).(feature).(bugfix)
  // green  = identical to ours
  // yellow = same major+feature, different bugfix
  // orange = same major, different feature
  // red    = different major version
  function versionBadgeHtml(ver) {
    if (!ver) return "";
    const parse = v => v.split(".").map(Number);
    const [ma, fe, bf]   = parse(CURRENT_VERSION);
    const [ma2, fe2, bf2] = parse(ver);
    let color, title;
    if (ma2 === ma && fe2 === fe && bf2 === bf) {
      color = "#44ff88"; title = "Same version";
    } else if (ma2 === ma && fe2 === fe) {
      color = "#ffee44"; title = "Different bugfix";
    } else if (ma2 === ma) {
      color = "#ff9933"; title = "Different feature version";
    } else {
      color = "#ff4444"; title = "Different major version";
    }
    return `<span class="chain-presence-ver" style="color:${color}" title="${title}">v${escHtml(ver)}</span>`;
  }

  // Recompute networkLatestVersion from presenceMap — called on every poll and popover open.
  // Only runs before fbPollClientVersions has set networkLatestVersion from Firebase.
  // Peer versions must never raise it above the GitHub canonical — dev/pre-release builds
  // running locally would otherwise trigger phantom update arrows on other clients.
  function recomputeNetworkLatestVersion() {
    if (networkLatestVersion) return;
    let latest = CURRENT_VERSION;
    presenceMap.forEach(m => {
      if (m.version && isNewerVersion(m.version, latest)) latest = m.version;
    });
    if (latest !== networkLatestVersion) {
      networkLatestVersion = latest;
      updateVersionUI();
    }
  }

  function renderPresence() {
    const now = Date.now();
    presenceList.innerHTML = "";
    const offlineList   = document.getElementById("chain-offline-list");
    const offlineToggle = document.getElementById("chain-offline-toggle");
    const offlineLabel  = document.getElementById("chain-offline-label");
    if (offlineList) offlineList.innerHTML = "";

    // Deduplicate by name across all entries
    const seenNames = new Set();
    const allEntries = [...presenceMap.entries()].filter(([, m]) => {
      if (!m || !m.name) return false;
      if (seenNames.has(m.name)) return false;
      seenNames.add(m.name);
      return true;
    });

    const online  = sortMeFirst(
      allEntries.filter(([, m]) => (now - (m.lastSeen||0)) < PRESENCE_TIMEOUT),
      ([, m]) => m.name || ""
    );
    const offline = sortMeFirst(
      allEntries.filter(([, m]) => (now - (m.lastSeen||0)) >= PRESENCE_TIMEOUT && m.version),
      ([, m]) => m.name || ""
    );

    // Recompute networkLatestVersion from presenceMap — always in sync with main poll,
    // no separate fetch delay. Covers both online and recently-offline members.
    recomputeNetworkLatestVersion();

    updateOnlineCount();

    if (!online.length) {
      presenceList.innerHTML = `<div style="font-size:11px;color:#445;text-align:center;padding:4px">No one else online</div>`;
    } else {
      online.forEach(([uid, m]) => {
        const row = document.createElement("div");
        row.className = "chain-presence-row";
        const isMe = (m.tornId && m.tornId === ownId) || m.name === ownName;
        const ver  = m.version || clientVersionMap.get(uid) || null;
        row.innerHTML = `<span class="chain-presence-dot"></span><span class="chain-presence-name">${escHtml(m.name)}${isMe?" (you)":""}</span>${versionBadgeHtml(ver)}`;
        presenceList.appendChild(row);
      });
    }

    // Offline section
    if (offlineList && offlineToggle && offlineLabel) {
      offlineLabel.textContent = `OFFLINE (${offline.length})`;
      offlineToggle.style.display = offline.length ? "" : "none";
      offline.forEach(([uid, m]) => {
        const row = document.createElement("div");
        row.className = "chain-presence-row offline";
        const ver = m.version || clientVersionMap.get(uid) || null;
        row.innerHTML = `<span class="chain-presence-dot offline"></span><span class="chain-presence-name">${escHtml(m.name)}</span>${versionBadgeHtml(ver)}`;
        offlineList.appendChild(row);
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Whitelist (owner only)
  // ══════════════════════════════════════════════════════════════════════════
  const whitelistPopover = document.getElementById("chain-whitelist-popover");
  const whitelistList    = document.getElementById("chain-whitelist-list");
  const whitelistInput   = document.getElementById("chain-whitelist-input");
  const whitelistAdd     = document.getElementById("chain-whitelist-add");
  const whitelistStatus  = document.getElementById("chain-whitelist-status");
  const whitelistClose   = document.getElementById("chain-whitelist-close");

  if (whitelistBtn) {
    whitelistBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (whitelistPopover.classList.contains("open")) { closeAllPopovers(); return; }
      closeAllPopovers();
      openWhitelistPopover();
    });
  }
  if (whitelistClose) whitelistClose.onclick = closeAllPopovers;
  if (whitelistAdd)   whitelistAdd.onclick   = addWhitelistEntry;
  if (whitelistInput) whitelistInput.addEventListener("keydown", e => { if (e.key === "Enter") addWhitelistEntry(); });

  function openWhitelistPopover() {
    whitelistList.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:4px">Loading…</div>`;
    whitelistStatus.textContent = "";
    whitelistPopover.classList.add("open");
    fbGet(P.whitelist(), data => {
      whitelistList.innerHTML = "";
      const fids = data ? Object.keys(data) : [];
      if (!fids.length) {
        whitelistList.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:4px">No factions whitelisted yet.</div>`;
        return;
      }
      // Render placeholders first, then fill names async
      fids.forEach(fid => {
        const row = document.createElement("div");
        row.className = "chain-whitelist-row";
        row.id = `chain-wl-row-${fid}`;
        row.innerHTML = `<span id="chain-wl-name-${escHtml(fid)}" style="color:#445">${escHtml(fid)}…</span><button data-fid="${escHtml(fid)}">✕</button>`;
        row.querySelector("button").addEventListener("click", () => removeWhitelistEntry(fid));
        whitelistList.appendChild(row);
        // Fetch faction name from Torn API
        if (tornApiKey) {
          GM_xmlhttpRequest({
            method: "GET",
            url: `https://api.torn.com/faction/${fid}?selections=basic&key=${encodeURIComponent(tornApiKey)}`,
            timeout: 8000,
            onload(r) {
              try {
                const d = JSON.parse(r.responseText);
                const nameEl = document.getElementById(`chain-wl-name-${fid}`);
                if (!nameEl) return;
                if (d && d.name) {
                  nameEl.textContent = `${d.name} [${fid}]`;
                  nameEl.style.color = "";
                } else {
                  nameEl.textContent = `${fid} (unknown)`;
                }
              } catch { /**/ }
            },
            onerror()  { /**/ },
            ontimeout(){ /**/ },
          });
        }
      });
    });
  }

  function addWhitelistEntry() {
    const fid = (whitelistInput.value || "").trim();
    if (!fid || isNaN(fid)) { whitelistStatus.textContent = "Enter a valid faction ID."; whitelistStatus.style.color="#ff8888"; return; }
    whitelistStatus.textContent = "Adding…"; whitelistStatus.style.color="#ffcc66";
    fbPut(P.whitelistEntry(fid), true, () => {
      whitelistInput.value = "";
      whitelistStatus.textContent = `✓ ${fid} added.`; whitelistStatus.style.color="#44ff88";
      openWhitelistPopover();
    });
  }

  function removeWhitelistEntry(fid) {
    fbDelete(P.whitelistEntry(fid), () => openWhitelistPopover());
  }

  // Check if this client's faction is on the whitelist.
  // No client-side bypass — Firebase rules are the sole authority.
  // The owner's faction (50825) is in the whitelist, so this returns true for them
  // the same as any other whitelisted faction. No special client-side case needed.
  function fbCheckWhitelist(cb) {
    fbGet(P.whitelistEntry(factionId), data => {
      cb(data === true);
    });
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  Bug Report & Tracker
  // ══════════════════════════════════════════════════════════════════════════
  const bugBtn          = document.getElementById("chain-bug-btn");
  const bugMenu         = document.getElementById("chain-bug-menu");
  const bugReportItem   = document.getElementById("chain-bug-report-item");
  const bugTrackerItem  = document.getElementById("chain-bug-tracker-item");
  const bugPopover      = document.getElementById("chain-bug-popover");
  const bugTitleInput   = document.getElementById("chain-bug-title-input");
  const bugDescInput    = document.getElementById("chain-bug-desc-input");
  const bugSubmitBtn    = document.getElementById("chain-bug-submit");
  const bugCancelBtn    = document.getElementById("chain-bug-cancel");
  const bugReportStatus = document.getElementById("chain-bug-report-status");
  const trackerPopover  = document.getElementById("chain-tracker-popover");
  const trackerList     = document.getElementById("chain-tracker-list");
  const adminSection    = document.getElementById("chain-admin-section");
  const adminInbox      = document.getElementById("chain-admin-inbox");
  const trackerClose    = document.getElementById("chain-tracker-close");

  function closeBugPopovers() {
    bugMenu.classList.remove("open");
    bugPopover.classList.remove("open");
    trackerPopover.classList.remove("open");
  }

  // Bug button toggles dropdown
  if (bugBtn) bugBtn.addEventListener("click", e => {
    e.stopPropagation();
    const isOpen = bugMenu.classList.contains("open");
    closeAllPopovers(); closeBugPopovers();
    if (!isOpen) bugMenu.classList.add("open");
  });

  // Prevent clicks inside the bug popovers from propagating to the document close handler
  [bugPopover, trackerPopover, bugMenu].forEach(el => {
    if (el) el.addEventListener("click", e => e.stopPropagation());
  });

  // Report Bug item
  if (bugReportItem) bugReportItem.addEventListener("click", e => {
    e.stopPropagation();
    closeBugPopovers();
    bugTitleInput.value = ""; bugDescInput.value = ""; bugReportStatus.textContent = "";
    bugPopover.classList.add("open");
    setTimeout(() => bugTitleInput.focus(), 50);
  });

  // View Tracker item
  if (bugTrackerItem) bugTrackerItem.addEventListener("click", e => {
    e.stopPropagation();
    closeBugPopovers();
    openBugTracker();
  });

  if (bugCancelBtn) bugCancelBtn.onclick = closeBugPopovers;
  if (trackerClose) trackerClose.onclick = closeBugPopovers;

  // ── Admin inbox resize handle ────────────────────────────────────────────
  (function initAdminResize() {
    const handle = document.getElementById("chain-admin-inbox-resize");
    const inbox  = document.getElementById("chain-admin-inbox");
    if (!handle || !inbox) return;
    const MIN_H = 80, MAX_H = 600;
    // Restore saved height
    const savedH = GM_getValue(SK_ADMIN_H, 200);
    inbox.style.height = Math.min(MAX_H, Math.max(MIN_H, savedH)) + "px";

    let resizing=false, startY=0, startH=0;
    function onStart(cy) { resizing=true; startY=cy; startH=inbox.offsetHeight; document.body.style.userSelect="none"; }
    function onMove(cy)  { if(!resizing) return;
      // Handle is ABOVE the inbox. Drag down = shrink, drag up = grow.
      inbox.style.height = Math.min(MAX_H, Math.max(MIN_H, startH-(cy-startY)))+"px"; }
    function onEnd()     { if(!resizing) return; resizing=false; document.body.style.userSelect=""; GM_setValue(SK_ADMIN_H, inbox.offsetHeight); }

    handle.addEventListener("mousedown",  e => {
      e.preventDefault(); e.stopPropagation(); onStart(e.clientY);
      const mm = e2 => onMove(e2.clientY);
      const mu = () => { onEnd(); document.removeEventListener("mousemove",mm); document.removeEventListener("mouseup",mu); };
      document.addEventListener("mousemove", mm);
      document.addEventListener("mouseup", mu);
    });
    handle.addEventListener("touchstart", e => {
      e.stopPropagation(); onStart(e.touches[0].clientY);
      const tm = e2 => { if(resizing){ e2.preventDefault(); onMove(e2.touches[0].clientY); } };
      const te = () => { onEnd(); document.removeEventListener("touchmove",tm); document.removeEventListener("touchend",te); };
      document.addEventListener("touchmove", tm, {passive:false});
      document.addEventListener("touchend", te);
    }, {passive:true});
  })();

  // ── Tracker resize handle ─────────────────────────────────────────────────
  (function initTrackerResize() {
    const handle = document.getElementById("chain-tracker-resize-handle");
    if (!handle || !trackerPopover) return;
    const MIN_H = 200, MAX_H = Math.round(window.innerHeight * 0.85);
    let resizing=false, startY=0, startH=0;
    // Restore saved height
    const savedH = GM_getValue(SK_TRACKER_H, 440);
    trackerPopover.style.height = Math.min(MAX_H, Math.max(MIN_H, savedH)) + "px";

    function onStart(cy) {
      resizing=true; startY=cy; startH=trackerPopover.offsetHeight;
      document.body.style.userSelect="none";
    }
    function onMove(cy) {
      if (!resizing) return;
      const newH = Math.min(MAX_H, Math.max(MIN_H, startH + (cy - startY)));
      trackerPopover.style.height = newH+"px";
    }
    function onEnd() {
      if (!resizing) return; resizing=false;
      document.body.style.userSelect="";
      GM_setValue(SK_TRACKER_H, trackerPopover.offsetHeight);
    }
    handle.addEventListener("mousedown",  e => {
      e.preventDefault(); e.stopPropagation(); onStart(e.clientY);
      const mm = e2 => onMove(e2.clientY);
      const mu = () => { onEnd(); document.removeEventListener("mousemove",mm); document.removeEventListener("mouseup",mu); };
      document.addEventListener("mousemove", mm);
      document.addEventListener("mouseup", mu);
    });
    handle.addEventListener("touchstart", e => {
      e.stopPropagation(); onStart(e.touches[0].clientY);
      const tm = e2 => { if(resizing) { e2.preventDefault(); onMove(e2.touches[0].clientY); } };
      const te = () => { onEnd(); document.removeEventListener("touchmove",tm); document.removeEventListener("touchend",te); };
      document.addEventListener("touchmove", tm, {passive:false});
      document.addEventListener("touchend", te);
    }, {passive:true});
  })();

  // Submit bug report
  if (bugSubmitBtn) bugSubmitBtn.addEventListener("click", e => {
    e.stopPropagation();
    const title = (bugTitleInput.value || "").trim();
    const desc  = (bugDescInput.value  || "").trim();
    if (!title) { bugReportStatus.textContent = "Please enter a title."; bugReportStatus.style.color = "#ff8888"; return; }
    if (!desc)  { bugReportStatus.textContent = "Please describe the issue."; bugReportStatus.style.color = "#ff8888"; return; }
    if (!fbConfigured()) { bugReportStatus.textContent = "Firebase not configured."; bugReportStatus.style.color = "#ff8888"; return; }
    bugSubmitBtn.disabled = true;
    bugReportStatus.textContent = "Submitting…"; bugReportStatus.style.color = "#ffcc66";
    const bugId = `bug_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const bugTypeSel = document.getElementById("chain-bug-type-sel");
    const report = {
      id: bugId, title, description: desc,
      type: (bugTypeSel ? bugTypeSel.value : "bug"),
      reporter: ownName || "Unknown", tornId: ownId || "",
      factionId: factionId || "", factionName: factionName || "",
      version: CURRENT_VERSION, ua: _ua.slice(0, 200),
      timestamp: Date.now(), status: "new",
    };

    function doSubmit(token) {
      const url = `${FIREBASE_DB_URL}/bugs/${bugId}.json${token ? "?auth="+token : ""}`;
      GM_xmlhttpRequest({
        method: "PUT", url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(report),
        timeout: 12000,
        onload(r) {
          bugSubmitBtn.disabled = false;
          if (r.status >= 200 && r.status < 300) {
            bugReportStatus.textContent = "✓ Report submitted — thank you!";
            bugReportStatus.style.color = "#44ff88";
            bugTitleInput.value = ""; bugDescInput.value = "";
            setTimeout(closeBugPopovers, 2500);
          } else {
            bugReportStatus.textContent = `❌ Failed (${r.status}) — try again.`;
            bugReportStatus.style.color = "#ff8888";
          }
        },
        onerror()  { bugSubmitBtn.disabled = false; bugReportStatus.textContent = "❌ Network error."; bugReportStatus.style.color = "#ff8888"; },
        ontimeout(){ bugSubmitBtn.disabled = false; bugReportStatus.textContent = "❌ Timed out."; bugReportStatus.style.color = "#ff8888"; },
      });
    }

    if (fbToken) {
      doSubmit(fbToken);
    } else {
      // No token yet — sign in anonymously first
      bugReportStatus.textContent = "Authenticating…"; bugReportStatus.style.color = "#ffcc66";
      fbSignInAnon((token, uid) => {
        if (token) { fbToken = token; fbUid = uid; doSubmit(token); }
        else { bugSubmitBtn.disabled = false; bugReportStatus.textContent = "❌ Auth failed."; bugReportStatus.style.color = "#ff8888"; }
      });
    }
  });

  function statusLabel(s) {
    return { new:"New", acknowledged:"Acknowledged", in_progress:"In Progress", fixed:"Fixed", wontfix:"Won't Fix" }[s] || s;
  }

  function openBugTracker() {
    trackerList.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:6px">Loading…</div>`;
    if (adminSection) adminSection.style.display = "none";
    trackerPopover.classList.add("open");

    // Load public tracker entries (no auth needed — public read)
    const publicUrl = `${FIREBASE_DB_URL}/bugTracker.json`;
    // Admin inbox: only shown if isOwner was confirmed by the boot probe (fbProbeOwner).
    // loadAdminInbox handles its own ownerProbeResult guard — safe to call always.
    if (ownerProbeResult === true) loadAdminInbox();
    GM_xmlhttpRequest({
      method: "GET", url: publicUrl, timeout: 10000,
      onload(r) {
        try {
          const data = r.status >= 200 && r.status < 300 ? JSON.parse(r.responseText) : null;
          trackerList.innerHTML = "";
          if (!data || !Object.keys(data).length) {
            trackerList.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:6px">No tracked items yet.</div>`;
          } else {
            // Attach the Firebase key to each entry so the delete button has it reliably
            Object.keys(data).forEach(k => { if (data[k] && typeof data[k]==='object') data[k]._fbKey = k; });
            const all = Object.values(data).sort((a, b) => (b.updatedAt||0) - (a.updatedAt||0));
            const bugs     = all.filter(e => (e.type||"bug") === "bug");
            const features = all.filter(e => e.type === "feature");

            function renderSection(label, items) {
              if (!items.length) return;
              const hdr = document.createElement("div");
              hdr.className = "chain-tracker-section-hdr";
              hdr.textContent = label;
              trackerList.appendChild(hdr);
              items.forEach(entry => {
                const div = document.createElement("div");
                div.className = `chain-tracker-entry status-${entry.status||"new"}`;
                const typeBadge = entry.type === "feature"
                  ? `<span class="chain-tracker-type-feature">Feature</span>`
                  : `<span class="chain-tracker-type-bug">Bug</span>`;
                // Owner gets a delete button — DELETEs the /bugTracker entry entirely
                const deleteBtn = isOwner
                  ? `<button class="chain-tracker-delete-btn" data-entry-id="${escHtml(entry._fbKey||entry.id||"")}" style="float:right;font-size:9px;padding:1px 5px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,80,80,.35);background:rgba(255,60,60,.1);color:#ff8888;margin-left:4px;">✕</button>`
                  : "";
                div.innerHTML = `
                  <div class="chain-tracker-entry-title">
                    ${deleteBtn}${typeBadge}${escHtml(entry.title||"Untitled")}
                    <span class="chain-tracker-badge ${(entry.status||"new").replace("_","-")}">${statusLabel(entry.status||"new")}</span>
                  </div>
                  ${entry.adminNote ? `<div class="chain-tracker-entry-note">${escHtml(entry.adminNote)}</div>` : ""}
                `;
                trackerList.appendChild(div);
              });
              // Wire delete buttons
              trackerList.querySelectorAll(".chain-tracker-delete-btn").forEach(btn => {
                btn.addEventListener("click", e => {
                  e.stopPropagation();
                  const entryId = btn.dataset.entryId;
                  if (!entryId || !fbToken) return;
                  const url = `${FIREBASE_DB_URL}/bugTracker/${entryId}.json?auth=${fbToken}`;
                  GM_xmlhttpRequest({
                    method: "DELETE", url, timeout: 8000,
                    onload(r) {
                      if (r.status >= 200 && r.status < 300) {
                        const card = btn.closest(".chain-tracker-entry");
                        if (card) card.remove();
                        // Remove empty section header if no siblings left
                        const list = trackerList;
                        list.querySelectorAll(".chain-tracker-section-hdr").forEach(hdr => {
                          let next = hdr.nextElementSibling;
                          if (!next || next.classList.contains("chain-tracker-section-hdr")) hdr.remove();
                        });
                      }
                    },
                    onerror(){}, ontimeout(){},
                  });
                });
              });
            }

            renderSection("🪲 Bugs", bugs);
            renderSection("✨ Feature Requests", features);
          }
        } catch { trackerList.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:6px">Failed to load tracker.</div>`; }

        // Owner: loadAdminInbox was already kicked off above in parallel.
      },
      onerror()  { trackerList.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:6px">Network error.</div>`; },
      ontimeout(){ trackerList.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:6px">Timed out.</div>`; },
    });
  }

  // Cached result of the owner probe — avoids re-probing on every tracker open.
  // null = not yet probed, true = confirmed owner, false = confirmed non-owner.
  let ownerProbeResult = null;

  // fbProbeOwner: called once at boot after lobby check-in succeeds.
  // Silently reads /bugs (limit 1) to determine owner status from Firebase rules.
  // Sets isOwner and refreshes the gear menu — no UI shown on failure.
  function fbProbeOwner() {
    if (!fbToken || !fbUid) return;
    // Probe owner status by attempting a write to /bugTracker — only the owner can write.
    // We write a sentinel key then immediately delete it. A 200 confirms owner access;
    // a 401/403 means not the owner. This works with the current rules without any
    // rules change — /bugTracker write requires tornId === '2348580' server-side.
    const sentinelKey = `_ownerProbe_${fbUid}`;
    const sentinelUrl = `${FIREBASE_DB_URL}/bugTracker/${sentinelKey}.json?auth=${fbToken}`;
    GM_xmlhttpRequest({
      method: "PUT", url: sentinelUrl,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(1),
      timeout: 10000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          // Confirmed owner — clean up sentinel immediately
          GM_xmlhttpRequest({ method: "DELETE", url: sentinelUrl, timeout: 5000,
            onload(){}, onerror(){}, ontimeout(){} });
          ownerProbeResult = true;
          isOwner = true;
          updateClearBtn();
          if (!ownerCleanupInterval) ownerCleanupInterval = setInterval(fbCleanOwnLobbyEntries, 2 * 60 * 1000);
        } else {
          ownerProbeResult = false;
        }
      },
      onerror()  { /* leave null — transient, tracker can retry */ },
      ontimeout(){ /* leave null */ },
    });
  }

  function loadAdminInbox() {
    // Firebase rules are the sole authority for owner status.
    // Once we've probed and got 401, skip silently on future opens.
    if (ownerProbeResult === false) return;
    if (!adminSection || !adminInbox) return;
    // Show a placeholder while we probe — hidden until we confirm access
    adminInbox.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:4px">Loading reports…</div>`;

    function doLoad(token) {
      // NOTE: /bugs root read requires ".read" at the /bugs level in Firebase rules.
      // If this returns 401, update rules to add: "bugs": { ".read": "<owner check>" }
      const url = `${FIREBASE_DB_URL}/bugs.json${token ? "?auth="+token : ""}`;
      GM_xmlhttpRequest({
        method: "GET", url, timeout: 12000,
        onload(r) {
          adminInbox.innerHTML = "";
          if (r.status === 401 || r.status === 403) {
            // Not the owner — cache result and hide section silently
            ownerProbeResult = false;
            if (adminSection) adminSection.style.display = "none";
            return;
          }
          // Confirmed owner — cache result, show section, set flag
          ownerProbeResult = true;
          isOwner = true;
          if (adminSection) adminSection.style.display = "";
          updateClearBtn();   // refresh gear menu to show whitelist option
          if (r.status < 200 || r.status >= 300) {
            let errMsg = r.responseText;
            try { errMsg = JSON.parse(r.responseText).error || errMsg; } catch {/**/ }
            adminInbox.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:4px">❌ Firebase ${r.status}: ${errMsg}</div>`;
            return;
          }
          let data = null;
          try { data = JSON.parse(r.responseText); } catch {/**/ }
          if (!data || !Object.keys(data).length) {
            adminInbox.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:4px">No reports yet.</div>`;
            return;
          }
          const reports = Object.values(data)
            .filter(r => r.status !== "dismissed")
            .sort((a, b) => (b.timestamp||0) - (a.timestamp||0));
          if (!reports.length) {
            adminInbox.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:4px">No reports yet.</div>`;
            return;
          }
          reports.forEach(report => {
            const div = document.createElement("div");
            div.className = "chain-admin-report";
            div.dataset.reportId = report.id;
            const ts = report.timestamp ? new Date(report.timestamp).toLocaleString([], {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "?";
            div.innerHTML = `
              <div class="chain-admin-report-header">
                <input class="chain-admin-title-input" type="text" value="${escHtml(report.title||"Untitled")}" maxlength="100">
                <button class="chain-admin-copy-btn" data-copy-id="${escHtml(report.id)}">Copy</button>
                <button class="chain-admin-dismiss-btn" data-dismiss-id="${escHtml(report.id)}">✕</button>
              </div>
              <div class="chain-admin-report-meta" style="font-size:9px;color:#556;margin:2px 0 4px;">${escHtml(report.reporter||"?")} v${escHtml(report.version||"?")} ${ts}</div>
              <div class="chain-admin-report-desc">${escHtml(report.description||"")}</div>
              <div class="chain-admin-status-row">
                <select class="chain-admin-type-sel" data-report-id="${escHtml(report.id)}">
                  ${["bug","feature"].map(t =>
                    `<option value="${t}"${(report.type||"bug")===t?" selected":""}>${t==="bug"?"🪲 Bug":"✨ Feature"}</option>`
                  ).join("")}
                </select>
                <select class="chain-admin-status-sel" data-report-id="${escHtml(report.id)}">
                  ${["new","acknowledged","in_progress","fixed","wontfix"].map(s =>
                    `<option value="${s}"${(report.status||"new")===s?" selected":""}>${statusLabel(s)}</option>`
                  ).join("")}
                </select>
                <input class="chain-admin-note-input" type="text" placeholder="Admin note…" value="${escHtml(report.adminNote||"")}">
                <button class="chain-admin-publish-btn" data-report-id="${escHtml(report.id)}">Publish</button>
              </div>
            `;
            adminInbox.appendChild(div);
          });

          // Wire copy buttons
          adminInbox.querySelectorAll(".chain-admin-copy-btn").forEach(btn => {
            btn.addEventListener("click", e => {
              e.stopPropagation();
              const id = btn.dataset.copyId;
              const r = reports.find(x => x.id === id);
              if (!r) return;
              const card = btn.closest(".chain-admin-report");
              const currentTitle = card ? card.querySelector(".chain-admin-title-input").value : r.title;
              const txt = `**${r.type==="feature"?"Feature Request":"Bug Report"}**\nTitle: ${currentTitle}\nReporter: ${r.reporter} (${r.tornId}) v${r.version}\nFaction: ${r.factionName} (${r.factionId})\nTime: ${new Date(r.timestamp).toISOString()}\nUA: ${r.ua||""}\n\nDescription:\n${r.description}`;
              try { navigator.clipboard.writeText(txt).then(() => { btn.textContent="✓"; setTimeout(()=>btn.textContent="Copy",1500); }); } catch { btn.textContent="✓"; }
            });
          });

          // Wire dismiss buttons — sets status:dismissed in Firebase, removes card from UI
          adminInbox.querySelectorAll(".chain-admin-dismiss-btn").forEach(btn => {
            btn.addEventListener("click", e => {
              e.stopPropagation();
              const reportId = btn.dataset.dismissId;
              const orig = reports.find(x => x.id === reportId);
              if (!orig) return;
              fbPut(P.bugReport(reportId), { ...orig, status: "dismissed" }, () => {
                const card = btn.closest(".chain-admin-report");
                if (card) card.remove();
              });
            });
          });

          // Wire publish buttons — reads editable title and type from card
          adminInbox.querySelectorAll(".chain-admin-publish-btn").forEach(btn => {
            btn.addEventListener("click", e => {
              e.stopPropagation();
              const reportId = btn.dataset.reportId;
              const row  = btn.closest(".chain-admin-status-row");
              const card = btn.closest(".chain-admin-report");
              const title  = card ? card.querySelector(".chain-admin-title-input").value.trim() : "";
              const type   = row.querySelector(".chain-admin-type-sel").value;
              const status = row.querySelector(".chain-admin-status-sel").value;
              const note   = row.querySelector(".chain-admin-note-input").value.trim();
              const entry  = { title: title||"Untitled", type, status, adminNote: note, updatedAt: Date.now() };
              fbPut(P.bugTrackerEntry(reportId), entry, () => {
                btn.textContent = "✓ Published";
                setTimeout(() => btn.textContent = "Publish", 2000);
              });
              // Also update raw report with any edits
              const orig = reports.find(x => x.id === reportId);
              if (orig) fbPut(P.bugReport(reportId), { ...orig, title: entry.title, type, status, adminNote: note });
            });
          });
        },
        onerror()  { adminInbox.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:4px">Network error loading reports.</div>`; },
        ontimeout(){ adminInbox.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:4px">Timed out loading reports.</div>`; },
      });
    }

    // The Firebase rule for /bugs checks lobby/{uid}/tornId — so we must ensure
    // the lobby entry is fresh AND has a populated tornId before reading.
    // ownId is only set after fetchOwnProfile completes; if it's empty we poll briefly.
    function ensureLobbyThenLoad(token, uid) {
      function writeLobbyAndLoad() {
        if (!ownId) {
          // fetchOwnProfile hasn't returned yet — retry in 500ms (max 10s)
          ensureLobbyThenLoad._retries = (ensureLobbyThenLoad._retries || 0) + 1;
          if (ensureLobbyThenLoad._retries < 20) {
            setTimeout(() => writeLobbyAndLoad(), 500);
          } else {
            adminInbox.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:4px">❌ Profile not loaded — open API popover and save key.</div>`;
          }
          return;
        }
        ensureLobbyThenLoad._retries = 0;
        const lobbyUrl = `${FIREBASE_DB_URL}/lobby/${uid}.json?auth=${token}`;
        GM_xmlhttpRequest({
          method: "PUT", url: lobbyUrl,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ name: ownName, tornId: ownId, factionId: factionId||"", lastSeen: Date.now() }),
          timeout: 8000,
          onload(r) {
            if (r.status >= 200 && r.status < 300) {
              doLoad(token);
            } else {
              // Lobby write failed — try reading anyway in case lobby is still valid from boot
              doLoad(token);
            }
          },
          onerror()  { doLoad(token); },
          ontimeout(){ doLoad(token); },
        });
      }
      writeLobbyAndLoad();
    }

    if (fbToken && fbUid) {
      ensureLobbyThenLoad(fbToken, fbUid);
    } else {
      adminInbox.innerHTML = `<div style="font-size:10px;color:#445;text-align:center;padding:4px">Authenticating…</div>`;
      fbSignInAnon((token, uid) => {
        if (!token) { adminInbox.innerHTML = `<div style="font-size:10px;color:#ff8888;text-align:center;padding:4px">Auth failed.</div>`; return; }
        fbToken = token; fbUid = uid;
        ensureLobbyThenLoad(token, uid);
      });
    }
  }

  // Close bug popovers when clicking outside panel — but not when clicking inside them
  // ── Single consolidated document click handler ────────────────────────────
  // Replaces four separate document.addEventListener("click") calls:
  //   1. closeAllPopovers when clicking outside panel
  //   2. gearMenu close
  //   3. offline-section toggle
  //   4. bug/tracker popover close when clicking outside panel
  document.addEventListener("click", e => {
    const outsidePanel = !panel.contains(e.target);

    // 1 + 4: close all popovers (including bug/tracker) on outside click
    if (outsidePanel) {
      closeAllPopovers();
      // bug popovers need explicit remove in case they're outside the panel contains check
      if (bugMenu)        bugMenu.classList.remove("open");
      if (bugPopover     && !bugPopover.contains(e.target))     bugPopover.classList.remove("open");
      if (trackerPopover && !trackerPopover.contains(e.target)) trackerPopover.classList.remove("open");
    }

    // 2: gear menu closes on any click (inside or outside panel)
    const gearMenu = document.getElementById("chain-gear-menu");
    if (gearMenu) gearMenu.classList.remove("open");

    // 3: offline section toggle
    const toggle = e.target.closest("#chain-offline-toggle");
    if (toggle) {
      e.stopPropagation();
      const list = document.getElementById("chain-offline-list");
      const isOpen = toggle.classList.toggle("open");
      if (list) list.classList.toggle("open", isOpen);
    }
  });

  function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function formatTime(ms) {
    if (ms<=0) return "NOW";
    const s=Math.floor(ms/1000);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
  }
  function isHospStillIn(hit) { return !!(hit.hospReleaseAt && hit.hospReleaseAt>Date.now()); }
  function hitTimerClass(rem) { if(rem<=0)return"due"; if(rem<=settDangerThreshold*1000)return"soon"; return"wait"; }
  function hitRowClass(rem, hosp, untracked) {
    if(untracked) return"untracked";
    if(hosp)      return"hosp-waiting";
    if(rem<=0)    return"due";
    if(rem<=60000)return"soon";
    return"waiting";
  }

  // chainTimerMs() — used for UI display. DOM observer ONLY.
  // Never uses the API timer — it's too imprecise for display (1-30s off
  // depending on network latency and poll phase).
  function chainTimerMs() {
    if (liveChainSecs !== null && lastTimerReadAt !== null) {
      return Math.max(0, (liveChainSecs + settTimerFudge - (performance.now() - lastTimerReadAt) / 1000)) * 1000;
    }
    return 0;
  }

  // chainTimerMsForScheduling() — used for hit window calculations only.
  // Falls back to API timer when DOM observer unavailable (acceptable ±5s precision).
  function chainTimerMsForScheduling() {
    if (liveChainSecs !== null && lastTimerReadAt !== null) {
      return Math.max(0, (liveChainSecs - (performance.now() - lastTimerReadAt) / 1000)) * 1000;
    }
    if (apiTimerSecs !== null && apiTimerReadAt !== null && liveChainCount !== null) {
      return Math.max(0, (apiTimerSecs - (performance.now() - apiTimerReadAt) / 1000)) * 1000;
    }
    return 0;
  }

  // pendingCountdownMs(pos): ms until the pending hit at sorted queue position
  // pos should be attacked.
  //
  // Previously this was computed as chainTimerMsForScheduling() + pos*HIT_DELAY,
  // which caused the queue timers to update in ~5-6s steps whenever the DOM
  // observer was unavailable and the fallback fell through to the Firebase-polled
  // apiTimerSecs value.
  //
  // Now we use each hit's scheduledAt (an absolute wall-clock ms timestamp
  // stored in Firebase) as the primary source.  syncPendingScheduledAt() is
  // called each UI tick and re-anchors pos-0's scheduledAt to the accurate DOM
  // timer, keeping all subsequent positions in sync without any polling lag.
  // pendingCountdownMs(pos, prebuilt?)
  // Pass the pre-sorted pending array when available (e.g. from the 1s tick) to
  // avoid rebuilding it for every row.  Falls back to building it internally so
  // all existing callers outside the tick continue to work unchanged.
  function pendingCountdownMs(pos, prebuilt) {
    const pending = prebuilt || [...hitMap.values()]
      .filter(h => h.status !== "done")
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
    const hit = pending[pos];
    if (!hit) return 0;
    return Math.max(0, hit.scheduledAt - Date.now());
  }

  // syncPendingScheduledAt(): called once per UI tick when the DOM timer is live.
  // Re-derives every pending hit's scheduledAt directly from the live chain timer
  // so all countdowns stay in sync with the actual Torn countdown, not with
  // wall-clock offsets that drift between Firebase polls.
  //
  // Layout (FIX 4.9.4):
  //
  //   currentHitNum  = liveChainCount + 1  (the hit the chain needs RIGHT NOW)
  //   chainExpiresAt = Date.now() + chainTimerMsForScheduling()
  //                    (absolute instant the current chain window expires)
  //
  //   For each pending hit sorted by hitNumber:
  //     offset      = max(0, hitNumber - currentHitNum)
  //                   0 for the current hit, 1 for the next, 2 for the one after…
  //     scheduledAt = chainExpiresAt + offset * HIT_INTERVAL
  //
  //   Result:
  //     slot N   (current)  → countdown mirrors the live chain timer
  //     slot N+1            → chainTimer + 5:00
  //     slot N+2            → chainTimer + 10:00
  //     …
  //
  //   When liveChainCount increments after a hit, chainExpiresAt resets to the
  //   fresh 5:00 window and every slot immediately re-derives from it, so the
  //   "N+1 timer = chain_length" invariant is always maintained.
  //   Hosp override: hospReleaseAt takes priority when it falls later.
  function syncPendingScheduledAt() {
    if (liveChainSecs === null || lastTimerReadAt === null) return;
    const pending = [...hitMap.values()]
      .filter(h => h.status !== "done")
      .sort((a, b) => (a.chainHitNum || a.hitNumber) - (b.chainHitNum || b.hitNumber));
    if (!pending.length) return;

    // Absolute wall-clock instant when the current chain window expires.
    const chainExpiresAt = Date.now() + chainTimerMsForScheduling();

    // The hit number the chain needs right now.
    const currentHitNum = liveChainCount !== null
      ? liveChainCount + 1
      : getHighestDoneHitNum() + 1;

    pending.forEach(h => {
      const hitNum = h.chainHitNum || h.hitNumber;
      const offset = Math.max(0, hitNum - currentHitNum); // 0 = current, 1 = next, …
      const computed = chainExpiresAt + offset * HIT_INTERVAL;
      const newScheduledAt = Math.max(computed, h.hospReleaseAt || 0);
      // Only adjust when drift exceeds 1s — avoids constant churn on each tick.
      if (Math.abs(newScheduledAt - h.scheduledAt) >= 1000) {
        h.scheduledAt = newScheduledAt;
      }
    });
    // No Firebase write — this is a local display-only re-anchor.  The
    // authoritative scheduledAt (from scheduleAndWrite / moveToSlot) persists
    // in Firebase unchanged and drives scheduling decisions.
  }

  function getPendingHits() {
    return [...hitMap.values()].filter(h=>h.status!=="done").sort((a,b)=>a.hitNumber-b.hitNumber);
  }
  // Sort done hits ascending by chainHitNum, deduplicated — one entry per slot
  function getDoneHits() {
    const all = [...hitMap.values()].filter(h=>h.status==="done");
    // Deduplicate by chainHitNum: prefer non-untracked (user-queued) over scraped
    const byNum = new Map();
    for (const h of all) {
      const num = h.chainHitNum || h.hitNumber || 0;
      if (!num) continue;
      const ex = byNum.get(num);
      if (!ex) { byNum.set(num, h); continue; }
      // Prefer queued (non-untracked) over scraped untracked
      if (ex.untracked && !h.untracked) byNum.set(num, h);
    }
    return [...byNum.values()].sort((a,b)=>(a.chainHitNum||0)-(b.chainHitNum||0));
  }
  function getHighestDoneHitNum() {
    return [...hitMap.values()].filter(h=>h.status==="done"&&h.chainHitNum).reduce((m,h)=>Math.max(m,h.chainHitNum),0);
  }

  // reNumberPending: assigns correct hitNumbers locally and syncs to Firebase.
  // IMPORTANT: Only pushes hitNumber updates for hits that are ALREADY fully committed
  // to Firebase (i.e. exist in the server payload). Newly-created hits (added to hitMap
  // by scheduleAndWrite but not yet written) must NOT receive a field-level PUT — a
  // field-level write to /hits/{id}/hitNumber recreates the parent node in Firebase
  // even after the /hits node was wiped, producing zombie entries with only hitNumber.
  // The caller (scheduleAndWrite) always calls fbWriteHit() immediately after
  // reNumberPending(), which writes the complete hit object including the correct number.
  // Pass skipWrite=true to suppress all Firebase writes (used during local-only renumber).
  function reNumberPending(skipWrite) {
    const highest = getHighestDoneHitNum();
    const pending = [...hitMap.values()].filter(h=>h.status!=="done").sort((a,b)=>a.scheduledAt-b.scheduledAt);
    pending.forEach((h, i) => {
      const newNum = highest + i + 1;
      if (h.hitNumber !== newNum) {
        h.hitNumber = newNum;
        // Only push a field-level hitNumber update if the hit is already in Firebase
        // as a complete object (has a status field in the server copy).
        // Newly-created hits are skipped here — fbWriteHit writes the full object.
        if (!skipWrite && h.id && fbConfigured() && fbToken && h._fbCommitted) {
          fbPut(P.hitField(h.id, "hitNumber"), newNum);
        }
      }
    });
  }

  function fbConfigured() {
    return FIREBASE_DB_URL!=="https://YOUR-PROJECT-default-rtdb.firebaseio.com"
        && FIREBASE_API_KEY!=="YOUR_FIREBASE_WEB_API_KEY";
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase low-level HTTP helpers
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
        else {
          setSyncDot("error");
          const safeUrl = url.replace(/auth=[^&]+/,"auth=***");
          console.warn("[ChainCoord] Firebase write failed "+r.status+":", r.responseText, "URL:", safeUrl);
          try {
            const e=JSON.parse(r.responseText);
            const msg = e.error||r.responseText;
            syncDot.title="Sync error "+r.status+": "+msg;
            showBanner("chain-banner-debug",true,"❌ Firebase "+r.status+": "+msg);
          } catch { syncDot.title="Sync error "+r.status; showBanner("chain-banner-debug",true,"❌ Firebase error "+r.status+": "+r.responseText); }
        }
      },
      onerror(e)  { setSyncDot("error"); showBanner("chain-banner-debug",true,"❌ Network error reaching Firebase. Check @connect firebaseio.com in script header."); console.warn("[ChainCoord] Firebase PUT network error",e); },
      ontimeout(){ setSyncDot("error"); showBanner("chain-banner-debug",true,"❌ Firebase PUT timed out — DB may be unreachable."); console.warn("[ChainCoord] Firebase PUT timeout"); },
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
          if (!d.idToken) {
            console.warn("[ChainCoord] Firebase anon auth failed:", r.responseText);
            showBanner("chain-banner-status", true, "⚠ Firebase auth failed — check API key or project settings.");
          }
          if (d.refreshToken) {
            fbRefreshToken = d.refreshToken;
            // Proactively refresh 5 minutes before the 1-hour expiry
            const expiresIn = parseInt(d.expiresIn || 3600);
            setTimeout(fbRefreshIdToken, (expiresIn - 300) * 1000);
          }
          cb(d.idToken||null, d.localId||null);
        } catch(e) { console.warn("[ChainCoord] Firebase auth parse error",e); cb(null,null); }
      },
      onerror(e)  { console.warn("[ChainCoord] Firebase auth network error",e); cb(null,null); },
      ontimeout(){ console.warn("[ChainCoord] Firebase auth timeout"); cb(null,null); },
    });
  }

  function fbRefreshIdToken() {
    if (!fbRefreshToken) return;
    GM_xmlhttpRequest({
      method:"POST",
      url:`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify({ grant_type:"refresh_token", refresh_token:fbRefreshToken }),
      timeout:10000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);
          if (d.id_token) {
            fbToken = d.id_token;
            if (d.refresh_token) fbRefreshToken = d.refresh_token;
            const expiresIn = parseInt(d.expires_in || 3600);
            setTimeout(fbRefreshIdToken, (expiresIn - 300) * 1000);
            console.log("[ChainCoord] Firebase token refreshed OK");
          } else {
            console.warn("[ChainCoord] Token refresh failed:", r.responseText);
            // Fall back to full re-auth
            fbSignInAnon((token, uid) => { if (token) fbToken = token; });
          }
        } catch(e) { console.warn("[ChainCoord] Token refresh parse error",e); }
      },
      onerror()  { console.warn("[ChainCoord] Token refresh network error — will retry"); setTimeout(fbRefreshIdToken, 30000); },
      ontimeout(){ console.warn("[ChainCoord] Token refresh timeout — will retry"); setTimeout(fbRefreshIdToken, 30000); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase member registration + heartbeat
  // ══════════════════════════════════════════════════════════════════════════
  // Lobby cleanup — runs once on login:
  // 1. Delete any old fbUid-keyed entries for our tornId (left from pre-4.4.3 versions)
  // 2. Owner only: delete globally stale entries older than PRESENCE_TIMEOUT * 4
  // Delete lobby entries that share our tornId but are NOT our current fbUid session.
  // Also owner-sweeps globally stale entries. Runs once on login.
  function fbCleanOwnLobbyEntries() {
    if (!fbUid || !ownId || !fbConfigured()) return;
    fbGet(P.lobbyAll(), data => {
      if (!data || typeof data !== "object") return;
      const now = Date.now();
      const STALE_MS = PRESENCE_TIMEOUT * 2;  // 3 min — dead sessions swept quickly
      Object.entries(data).forEach(([key, entry]) => {
        if (!entry) return;
        if (key === fbUid) return;   // keep current session
        const isMineByTornId = String(entry.tornId) === String(ownId);
        const isStale        = (now - (entry.lastSeen || 0)) > STALE_MS;
        if (isMineByTornId) {
          // Old session entry for our tornId — delete regardless of age
          fbDelete(`${FIREBASE_DB_URL}/lobby/${key}.json${auth()}`);
        } else if (isOwner && isStale) {
          // Owner sweeps anyone's globally stale entries
          fbDelete(`${FIREBASE_DB_URL}/lobby/${key}.json${auth()}`);
        }
      });
    });
  }

  function fbRegisterMember() {
    if (!factionId || !ownId || !fbUid || !fbConfigured()) return;
    const lobbyUrl = P.lobbyMe();
    if (!lobbyUrl) return;
    fbPut(lobbyUrl, { name: ownName, tornId: ownId, factionId: factionId, lastSeen: Date.now() });
    // Member record keyed by torn_{tornId} — stable across page loads, no dedup needed.
    // Only overwrite version if ours is newer or equal — prevents an older device's
    // heartbeat from clobbering a newer version written by another device.
    fbGet(P.memberMe(), existing => {
      const storedVer = existing && existing.version ? existing.version : null;
      const shouldWriteVer = !storedVer || !isNewerVersion(storedVer, CURRENT_VERSION);
      fbPut(P.memberMe(), { name: ownName, tornId: ownId, lastSeen: Date.now(), version: shouldWriteVer ? CURRENT_VERSION : storedVer });
    });
    fbPut(P.clientVersion("torn_"+ownId), { version: CURRENT_VERSION, name: ownName, lastSeen: Date.now() });
  }

  function fbHeartbeat() {
    if (!factionId || !ownId || !fbUid || !fbConfigured()) return;
    const now = Date.now();
    const lobbyUrl = P.lobbyMe();
    if (!lobbyUrl) return;

    // Write lobby first — member write is authorized by rules reading lobby.factionId.
    // Chain: only write member/version after lobby confirms success.
    GM_xmlhttpRequest({
      method: "PUT", url: lobbyUrl,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ name: ownName, tornId: ownId, factionId: factionId, lastSeen: now }),
      timeout: 8000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          heartbeatFailCount = 0;
          // Only write our version if it's >= what's stored — prevents an older
          // device from clobbering the newest version written by another device.
          fbGet(P.memberMe(), existing => {
            const storedVer = existing && existing.version ? existing.version : null;
            const shouldWriteVer = !storedVer || !isNewerVersion(storedVer, CURRENT_VERSION);
            fbPut(P.memberMe(), { name: ownName, tornId: ownId, lastSeen: Date.now(), version: shouldWriteVer ? CURRENT_VERSION : storedVer });
          });
          fbPut(P.clientVersion("torn_"+ownId), { version: CURRENT_VERSION, name: ownName, lastSeen: Date.now() });
        } else {
          heartbeatFailCount++;
          console.warn("[ChainCoord] Heartbeat lobby write failed", r.status, "consecutive:", heartbeatFailCount);
          if (heartbeatFailCount >= 3) {
            // 3 consecutive failures — token may have expired or lobby got evicted.
            // Re-run full sign-in to get a fresh token and re-establish lobby.
            heartbeatFailCount = 0;
            console.warn("[ChainCoord] Heartbeat: re-authenticating after repeated failures");
            fbSignInAnon((token, uid) => {
              if (token && uid) {
                fbToken = token;
                fbUid   = uid;
                fbRegisterMember();
              }
            });
          }
        }
      },
      onerror()  {
        heartbeatFailCount++;
        console.warn("[ChainCoord] Heartbeat lobby network error, consecutive:", heartbeatFailCount);
      },
      ontimeout() {
        heartbeatFailCount++;
        console.warn("[ChainCoord] Heartbeat lobby timed out, consecutive:", heartbeatFailCount);
      },
    });
  }

  // Presence is served by /factions/{fid}/members which is written on register/heartbeat
  // and read by the main poll (fbPollOnce). Under the new Firebase rules, reading
  // /lobby (the full subtree) is denied — only /lobby/{uid} for auth.uid === uid is
  // accessible. So we no longer attempt a /lobby root read here.
  // This function is kept as a no-op stub so existing call-sites don't need to change.
  function fbSyncLobbyPresence() {
    // no-op: presence is populated via /factions/{fid}/members in the main poll
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Network version tracking
  //  /meta/clientVersions/{fbUid} = { version, name, lastSeen }
  //  Polled every CHAIN_POLL_MS alongside the faction poll.
  // ══════════════════════════════════════════════════════════════════════════
  function fbPollClientVersions() {
    if (!fbConfigured() || !fbUid) return;
    // GitHub is the sole source of truth for the canonical latest version.
    // Peer clientVersions are recorded for display purposes only and must never
    // push networkLatestVersion above what GitHub has published — otherwise a
    // dev/pre-release build running locally would trigger phantom update arrows
    // on all other clients pointing to a version that doesn't exist on GitHub.
    fbGet(P.latestVersion(), lv => {
      const githubLatest = (lv && lv.version) ? lv.version : CURRENT_VERSION;
      fbGet(P.clientVersions(), data => {
        const now = Date.now();
        const ACTIVE_WINDOW = PRESENCE_TIMEOUT * 2;
        clientVersionMap.clear();
        if (data && typeof data === "object") {
          Object.entries(data).forEach(([uid, entry]) => {
            if (!entry || !entry.version) return;
            if (entry.lastSeen && (now - entry.lastSeen) > ACTIVE_WINDOW) return;
            clientVersionMap.set(uid, entry.version);
          });
        }
        // Always cap at githubLatest — peer versions are never allowed to exceed it.
        networkLatestVersion = githubLatest;
        updateVersionUI();
      });
    });
  }

  function updateVersionUI() {
    const badge  = document.getElementById("chain-version-badge");
    const upBtn  = document.getElementById("chain-update-btn");
    if (!badge || !upBtn) return;

    const behindNetwork = networkLatestVersion && isNewerVersion(networkLatestVersion, CURRENT_VERSION);

    if (behindNetwork) {
      // Use same colour logic as member list: yellow=bugfix, orange=feature, red=major
      const parse = v => v.split(".").map(Number);
      const [ma,  fe ]       = parse(CURRENT_VERSION);
      const [ma2, fe2, bf2]  = parse(networkLatestVersion);
      let color;
      if (ma2 !== ma)             color = "#ff4444";   // different major — red
      else if (fe2 !== fe)        color = "#ff9933";   // different feature — orange
      else                        color = "#ffee44";   // different bugfix — yellow
      badge.textContent = "v" + CURRENT_VERSION;
      badge.style.color = color;
      badge.className   = "behind";
      badge.title       = "v" + networkLatestVersion + " is available — click ↑ to update";
      upBtn.classList.add("has-update");
      upBtn.title = "Update available: v" + CURRENT_VERSION + " → v" + networkLatestVersion;
    } else {
      badge.textContent = "v" + CURRENT_VERSION;
      badge.style.color = "";   // let CSS class handle it
      badge.className   = "newest";
      badge.title       = "You are on the latest version";
      upBtn.classList.remove("has-update");
      upBtn.title = "You are on the latest version";
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase sync — polling via GM_xmlhttpRequest
  //  EventSource (SSE) is blocked by Torn's Content Security Policy.
  //  We poll the full faction node every 3s instead. GM_xmlhttpRequest
  //  bypasses CSP, so this works reliably from a userscript.
  //  On each poll we compare the received data to local state and apply
  //  any changes, giving us near-real-time sync without SSE.
  // ══════════════════════════════════════════════════════════════════════════
  let ssePollInterval       = null;
  let lastPollEtag          = null;   // rough change detection
  let lastPollResponse      = null;   // skip applyPatch when response text unchanged
  let factionPollInterval   = null;   // handle for pollFactionChain interval
  let heartbeatInterval     = null;   // handle for fbHeartbeat interval
  let versionPollInterval   = null;   // handle for fbPollClientVersions interval
  let ownerCleanupInterval  = null;   // handle for fbCleanOwnLobbyEntries interval

  function clearAllIntervals() {
    if (factionPollInterval)  { clearInterval(factionPollInterval);  factionPollInterval  = null; }
    if (heartbeatInterval)    { clearInterval(heartbeatInterval);    heartbeatInterval    = null; }
    if (versionPollInterval)  { clearInterval(versionPollInterval);  versionPollInterval  = null; }
    if (ownerCleanupInterval) { clearInterval(ownerCleanupInterval); ownerCleanupInterval = null; }
    if (ssePollInterval)      { clearInterval(ssePollInterval);      ssePollInterval      = null; }
  }

  function fbStartMainListener() {
    if (!factionId || !fbConfigured()) return;
    if (ssePollInterval) { clearInterval(ssePollInterval); ssePollInterval = null; }

    // Immediate first fetch
    fbPollOnce();
    fbPollClientVersions();

    // Then every 3 seconds
    // Poll every 3s — halves network + parse load vs 1.5s with no noticeable UX difference
    ssePollInterval = setInterval(fbPollOnce, 3000);
    // Version poll is low-priority — run every 30s, offset by 2s to stagger with main poll
    setTimeout(() => { if (!versionPollInterval) versionPollInterval = setInterval(fbPollClientVersions, 30000); }, 2000);
  }

  let pollInFlight = false;
  function fbPollOnce() {
    if (!factionId || !fbConfigured()) return;
    if (pollInFlight) return;  // skip if previous poll hasn't returned yet
    pollInFlight = true;
    GM_xmlhttpRequest({
      method: "GET",
      url: P.root(),
      headers: { "Cache-Control": "no-cache" },
      timeout: 8000,
      onload(r) {
        pollInFlight = false;
        if (r.status >= 200 && r.status < 300) {
          try {
            // Skip full parse+render if response text is identical to last poll.
            // Firebase caches responses up to 30s server-side, so identical strings
            // are common between updates. This cuts CPU by ~60% during idle periods.
            if (r.responseText === lastPollResponse) {
              setSyncDot("live");
              return;
            }
            lastPollResponse = r.responseText;
            const data = JSON.parse(r.responseText);
            applyPatch("/", data);
            setSyncDot("live");
            showBanner("chain-banner-debug", false);
          } catch(e) {
            console.warn("[ChainCoord] Poll parse error", e);
          }
        } else {
          setSyncDot("error");
          if (r.status === 401 || r.status === 403) {
            // Could be expired token or whitelist denial.
            // Try refreshing the token first — if that fixes it, it was expiry not whitelist.
            if (fbRefreshToken) {
              fbRefreshIdToken();
              // Restart poll after a short delay to let the refresh complete
              if (ssePollInterval) { clearInterval(ssePollInterval); ssePollInterval = null; }
              setTimeout(() => { fbStartMainListener(); }, 3000);
            } else {
              // No refresh token — must be a genuine permission denial
              showBanner("chain-banner-locked", true);
              showBanner("chain-banner-debug", false);
              if (ssePollInterval) { clearInterval(ssePollInterval); ssePollInterval = null; }
            }
          } else {
            let msg = r.responseText;
            try { msg = JSON.parse(r.responseText).error || msg; } catch { /**/ }
            showBanner("chain-banner-debug", true, "❌ Poll failed "+r.status+": "+msg);
            console.warn("[ChainCoord] Poll failed", r.status, r.responseText);
          }
        }
      },
      onerror()  { pollInFlight=false; setSyncDot("error"); showBanner("chain-banner-debug", true, "❌ Poll network error — check @connect firebaseio.com"); },
      ontimeout(){ pollInFlight=false; setSyncDot("error"); },
    });
  }

    // Route a Firebase patch to the right handler
  function applyPatch(path, data) {
    if (path === "/hits") {
      // Only clear+replace if Firebase gave us actual hit data.
      // A null /hits means the node was deleted (chain cleared) — that's intentional.
      // But never wipe local state if data is undefined/missing (transient Firebase state).
      if (data === null) {
        hitMap.clear();  // deliberate clear from Firebase
        _deletedHitIds.clear();  // all hits gone — no need to guard deletions any more
      } else if (data && typeof data === "object") {
        // Merge: keep any local pending hits that Firebase doesn't know about yet.
        // These are hits written by fbWriteHit whose PUT hasn't been committed before
        // this poll fired — a race that wipes the queue if we blind-clear here.
        const localPendingNotInFb = [...hitMap.entries()].filter(
          ([id, h]) => h.status !== "done" && !(id in data)
        );
        hitMap.clear();
        Object.entries(data).forEach(([id, h]) => {
          // BUG FIX: Never re-insert a hit that was locally deleted — skip until
          // Firebase confirms the DELETE by omitting the node from future responses.
          // BUG FIX: Skip "zombie" entries that only have a hitNumber and no status/targetName —
          // these are leftover partial nodes after fbClearHits() wipes the /hits node but
          // Firebase retains child keys that were written individually (e.g. hitNumber fields).
          if (h && !_deletedHitIds.has(id) && h.status && h.targetName) {
            h._fbCommitted = true;
            hitMap.set(id, h);
          } else if (h && !h.status && !h.targetName && !_deletedHitIds.has(id)) {
            // Zombie node: only has hitNumber (or similar partial data), no status/targetName.
            // This was created by a stale field-level hitNumber PUT after the /hits node
            // was wiped. Delete it from Firebase so it stops reappearing on every poll.
            _deletedHitIds.add(id);
            fbDelete(P.hit(id));
          }
        });
        // Re-inject local-only pending hits so they survive until Firebase confirms,
        // but never re-inject hits that are pending deletion.
        for (const [id, h] of localPendingNotInFb) {
          if (!_deletedHitIds.has(id)) hitMap.set(id, h);
        }
        // Prune _deletedHitIds for entries that Firebase has already removed
        // (they're no longer in the server payload, so the guard is no longer needed).
        _deletedHitIds.forEach(id => { if (!(id in data)) _deletedHitIds.delete(id); });
      }
      // If data is undefined or any other falsy — leave hitMap alone
      reNumberPending();
      setSyncDot("live");
      scheduleRender();
      return;
    }

    const hitMatch = path.match(/^\/hits\/([^/]+)$/);
    if (hitMatch) {
      const id = hitMatch[1];
      if (data === null) {
        hitMap.delete(id);
        _deletedHitIds.delete(id);  // Firebase confirmed the delete — release the guard
      } else if (!_deletedHitIds.has(id)) {
        // BUG FIX: Don't re-insert a hit that's pending local deletion
        if (data && data.status && data.targetName) {
          data._fbCommitted = true;
          hitMap.set(id, data);
        }
      }
      reNumberPending();
      setSyncDot("live");
      scheduleRender();
      return;
    }

    // FIX #1: handle sub-field updates — e.g. /hits/{id}/status or /hits/{id}/hitNumber
    const hitFieldMatch = path.match(/^\/hits\/([^/]+)\/(.+)$/);
    if (hitFieldMatch) {
      const [,id,field] = hitFieldMatch;
      if (hitMap.has(id)) {
        // Support nested field paths like "foo/bar" if they ever appear
        const parts = field.split("/");
        let obj = hitMap.get(id);
        for (let i = 0; i < parts.length - 1; i++) {
          if (obj[parts[i]] === undefined) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = data;
        reNumberPending();
        setSyncDot("live");
        scheduleRender();
      } else if (data !== null) {
        // Hit doesn't exist locally yet — fetch the full hit node
        fbGet(P.hit(id), hit => {
          if (hit) {
            hitMap.set(id, hit);
            reNumberPending();
            scheduleRender();
          }
        });
      }
      return;
    }

    if (path === "/session") {
      handleRemoteSession(data);
      return;
    }

    if (path === "/permissions") {
      permissions = (data && typeof data === "object") ? data : {};
      updateClearBtn();
      return;
    }

    const permMatch = path.match(/^\/permissions\/([^/]+)$/);
    if (permMatch) {
      const uid = permMatch[1];
      if (data === null || data === false) delete permissions[uid];
      else permissions[uid] = true;
      updateClearBtn();
      return;
    }

    if (path === "/members") {
      presenceMap.clear();
      if (data && typeof data === "object") {
        Object.entries(data).forEach(([uid, m]) => { if(m) presenceMap.set(uid, m); });
      }
      recomputeNetworkLatestVersion();
      updateOnlineCount();
      return;
    }

    const memberMatch = path.match(/^\/members\/([^/]+)$/);
    if (memberMatch) {
      const uid = memberMatch[1];
      if (data === null) presenceMap.delete(uid);
      else presenceMap.set(uid, data);
      recomputeNetworkLatestVersion();
      updateOnlineCount();
      return;
    }

    const heartbeatMatch = path.match(/^\/members\/([^/]+)\/lastSeen$/);
    if (heartbeatMatch) {
      const uid = heartbeatMatch[1];
      if (presenceMap.has(uid)) presenceMap.get(uid).lastSeen = data;
      else presenceMap.set(uid, { lastSeen: data });
      updateOnlineCount();
      return;
    }

    // Lobby presence updates — filter by factionId to only show faction-mates
    if (path === "/lobby" || path.startsWith("/lobby/")) {
      fbSyncLobbyPresence();
      return;
    }

    // Root full load
    if (path === "/") {
      if (data && typeof data === "object") {
        const keys = Object.keys(data).join(",") || "(empty)";
        showBanner("chain-banner-debug", true, "✓ SSE root received. keys="+keys);
        setTimeout(()=>showBanner("chain-banner-debug",false), 6000);
        // Only replace hitMap if Firebase actually sent hits data.
        // If the hits key is absent from the root response, leave local state alone —
        // it means Firebase returned a partial/transient snapshot, not a deliberate clear.
        if ("hits" in data) {
          if (data.hits && typeof data.hits === "object") {
            // Merge: preserve local pending hits not yet committed to Firebase.
            // A poll can arrive before our fbPut response, wiping hits we just wrote.
            const localPendingNotInFb = [...hitMap.entries()].filter(
              ([id, h]) => h.status !== "done" && !(id in data.hits)
            );
            hitMap.clear();
            Object.entries(data.hits).forEach(([id,h]) => { if(h && h.status && h.targetName) { h._fbCommitted = true; hitMap.set(id,h); } });
            for (const [id, h] of localPendingNotInFb) hitMap.set(id, h);
          } else if (data.hits === null) {
            hitMap.clear();  // deliberate clear
          }
          // Rebuild scrapedHitIds to match Firebase state
          scrapedHitIds.clear();
          for (const h of hitMap.values()) {
            if (h.status === "done" && h.chainHitNum && chainSessionId) {
              scrapedHitIds.add((chainSessionId||"nosession") + "_hit_" + h.chainHitNum);
            }
          }
        }
        if (data.session) handleRemoteSession(data.session);
        permissions = (data.permissions && typeof data.permissions==="object") ? data.permissions : {};
        presenceMap.clear();
        if (data.members && typeof data.members==="object") {
          Object.entries(data.members).forEach(([uid,m]) => { if(m) presenceMap.set(uid,m); });
        }
        // Also populate presence from lobby (lobby is the authoritative presence source)
        fbSyncLobbyPresence();
        recomputeNetworkLatestVersion();
        updateOnlineCount();
        reNumberPending();
        updateClearBtn();
        setSyncDot("live");
        scheduleRender();
      } else {
        showBanner("chain-banner-debug", true, "⚠ SSE root: data was null/empty — rules may be blocking read");
        setTimeout(()=>showBanner("chain-banner-debug",false), 8000);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Hit write operations
  // ══════════════════════════════════════════════════════════════════════════

  function fbWriteHit(hit) {
    // Mark as committed optimistically so reNumberPending() may field-write hitNumber
    // on subsequent renumbers (e.g. when another hit is removed from the queue).
    hit._fbCommitted = true;
    fbPut(P.hit(hit.id), hit);
    hitMap.set(hit.id, hit);
    reNumberPending();
    scheduleRender();
  }

  // FIX #1: kept for targeted single-field writes (hitNumber sync), but
  // the scraper now uses fbUpdateHit (full node) for reliability.
  function fbUpdateHitField(hitId, field, value) {
    fbPut(P.hitField(hitId, field), value);
    if (hitMap.has(hitId)) {
      hitMap.get(hitId)[field] = value;
      reNumberPending();
      scheduleRender();
    }
  }

  // FIX #1: full node PUT — most reliable for cross-client sync
  function fbUpdateHit(hitId, updates) {
    if (!hitMap.has(hitId)) return;
    const hit = { ...hitMap.get(hitId), ...updates };
    fbPut(P.hit(hitId), hit);
    hitMap.set(hitId, hit);
    reNumberPending();
    scheduleRender();
  }

  function fbClearHits() {
    fbDelete(P.hits());
    hitMap.clear();
    scheduleRender();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Session management
  // ══════════════════════════════════════════════════════════════════════════
  function onChainStart(startMs) {
    chainStartTime = startMs || Date.now();
    chainSessionId = `s_${chainStartTime}_${Math.random().toString(36).slice(2,7)}`;
    fbPut(P.session(), { id: chainSessionId, startTime: chainStartTime });
    persistSession();
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
    sessionMinHitNum  = null;
    scrapedHitIds.clear();
    apiTimerSecs      = null;
    apiTimerReadAt    = null;
    if (chainCountObserver) { chainCountObserver.disconnect(); chainCountObserver = null; }
    hitMap.clear();
    fbClearHits();
    fbDelete(P.session());
    persistSession();
    scheduleRender();
    updateChainTimerUI();
  }

  function handleRemoteSession(data) {
    if (!data) {
      if (chainSessionId) {
        chainSessionId = null; chainStartTime = null; chainConfirmed = false;
        chainHit1Time = null; sessionMinHitNum = null; scrapedHitIds.clear();
        // Don't wipe hitMap here — Firebase /hits may still have data.
        // The poll will reconcile hits on the next cycle.
        // Only wipe if the /hits node also comes back null (handled in applyPatch).
        persistSession();
        scheduleRender();
      }
    } else if (data.id && data.id !== chainSessionId) {
      // Only accept a remote session if its startTime is recent (within 2 hours).
      // Stale Firebase sessions from previous chains must not set chainStartTime
      // to a time in the past, which would allow old DOM hits to pass the filter.
      const remoteStart = data.startTime || 0;
      const ageMs = Date.now() - remoteStart;
      if (ageMs > 2 * 60 * 60 * 1000) {
        // Session is older than 2 hours — stale, ignore it
        console.warn("[ChainCoord] Ignoring stale remote session, age:", Math.round(ageMs/60000), "min");
        return;
      }
      chainSessionId   = data.id;
      chainStartTime   = remoteStart || Date.now();
      sessionMinHitNum = null;
      scrapedHitIds.clear();  // clear dedup so scraper re-evaluates with correct start time
      persistSession();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain timer — MutationObserver + fallback retry loop
  // ══════════════════════════════════════════════════════════════════════════
  function parseTimerText(txt) {
    const m = (txt||"").match(/(\d+):(\d+)(?::(\d+))?/);
    if (!m) return null;
    return m[3]!==undefined
      ? parseInt(m[1])*3600+parseInt(m[2])*60+parseInt(m[3])
      : parseInt(m[1])*60+parseInt(m[2]);
  }

  // ── Top-bar chain count observer (all pages) ─────────────────────────────
  // bar-value inside chain-bar always shows "N / 10" or "N / 50" etc.
  // We watch it with a MutationObserver so count increments are caught
  // instantly from the DOM on every page, not just after the next API poll.

  function parseChainCountText(txt) {
    // Matches "1 / 10", "25 / 50", etc. Returns current hit count or null.
    const m = (txt || "").match(/(\d+)\s*\/\s*\d+/);
    return m ? parseInt(m[1]) : null;
  }

  function findChainCountEl() {
    // chain-bar is the <a> wrapper; bar-value is the text node inside it.
    const bar = document.querySelector('[class*="chain-bar"]');
    if (!bar) return null;
    const val = bar.querySelector('[class*="bar-value"]');
    if (val && parseChainCountText(val.textContent) !== null) return val;
    return null;
  }

  let chainCountObserver = null;

  function onDomChainCountUpdate(newCount) {
    if (newCount === null || newCount === liveChainCount) return;
    const prev = liveChainCount;
    liveChainCount = newCount > 0 ? newCount : null;
    persistSession();
    if (liveChainCount !== null && liveChainCount >= CHAIN_CONFIRM_HITS) chainConfirmed = true;
    if (prev !== null && liveChainCount !== null && liveChainCount > prev) {
      reNumberPending();
      scheduleRender();
    }
    updateChainTimerUI();
  }

  function startChainCountObserver() {
    if (chainCountObserver) return;  // already watching
    const el = findChainCountEl();
    if (!el) return;
    onDomChainCountUpdate(parseChainCountText(el.textContent));
    chainCountObserver = new MutationObserver(() => {
      const count = parseChainCountText(el.textContent);
      if (count === null) {
        chainCountObserver.disconnect(); chainCountObserver = null;
      } else {
        onDomChainCountUpdate(count);
      }
    });
    chainCountObserver.observe(el, { characterData: true, childList: true, subtree: true });
  }

  // ── Chain bar timer element bootstrap ────────────────────────────────────
  // Desktop Torn uses React keepMounted — bar-timeleft is always in the DOM,
  // only its opacity is toggled on hover, so we can attach directly with no
  // visual side-effect.
  //
  // Mobile Torn (Firefox / Chrome) conditionally renders the tooltip only on
  // tap/hover — the element is genuinely absent until an interaction occurs.
  // For those cases we dispatch a synthetic pointerenter to force the render,
  // but suppress the visual flash by briefly setting the tooltip container to
  // visibility:hidden for the duration of the attach-and-dismiss cycle.
  function scheduleTooltipTrigger() {
    let attempts = 0;
    let cancelled = false;
    const tryAttach = () => {
      if (cancelled) return;                    // a later retry was queued but we're done
      if (chainTimerObserver) return;           // observer already running — done
      if (startChainTimerObserver()) return;    // element in DOM — attached cleanly

      // Element not in DOM yet. Try to force-render it via synthetic hover,
      // suppressing any visual flash with a temporary visibility override.
      const chainBar = document.querySelector('[class*="chain-bar"]');
      if (chainBar) {
        // The tooltip popup doesn't exist before the hover fires, so we can't
        // hide it in advance. Instead, use a MutationObserver to catch it the
        // instant it's added to the DOM and hide it immediately — before the
        // browser has a chance to paint it. The chain bar itself is never
        // touched so user interaction with it remains fully functional.
        const hiddenPortals = new Set();
        const hideNode = n => {
          n.style.setProperty('visibility', 'hidden', 'important');
          hiddenPortals.add(n);
          // Also watch this specific node for attribute/style mutations — React
          // re-renders can reset inline styles, causing a flicker. Re-apply
          // visibility:hidden immediately whenever that happens.
          nodeWatcher.observe(n, { attributes: true, attributeFilter: ['style', 'class'] });
        };
        const isTooltipNode = n =>
          n instanceof Element && (
            n.matches('[class*="tooltip"],[class*="floating"],[data-floating-ui-portal],[class*="popup"],[class*="Popup"],[class*="Tooltip"]')
            || n.querySelector('[class*="bar-timeleft"],[class*="chainTimer"]')
          );
        // Watches already-hidden nodes and re-hides them if React resets their style.
        const nodeWatcher = new MutationObserver(mutations => {
          for (const m of mutations) {
            if (m.type === 'attributes' && hiddenPortals.has(m.target)) {
              m.target.style.setProperty('visibility', 'hidden', 'important');
            }
          }
        });

        // FIX (4.9.8): Replace portalWatcher document.body subtree:true MutationObserver
        // with a lightweight poll. The subtree observer fired on EVERY DOM mutation
        // site-wide (including Torn's ~10s attack-log rerenders), compounding the freeze.
        // Polling at 50ms is far cheaper — the browser only runs it between frames and
        // there are at most ~20 ticks during the 1s attach window (same as before).
        // We scan only direct children of body for new portal nodes, which is O(1)
        // compared to the O(subtree) traversal the MutationObserver implied.
        let _lastPortalChildCount = document.body.children.length;
        const portalWatcher = setInterval(() => {
          const currentCount = document.body.children.length;
          if (currentCount !== _lastPortalChildCount) {
            _lastPortalChildCount = currentCount;
            // A child was added/removed — check the newest children for tooltip portals.
            for (const child of document.body.children) {
              if (!hiddenPortals.has(child) && isTooltipNode(child)) hideNode(child);
            }
          }
          // Re-hide tracked portals in case React reset their visibility.
          hiddenPortals.forEach(n => {
            if (n.isConnected) n.style.setProperty('visibility', 'hidden', 'important');
          });
        }, 50);

        chainBar.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, cancelable: true }));
        chainBar.dispatchEvent(new MouseEvent('mouseenter',    { bubbles: true, cancelable: true }));

        // Dismiss the synthetic hover, but keep watchers alive through the
        // pointerleave re-render cycle — Torn may remove/re-add the tooltip
        // node during dismiss, which would flash visible if we'd already
        // disconnected. Restore visibility only after a short settle delay.
        const dismissAndRestore = () => {
          chainBar.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, cancelable: true }));
          chainBar.dispatchEvent(new MouseEvent('mouseleave',    { bubbles: true, cancelable: true }));
          // Keep suppressing for 300ms after pointerleave to cover the re-render.
          setTimeout(() => {
            clearInterval(portalWatcher);
            nodeWatcher.disconnect();
            hiddenPortals.forEach(n => n.style.removeProperty('visibility'));
            hiddenPortals.clear();
          }, 300);
        };

        let polls = 0;
        const findAndAttach = setInterval(() => {
          polls++;
          if (startChainTimerObserver()) {
            // Observer attached — dismiss and allow tooltip to restore after settle.
            clearInterval(findAndAttach);
            cancelled = true;
            dismissAndRestore();
          } else if (polls >= 20) {
            // 1s elapsed, element never appeared — give up this attempt.
            clearInterval(findAndAttach);
            cancelled = true;
            dismissAndRestore();
          }
        }, 50);
      }

      if (++attempts < 5) setTimeout(tryAttach, 500);
      // If the observer gets set by something else while we're waiting (e.g. Torn
      // re-renders the chain bar on Firebase connect), cancel the next retry so we
      // don't fire a synthetic hover on a page that already has the element.
      if (chainTimerObserver) cancelled = true;
    };
    tryAttach();
  }

  // FIX (4.9.8): Cache the last-found timer element so the expensive querySelectorAll("*")
  // fallback in findChainTimerEl is only reached when the cached reference is stale.
  // Once found, subsequent calls hit the fast-path document.contains() check and return
  // immediately — no DOM scan needed during Torn's ~10s attack-log rerenders.
  let _cachedTimerEl = null;

  function findChainTimerEl() {
    // Fast path: return cached element if it's still in the DOM and still readable.
    if (_cachedTimerEl && document.contains(_cachedTimerEl) && parseTimerText(_cachedTimerEl.textContent) !== null) {
      return _cachedTimerEl;
    }
    _cachedTimerEl = null;  // stale — clear and re-scan

    const sels = [
      // Top-bar tooltip timer — present on ALL Torn pages (mobile and desktop).
      // The tooltip div is always in the DOM; only its opacity is toggled on hover.
      // class suffix is CSS-module-hashed so we match on the stable prefix only.
      '[class*="bar-timeleft"]',
      '[class*="chainTimer"] [class*="counter"]',
      '[class*="chain-timer"]',
      '[class*="chainInfo"] [class*="timer"]',
      '[class*="chain"] [class*="time"]:not(#chain-panel *)',
    ];
    for (const sel of sels) {
      try { const el=document.querySelector(sel); if(el&&parseTimerText(el.textContent)!==null) { _cachedTimerEl = el; return el; } } catch {/**/ }
    }
    // Expensive fallback: walk every child of the chain widget looking for a
    // leaf node whose text parses as a timer. Guard with a chain-widget presence
    // check first — if the chain bar itself isn't in the DOM (e.g. user is not
    // in a chain, or Torn is mid-DOM-replacement) we bail immediately rather than
    // scanning hundreds of nodes on every watcher callback invocation.
    const cw = document.querySelector('[class*="chain-bar"]:not(#chain-panel *)')
             || document.querySelector('[class*="chain"]:not(#chain-panel *)');
    if (!cw) return null;
    for (const el of cw.querySelectorAll("*")) {
      if (el.children.length > 0) continue;
      if (parseTimerText(el.textContent) !== null) { _cachedTimerEl = el; return el; }
    }
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
      // Keep the API fallback timer calibrated to the DOM reading.
      // If we later lose the observer (navigation) the fallback will start
      // from the last known-good DOM value rather than a stale API value.
      apiTimerSecs   = liveChainSecs;
      apiTimerReadAt = lastTimerReadAt;
    }
    updateChainTimerUI();
  }

  // FIX #2: startChainTimerObserver — also clears the fallback retry interval
  // once a timer element is found.
  function startChainTimerObserver() {
    if (chainTimerObserver) { chainTimerObserver.disconnect(); chainTimerObserver = null; }
    _cachedTimerEl = null;  // FIX (4.9.8): invalidate cache so findChainTimerEl re-scans fresh
    const timerEl = findChainTimerEl();
    if (!timerEl) return false;  // return false so caller knows we failed

    // Found it — cancel the fallback retry interval
    if (timerRetryInterval) { clearInterval(timerRetryInterval); timerRetryInterval = null; }

    onDomTimerUpdate(parseTimerText(timerEl.textContent));
    chainTimerObserver = new MutationObserver(() => {
      const secs = parseTimerText(timerEl.textContent);
      if (secs === null) {
        onDomTimerUpdate(null);
        chainTimerObserver.disconnect(); chainTimerObserver = null;
        _cachedTimerEl = null;  // FIX (4.9.8): element left DOM — clear cache so next scan is fresh
        // FIX #2: restart fallback retry when observer loses the element
        startTimerRetryLoop();
      } else { onDomTimerUpdate(secs); }
    });
    chainTimerObserver.observe(timerEl, { characterData:true, childList:true, subtree:true });
    return true;
  }

  // FIX #2: independent 2s retry loop — works even without a MutationObserver trigger
  function startTimerRetryLoop() {
    if (timerRetryInterval) return;  // already running
    timerRetryInterval = setInterval(() => {
      if (chainTimerObserver) { clearInterval(timerRetryInterval); timerRetryInterval = null; return; }
      startChainTimerObserver();
    }, 2000);
  }

  // Observe the Torn content area (not body) for chain timer element appearance.
  // The retry loop (startTimerRetryLoop) handles the case where the element isn't
  // present yet — the observer here is just a fast-path trigger when it appears.
  // Skip on TornPDA — WebView DOM layout differs and causes freezes on faction page.
  // FIX: The original observer was immortal with subtree:true, firing hundreds of
  // times during Torn's ~10s attack-log DOM replacement and freezing the event loop.
  // Now it disconnects itself once both observers are live, and a 5s interval
  // re-arms it only if an observer dies (element leaves DOM).
  if (!isTornPDA) {
    (function setupTimerObserver() {
      const tornRoot = document.getElementById("mainContainer")
        || document.getElementById("torn-app")
        || document.querySelector('[class*="mainContainer"]')
        || document.body;

      let watcherObs = null;

      function startWatcher() {
        if (watcherObs) return;
        // Debounce: Torn's attack-log replaces large DOM chunks every ~10 s,
        // firing hundreds of rapid mutations. Without debouncing, each one
        // synchronously invokes findChainTimerEl (expensive scan) and freezes
        // the event loop for the duration of the burst.
        // We collapse the entire burst into a single deferred scan using a
        // 150 ms trailing debounce — any re-appearance of the timer element
        // will be caught well within the next poll cycle.
        let _watcherDebounceTimer = null;
        watcherObs = new MutationObserver(() => {
          if (_watcherDebounceTimer) return;  // burst already in flight
          _watcherDebounceTimer = setTimeout(() => {
            _watcherDebounceTimer = null;
            // Re-check: another path (retry loop, tooltip trigger) may have
            // already reconnected both observers during the debounce window.
            const timerDead = !chainTimerObserver;
            const countDead = !chainCountObserver;
            if (timerDead) startChainTimerObserver();
            if (countDead) startChainCountObserver();
            // Both observers are live — disconnect until one dies.
            if (!chainTimerObserver && !chainCountObserver) {
              // Neither came back (elements genuinely absent) — keep watching.
              return;
            }
            if (chainTimerObserver && chainCountObserver) {
              watcherObs.disconnect();
              watcherObs = null;
            }
            // One came back, one didn't — stay connected to catch the other.
          }, 150);
        });
        watcherObs.observe(tornRoot, { childList: true, subtree: true });
      }

      // Boot: try to attach both immediately; only start DOM watcher if either is missing.
      startChainTimerObserver();
      startChainCountObserver();
      if (!chainTimerObserver || !chainCountObserver) startWatcher();

      // Re-arm watcher at 5s cadence if either observer has died (element left DOM).
      // Runs far less often than every mutation — negligible overhead.
      setInterval(() => {
        if (!chainCountObserver || !chainTimerObserver) startWatcher();
      }, 5000);
    })();

    // Start retry loop for timer immediately on boot
    startTimerRetryLoop();
    // Trigger chain bar tooltip render so bar-timeleft enters the DOM without user tap
    scheduleTooltipTrigger();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain API poll — count + session detection
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
    const newCooldown = chain.cooldown || 0;

    // ── Cooldown detection ──────────────────────────────────────────────────
    // cooldown is non-zero when a confirmed chain (≥10 hits) has ended and is
    // in its cooldown window. We show the icy blue banner during this period.
    if (newCooldown > 0) {
      chainCooldownSecs   = newCooldown;
      chainCooldownReadAt = performance.now();
    } else if (chainCooldownSecs !== null && newCooldown === 0) {
      // Cooldown just finished
      chainCooldownSecs   = null;
      chainCooldownReadAt = null;
    }

    // ── API timer capture — used as fallback when DOM observer unavailable ──
    if (newTimeout > 0) {
      apiTimerSecs   = newTimeout;
      apiTimerReadAt = performance.now();
    } else if (newTimeout === 0 && newCount === 0) {
      // Chain ended — clear API timer too
      apiTimerSecs   = null;
      apiTimerReadAt = null;
    }

    if (newTimeout === 0 && chainSessionId) {
      if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
      onChainEnd(); return;
    }

    liveChainCount = newCount > 0 ? newCount : null;
    persistSession();  // FIX #2: keep count in GM storage

    if (liveChainCount !== null && liveChainCount >= CHAIN_CONFIRM_HITS) chainConfirmed = true;

    if (liveChainCount !== null && lastKnownCount !== null && liveChainCount > lastKnownCount) {
      reNumberPending();
      scheduleRender();
    }
    lastKnownCount = liveChainCount;

    const chainNowActive = newCount > 0 && newTimeout > 0;
    if (chainNowActive) {
      if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
      // Infer start time: if API provides chain.start use it; otherwise
      // estimate from timeout (chain resets at 5 min = 300s, so
      // start ≈ now - (300 - timeout) seconds).
      const apiStartMs = chainStart > 0
        ? chainStart * 1000
        : (newTimeout > 0 ? Date.now() - (300 - newTimeout) * 1000 : null);

      if (!chainSessionId) {
        onChainStart(apiStartMs || Date.now());
      } else if (apiStartMs && chainStartTime && Math.abs(apiStartMs - chainStartTime) > 3000) {
        // API start time differs from our local start by more than 3s — new chain
        onChainEnd();
        setTimeout(() => onChainStart(apiStartMs), 500);
        return;
      }
      // FIX #2: try to find the timer element if we don't have it yet
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
    const pillCount = document.getElementById("chain-pill-count");
    // UI display uses DOM observer only — API timer is too imprecise (1–30s off)
    const hasDomTimer = liveChainSecs !== null && lastTimerReadAt !== null;

    // Determine if cooldown is active before deciding pill state
    const isCoolingDown = chainCooldownSecs !== null && chainCooldownReadAt !== null &&
      Math.max(0, Math.round(chainCooldownSecs - (performance.now() - chainCooldownReadAt) / 1000)) > 0;

    if (!hasDomTimer) {
      chainTimerVal.textContent="—"; chainTimerVal.className="ct-none";
      chainCountBadge.className="none"; warmingMsg.style.display="none";
      if (isCoolingDown) {
        pillTimer.textContent="Cooling down"; pillTimer.className="ct-cool";
      } else {
        pillTimer.textContent="No Chain"; pillTimer.className="ct-none";
      }
      if (pillCount) pillCount.textContent = "";
    } else {
      const ms   = chainTimerMs();
      const disp = Math.max(0, Math.round(ms / 1000));
      const txt  = `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}`;
      chainTimerVal.textContent = txt; pillTimer.textContent = txt;
      const cls = disp<=settDangerThreshold?"ct-danger":disp<=settWarnThreshold?"ct-warn":"ct-ok";
      chainTimerVal.className=cls; pillTimer.className=cls;
    }
    if (count!==null) {
      chainCountBadge.textContent=count;
      chainCountBadge.className = chainConfirmed?"running":"warming";
      warmingMsg.style.display  = chainConfirmed?"none":"";
      // Update pill count — show N+1 (the next hit number needed)
      if (pillCount) {
        pillCount.textContent = count + 1;
        pillCount.style.color = chainConfirmed ? "#44ff88" : "#ffaa44";
      }
    } else {
      chainCountBadge.className="none"; warmingMsg.style.display="none";
      if (pillCount) pillCount.textContent = "";
    }

    // ── Cooldown banner ────────────────────────────────────────────────────
    if (chainCooldownSecs !== null && chainCooldownReadAt !== null) {
      const elapsed = (performance.now() - chainCooldownReadAt) / 1000;
      const remaining = Math.max(0, Math.round(chainCooldownSecs - elapsed));
      if (remaining > 0) {
        const mm = Math.floor(remaining / 60);
        const ss = String(remaining % 60).padStart(2, "0");
        if (cooldownTimer) cooldownTimer.textContent = `${mm}:${ss}`;
        coolingMsg.style.display = "";
      } else {
        // Cooldown expired locally — hide until next API poll confirms
        coolingMsg.style.display = "none";
      }
    } else {
      coolingMsg.style.display = "none";
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Recent attacks scraper
  // ══════════════════════════════════════════════════════════════════════════
  let _scraperContainer = null;   // cached container element
  let _scraperRows      = [];     // cached row list
  let _scraperRowCount  = 0;      // last known row count — re-scan only when it changes
  let _lastScrapeAt     = 0;      // timestamp of last scrapeRecentAttacks call (throttle)

  function scrapeRecentAttacks() {
    if (!chainStartTime) return;

    // Re-find container only if we don't have one (or it left the DOM)
    if (!_scraperContainer || !document.contains(_scraperContainer)) {
      _scraperContainer = null; _scraperRows = []; _scraperRowCount = 0;
      const containerSels = ['[class*="recentAttacks"]','[class*="recent-attacks"]','[class*="attackLog"]','[class*="attack-log"]'];
      for (const sel of containerSels) { try { _scraperContainer=document.querySelector(sel); if(_scraperContainer)break; } catch {/**/ } }
      if (!_scraperContainer) return;
    }

    // Re-scan rows only when count changes (new hit appeared)
    const currentCount = _scraperContainer.children.length;
    if (currentCount !== _scraperRowCount) {
      _scraperRowCount = currentCount;
      const rowSels = ['[class*="attackLogRow"]','[class*="attack-log-row"]','[class*="log-row"]','li[class*="attack"]','li'];
      _scraperRows = [];
      for (const sel of rowSels) { try { _scraperRows=Array.from(_scraperContainer.querySelectorAll(sel)); if(_scraperRows.length)break; } catch {/**/ } }
    }
    if (!_scraperRows.length) return;

    const rows   = _scraperRows;
    const now      = Date.now();
    const apiCount = liveChainCount || 0;
    let earliestHitTime = chainHit1Time;

    // ── Step 1: parse all DOM rows ───────────────────────────────────────────
    const rawCandidates = [];
    for (const row of rows) {
      const chainNumEl = (() => {
        // TreeWalker visits only text nodes — avoids querySelectorAll("*") element flood
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (/^#\d+$/.test(node.textContent.trim())) return node.parentElement;
        }
        return null;
      })();
      if (!chainNumEl) continue;
      const chainHitNum = parseInt(chainNumEl.textContent.trim().replace("#",""));
      if (isNaN(chainHitNum) || chainHitNum < 1) continue;
      if (apiCount > 0 && chainHitNum > apiCount) continue;  // strict: API count is the ceiling

      const profileLinks = row.querySelectorAll('a[href*="profiles.php?XID="]');
      if (profileLinks.length < 2) continue;
      const targetProfileA = profileLinks[profileLinks.length-1];
      const targetIdMatch  = (targetProfileA.href||"").match(/XID=(\d+)/i);
      if (!targetIdMatch) continue;

      // Parse Torn time display: "Xs", "Xm", "Xh"
      const sMatch = (row.textContent||"").match(/(\d+)\s*s\b/);
      const tMatch = (row.textContent||"").match(/(\d+)\s*m\b/);
      const hMatch = (row.textContent||"").match(/(\d+)\s*h\b/);
      let secsAgo = 0;
      if      (sMatch && !tMatch && !hMatch) secsAgo = parseInt(sMatch[1]);
      else if (tMatch && !hMatch)            secsAgo = parseInt(tMatch[1]) * 60;
      else if (hMatch)                       secsAgo = parseInt(hMatch[1]) * 3600 + (tMatch ? parseInt(tMatch[1]) * 60 : 0);
      const attackTime = now - secsAgo * 1000;

      // Pre-filter: more than 10 min before session start is definitely old
      if (attackTime < chainStartTime - 10 * 60000) continue;

      rawCandidates.push({
        chainHitNum, secsAgo, attackTime,
        targetId:    targetIdMatch[1],
        targetName:  (targetProfileA.textContent||"").trim() || "Player #" + targetIdMatch[1],
        attackerName:(profileLinks[0].textContent||"").trim() || "Unknown",
        attackUrl:   "https://www.torn.com/loader.php?sid=attack&user2ID=" + targetIdMatch[1],
      });
    }
    if (!rawCandidates.length) return;

    // ── Step 2: ONE hit per chain slot ───────────────────────────────────────
    // A chain can only have ONE hit at position #N. The DOM may show two hits
    // with the same number from consecutive chains (e.g. old #3 and new #3).
    // Pick the MOST RECENT hit that is on or after chainStartTime.
    // If both are before chainStartTime, pick the one closest to it.
    const byHitNum = new Map();
    for (const c of rawCandidates) {
      const ex = byHitNum.get(c.chainHitNum);
      if (!ex) { byHitNum.set(c.chainHitNum, c); continue; }
      const cAfter = c.attackTime  >= chainStartTime;
      const eAfter = ex.attackTime >= chainStartTime;
      if      (cAfter && !eAfter)  byHitNum.set(c.chainHitNum, c);             // c is in session, ex isn't
      else if (cAfter &&  eAfter && c.secsAgo < ex.secsAgo) byHitNum.set(c.chainHitNum, c); // both in session, c is newer
      else if (!cAfter && !eAfter) {                                            // both before session
        if (Math.abs(c.attackTime - chainStartTime) < Math.abs(ex.attackTime - chainStartTime))
          byHitNum.set(c.chainHitNum, c);
      }
    }

    // ── Step 3: sorted candidate list, monotonic time filter ────────────────
    // In a real chain, hit numbers increase as time progresses:
    //   #1 (oldest) → #2 → #3 → #4 (most recent)
    // So attackTime must INCREASE as chainHitNum increases.
    // If hit #4 is older than hit #3, hit #4 is from a previous chain.
    //
    // Walk ascending by chainHitNum. Track the most recent attackTime seen.
    // Any hit whose attackTime is more than 120s older than the previous
    // valid hit is rejected (120s slack for Torn's minute rounding).
    const sorted = [...byHitNum.values()].sort((a,b) => a.chainHitNum - b.chainHitNum);
    const candidates = [];
    let prevAttackTime = 0;
    for (const c of sorted) {
      if (candidates.length === 0) {
        // First hit — accept unconditionally
        candidates.push(c);
        prevAttackTime = c.attackTime;
      } else if (c.attackTime >= prevAttackTime - 120000) {
        // This hit is newer than (or within 120s of) the previous — valid
        candidates.push(c);
        prevAttackTime = Math.max(prevAttackTime, c.attackTime);
      }
      // else: this hit is more than 120s older than the previous — old chain, skip
    }

    // ── Step 4: establish session anchor ─────────────────────────────────────
    // sessionMinHitNum = lowest hit in the consecutive run that ends at
    // liveChainCount. Hits below this belong to a previous chain.
    if (sessionMinHitNum === null) {
      const hitNums = new Set(candidates.map(c => c.chainHitNum));
      // Find highest hit that is confirmed to be in this session
      let top = 0;
      for (const c of candidates) {
        if (c.chainHitNum <= apiCount && c.attackTime >= chainStartTime) top = c.chainHitNum;
      }
      if (top === 0 && apiCount > 0) top = apiCount; // use API count if no post-start hit found
      if (top > 0) {
        let anchor = top;
        while (anchor > 1 && hitNums.has(anchor - 1)) anchor--;
        sessionMinHitNum = anchor;
      } else if (candidates.some(c => c.chainHitNum === 1 && c.attackTime >= chainStartTime)) {
        sessionMinHitNum = 1;
      }
      if (sessionMinHitNum !== null) persistSession();
    }
    if (sessionMinHitNum === null) return;

    // ── Step 5: process validated hits ───────────────────────────────────────
    for (const c of candidates) {
      if (c.chainHitNum < sessionMinHitNum) continue;

      const dedupKey = (chainSessionId||"nosession") + "_hit_" + c.chainHitNum;
      if (scrapedHitIds.has(dedupKey)) continue;
      scrapedHitIds.add(dedupKey);

      if (c.chainHitNum === 1 && (!earliestHitTime || c.attackTime < earliestHitTime))
        earliestHitTime = c.attackTime;
      if (c.chainHitNum >= CHAIN_CONFIRM_HITS && earliestHitTime !== null)
        if (c.attackTime - earliestHitTime <= 5*60000) chainConfirmed = true;

      // Skip entire slot if already marked done — prevents double-writes on repoll
      const slotDone = [...hitMap.values()].some(h =>
        h.status === "done" && (h.chainHitNum === c.chainHitNum || h.hitNumber === c.chainHitNum)
      );
      if (slotDone) continue;

      const matchedEntry = [...hitMap.entries()].find(([,h]) =>
        h.status==="pending" && String(h.targetId)===String(c.targetId)
      );
      // Also check for an "Unspecified" outside hit occupying this chain slot number,
      // BUT only if it was claimed by the same person who made the scraped hit.
      // An unspecified queued by Sypharius should only be consumed when Sypharius
      // makes the untracked hit — not when someone else fills the slot.
      const outsideEntry = !matchedEntry ? [...hitMap.entries()].find(([,h]) =>
        h.status==="pending" && (h.outside || !h.targetId) &&
        (h.chainHitNum === c.chainHitNum || h.hitNumber === c.chainHitNum) &&
        (!h.claimedBy || h.claimedBy === c.attackerName)
      ) : null;
      if (matchedEntry) {
        fbUpdateHit(matchedEntry[0], {
          status:"done", doneAt:c.attackTime,
          hitNumber:c.chainHitNum, chainHitNum:c.chainHitNum,
          claimedBy:c.attackerName, targetId:c.targetId, targetName:c.targetName,
        });
      } else if (outsideEntry) {
        // A real hit filled this slot — consume the Unspecified placeholder for that slot
        fbUpdateHit(outsideEntry[0], {
          status:"done", doneAt:c.attackTime,
          hitNumber:c.chainHitNum, chainHitNum:c.chainHitNum,
          claimedBy:c.attackerName, targetId:c.targetId, targetName:c.targetName,
        });
      } else {
        if (c.attackTime < chainStartTime - 90000) continue; // strict cutoff for untracked
        const untrackedId = "scraped_" + dedupKey;
        // Don't write untracked if any done hit already covers this chain slot
        const slotTaken = [...hitMap.values()].some(h =>
          h.status === "done" && (h.chainHitNum === c.chainHitNum || h.hitNumber === c.chainHitNum)
        );
        if (!slotTaken && !hitMap.has(untrackedId)) {
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
  //
  //  Architecture:
  //   - #chain-panel-inner: single scrollable container for all hits.
  //     The current hit (queue pos 0) gets the sticky-now class so it
  //     sticks to the top of the scroll area. Done hits show above pending.
  //   - Hosp flicker fix: innerHTML only rewritten when hit list changes.
  //     Timer/status cells are patched in the 1s tick.
  // ══════════════════════════════════════════════════════════════════════════

  // RAF-debounced render scheduler — collapses multiple synchronous renderPanel()
  // calls (e.g. from a Firebase root poll that touches hits + session + members)
  // into a single paint frame, eliminating redundant querySelector work.
  let _renderScheduled = false;
  function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => { _renderScheduled = false; renderPanel(); });
  }

  // Track last rendered hit ID list to avoid unnecessary full re-renders
  let lastRenderedIds = "";

  function hitRowHtml(hit, queuePos, now) {
    const hosp = isHospStillIn(hit);
    const isDone = hit.status === "done";
    let rc, tc, timerText;
    if (isDone) {
      rc = hit.untracked ? "untracked" : "done";
      tc = "done"; timerText = "Done";
    } else {
      const rem = pendingCountdownMs(queuePos);
      // Timer rules:
      //   Hits 1–9  (warmup):  always show NOW — all immediately actionable.
      //   Hit  10   (confirm): shows the live chain timer countdown.
      //   Hits 11+  (running): shows chain timer + N * 5 min offsets.
      // When no live chain timer exists, hits outside warmup range show "—"
      // (their scheduledAt timestamps are stale/past — rem=0 is misleading).
      const hitNum = hit.chainHitNum || hit.hitNumber;
      const hasLiveTimer = liveChainSecs !== null && lastTimerReadAt !== null;
      const currentHitNumForTimer = liveChainCount !== null ? liveChainCount + 1 : getHighestDoneHitNum() + 1;
      const isCurrentTarget = !isDone && hitNum === currentHitNumForTimer;
      const isWarmupSlot = hitNum < CHAIN_CONFIRM_HITS;   // slots 1-9: always NOW
      // Show NOW only for warmup slots or when the countdown has actually elapsed.
      // Non-warmup slots with no live timer get "—" instead of a misleading NOW.
      const showNow = isWarmupSlot || (hasLiveTimer && (rem <= 0 || isCurrentTarget));
      const showDash = !isWarmupSlot && !hasLiveTimer;
      timerText = showDash ? "—" : showNow ? "NOW" : formatTime(rem);
      tc = showDash ? "wait" : hitTimerClass(showNow ? 0 : rem);
      rc = showDash ? "waiting" : hitRowClass(showNow ? 0 : rem, hosp, hit.untracked);
    }
    const isBonus = settShowBonusAlert && BONUS_HITS.has(hit.chainHitNum || hit.hitNumber);
    // "Current" hit = the next hit the chain needs right now.
    // When chain is live: liveChainCount + 1 (e.g. chain at 13 → hit 14 is current).
    // Fallback: highest done + 1.
    const currentHitNum = liveChainCount !== null ? liveChainCount + 1 : getHighestDoneHitNum() + 1;
    const isNow = !isDone && (hit.chainHitNum || hit.hitNumber) === currentHitNum;
    const canRemoveHit = !isDone && (canClear || hit.claimedBy === ownName || !hit.claimedBy);
    const hospSub = (!isDone && hosp)
      ? `<span class="chain-hit-hosp-sub" data-hosp-id="${hit.id}">out in ${formatTime(hit.hospReleaseAt - now)}</span>`
      : "";
    const attackDisabled = isDone || !hit.attackUrl || hit.attackUrl === "#";
    const isOutside = (hit.outside || !hit.targetId) && !isDone;
    const isWarTarget = !hit.outside && hit.targetId && !isDone &&
      inRankedWar && warOpponentFactionIds.size > 0 &&
      hit.targetFactionId && hit.targetFactionId !== "0" &&
      warOpponentFactionIds.has(String(hit.targetFactionId));
    const outBadge = isWarTarget
      ? '<span style="font-size:9px;font-weight:700;color:#ff6666;background:rgba(255,60,60,.15);border:1px solid rgba(255,80,80,.35);border-radius:3px;padding:0 3px;margin-right:3px;line-height:14px;display:inline-block">War</span>'
      : isOutside
        ? '<span style="font-size:9px;font-weight:700;color:#88bbff;background:rgba(80,140,255,.13);border:1px solid rgba(100,180,255,.3);border-radius:3px;padding:0 3px;margin-right:3px;line-height:14px;display:inline-block">Out</span>'
        : "";
    const claimerPrefix = isDone ? "✓ " : "";
    const canReorder = isLeaderOrCoLeader && !isDone;
    const hitNum = hit.chainHitNum || hit.hitNumber;
    const numCell = canReorder
      ? `<input class="chain-hit-num-input" type="number" min="1" value="${hitNum}" data-reorder-id="${hit.id}" title="Tap to move to slot">`
      : `<span class="chain-hit-num">${hitNum}</span>`;
    return `<div class="chain-hit-row ${rc}${isBonus?" bonus":""}${isNow?" sticky-now":""}" data-hit-id="${hit.id}" data-queue-pos="${isDone ? -1 : queuePos}">
      ${numCell}
      <span class="chain-hit-claimer" title="${escHtml(hit.claimedBy)}">${claimerPrefix}${escHtml(hit.claimedBy)}</span>
      <span class="chain-hit-target" title="${escHtml(hit.targetName)}">${outBadge}${escHtml(hit.targetName)}</span>
      <span class="chain-hit-timer ${tc}" data-pos="${isDone ? -1 : queuePos}">${timerText}</span>
      <a class="chain-hit-attack" href="${escHtml(hit.attackUrl || "#")}" target="_blank"${attackDisabled ? ' style="opacity:.2;pointer-events:none"' : ""}>🗡</a>
      ${canRemoveHit ? `<button class="chain-hit-remove" data-remove-id="${hit.id}" title="Remove this hit">✕</button>` : "<span></span>"}
      ${hospSub}
    </div>`;
  }

  function wireRemoveButtons(container) {
    container.querySelectorAll(".chain-hit-remove").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        const hitId = btn.dataset.removeId;
        if (!hitId) return;
        const hit = hitMap.get(hitId);
        if (!hit) return;
        if (!confirm(`Remove ${hit.targetName} from the queue?`)) return;

        // BUG FIX: Register deletion BEFORE removing from hitMap so applyPatch
        // merges never re-inject this hit from Firebase before the DELETE lands.
        _deletedHitIds.add(hitId);
        _notifiedHitIds.delete(hitId);

        // Capture the deleted hit's scheduledAt so we can close the gap.
        const deletedScheduledAt = hit.scheduledAt;
        fbDelete(P.hit(hitId));
        hitMap.delete(hitId);

        // BUG FIX: Shift remaining pending hits' scheduledAt to close the gap
        // left by the removed hit so their displayed timers are correct immediately.
        const remaining = [...hitMap.values()]
          .filter(h => h.status !== "done")
          .sort((a, b) => a.scheduledAt - b.scheduledAt);
        remaining.forEach(h => {
          if (h.scheduledAt > deletedScheduledAt) {
            h.scheduledAt -= HIT_INTERVAL;
          }
        });

        reNumberPending();
        scheduleRender();
      });
    });
  }

  function wireReorderButtons(container) {
    container.querySelectorAll(".chain-hit-num-input").forEach(input => {
      const hitId = input.dataset.reorderId;

      // Select all text on focus so typing immediately replaces it
      input.addEventListener("focus", () => input.select());

      // Prevent the row drag/click from stealing focus
      input.addEventListener("mousedown", e => e.stopPropagation());
      input.addEventListener("touchstart", e => e.stopPropagation(), { passive: true });

      function commit() {
        const target = parseInt(input.value);
        if (isNaN(target) || target < 1) { scheduleRender(); return; }
        moveToSlot(hitId, target);
      }
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { scheduleRender(); }
      });
      input.addEventListener("blur", commit);
    });
  }

  function moveToSlot(hitId, targetSlot) {
    const pending = [...hitMap.values()]
      .filter(h => h.status !== "done")
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
    if (!pending.length) return;

    const fromIdx = pending.findIndex(h => h.id === hitId);
    if (fromIdx < 0) return;

    // Clamp target to valid range (1-based slot → 0-based index)
    const toIdx = Math.max(0, Math.min(pending.length - 1, targetSlot - 1));
    if (fromIdx === toIdx) { scheduleRender(); return; }

    // Splice the hit out and reinsert at the target position
    const [moved] = pending.splice(fromIdx, 1);
    pending.splice(toIdx, 0, moved);

    // Reassign scheduledAt in order: each entry gets the scheduledAt of its
    // new neighbour so relative spacing is preserved
    const times = pending.map(h => h.scheduledAt).sort((a, b) => a - b);
    // Re-sort times and assign them in new order
    pending.forEach((h, i) => {
      h.scheduledAt = times[i];
      fbPut(P.hitField(h.id, "scheduledAt"), h.scheduledAt);
    });

    reNumberPending();
    scheduleRender();
  }

  function renderPanel() {
    const inner   = document.getElementById("chain-panel-inner");
    const colHead = document.getElementById("chain-col-header");
    const titleEl = document.getElementById("chain-panel-title");
    if (!inner) return;

    if (titleEl) titleEl.textContent = factionName ? `⛓ ${factionName}` : "⛓ Chain Board";

    const pendingHits = getPendingHits();
    const doneHits    = settShowDoneHits ? getDoneHits() : [];

    // Only refresh 🎯 buttons when hit structure has changed (renderKey will differ)
    const allHitsForKey = [...doneHits, ...pendingHits];
    const renderKey = allHitsForKey.map(h => h.id + h.status + (h.chainHitNum||"")).join("|") + "|c" + (liveChainCount||0);
    if (renderKey !== lastRenderedIds) {
      // Build a lookup of pending targetId → hit once — O(hits) — rather than
      // calling [...hitMap.values()].find() inside the loop which is O(buttons × hits).
      const pendingByTargetId = new Map();
      for (const h of hitMap.values()) {
        if (h.status === "pending") pendingByTargetId.set(h.targetId, h);
      }
      injectRoot.querySelectorAll(".chain-target-btn").forEach(btn => {
        const profileA = btn.nextElementSibling;
        if (!profileA) return;
        const m = (profileA.href || "").match(/XID=(\d+)/i);
        if (!m) return;
        const queued = pendingByTargetId.get(m[1]);
        if (queued) { btn.textContent = "✓"; btn.classList.add("claimed"); btn.title = `${profileA.textContent.trim()} queued as hit #${queued.hitNumber}`; }
        else if (btn.classList.contains("claimed")) { btn.textContent = "🎯"; btn.classList.remove("claimed"); }
      });
    }

    // Badges
    pillBadge.textContent = pendingHits.length;
    pillBadge.classList.toggle("visible", pendingHits.length > 0);
    if (iconBadge) { iconBadge.textContent = pendingHits.length; iconBadge.classList.toggle("visible", pendingHits.length > 0); }
    if (pillNext) {
      // liveChainCount = hits already completed. The next hit needed = liveChainCount + 1.
      if (liveChainCount !== null) {
        // Chain count known — find the pending hit for the next slot
        const nextSlot = liveChainCount + 1;
        const nextUp = pendingHits.find(h => (h.chainHitNum || h.hitNumber) === nextSlot)
          || pendingHits[0];  // fallback to first pending if no exact slot match
        pillNext.textContent = nextUp ? nextUp.targetName : "Unclaimed";
        pillNext.style.color = nextUp ? "" : "#ff8888";
        pillNext.dataset.attackUrl = (nextUp && nextUp.attackUrl && nextUp.attackUrl !== "#") ? nextUp.attackUrl : "";
        if (pillSep) pillSep.style.display = "";
      } else if (pendingHits.length > 0) {
        // No chain count yet but we have queued hits — show first pending
        const nextUp = pendingHits[0];
        pillNext.textContent = nextUp.targetName;
        pillNext.style.color = "#aaa";
        pillNext.dataset.attackUrl = (nextUp.attackUrl && nextUp.attackUrl !== "#") ? nextUp.attackUrl : "";
        if (pillSep) pillSep.style.display = "";
      } else {
        // No chain data and no pending hits — nothing to show
        pillNext.textContent = "—";
        pillNext.style.color = "#445";
        pillNext.dataset.attackUrl = "";
        if (pillSep) pillSep.style.display = "none";
      }
    }

    // ── Single scrollable list: done history + all pending ───────────────────
    // Show content if we have hits OR if we have a known chain count (need placeholders)
    const hasDoneOrPending = doneHits.length > 0 || pendingHits.length > 0 || liveChainCount !== null;
    if (!hasDoneOrPending) {
      colHead.style.display = "none";
      inner.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.6">No hits queued.<br>Click 🎯 next to an attack button.</div>`;
      lastRenderedIds = renderKey;
      return;
    }

    colHead.style.display = "";

    // Only do full innerHTML rewrite when structure changes (avoids flicker).
    // Skip if a slot-number input is focused — rewriting would steal focus mid-edit.
    const reorderFocused = !!inner.querySelector(".chain-hit-num-input:focus");
    if (renderKey !== lastRenderedIds && !reorderFocused) {
      lastRenderedIds = renderKey;
      const now = Date.now();
      let html = "";

      // Done hits (history) + "Waiting for Data" placeholders for unrecorded past slots.
      // Build slot→hit lookup from the FULL hitMap (not display-filtered doneHits) so
      // placeholders are replaced correctly even when settShowDoneHits=false.
      const allDoneBySlot = new Map();
      for (const h of hitMap.values()) {
        if (h.status !== "done") continue;
        const slot = h.chainHitNum || h.hitNumber;
        if (!slot) continue;
        const ex = allDoneBySlot.get(slot);
        // Prefer user-queued over scraped untracked
        if (!ex || (ex.untracked && !h.untracked)) allDoneBySlot.set(slot, h);
      }
      // How far back do we fill? Up to liveChainCount (hits already done on the chain).
      const placeholderUpTo = liveChainCount !== null ? liveChainCount : 0;
      if (placeholderUpTo > 0) {
        for (let slot = 1; slot <= placeholderUpTo; slot++) {
          const doneHit = allDoneBySlot.get(slot);
          if (doneHit && settShowDoneHits) {
            html += hitRowHtml(doneHit, -1, now);
          } else if (doneHit) {
            // Done hit exists but "show done hits" is off.
            // Still render a minimal collapsed row so the slot stays visible and
            // does not leave a gap — without this, the "Waiting for Data" placeholder
            // is correctly suppressed (we have data) but the done row is also hidden,
            // making it look like the WFD was consumed by the poll cycle.
            html += `<div class="chain-hit-row done" style="opacity:.25" data-hit-id="${doneHit.id}" data-queue-pos="-1">` +
              `<span class="chain-hit-num">${slot}</span>` +
              `<span class="chain-hit-claimer" style="font-size:10px">\u2713 ${escHtml(doneHit.claimedBy||"\u2014")}</span>` +
              `<span class="chain-hit-target" style="font-size:10px">${escHtml(doneHit.targetName||"\u2014")}</span>` +
              `<span class="chain-hit-timer done">Done</span>` +
              `<span></span><span></span></div>`;
          } else {
            html += `<div class="chain-hit-row waiting" style="opacity:.4;font-style:italic">` +
              `<span class="chain-hit-num" style="color:#445">${slot}</span>` +
              `<span class="chain-hit-claimer" style="color:#334">—</span>` +
              `<span class="chain-hit-target" style="color:#445">Waiting for Data</span>` +
              `<span class="chain-hit-timer wait" style="color:#334">—</span>` +
              `<span></span><span></span></div>`;
          }
        }
      } else {
        // No live count — just render whatever done hits we have
        for (const hit of doneHits) html += hitRowHtml(hit, -1, now);
      }

      // All pending hits — pos 0 gets sticky-now via hitRowHtml
      pendingHits.forEach((hit, i) => { html += hitRowHtml(hit, i, now); });

      // Unclaimed placeholder when chain is live but queue is empty
      if (pendingHits.length === 0 && allDoneBySlot.size === 0 && liveChainCount !== null) {
        const nextSlot = getHighestDoneHitNum() + 1;
        const disp = Math.round(chainTimerMs() / 1000);
        const t = liveChainSecs !== null ? `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}` : "—";
        html += `<div class="chain-hit-row unclaimed sticky-now"><span class="chain-hit-num">${nextSlot}</span><span class="chain-hit-claimer">—</span><span class="chain-hit-target">Unclaimed</span><span class="chain-hit-timer ${disp<=30?"due":disp<=90?"soon":"wait"}">${t}</span><span></span><span></span></div>`;
      }

      const prevScroll = inner.scrollTop;
      const wasAtBottom = inner.scrollHeight - inner.scrollTop - inner.clientHeight < 40;
      inner.innerHTML = html;
      wireRemoveButtons(inner);
      wireReorderButtons(inner);

      if (wasAtBottom || prevScroll === 0) {
        inner.scrollTop = inner.scrollHeight;
      } else {
        inner.scrollTop = prevScroll;
      }
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  1-second tick
  // ══════════════════════════════════════════════════════════════════════════
  let _lastTickSecs = null;  // deduplicate updateChainTimerUI calls in tick
  setInterval(() => {
    const now = Date.now();

    // Only call updateChainTimerUI from the tick when the displayed second has
    // actually changed — the MutationObserver already calls it on every DOM timer
    // mutation, so this avoids a redundant style-recalc on the same frame.
    const tickSecs = liveChainSecs !== null && lastTimerReadAt !== null
      ? Math.floor(Math.max(0, liveChainSecs - (performance.now() - lastTimerReadAt) / 1000))
      : null;
    if (tickSecs !== _lastTickSecs) {
      _lastTickSecs = tickSecs;
      updateChainTimerUI();
    }

    // Scrape whenever a chain session is active — including warmup (hits 1-9).
    // chainConfirmed only becomes true at hit 10, so we must not gate on it here.
    // Throttled to every 2s: hits are deduplicated via scrapedHitIds so no data
    // is lost, and halving the scrape rate cuts the per-tick DOM walk cost in half.
    if (chainStartTime && !isTornPDA && (now - _lastScrapeAt) >= 2000) {
      _lastScrapeAt = now;
      scrapeRecentAttacks();
    }

    // Re-anchor pending hit scheduledAt values to the live DOM timer so that
    // pendingCountdownMs() ticks smoothly at 1s rather than in Firebase poll steps.
    syncPendingScheduledAt();

    // Patch timer cells — only when panel is fully visible (view-full).
    // In icon/mini mode the rows are display:none so writes are wasted work.
    if (viewMode === 0) {
      // Pre-hoist shared values outside the loop
      const sortedPending = [...hitMap.values()]
        .filter(h => h.status === "pending")
        .sort((a, b) => a.hitNumber - b.hitNumber);
      const currentHitNum = liveChainCount !== null ? liveChainCount + 1 : getHighestDoneHitNum() + 1;
      // Use the cached panel inner reference to scope querySelector — avoids scanning the whole document
      const _panelInner = document.getElementById("chain-panel-inner");
      if (_panelInner) {
      _panelInner.querySelectorAll(".chain-hit-timer[data-pos]").forEach(cell => {
        const pos = parseInt(cell.dataset.pos);
        if (pos < 0) return;
        const hit  = sortedPending[pos] || null;
        const hosp = hit ? isHospStillIn(hit) : false;
        const rem  = pendingCountdownMs(pos, sortedPending);
        // Timer rules (same as hitRowHtml):
        //   Hits 1-9  (warmup):  always NOW
        //   Hit  10   (confirm): chain timer
        //   Hits 11+  (running): chain timer + offsets
        // No live timer → non-warmup slots show "—" (scheduledAt is stale).
        const hitNum      = hit ? (hit.chainHitNum || hit.hitNumber) : 0;
        const isCurrent   = hitNum === currentHitNum;
        const hasLiveTimer = liveChainSecs !== null && lastTimerReadAt !== null;
        const isWarmupSlot = hitNum < CHAIN_CONFIRM_HITS;
        const showNow     = isWarmupSlot || (hasLiveTimer && (isCurrent || rem <= 0));
        const showDash    = !isWarmupSlot && !hasLiveTimer;
        const dispRem     = showNow ? 0 : rem;
        const newText     = showDash ? "—" : dispRem <= 0 ? "NOW" : formatTime(dispRem);
        const newClass   = showDash ? "chain-hit-timer wait" : `chain-hit-timer ${hitTimerClass(dispRem)}`;
        // Only write if value changed — avoids unnecessary style recalcs
        if (cell.textContent !== newText) cell.textContent = newText;
        if (cell.className   !== newClass) cell.className  = newClass;
        const row = cell.closest(".chain-hit-row");
        if (row) {
          const newRc   = showDash ? "waiting" : hitRowClass(dispRem, hosp, hit?.untracked || false);
          const isBonus = settShowBonusAlert && BONUS_HITS.has(hitNum);
          const isNow   = isCurrent && hasLiveTimer;
          const newRowClass = `chain-hit-row ${newRc}${isBonus?" bonus":""}${isNow?" sticky-now":""}`;
          if (row.className !== newRowClass) row.className = newRowClass;
        }
      });
      // Update hosp sub-timers
      _panelInner.querySelectorAll("[data-hosp-id]").forEach(hc => {
        const hit = hitMap.get(hc.dataset.hospId);
        if (!hit) { hc.remove(); return; }
        if (!isHospStillIn(hit)) { hc.textContent = ""; hc.removeAttribute("data-hosp-id"); }
        else hc.textContent = `out in ${formatTime(hit.hospReleaseAt - Date.now())}`;
      });
      } // end if (_panelInner)

      const nh = getPendingHits()[0];
      if (nh) {
        const rem0 = pendingCountdownMs(0);
        nextTimer.textContent = rem0 <= 0 ? "NOW" : formatTime(rem0);
        nextTimer.className   = hitTimerClass(rem0);
      } else if (liveChainSecs !== null) {
        const rem  = chainTimerMs();
        const disp = Math.round(rem/1000);
        nextTimer.textContent = `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}`;
        nextTimer.className   = hitTimerClass(rem);
      }
    }

    // Top-bar chain badge (all pages)
    updateTopBarBadge();

    // ── Auto-expand + sound notification when OWN hit becomes due ────────────
    if (settNotifySound || settAutoExpandDue) {
      // Only fire alerts when the page is in the foreground — prevents background tabs
      // from beeping and auto-expanding continuously on every poll cycle.
      const pageVisible = !document.hidden;
      const myPending = [...hitMap.values()].filter(h => h.status !== "done" && h.claimedBy === ownName)
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      if (myPending.length) {
        const first = myPending[0];
        const rem = Math.max(0, first.scheduledAt - Date.now());
        // Fire exactly once when countdown hits 0 — keyed by hit ID in a persistent Set
        // so Firebase re-syncs (which wipe per-object flags) don't re-trigger the alert.
        if (rem < 1000 && !_notifiedHitIds.has(first.id)) {
          _notifiedHitIds.add(first.id);
          if (pageVisible) {
            playDueSound();
            if (settAutoExpandDue && viewMode !== 0) {
              viewMode = 0; GM_setValue(SK_VIEW_MODE, viewMode); applyViewMode();
            }
          }
        } else if (rem > 5000) {
          // Reset: hit is back in the future (e.g. rescheduled), allow future alert
          _notifiedHitIds.delete(first.id);
        }
        // Purge stale IDs for hits that are now done or removed
        _notifiedHitIds.forEach(id => {
          const h = hitMap.get(id);
          if (!h || h.status === "done") _notifiedHitIds.delete(id);
        });
      }
    }
  }, 1000);

  // ══════════════════════════════════════════════════════════════════════════
  //  Scheduling — queue a new pending hit
  //  FIX #1: reNumberPending() runs BEFORE fbWriteHit() so hitNumber
  //  is correct in the initial Firebase write.
  // ══════════════════════════════════════════════════════════════════════════
  function scheduleAndWrite(apiData, targetId, targetName, attackUrl, btn) {
    const now            = Date.now();
    const state          = (apiData?.status?.state||"").toLowerCase();
    const hospReleaseSec = apiData?.states?.hospital_timestamp||0;
    const isInHosp       = state==="hospital"&&hospReleaseSec>0;
    const hospReleaseMs  = isInHosp ? hospReleaseSec*1000 : 0;
    const earliest       = Math.max(now, hospReleaseMs);

    const activeHits = [...hitMap.values()].filter(h=>h.status!=="done").sort((a,b)=>a.scheduledAt-b.scheduledAt);

    // Always append to the end of the queue — gap-fitting caused re-queued hits
    // to reclaim their old slot instead of going to the back of the line.
    const insertSlot = activeHits.length
      ? activeHits[activeHits.length - 1].scheduledAt + HIT_INTERVAL
      : Math.max(now, earliest);

    const newHit = {
      id:            `hit_${now}_${Math.random().toString(36).slice(2)}`,
      hitNumber:     0,   // placeholder — reNumberPending assigns the real number below
      targetId,
      targetName:    apiData.name||targetName,
      targetFactionId: String(apiData?.faction?.faction_id || "0"),
      claimedBy:     ownName,
      claimedAt:     now,
      scheduledAt:   insertSlot,
      hospReleaseAt: hospReleaseMs||null,
      attackUrl,
      status:        "pending",
      sessionId:     chainSessionId,
    };

    // Add to hitMap first, THEN reNumber so hitNumber is correct before write.
    // Pass skipWrite=true to reNumberPending: existing hits already have the right
    // numbers, and the new hit is about to be written in full by fbWriteHit below —
    // a field-level hitNumber PUT here would create a zombie partial node.
    hitMap.set(newHit.id, newHit);
    reNumberPending(true);
    fbWriteHit(newHit);  // writes the complete, correctly-numbered hit to Firebase

    if (btn.dataset.iconClaimed) { btn.innerHTML = btn.dataset.iconClaimed; btn.style.color="#44ff88"; }
    else { btn.textContent = "✓"; }
    btn.classList.add("claimed");
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

    const already = [...hitMap.values()].find(h=>h.status==="pending"&&h.targetId===targetId);
    if (already) { alert(`${targetName} is already queued as hit #${already.hitNumber}.`); return; }

    const resetBtn = () => {
      btn.disabled=false; btn.classList.remove("loading");
      if (btn.dataset.iconDefault) { btn.innerHTML = btn.dataset.iconDefault; btn.style.color=""; }
      else { btn.textContent="🎯"; }
    };

    btn.disabled=true; btn.classList.add("loading"); btn.textContent="⏳";

    GM_xmlhttpRequest({
      method:"GET",
      url:`https://api.torn.com/user/${encodeURIComponent(targetId)}?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout:15000,
      onload(r) {
        btn.disabled=false; btn.classList.remove("loading");
        let data=null; try{data=JSON.parse(r.responseText);}catch{/**/ }
        if(!data||data.error){resetBtn();alert(`Torn API error: ${data?.error?.error||"Unknown"}`);return;}
        const state=(data?.status?.state||"").toLowerCase();
        if(["abroad","traveling","jail","federal","fallen"].some(s=>state.includes(s))){resetBtn();alert(`${targetName} is ${state} — cannot be scheduled.`);return;}
        // War gating — if we're in a ranked war, only allow queuing opponents
        if (inRankedWar && warOpponentFactionIds.size > 0) {
          const targetFactionId = String(data?.faction?.faction_id || "0");
          if (targetFactionId === "0" || !warOpponentFactionIds.has(targetFactionId)) {
            resetBtn();
            alert(`${targetName} is not in a war opponent faction — only war targets can be queued during a ranked war.`);
            return;
          }
        }
        scheduleAndWrite(data,targetId,targetName,attackUrl,btn);
      },
      onerror()  { resetBtn(); alert("Network error."); },
      ontimeout(){ resetBtn(); alert("Request timed out."); },
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

  // Page detection
  const IS_FACTIONS_PAGE   = /factions\.php/.test(window.location.pathname);
  const IS_LIST_PAGE       = /page\.php/.test(window.location.pathname) &&
                             /sid=list/.test(window.location.search);
  const IS_PROFILE_PAGE    = /profiles\.php/.test(window.location.pathname);
  const IS_ANY_TORN_PAGE   = /torn\.com/.test(window.location.hostname);

  function isInsideWarList(el) {
    const WAR_SELS='[class*="rankedWar"],[class*="ranked-war"],[class*="warFilter"],[class*="war-filter"],[class*="memberList"],[class*="member-list"],[class*="factionMembers"],[class*="members-list"],[class*="membersTable"]';
    let node=el.parentElement;
    while(node&&node!==document.body){try{if(node.matches&&node.matches(WAR_SELS))return true;}catch{/**/ }node=node.parentElement;}
    return false;
  }

  // ── Top-bar chain status badge (all pages) ────────────────────────────────
  let topBarBadge = null;

  function injectTopBarBadge() {
    // Disabled: badge injected into Torn's nav bar overlaps the FACTION tab
    // links and accidentally triggers full-panel expansion on tap.
    // The panel's own icon / mini modes already display the timer.
  }

  function updateTopBarBadge() {
    // Disabled: see injectTopBarBadge above.
  }

  // ── Profile page: inject directly using XID from URL ─────────────────────
  let profilePageInjected = false;
  function injectProfilePageButton() {
    if (!IS_PROFILE_PAGE || profilePageInjected) return;
    const m = window.location.search.match(/XID=(\d+)/i) ||
              window.location.pathname.match(/\/(\d+)$/);
    if (!m) return;
    const targetId = m[1];
    if (ownId && targetId === ownId) return;

    // Find the attack button — it's in the Actions section
    const attackA = document.querySelector('a[href*="loader.php?sid=attack"], a[href*="user2ID='+targetId+'"]');
    if (!attackA) return;  // Actions not loaded yet — observer will retry
    const attackUrl = extractAttackUrl(attackA);

    // Extract name from page title or heading
    const nameEl = document.querySelector('h4[class*="name"], [class*="profileName"], h1, [class*="user-name"], [class*="userName"]');
    const targetName = nameEl ? (nameEl.textContent||"").replace(/\[.*?\]/g,"").trim() : "Player #"+targetId;

    profilePageInjected = true;
    const btn = document.createElement("button");
    btn.className = "chain-target-btn chain-target-btn-lg";
    btn.id = "chain-profile-btn";
    const queued = [...hitMap.values()].find(h => h.status==="pending" && h.targetId===targetId);
    if (queued) { btn.textContent="✓"; btn.classList.add("claimed"); btn.title=`${targetName} queued as hit #${queued.hitNumber}`; }
    else { btn.textContent="🎯"; btn.title=`Add ${targetName} to chain queue`; }
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); handleTargetClaim(btn, targetId, targetName, attackUrl); };
    // Insert AFTER the attack button
    attackA.parentNode.insertBefore(btn, attackA.nextSibling);
  }

  function injectTargetButtons() {
    // Profile page: handled separately above
    if (IS_PROFILE_PAGE) { injectProfilePageButton(); }

    if (!IS_FACTIONS_PAGE && !IS_LIST_PAGE) {
      // On non-list/faction pages, only inject into popup hover cards
      injectPopupHoverCards();
      return;
    }

    // Scope to injectRoot (mainContainer or torn-app) to avoid scanning the
    // entire document on every inject call — chat, nav, and other sidebar elements
    // are excluded for free. Falls back to document.body when injectRoot is body.
    injectRoot.querySelectorAll('a[href*="profiles.php?XID="]').forEach(profileA => {
      if(panel.contains(profileA))return;
      if(profileA.dataset.chainBtnInjected)return;
      if(IS_FACTIONS_PAGE && !isInsideWarList(profileA))return;
      if(IS_LIST_PAGE && !isInsidePlayerList(profileA))return;
      // Never inject into the mini popup card — that's handled by _injectIntoPopupCard
      if(profileA.closest(".mini-profile-wrapper, .buttons-list, .buttons-wrap, [class*='profile-mini-']"))return;
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

    // Also inject into any popup hover cards visible on these pages
    injectPopupHoverCards();
  }

  // Inject into Torn's popup hover cards (appear on any page when tap-holding a name)
  // Uses class*= to handle CSS module hashed suffixes on the class name.
  function injectPopupHoverCards() {
    // Fast early-exit: if #profile-mini-root exists but contains no .buttons-list
    // without an already-injected chain button, there is no open hover card to inject
    // into. This avoids the 6-selector document-wide scan on every idle mutation.
    const miniRoot = document.getElementById("profile-mini-root");
    if (miniRoot) {
      const hasWork = miniRoot.querySelector(
        ".buttons-list:not(:has(.chain-target-btn)), .buttons-wrap:not(:has(.chain-target-btn))"
      );
      if (!hasWork && !miniRoot.querySelector(".mini-profile-wrapper, [class*=\"profile-mini-_wrapper_\"]")) {
        return;  // miniRoot is empty or all cards already injected
      }
    }

    // Collect candidate popup roots, then deduplicate to outermost only.
    // This prevents injecting multiple buttons when nested children all match the selector.
    const seen = new Set();
    function _tryCard(el) {
      if (!el || seen.has(el)) return;
      // Walk UP to the outermost matching ancestor so we always pass the wrapper div
      let root = el;
      while (root.parentElement && root.parentElement !== document.body) {
        const p = root.parentElement;
        if (p.matches && (
          p.classList.contains("mini-profile-wrapper") ||
          [...p.classList].some(c => c.startsWith("profile-mini-_wrapper_"))
        )) { root = p; } else { break; }
      }
      if (seen.has(root)) return;
      seen.add(root);
      _injectIntoPopupCard(root);
    }

    // Strategy 1: stable ID — #profile-mini-root is a direct <body> child outside
    // #mainContainer so the main MutationObserver doesn't cover it.
    if (miniRoot) {
      miniRoot.querySelectorAll(
        ".mini-profile-wrapper, [class*=\"profile-mini-_wrapper_\"]"
      ).forEach(_tryCard);
    }

    // Strategy 2: Broad document scan for other hover-card implementations
    const popupSel = [
      ".mini-profile-wrapper",
      "[class*=\"profile-mini-_wrapper_\"]",
      "[class*=\"profile-mini-_userProfileWrapper_\"]",
      "[class*=\"userProfileWrapper\"]",
      "[class*=\"profileMini_\"]",
      "[class*=\"profile-mini_\"]",
    ].join(",");
    document.querySelectorAll(popupSel).forEach(_tryCard);
  }

  function _injectIntoPopupCard(popup) {
    if (panel && panel.contains(popup)) return;

    // Guard: not inside nav/header/settings
    let node = popup.parentElement;
    while (node && node !== document.body) {
      try { if (node.matches && node.matches('nav,[class*="nav"],[class*="topBar"],[class*="settingsMenu"]')) return; } catch {/**/ }
      node = node.parentElement;
    }

    // The real popup structure (from DOM inspection) is:
    //   div.buttons-wrap > div.buttons-list > a.profile-button x12
    // The last button is profile-button-viewDisplayCabinet (mini-button11-profile-XID).
    // We append our button to div.buttons-list as item #13.
    // Do NOT use dataset.chainPopupInjected guard — React re-renders wipe it.
    // Instead check for an already-injected .chain-target-btn inside .buttons-list.
    const buttonsList = popup.querySelector(".buttons-list");
    if (!buttonsList) return;  // popup not fully rendered yet — observer will retry
    if (buttonsList.querySelector(".chain-target-btn")) return;  // already injected

    // Extract XID from the attack button href: id="mini-button0-profile-XID"
    // or href="...user2ID=XID" or any profile link XID=
    let targetId = null;
    const attackA = buttonsList.querySelector('a.profile-button-attack[href*="user2ID="]');
    if (attackA) {
      const m = (attackA.href||"").match(/user2ID=(\d+)/i);
      if (m) targetId = m[1];
    }
    if (!targetId) {
      const idEl = buttonsList.querySelector('[id*="-profile-"]');
      if (idEl) { const m = (idEl.id||"").match(/-profile-(\d+)$/); if (m) targetId = m[1]; }
    }
    if (!targetId) {
      for (const a of popup.querySelectorAll("a[href]")) {
        const m = (a.href||"").match(/XID=(\d+)/i) || (a.href||"").match(/user2ID=(\d+)/i);
        if (m) { targetId = m[1]; break; }
      }
    }
    if (!targetId) return;
    if (ownId && targetId === ownId) return;

    // Extract name from the "View profile of NAME" aria-label on the profile link
    const nameA = popup.querySelector('a[aria-label*="View profile of"]');
    let targetName = "";
    if (nameA) {
      const am = (nameA.getAttribute("aria-label")||"").match(/of (.+)$/i);
      targetName = am ? am[1].trim() : "";
    }
    if (!targetName) targetName = "Player #" + targetId;

    const attackUrl = `https://www.torn.com/loader.php?sid=attack&user2ID=${targetId}`;

    const btn = document.createElement("a");
    btn.className = "chain-target-btn";
    // Fixed 35px to match popup button grid — avoids getComputedStyle forced layout flush
    btn.style.cssText = "cursor:pointer;text-decoration:none;width:35px;height:35px;display:inline-flex;align-items:center;justify-content:center;";
    const queued = [...hitMap.values()].find(h => h.status==="pending" && h.targetId===targetId);
    if (queued) {
      btn.textContent = "\u2713"; btn.classList.add("claimed");
      btn.title=`${targetName} queued as hit #${queued.hitNumber}`;
    } else {
      btn.textContent = "\uD83C\uDFAF";
      btn.title=`Add ${targetName} to chain queue`;
    }
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); handleTargetClaim(btn, targetId, targetName, attackUrl); };

    // Append as the 13th icon in the buttons-list grid — lands after the
    // display case button at the end of row 2, above "View profile / New tab".
    buttonsList.appendChild(btn);
  }

  // On list pages, inject on any profile link that isn't inside a chat or nav container.
  function isInsidePlayerList(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      try {
        if (node.matches && node.matches(
          '[class*="chat"],[class*="Chat"],[id*="chat"],[id*="Chat"],' +
          '[class*="faction-chat"],[class*="factionChat"],' +
          'nav,[class*="nav"],[class*="header"],[class*="topBar"],[class*="top-bar"],' +
          '[class*="settingsMenu"],[class*="settings-menu"],[class*="userMenu"],[class*="user-menu"]'
        )) return false;
      } catch {/**/ }
      node = node.parentElement;
    }
    return true;
  }

  // Observe only the Torn content area for inject button triggers — not the whole body.
  // document.body with subtree:true fires on every DOM mutation site-wide (chat, timers,
  // notifications) and is the primary cause of main-thread slowdowns.
  //
  // FIX (4.9.9): injectRoot was previously resolved ONCE at document-idle. If mainContainer
  // wasn't in the DOM yet at that moment (slow page loads, some Torn subpages), it silently
  // fell back to document.body — making tornRootObs observe the ENTIRE document with
  // subtree:true, which is the original root cause of the 10s main-thread freeze.
  // Now resolved lazily via getInjectRoot() so we always get the live element, and the
  // observer is NEVER attached to document.body (null = retry, not body fallback).
  function getInjectRoot() {
    return document.getElementById("mainContainer")
      || document.getElementById("torn-app")
      || document.querySelector('[class*="mainContainer"]')
      || null;  // DO NOT fall back to document.body — callers retry if null
  }
  // Best-effort eager resolution for querySelectorAll scoping (body fallback is safe
  // there since it just means a slightly wider scan, not an immortal subtree observer).
  let injectRoot = getInjectRoot() || document.body;

  (function setupInjectObserver() {
    // FIX (4.9.9): tornRoot is resolved fresh each time connectTornRootObs() runs,
    // not captured once at IIFE entry. This prevents the case where mainContainer
    // wasn't in the DOM at document-idle, causing tornRoot === document.body and
    // an immortal subtree:true observer on the entire document (the freeze cause).
    // If getInjectRoot() returns null, we retry via the shallow body observer below
    // rather than falling back to document.body for the subtree observer.
    let injectQueued = false;

    // tornRoot observer is disconnected once all visible profile links are injected.
    // It is re-armed on SPA navigation (popstate / pushstate) so new page loads get covered.
    let tornRootObs = null;
    let tornRootConnected = false;
    let _currentTornRoot = null;  // track which element the observer is attached to

    // Declare trigger first so connectTornRootObs can close over it.
    const trigger = () => {
      if (injectQueued) return;
      injectQueued = true;
      setTimeout(() => {
        injectQueued = false;
        // Refresh injectRoot to the live element (may have been null at boot time)
        const liveRoot = getInjectRoot();
        if (liveRoot) injectRoot = liveRoot;
        // Fast early-exit: if every profile link in the inject root is already marked,
        // there is no work to do. Skip the full injectTargetButtons scan entirely.
        // querySelectorAll with :not() is far cheaper than running the full inject.
        const hasUninjected = injectRoot.querySelector(
          'a[href*="profiles.php?XID="]:not([data-chain-btn-injected])'
        );
        // Always run on profile/miniRoot triggers (hover cards) — they don't set chainBtnInjected.
        // For the main tornRoot, skip if nothing is uninjected.
        if (!hasUninjected && (IS_FACTIONS_PAGE || IS_LIST_PAGE)) {
          // All links already injected — disconnect the main observer until navigation
          disconnectTornRootObs();
          return;
        }
        injectTargetButtons();
      }, 500);
    };

    function disconnectTornRootObs() {
      if (tornRootObs && tornRootConnected) {
        tornRootObs.disconnect();
        tornRootConnected = false;
        _currentTornRoot = null;
      }
    }
    function connectTornRootObs() {
      // Resolve the container fresh — never use document.body for subtree observation
      const root = getInjectRoot();
      if (!root) {
        // Container not in DOM yet — the shallow body observer below will retry when it appears
        return;
      }
      // Already observing this exact element — nothing to do
      if (tornRootConnected && _currentTornRoot === root) return;
      // Disconnect from old element if we switched (e.g. after SPA nav rebuilt mainContainer)
      if (tornRootObs && tornRootConnected) { tornRootObs.disconnect(); tornRootConnected = false; }
      if (!tornRootObs) tornRootObs = new MutationObserver(trigger);
      tornRootObs.observe(root, { childList: true, subtree: true });
      tornRootConnected = true;
      _currentTornRoot = root;
      // Update injectRoot to the live element while we're here
      injectRoot = root;
    }

    connectTornRootObs();

    // Re-arm tornRoot observer on SPA navigation so new page content gets covered.
    const rearmOnNav = () => {
      profilePageInjected = false;   // reset profile page flag on navigation
      connectTornRootObs();
      trigger();
    };
    window.addEventListener("popstate", rearmOnNav);
    // Intercept pushState/replaceState (SPA routers)
    const _pushState = history.pushState.bind(history);
    history.pushState = function(...args) { _pushState(...args); rearmOnNav(); };
    const _replaceState = history.replaceState.bind(history);
    history.replaceState = function(...args) { _replaceState(...args); rearmOnNav(); };

    // Watch direct children of <body> (zero subtree cost) so we catch:
    // (a) #profile-mini-root being appended (hover cards)
    // (b) #mainContainer / #torn-app appearing for the first time on slow page loads
    //     — when it appears, connectTornRootObs() will attach the real narrow observer.
    // subtree:false means only direct <body> children fire this, which is very cheap.
    new MutationObserver(() => {
      // If we don't have a real tornRoot observer yet, try to connect now
      if (!tornRootConnected) connectTornRootObs();
      trigger();
    }).observe(document.body, { childList: true, subtree: false });
    // Observe #profile-mini-root with subtree — catches React populating the card
    const miniRootEl = document.getElementById("profile-mini-root");
    if (miniRootEl) {
      new MutationObserver(trigger).observe(miniRootEl, { childList: true, subtree: true });
    } else {
      // If not yet in DOM, watch body shallowly and attach once it appears
      const bodyObs = new MutationObserver(() => {
        const mr = document.getElementById("profile-mini-root");
        if (mr) {
          new MutationObserver(trigger).observe(mr, { childList: true, subtree: true });
          bodyObs.disconnect();
        }
      });
      bodyObs.observe(document.body, { childList: true, subtree: false });
    }
  })();
  // No setInterval fallback needed — the MutationObserver covers all DOM changes.

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
          // Parse active ranked wars — collect opponent faction IDs
          warOpponentFactionIds.clear();
          inRankedWar = false;
          if (d.ranked_wars && typeof d.ranked_wars === "object") {
            Object.values(d.ranked_wars).forEach(w => {
              if (!w || !w.war || w.war.end !== 0) return; // skip finished wars
              inRankedWar = true;
              if (w.factions) Object.keys(w.factions).forEach(fid => {
                if (String(fid) !== String(factionId)) warOpponentFactionIds.add(String(fid));
              });
            });
          }
          updateClearBtn();
        } catch {/**/ }
      },
    });
  }

  function fetchOwnProfile() {
    if (!tornApiKey) { showBanner("chain-banner-nokey",true); return; }
    // Clear any existing intervals before re-running boot — prevents accumulation
    // when fetchOwnProfile is called again (e.g. after API key save or token refresh).
    clearAllIntervals();
    lastPollResponse = null;  // force a fresh applyPatch on next poll
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
          // isOwner is determined by a Firebase probe read after auth — not client-side.
          // whitelistBtn is a hidden proxy; gear menu visibility is handled in updateClearBtn()
          updateApiBtn();
          // Keep "Connecting…" banner up — lobby check-in will dismiss it.

          if(!factionId||factionId==="0"){showBanner("chain-banner-nofact",true);return;}
          showBanner("chain-banner-nofact",false);

          if(!fbConfigured()){showBanner("chain-banner-nofb",true);return;}
          showBanner("chain-banner-nofb",false);

          fetchFactionBasic();

          // FIX #2: try the timer observer as soon as profile loads
          startChainTimerObserver();

          fbSignInAnon((token,uid)=>{
            fbToken = token;
            fbUid   = uid;

            if (!token || !uid) {
              // FIX E: Clear the generic "Connecting…" banner so it doesn't hang
              // forever when Firebase auth can't complete (e.g. on TornPDA where
              // googleapis.com may be unreachable from the WebView sandbox).
              showBanner("chain-banner-status", false);
              const pdaNote = isTornPDA ? " (TornPDA: Firebase auth may be blocked — check @connect in script header)" : "";
              showBanner("chain-banner-debug", true, "⚠ Firebase auth failed — anonymous sign-in returned no token." + pdaNote);
              return;
            }

            // Write to /lobby/{fbUid} — auth.uid === $uid always passes, no chicken-and-egg.
            // fbUid is the only key Firebase rules can reliably look up via auth.uid.
            // Old fbUid entries from previous sessions are cleaned up by fbCleanOwnLobbyEntries.
            const lobbyBootstrapUrl = P.lobbyMe();
            // Lobby check-in runs silently — keep the "Connecting…" status banner visible
            // (already shown by fetchOwnProfile) and only surface debug info on error.
            showBanner("chain-banner-status", true, "Connecting…");
            GM_xmlhttpRequest({
              method:"PUT", url: lobbyBootstrapUrl,
              headers:{"Content-Type":"application/json"},
              data: JSON.stringify({ name: ownName, tornId: ownId, factionId: factionId, lastSeen: Date.now() }),
              timeout:10000,
              onload(r) {
                if (r.status>=200 && r.status<300) {
                  setSyncDot("live");
                  // Read back to confirm committed in rules engine before proceeding
                  GM_xmlhttpRequest({
                    method: "GET", url: lobbyBootstrapUrl, timeout: 8000,
                    onload(rr) {
                      showBanner("chain-banner-status", false);
                      fbCleanOwnLobbyEntries();
                      fbRegisterMember();
                      fbProbeOwner();   // silent boot-time owner check — sets isOwner + gear menu
                      // Lobby is confirmed — safe to push GitHub version to Firebase now.
                      checkForUpdate();
                      fbCheckWhitelist(allowed => {
                        if (!allowed) {
                          showBanner("chain-banner-locked", true);
                          setSyncDot("error");
                          return;
                        }
                        showBanner("chain-banner-locked", false);
                        fbStartMainListener();
                        pollFactionChain();
                        if (!factionPollInterval) factionPollInterval = setInterval(pollFactionChain, CHAIN_POLL_MS);
                      });
                    },
                    onerror()  { showBanner("chain-banner-status", false); fbRegisterMember(); checkForUpdate(); fbCheckWhitelist(allowed => { if(allowed){fbStartMainListener();pollFactionChain();if(!factionPollInterval)factionPollInterval=setInterval(pollFactionChain,CHAIN_POLL_MS);}else{showBanner("chain-banner-locked",true);setSyncDot("error");} }); },
                    ontimeout(){ showBanner("chain-banner-status", false); fbRegisterMember(); checkForUpdate(); fbCheckWhitelist(allowed => { if(allowed){fbStartMainListener();pollFactionChain();if(!factionPollInterval)factionPollInterval=setInterval(pollFactionChain,CHAIN_POLL_MS);}else{showBanner("chain-banner-locked",true);setSyncDot("error");} }); },
                  });
                } else {
                  setSyncDot("error");
                  showBanner("chain-banner-status", false);
                  let msg = r.responseText;
                  try { msg = JSON.parse(r.responseText).error || msg; } catch { /**/ }
                  showBanner("chain-banner-debug", true, "❌ Lobby check-in failed "+r.status+": "+msg+" | url: "+lobbyBootstrapUrl.replace(/auth=[^&]+/,"auth=***"));
                  console.warn("[ChainCoord] Lobby check-in failed", r.status, r.responseText, lobbyUrl);
                }
              },
              onerror(e)  { setSyncDot("error"); showBanner("chain-banner-status", false); showBanner("chain-banner-debug", true, "❌ Lobby check-in network error — check @connect firebaseio.com"); },
              ontimeout() { setSyncDot("error"); showBanner("chain-banner-status", false); showBanner("chain-banner-debug", true, "❌ Lobby check-in timed out"); },
            });

            if (!heartbeatInterval) heartbeatInterval = setInterval(fbHeartbeat, PRESENCE_HEARTBEAT);
            // Owner lobby cleanup interval is started inside fbProbeOwner on success.
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
    tornApiKey=""; GM_setValue(SK_API_KEY,""); try{localStorage.removeItem("tcc_api_key");}catch{/**/ } updateApiBtn(); showBanner("chain-banner-nokey",true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  Version check — compare running version against GitHub raw file
  // ══════════════════════════════════════════════════════════════════════════
  // CURRENT_VERSION is declared at the top of the IIFE (needed for panel HTML template).
  const SCRIPT_RAW_URL  = "https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js";
  const SCRIPT_INSTALL_URL = "https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js";

  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: "GET",
      url: SCRIPT_RAW_URL + "?nocache=" + Date.now(),
      timeout: 10000,
      onload(r) {
        if (r.status !== 200) return;
        const match = r.responseText.match(/@version\s+([\d.]+)/);
        if (!match) return;
        const latest = match[1];
        // Write the canonical latest version to Firebase so all connected clients
        // see the update arrow immediately — without each one hitting GitHub.
        // Skip the pre-read (which doubled failure surface) and write directly.
        // Gate only on fbConfigured + fbUid — not on CURRENT_VERSION, so an already-
        // updated owner client still pushes the version for peers running older builds.
        if (fbConfigured() && fbUid) {
          const lvUrl = P.latestVersion();
          if (lvUrl) {
            GM_xmlhttpRequest({
              method: "PUT", url: lvUrl,
              headers: { "Content-Type": "application/json" },
              data: JSON.stringify({ version: latest, updatedAt: Date.now() }),
              timeout: 10000,
              onload(wr) {
                if (wr.status >= 200 && wr.status < 300) {
                  console.log("[ChainCoord] latestVersion written to Firebase:", latest);
                } else {
                  let msg = wr.responseText;
                  try { msg = JSON.parse(wr.responseText).error || msg; } catch { /**/ }
                  console.warn("[ChainCoord] latestVersion write failed", wr.status, msg);
                  showBanner("chain-banner-debug", true,
                    `⚠ latestVersion write failed (${wr.status}): ${msg} — check Firebase rules allow write to /meta/latestVersion`);
                }
              },
              onerror()  { console.warn("[ChainCoord] latestVersion write: network error"); },
              ontimeout(){ console.warn("[ChainCoord] latestVersion write: timed out"); },
            });
          }
        }
        // Update version badge + arrow button colour — no banner
        if (isNewerVersion(latest, networkLatestVersion || "0.0.0") || networkLatestVersion === null) {
          networkLatestVersion = latest;
        }
        updateVersionUI();
      },
      onerror()  { console.warn("[ChainCoord] checkForUpdate: GitHub fetch network error — is raw.githubusercontent.com in @connect?"); },
      ontimeout(){ console.warn("[ChainCoord] checkForUpdate: GitHub fetch timed out"); },
    });
  }

  function isNewerVersion(a, b) {
    // Returns true if version string a is newer than b
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return true;
      if (na < nb) return false;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Boot
  // ══════════════════════════════════════════════════════════════════════════
  renderPanel();
  fetchOwnProfile();
  if (!isTornPDA) injectTargetButtons();
  updateVersionUI();   // set initial badge state before Firebase connects
  // checkForUpdate() is called from inside the lobby check-in callback, once fbUid
  // is confirmed — this guarantees the Firebase write succeeds (auth is ready).
  // No blind setTimeout needed here anymore.

})();
