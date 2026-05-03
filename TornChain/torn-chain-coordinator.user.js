// ==UserScript==
// @name         Torn Chain Coordinator
// @namespace    https://kreinas1995.github.io/
// @version      2.0.0
// @description  Shared real-time chain scheduling board. All members of your faction see the same live queue, powered by Firebase.
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
// @updateURL    https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/TornChain/torn-chain-coordinator.user.js
// @downloadURL  https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/TornChain/torn-chain-coordinator.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  CONFIG — the only values you need to change after Firebase setup.      ║
  // ║  See FIREBASE_SETUP.md in the TornChain folder for step-by-step guide.  ║
  // ║  These are NOT secrets — safe to commit to your public GitHub repo.     ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const FIREBASE_DB_URL  = "https://syph-s-war-overhaul-default-rtdb.firebaseio.com"
  const FIREBASE_API_KEY = "AIzaSyATeusVjS6_S0JlSVu6su4jghnTRiy2I5w";

  // ─── Poll interval (ms) — SSE gives real-time push; this is just a backup ─
  const POLL_MS = 8000;

  // ─── Local GM storage keys (Torn API key + UI prefs, never shared) ────────
  const SK_API_KEY    = "chain_api_key";
  const SK_PANEL_SIZE = "chain_panel_size";
  const SK_MINIMIZED  = "chain_panel_minimized";

  // ─── Runtime state ────────────────────────────────────────────────────────
  let tornApiKey  = (GM_getValue(SK_API_KEY,    "") || "").trim();
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
    .chain-target-btn {
      display:inline-flex !important; align-items:center !important; justify-content:center !important;
      margin-left:4px !important; padding:0 4px !important; height:20px !important; min-width:20px !important;
      border-radius:5px !important; border:1px solid rgba(255,200,0,.5) !important;
      background:rgba(255,180,0,.15) !important; color:#ffd700 !important;
      font-size:12px !important; cursor:pointer !important; vertical-align:middle !important;
      line-height:1 !important; transition:background .12s !important; flex-shrink:0 !important;
    }
    .chain-target-btn:hover    { background:rgba(255,180,0,.35) !important; }
    .chain-target-btn:disabled { opacity:.4 !important; cursor:default !important; }
    .chain-target-btn.claimed  { background:rgba(68,255,136,.2) !important; border-color:rgba(68,255,136,.6) !important; color:#44ff88 !important; }
    .chain-target-btn.loading  { animation:chain-blink .6s linear infinite !important; }
    @keyframes chain-blink { 0%,100%{opacity:1} 50%{opacity:.3} }

    #chain-panel {
      position:fixed !important; right:12px !important; top:60px !important; z-index:999999 !important;
      border-radius:12px !important; background:rgba(16,18,24,.95) !important; color:#e8e8e8 !important;
      box-shadow:0 12px 32px rgba(0,0,0,.55) !important; font-family:Arial,Helvetica,sans-serif !important;
      user-select:none !important; overflow:hidden !important; display:flex !important;
      flex-direction:column !important; min-width:280px !important;
    }
    #chain-panel-header {
      display:flex !important; align-items:center !important; gap:6px !important;
      padding:9px 12px !important; background:rgba(255,255,255,.05) !important;
      border-bottom:1px solid rgba(255,255,255,.08) !important; flex-shrink:0 !important;
    }
    #chain-panel-title {
      font-weight:700 !important; font-size:13px !important; flex:1 !important;
      white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important;
    }
    .chain-hbtn {
      background:rgba(255,255,255,.1) !important; border:1px solid rgba(255,255,255,.15) !important;
      color:#ccc !important; border-radius:6px !important; padding:2px 7px !important;
      font-size:11px !important; cursor:pointer !important; line-height:1.4 !important; white-space:nowrap !important;
    }
    .chain-hbtn:hover       { background:rgba(255,255,255,.2) !important; }
    .chain-hbtn.danger      { border-color:rgba(255,80,80,.5) !important; color:#ff8888 !important; }
    .chain-hbtn.danger:hover{ background:rgba(255,60,60,.25) !important; }

    #chain-panel-body { display:flex !important; flex-direction:column !important; flex:1 !important; overflow:hidden !important; }

    .chain-banner { padding:5px 10px !important; font-size:11px !important; text-align:center !important; flex-shrink:0 !important; line-height:1.3 !important; }
    .chain-banner.warn { color:#ff8888; background:rgba(255,60,60,.08); border-bottom:1px solid rgba(255,60,60,.15); }
    .chain-banner.info { color:#88aacc; background:rgba(80,120,200,.08); border-bottom:1px solid rgba(80,120,200,.15); }

    #chain-col-header {
      display:grid !important; grid-template-columns:26px 1fr 1fr 58px 20px 20px !important;
      gap:0 5px !important; padding:4px 10px !important; font-size:10px !important;
      text-transform:uppercase !important; letter-spacing:.5px !important; color:#445 !important;
      border-bottom:1px solid rgba(255,255,255,.06) !important; flex-shrink:0 !important;
    }
    #chain-panel-inner {
      overflow-y:auto !important; flex:1 !important; max-height:420px !important; padding:4px 0 !important;
    }
    #chain-panel-inner::-webkit-scrollbar { width:5px; }
    #chain-panel-inner::-webkit-scrollbar-thumb { background:rgba(255,255,255,.2); border-radius:3px; }

    .chain-hit-row {
      display:grid !important; grid-template-columns:26px 1fr 1fr 58px 20px 20px !important;
      align-items:center !important; gap:0 5px !important; padding:4px 10px !important;
      border-left:3px solid transparent !important; font-size:11px !important; transition:background .1s !important;
    }
    .chain-hit-row:hover    { background:rgba(255,255,255,.04) !important; }
    .chain-hit-row.due      { border-left-color:#44ff88 !important; animation:chain-pulse 1s ease-in-out infinite alternate !important; }
    .chain-hit-row.soon     { border-left-color:#ffcc66 !important; }
    .chain-hit-row.waiting  { border-left-color:#445 !important; }
    .chain-hit-row.done     { opacity:.4 !important; text-decoration:line-through !important; border-left-color:#222 !important; }
    .chain-hit-row.hosp-waiting { border-left-color:#6699cc !important; background:rgba(80,120,200,.04) !important; }
    .chain-hit-row.hosp-waiting .chain-hit-target::before { content:"🏥 " !important; }
    .chain-hit-row.hosp-waiting .chain-hit-attack { opacity:.25 !important; pointer-events:none !important; }
    @keyframes chain-pulse { from{background:rgba(68,255,136,.04)} to{background:rgba(68,255,136,.14)} }

    .chain-hit-num     { font-weight:700; font-size:12px; color:#666; text-align:center; }
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

    #chain-panel-footer {
      padding:6px 10px !important; border-top:1px solid rgba(255,255,255,.06) !important;
      display:flex !important; align-items:center !important; gap:8px !important; flex-shrink:0 !important;
    }
    #chain-size-label  { font-size:10px; color:#445; white-space:nowrap; }
    #chain-size-slider { flex:1 !important; accent-color:#ffcc66 !important; cursor:pointer !important; }

    #chain-sync-dot {
      width:7px; height:7px; border-radius:50%; flex-shrink:0; background:#445; transition:background .3s;
    }
    #chain-sync-dot.live    { background:#44ff88; }
    #chain-sync-dot.syncing { background:#ffcc66; }
    #chain-sync-dot.error   { background:#ff4444; }
  `);

  // ══════════════════════════════════════════════════════════════════════════
  //  Panel HTML
  // ══════════════════════════════════════════════════════════════════════════
  const panel = document.createElement("div");
  panel.id = "chain-panel";
  panel.innerHTML = `
    <div id="chain-panel-header">
      <span id="chain-sync-dot" title="Sync status"></span>
      <span id="chain-panel-title">⛓ Chain Board</span>
      <button class="chain-hbtn" id="chain-toggle-btn">${minimized ? "＋" : "−"}</button>
      <button class="chain-hbtn danger" id="chain-clear-btn">✕ Clear</button>
    </div>
    <div id="chain-panel-body">
      <div id="chain-banner-nokey"  class="chain-banner warn" style="display:none">⚠ No Torn API key — use Tampermonkey menu.</div>
      <div id="chain-banner-nofb"   class="chain-banner warn" style="display:none">⚠ Firebase not configured — see FIREBASE_SETUP.md.</div>
      <div id="chain-banner-nofact" class="chain-banner info" style="display:none">ℹ Not in a faction — queue unavailable.</div>
      <div id="chain-banner-status" class="chain-banner info" style="display:none"></div>
      <div id="chain-col-header" style="display:none">
        <span>#</span><span>Claimer</span><span>Target</span>
        <span style="text-align:right">Timer</span><span></span><span></span>
      </div>
      <div id="chain-panel-inner">
        <div id="chain-empty" style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.5">
          No hits queued.<br>Click 🎯 next to an attack button to add a target.
        </div>
      </div>
      <div id="chain-panel-footer">
        <span id="chain-size-label">Size</span>
        <input type="range" id="chain-size-slider" min="0" max="100" value="${Math.round(panelSize * 100)}">
      </div>
    </div>`;
  document.body.appendChild(panel);

  // ── Wire controls ─────────────────────────────────────────────────────────
  const panelBody  = document.getElementById("chain-panel-body");
  const toggleBtn  = document.getElementById("chain-toggle-btn");
  const clearBtn   = document.getElementById("chain-clear-btn");
  const sizeSlider = document.getElementById("chain-size-slider");
  const syncDot    = document.getElementById("chain-sync-dot");

  toggleBtn.onclick = () => {
    minimized = !minimized;
    GM_setValue(SK_MINIMIZED, minimized);
    panelBody.style.display = minimized ? "none" : "flex";
    toggleBtn.textContent = minimized ? "＋" : "−";
  };
  if (minimized) panelBody.style.display = "none";

  clearBtn.onclick = () => {
    if (!factionId) return;
    if (!confirm("Clear the entire chain list for your faction?")) return;
    fbWrite([]);
  };

  sizeSlider.oninput = () => {
    panelSize = sizeSlider.value / 100;
    GM_setValue(SK_PANEL_SIZE, panelSize);
    panel.style.width = Math.round(280 + panelSize * 320) + "px";
  };
  panel.style.width = Math.round(280 + panelSize * 320) + "px";

  function setSyncDot(state) {
    syncDot.className = state === "off" ? "" : state;
    syncDot.title = { live:"Live ✓", syncing:"Syncing…", error:"Sync error ✕", off:"Offline" }[state] || "";
  }
  function showBanner(id, show, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = show ? "" : "none";
    if (text !== undefined) el.textContent = text;
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
      inner.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:11px;color:#334;line-height:1.5">No hits queued.<br>Click 🎯 next to an attack button to add a target.</div>`;
      return;
    }

    colHead.style.display = "";
    const now = Date.now();
    let html  = "";

    for (const hit of hitList) {
      const rem   = hit.scheduledAt - now;
      const hosp  = isHospStillIn(hit);
      const tc    = hitTimerClass(rem, hit.status);
      const rc    = hitRowClass(rem, hit.status, hosp);
      const timer = hit.status === "done" ? "Done" : formatTime(rem);
      const hospSub = hosp
        ? `<span class="chain-hit-hosp-sub" data-hosp-id="${hit.id}">out in ${formatTime(hit.hospReleaseAt - now)}</span>`
        : "";

      html += `
        <div class="chain-hit-row ${rc}" data-hit-id="${hit.id}">
          <span class="chain-hit-num">${hit.hitNumber}</span>
          <span class="chain-hit-claimer" title="${escHtml(hit.claimedBy)}">${escHtml(hit.claimedBy)}</span>
          <span class="chain-hit-target"  title="${escHtml(hit.targetName)}">${escHtml(hit.targetName)}</span>
          <span class="chain-hit-timer ${tc}" data-timer-id="${hit.id}">${timer}</span>
          <a class="chain-hit-attack" href="${escHtml(hit.attackUrl)}" target="_blank" title="Attack ${escHtml(hit.targetName)}">⚔</a>
          <button class="chain-row-btn chain-done-btn" data-hit-id="${hit.id}">${hit.status==="done" ? "↩" : "✓"}</button>
          ${hospSub}
        </div>`;
    }

    inner.innerHTML = html;

    inner.querySelectorAll(".chain-done-btn").forEach(btn => {
      btn.onclick = () => {
        const id  = btn.dataset.hitId;
        const updated = hitList.map(h =>
          h.id === id ? { ...h, status: h.status === "done" ? "pending" : "done" } : h
        );
        fbWrite(updated);
      };
    });
  }

  // ── Timer tick ────────────────────────────────────────────────────────────
  setInterval(() => {
    const now = Date.now();
    for (const hit of hitList) {
      if (hit.status === "done") continue;
      const rem  = hit.scheduledAt - now;
      const hosp = isHospStillIn(hit);
      const cell = document.querySelector(`[data-timer-id="${hit.id}"]`);
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
    const auth = fbToken ? `?auth=${fbToken}` : "";
    return `${FIREBASE_DB_URL}/factions/${factionId}/hits.json${auth}`;
  }

  // Anonymous auth — gives each client a token so DB rules can allow access
  function fbSignInAnon(cb) {
    GM_xmlhttpRequest({
      method: "POST",
      url: `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ returnSecureToken: true }),
      timeout: 10000,
      onload(r)   { try { cb(JSON.parse(r.responseText).idToken || null); } catch { cb(null); } },
      onerror()   { cb(null); },
      ontimeout() { cb(null); },
    });
  }

  // Write entire hit list to Firebase
  function fbWrite(newList) {
    if (!factionId || !fbConfigured()) return;
    setSyncDot("syncing");
    GM_xmlhttpRequest({
      method: "PUT",
      url: fbPath(),
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(newList.length ? newList : null),
      timeout: 10000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          hitList = newList;
          setSyncDot("live");
          renderPanel();
        } else {
          setSyncDot("error");
          console.error("[ChainCoord] Write failed", r.status);
        }
      },
      onerror()   { setSyncDot("error"); },
      ontimeout() { setSyncDot("error"); },
    });
  }

  // Read snapshot from Firebase (poll fallback)
  function fbRead() {
    if (!factionId || !fbConfigured()) return;
    GM_xmlhttpRequest({
      method: "GET", url: fbPath(), timeout: 10000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          try {
            const data = JSON.parse(r.responseText);
            hitList = Array.isArray(data) ? data : [];
            setSyncDot("live");
            renderPanel();
          } catch { /**/ }
        }
      },
    });
  }

  // Real-time SSE listener — Firebase REST supports EventSource natively
  function fbStartListener() {
    if (!factionId || !fbConfigured()) return;
    if (sseSource) { try { sseSource.close(); } catch { /**/ } }

    const auth = fbToken ? `?auth=${fbToken}` : "";
    const url  = `${FIREBASE_DB_URL}/factions/${factionId}/hits.json${auth}`;

    try {
      sseSource = new EventSource(url);
      sseSource.addEventListener("put", e => {
        try {
          const payload = JSON.parse(e.data);
          hitList = Array.isArray(payload.data) ? payload.data : [];
          setSyncDot("live");
          renderPanel();
        } catch { /**/ }
      });
      sseSource.onerror = () => {
        setSyncDot("error");
        setTimeout(fbStartListener, 5000); // auto-reconnect
      };
    } catch (err) {
      // SSE blocked in this browser context — polling takes over
      console.warn("[ChainCoord] SSE unavailable, using polling only:", err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Slot-finding algorithm (same logic, now fbWrite instead of persistHits)
  // ══════════════════════════════════════════════════════════════════════════
  const HIT_INTERVAL = 4 * 60 * 1000;

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

    let insertSlot = null;
    let insertPos  = -1;

    if (activeHits.length === 0) {
      insertSlot = earliestAllowed;
    } else {
      for (let i = 0; i <= activeHits.length; i++) {
        const prev      = i === 0 ? now : activeHits[i - 1].scheduledAt;
        const candidate = Math.max(prev + HIT_INTERVAL, earliestAllowed);
        const next      = i < activeHits.length ? activeHits[i].scheduledAt : Infinity;
        if (candidate + HIT_INTERVAL <= next || i === activeHits.length) {
          insertSlot = candidate;
          insertPos  = i - 1;
          break;
        }
      }
      if (insertSlot === null) {
        insertSlot = activeHits[activeHits.length - 1].scheduledAt + HIT_INTERVAL;
        insertPos  = activeHits.length - 1;
      }
    }

    // Push colliding later hits forward
    for (let i = insertPos + 1; i < activeHits.length; i++) {
      const prevTime = i === 0 ? insertSlot : activeHits[i - 1].scheduledAt;
      const required = prevTime + HIT_INTERVAL;
      if (activeHits[i].scheduledAt < required) activeHits[i].scheduledAt = required;
    }

    const newHit = {
      id:           `hit_${now}_${Math.random().toString(36).slice(2)}`,
      hitNumber:    0,
      targetId,
      targetName:   apiData.name || targetName,
      claimedBy:    ownName,
      claimedAt:    now,
      scheduledAt:  insertSlot,
      hospReleaseAt: hospReleaseMs || null,
      attackUrl,
      status:       "pending",
    };

    // Merge: done hits at end, active sorted by scheduledAt
    const merged = [
      ...activeHits, newHit,
      ...hitList.filter(h => h.status === "done"),
    ].sort((a, b) => {
      if (a.status === "done" && b.status !== "done") return 1;
      if (b.status === "done" && a.status !== "done") return -1;
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
    if (!tornApiKey) { alert("Set your Torn API key via the Tampermonkey menu first."); return; }
    if (!factionId)  { alert("Could not detect your faction — make sure your API key is set."); return; }
    if (!fbConfigured()) { alert("Firebase is not configured yet — see FIREBASE_SETUP.md."); return; }

    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "⏳";

    GM_xmlhttpRequest({
      method: "GET",
      url: `https://api.torn.com/user/${encodeURIComponent(targetId)}?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout: 15000,
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
  //  Button injection
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
      const row = a.closest("li") || a.closest('[class*="member"]') || a.closest("tr") || a.parentElement;
      if (!row || row.dataset.chainInjected) return;
      const targetId = getTargetId(a);
      if (!targetId || (ownId && targetId === ownId)) return;
      row.dataset.chainInjected = "1";
      const targetName = getTargetName(row);
      const attackUrl  = extractAttackUrl(a);
      const btn = document.createElement("button");
      btn.className   = "chain-target-btn";
      btn.textContent = "🎯";
      btn.title       = `Add ${targetName} to chain queue`;
      btn.onclick     = e => { e.preventDefault(); e.stopPropagation(); handleTargetClaim(btn, targetId, targetName, attackUrl); };
      a.insertAdjacentElement("afterend", btn);
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
  //  Torn API — resolve own profile + faction, then boot Firebase
  // ══════════════════════════════════════════════════════════════════════════
  function fetchOwnProfile() {
    if (!tornApiKey) { showBanner("chain-banner-nokey", true); return; }
    showBanner("chain-banner-nokey", false);
    showBanner("chain-banner-status", true, "Connecting to Torn API…");

    GM_xmlhttpRequest({
      method: "GET",
      url: `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(tornApiKey)}`,
      timeout: 15000,
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

          showBanner("chain-banner-status", false);

          if (!factionId || factionId === "0") {
            showBanner("chain-banner-nofact", true);
            return;
          }
          showBanner("chain-banner-nofact", false);

          if (!fbConfigured()) {
            showBanner("chain-banner-nofb", true);
            return;
          }
          showBanner("chain-banner-nofb", false);

          // Sign in anonymously, then start real-time listener + initial read
          fbSignInAnon(token => {
            fbToken = token;
            fbStartListener();
            fbRead();
            setInterval(fbRead, POLL_MS);
          });

        } catch (e) {
          showBanner("chain-banner-status", true, "Failed to parse API response.");
        }
      },
      onerror()   { showBanner("chain-banner-status", true, "Network error reaching Torn API."); },
      ontimeout() { showBanner("chain-banner-status", true, "Torn API timed out."); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Tampermonkey menu
  // ══════════════════════════════════════════════════════════════════════════
  GM_registerMenuCommand("Set Torn API Key", () => {
    const v = prompt("Enter your Torn API key:", tornApiKey || "");
    if (v === null) return;
    tornApiKey = v.trim();
    GM_setValue(SK_API_KEY, tornApiKey);
    fetchOwnProfile();
  });

  GM_registerMenuCommand("Clear Torn API Key", () => {
    tornApiKey = "";
    GM_setValue(SK_API_KEY, "");
    showBanner("chain-banner-nokey", true);
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
