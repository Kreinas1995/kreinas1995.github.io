// ==UserScript==
// @name         Torn Chain Coordinator
// @namespace    https://kreinas1995.github.io/
// @version      5.10.1
// @description  Multi-faction shared chain board. Keyed Firebase writes, single SSE per client, presence display, faction-scoped auth.
// @author       Kreinas1995
// @match        https://www.torn.com/*
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
// @grant        unsafeWindow
// @connect      api.torn.com
// @connect      firebaseio.com
// @connect      syph-s-war-overhaul-default-rtdb.firebaseio.com
// @connect      googleapis.com
// @connect      securetoken.googleapis.com
// @connect      identitytoolkit.googleapis.com
// @connect      cloudfunctions.net
// @connect      us-central1-syph-s-war-overhaul.cloudfunctions.net
// @connect      run.app
// @connect      lobbywrite-mic6zyuycq-uc.a.run.app
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js
// @downloadURL  https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════════
  //  DEFENSIVE CODING RULES — READ BEFORE ADDING ANY NEW FEATURE
  //
  //  These rules exist because Opera GX / Violentmonkey has caused silent
  //  script-killing failures that were extremely hard to diagnose. One uncaught
  //  exception in any synchronous IIFE or module-level block kills ALL code
  //  that follows — including fetchOwnProfile() and Firebase init.
  //
  //  1. ALWAYS wrap browser-API access in try/catch at module level.
  //     Affected APIs: console patching, localStorage, MutationObserver,
  //     requestAnimationFrame, navigator.*, document.*, window.*
  //     Example: console.log = fn  →  throws on Opera (frozen native object)
  //     Fix that killed the whole script: _patchConsole had no try/catch (v5.4.2→v5.4.3)
  //
  //  2. NEVER call .click() on display:none elements programmatically.
  //     Opera/Violentmonkey silently drops programmatic clicks on hidden elements.
  //     Always call the target function directly instead.
  //     Example: bugBtn.click() → use openBugTracker() directly
  //
  //  3. ALWAYS use wireCheckbox() for checkbox event listeners, never bare 'change'.
  //     Opera does not reliably fire 'change' on injected panel checkboxes.
  //     wireCheckbox() covers change + click + label click with setTimeout(0).
  //
  //  4. NEVER nest GM_xmlhttpRequest calls beyond what 4.9.10 already did.
  //     Deeply nested XHR callbacks can be silently dropped on some Opera builds.
  //     The removed read-back GET (v5.4.2) was an example of this.
  //
  //  5. Any new IIFE at module level MUST be wrapped in try/catch if it touches
  //     browser APIs that could be frozen, sealed, or restricted in a sandbox.
  //
  //  6. Test with Opera GX + Violentmonkey after any non-trivial change.
  //     Firefox + Tampermonkey is more permissive and will not catch these issues.
  // ══════════════════════════════════════════════════════════════════════════

  // ── Cross-script shared window ───────────────────────────────────────────
  let _xw = window;
  try { if (typeof unsafeWindow !== "undefined") _xw = unsafeWindow; } catch(_) {}

  // ── Singleton guard ───────────────────────────────────────────────────────
  try {
    if (_xw.__tccRunning && document.getElementById("chain-panel")) return;
    _xw.__tccRunning = true;
  } catch(_) {
    if (window.__tccRunning && document.getElementById("chain-panel")) return;
    window.__tccRunning = true;
    _xw = window;
  }

  // Shared debug state — readable by all scopes within this IIFE without window hacks
  const _dbg = {
    verbosePoll:      false,
    verboseMutations: false,
    recordPoll:       null,   // assigned by wireSettings() once the function exists
  };

  // Detect localStorage availability once — before _bg block since _bgLoadPersisted uses it.
  // Opera GX, some Chromium builds, and sandboxed contexts block localStorage even
  // when not on TornPDA. Test it rather than assume.
  const _lsAvailable = (() => {
    if (typeof localStorage === "undefined") return false;
    try {
      const k = "__tcc_ls_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch(_) { return false; }
  })();

  // ── Always-on background diagnostics (persisted across page loads) ─────────
  // Runs unconditionally from boot — zero UI, ~0.01ms overhead per frame.
  // Counters are saved to localStorage on every freeze event and XHR error,
  // and on a 10s flush interval, so data survives page navigation.
  // TornPDA blocks localStorage — skipped there, falls back to session-only.
  const BG_FREEZE_MS  = 150;   // gap threshold to count as a freeze
  const BG_LOG_MAX    = 60;    // ring buffer depth
  const BG_LS_KEY     = "tcc_diag_v1";  // localStorage persistence key
  function _bgLoadPersisted() {
    if (!_lsAvailable) return null;
    try {
      const raw = localStorage.getItem(BG_LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(_) { return null; }
  }

  // _bgSavePersisted: NEVER call synchronously from rAF or hot paths.
  // localStorage.setItem on Firefox Android blocks the main thread (synchronous
  // IndexedDB bridge), and calling it from within a freeze-detection callback
  // creates a feedback loop: freeze → save → blocks → freeze → save → blocks…
  // This was causing the cascading 1000ms+ freeze clusters seen in production.
  //
  // Solution: all saves are debounced through a setTimeout(0) so they run in
  // a future task, never inside the current rAF/timer callback. A dirty flag
  // prevents scheduling redundant save tasks. Minimum 2s between actual writes.
  let _bgSaveDirty  = false;
  let _bgLastSaveAt = 0;
  let _bgSaveQueued = false;
  function _bgSavePersisted() {
    if (!_lsAvailable) return;
    _bgSaveDirty = true;
    if (_bgSaveQueued) return;  // already a save task pending
    const now = Date.now();
    const delay = Math.max(0, 2000 - (now - _bgLastSaveAt));  // min 2s between writes
    _bgSaveQueued = true;
    setTimeout(() => {
      _bgSaveQueued = false;
      if (!_bgSaveDirty) return;
      _bgSaveDirty = false;
      _bgLastSaveAt = Date.now();
      try {
        localStorage.setItem(BG_LS_KEY, JSON.stringify({
          freezeCount: _bg.freezeCount,
          freezeLog:   _bg.freezeLog.slice(0, BG_LOG_MAX),
          xhrTotal:    _bg.xhrTotal,
          xhrErr:      _bg.xhrErr,
          firstSeen:   _bg.firstSeen,
        }));
      } catch(_) {}
    }, delay);
  }

  // Load persisted data from previous page loads
  const _bgPrev = _bgLoadPersisted();
  const _bg = {
    startTime:   Date.now(),                               // this page load start
    firstSeen:   _bgPrev ? _bgPrev.firstSeen : Date.now(),// first ever load (persisted)
    freezeCount: _bgPrev ? _bgPrev.freezeCount : 0,       // cumulative across loads
    freezeLog:   _bgPrev ? _bgPrev.freezeLog   : [],      // persisted freeze events
    xhrTotal:    _bgPrev ? _bgPrev.xhrTotal    : 0,       // cumulative XHR calls
    xhrErr:      _bgPrev ? _bgPrev.xhrErr      : 0,       // cumulative XHR errors
    lastRafTime: 0,
    rafActive:   true,
  };

  (function _bgRafBoot() {
    function _bgRafLoop(now) {
      if (!_bg.rafActive) return;
      const gap = now - _bg.lastRafTime;
      if (_bg.lastRafTime > 0 && gap > BG_FREEZE_MS) {
        // Filter out tab-hidden pauses: rAF stops when the tab is in the background.
        // Gaps >10s while document.hidden was (or is now) true are visibility pauses,
        // not main-thread freezes — exclude them from freeze counts/logs.
        const isVisibilityPause = gap > 10000 || document.hidden;
        if (!isVisibilityPause) {
          _bg.freezeCount++;
          _bg.freezeLog.unshift({ time: new Date().toLocaleTimeString(), gap: Math.round(gap) });
          if (_bg.freezeLog.length > BG_LOG_MAX) _bg.freezeLog.pop();
          _bgSaveDirty = true;
        }
      }
      _bg.lastRafTime = now;
      requestAnimationFrame(_bgRafLoop);
    }
    requestAnimationFrame(_bgRafLoop);
    // No setInterval flush needed — _bgSavePersisted is called from _xhrTracked
    // on every XHR call (debounced, min 2s between writes) so counts are saved continuously.
  })();

  function _bgResetPersisted() {
    _bg.freezeCount = 0; _bg.freezeLog = [];
    _bg.xhrTotal = 0; _bg.xhrErr = 0;
    _bg.firstSeen = Date.now();
    _bgSavePersisted();
  }

  function _bgGenerateReport() {
    const now     = Date.now();
    const pageMs  = now - _bg.startTime;
    const totalMs = now - _bg.firstSeen;
    const pageMin = Math.floor(pageMs / 60000);
    const pageSec = Math.floor((pageMs % 60000) / 1000);
    const totMin  = Math.floor(totalMs / 60000);
    const totSec  = Math.floor((totalMs % 60000) / 1000);
    const lines = [
      `=== TCC Freeze Report v${CURRENT_VERSION} ===`,
      `Time:          ${new Date().toLocaleString()}`,
      `Page uptime:   ${pageMin}m ${pageSec}s`,
      `Total tracked: ${totMin}m ${totSec}s (across page loads)`,
      `Browser:       ${navigator.userAgent}`,
      `Page:          ${window.location.pathname}${window.location.search}`,
      ``,
      `--- Performance (cumulative, survives page navigation) ---`,
      `Freezes (>${BG_FREEZE_MS}ms): ${_bg.freezeCount}`,
      `XHR calls:   ${_bg.xhrTotal}`,
      `XHR errors:  ${_bg.xhrErr}`,
      `XHR/min:     ${totalMs > 0 ? Math.round(_bg.xhrTotal / (totalMs / 60000)) : 0}`,
      ``,
      `--- Chain State ---`,
      `Chain active: ${!!chainStartTime}`,
      `Chain count:  ${liveChainCount ?? "—"}`,
      `Hits in map:  ${hitMap.size}`,
      `Faction:      ${factionId ?? "—"}`,
      ``,
      `--- Last 20 Freezes ---`,
    ];
    _bg.freezeLog.slice(0, 20).forEach((f, i) => {
      lines.push(`  ${i+1}. ${f.time}  ${f.gap}ms`);
    });
    if (!_bg.freezeLog.length) lines.push("  (none recorded)");
    return lines.join("\n");
  }


  // ── XHR instrumentation wrapper ──────────────────────────────────────────
  // Intercepts every GM_xmlhttpRequest call to count calls and errors for the
  // freeze report. Zero overhead: increments a counter, delegates immediately.
  function _xhrTracked(details) {
    // Count XHR for diagnostics. Pass a NEW object to GM_xmlhttpRequest so we never
    // mutate the caller's literal — some Violentmonkey builds on Opera treat the
    // passed object as frozen or proxy-wrapped, causing silent failures if mutated.
    // Also call GM_xmlhttpRequest directly (not via a stored reference) so Opera's
    // binding context is always fresh.
    _bg.xhrTotal++;
    _bgSavePersisted();
    const origErr     = details.onerror;
    const origTimeout = details.ontimeout;
    // ViolentMonkey/Opera accumulates a per-URL response cache for GM_xmlhttpRequest.
    // After a long chain session this cache grows large and persists even after the
    // script is disabled, causing CPU lag until Opera is reinstalled. Fix: append a
    // monotonic cache-bust param to every GET URL so VM never serves a stale cached
    // response. Both Firebase REST and Torn API silently ignore unknown query params.
    let bustUrl = details.url || "";
    if (!details.method || details.method.toUpperCase() === "GET") {
      bustUrl += (bustUrl.includes("?") ? "&" : "?") + "_cb=" + Date.now();
    }
    const wrapped = Object.assign({}, details, {
      url:       bustUrl,
      onerror:   function(...a) { _bg.xhrErr++; _bgSavePersisted(); if (origErr)     origErr.apply(this, a); },
      ontimeout: function(...a) { _bg.xhrErr++; _bgSavePersisted(); if (origTimeout) origTimeout.apply(this, a); },
    });
    GM_xmlhttpRequest(wrapped);
  }


  // ── TornPDA universal Firebase proxy ────────────────────────────────────────
  // TornPDA's GM bridge: PUT/DELETE silently fail; GET callbacks are dropped for
  // non-api.torn.com domains. When TCC_PROXY_URL is set, ALL Firebase operations
  // (GET, PUT, DELETE) go through the tccProxy Cloud Function via POST.
  // On desktop browsers everything goes directly to Firebase REST as before.

  // Extract the DB path from a full Firebase REST URL, stripping .json and auth param.
  function _fbUrlToPath(url) {
    try {
      const u = new URL(url);
      return u.pathname.replace(/\.json$/, "");
    } catch { return null; }
  }

  // Core proxy helper — POSTs to tccProxy and calls back like a normal XHR response.
  function _tccProxy(method, url, data, onload, onerror, ontimeout, timeout) {
    if (!TCC_PROXY_URL || !fbToken || !fbUid) { console.warn("[ChainCoord] _tccProxy skipped: no proxy/token/uid"); if (onerror) onerror({}); return; }
    const path = _fbUrlToPath(url);
    if (!path) { console.warn("[ChainCoord] _tccProxy bad url:", url); if (onerror) onerror({}); return; }
    let _settled = false;
    _xhrTracked({
      method: "POST",
      url: TCC_PROXY_URL,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ token: fbToken, uid: fbUid, method, path, data: data !== undefined ? data : null }),
      timeout: timeout || 10000,
      onload(r) {
        if (_settled) return; _settled = true;
        if (r && r.status >= 200 && r.status < 300) {
          if (method === "GET") {
            // fbGet calls onData(JSON.parse(r.responseText)) — rewrap proxy's {data:...}
            let inner; try { inner = JSON.parse(r.responseText); } catch { inner = {}; }
            if (onload) onload({ status: 200, responseText: JSON.stringify(inner.data !== undefined ? inner.data : null) });
          } else {
            if (onload) onload({ status: 200, responseText: r.responseText });
          }
        } else {
          if (onload) onload(r || { status: 500, responseText: "" });
        }
      },
      onerror(e)  { if (_settled) return; _settled = true; if (onerror)  onerror(e||{}); },
      ontimeout(e){ if (_settled) return; _settled = true; if (ontimeout) ontimeout(e); },
    });
  }

  // fbRequest: used by fbPut/fbDelete via legacy path, and boot lobby write directly.
  // On TornPDA with TCC_PROXY_URL, routes PUT/DELETE through _tccProxy.
  // Legacy fallback: LOBBY_PROXY_URL for lobby PUTs only (pre-tccProxy era).
  function fbRequest(details) {
    const method = (details.method || "GET").toUpperCase();
    if (isTornPDA && (method === "PUT" || method === "DELETE")) {
      if (TCC_PROXY_URL) {
        let payload; try { payload = details.data ? JSON.parse(details.data) : null; } catch { payload = null; }
        _tccProxy(method, details.url, payload,
          details.onload, details.onerror, details.ontimeout, details.timeout);
        return;
      }
      // Legacy fallback: lobby PUT only via LOBBY_PROXY_URL
      if (method === "PUT" && details.url && details.url.includes("/lobby/")) {
        const urlObj = new URL(details.url);
        const authParam = urlObj.searchParams.get("auth");
        let payload; try { payload = JSON.parse(details.data); } catch { payload = {}; }
        let _s = false;
        return _xhrTracked({
          method: "POST", url: LOBBY_PROXY_URL,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ token: authParam, uid: fbUid, data: payload }),
          timeout: details.timeout || 10000,
          onload(r) {
            if (_s) return; _s = true;
            console.log("[ChainCoord] lobbyProxy onload status=" + (r && r.status));
            if (details.onload) details.onload(r);
          },
          onerror(e) { if (_s) return; _s = true; if (details.onerror) details.onerror(e); },
          ontimeout(e){ if (_s) return; _s = true; if (details.ontimeout) details.ontimeout(e); },
        });
      }
      console.log("[ChainCoord] fbRequest TornPDA: " + method + " skipped (no proxy)");
      return;
    }
    return _xhrTracked(details);
  }


  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  CONFIG                                                                  ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const FIREBASE_DB_URL  = "https://syph-s-war-overhaul-default-rtdb.firebaseio.com";
  const FIREBASE_API_KEY = "AIzaSyATeusVjS6_S0JlSVu6su4jghnTRiy2I5w";
  // OWNER_TORN_ID has been removed from client code — owner identity is verified
  // exclusively by Firebase rules (lobby/{uid}/tornId check server-side). This prevents
  // anyone from editing the script to impersonate the owner.
  const CURRENT_VERSION  = "5.10.1";
  // ── v5.8.20 ───────────────────────────────────────────────────────────────
  // • Attack scraper: apiCount ceiling now uses liveChainCount + 1 instead of
  //   strict liveChainCount. The attacks endpoint and chain count poll have
  //   independent intervals — the scraper can receive hit #N before the chain
  //   poll has confirmed count N, causing valid hits to be filtered out. The
  //   +1 buffer matches the scraper filter rules (chainHitNum <= liveChainCount+1).
  // ── v5.8.19 ───────────────────────────────────────────────────────────────
  // • CPU fix (Opera dual-monitor): 1s tick now early-returns when chainStartTime
  //   and liveChainCount are both null. document.hidden is false when the tab is
  //   visible on a second monitor — so between chains the tick was running
  //   syncPendingScheduledAt, DOM patch loops, and notification sort every second
  //   even with nothing to do. Now it costs one null-check and returns immediately.
  //   Only updateTopBarBadge (no-op) runs between chains.
  // ── v5.8.18 ───────────────────────────────────────────────────────────────
  // • Attack scraper: added 60-second buffer to chainStartSec filter. During
  //   warmup (hits 1-9), Torn's API returns chain.start = 0, so chainStartTime
  //   is estimated from timeout. That estimate can land several seconds AFTER
  //   the actual first hit, causing warmup hits to be silently filtered out.
  //   60s of headroom ensures no hit is ever dropped due to estimation error.
  //   This was the primary cause of "Waiting for Data" during warmup for both
  //   Opera and TornPDA users.
  // ── v5.8.17 ───────────────────────────────────────────────────────────────
  // • Attack scraper: onChainStart now fires pollFactionAttacks() immediately
  //   rather than waiting up to 7s for the next interval tick. Eliminates the
  //   "Waiting for Data" delay at chain start, especially noticeable during
  //   warmup when the 4s session-wait + 7s interval = up to 11s before first
  //   attack data arrives.
  // • TornPDA timer: scheduleTouchTooltipTrigger() now also fires from
  //   onChainApiData when chain becomes active and observer is missing —
  //   same trigger point as desktop scheduleTooltipTrigger().
  // ── v5.8.16 ───────────────────────────────────────────────────────────────
  // • TornPDA timer: findChainTimerEl now searches the last 5 body children
  //   (portal nodes) for any leaf element containing MM:SS text — the tooltip
  //   renders as a document.body portal on TornPDA, not inside chain-bar.
  // • TornPDA timer: MutationObserver now also watches timerEl.parentElement for
  //   childList removal. When the portal is removed (tooltip dismissed), the MO
  //   fires, detects !document.contains(timerEl), and re-triggers the touch tap
  //   to re-attach. Previously the observer stayed pointing at a detached node
  //   with retry loop cleared — leaving Observer MISSING indefinitely.
  // ── v5.8.15 ───────────────────────────────────────────────────────────────
  // • TornPDA timer: removed portal watcher and second-tap dismiss entirely —
  //   hiding the tooltip was fighting Torn's state machine causing open/close
  //   flicker. Now: tap opens tooltip, poll attaches observer, then ONE clean
  //   outside pointerdown/pointerup/click closes it. No loops, no visibility
  //   tricks. Tooltip flashes briefly (~700ms) once, then closes cleanly.
  // ── v5.8.14 ───────────────────────────────────────────────────────────────
  // • TornPDA timer: dismiss now fires a second tap on the chain bar (toggle
  //   close) plus the full suite of pointerdown/mousedown/pointerup/mouseup/click
  //   on document.body covering all floating-ui outside-click patterns. Poll
  //   reduced to 700ms max; dismiss fires immediately once observer attaches
  //   rather than waiting out the full poll window.
  // ── v5.8.13 ───────────────────────────────────────────────────────────────
  // • TornPDA timer: fixed tooltip staying open after observer attached. The
  //   dismiss now always fires after the 50ms poll loop (whether or not attach
  //   succeeded) — dispatches mousedown/mouseup on body + click on document to
  //   close floating-ui tooltip. Portal watcher stops and visibility is restored
  //   100ms after dismiss. Removed the premature early-return that skipped the
  //   touch tap when bar-timeleft was already in DOM (boot already handles that).
  // ── v5.8.12 ───────────────────────────────────────────────────────────────
  // • TornPDA chain timer: added scheduleTouchTooltipTrigger() — on TornPDA the
  //   timer observer was never attempted (entire block was !isTornPDA guarded).
  //   Now TornPDA runs startChainTimerObserver() + startTimerRetryLoop() at boot
  //   (catches bar-timeleft if already in DOM), plus a touch-tap trigger that
  //   dispatches touchstart/touchend/click on the chain bar to force Torn to
  //   render the tooltip DOM, then immediately tries to attach the MO observer.
  //   Portal watcher hides any visual flash. Retries every 2s up to 30 attempts.
  // ── v5.8.11 ───────────────────────────────────────────────────────────────
  // • Restored ATTACKS_POLL_MS to 7s (was raised to 15s in v5.8.6). The 15s
  //   interval caused visible "Waiting for Data" delay during chain warmup —
  //   target names took up to 15s to appear after a hit. The document.hidden
  //   guard (v5.8.8) already prevents wasted polls on backgrounded tabs, so
  //   the 15s rate-reduction was unnecessary.
  // ── v5.8.10 ───────────────────────────────────────────────────────────────
  // • Freeze fix (Opera, script disabled): console patch now bails immediately
  //   unless the first argument is a string containing "[ChainCoord]". Torn's
  //   Sendbird chat fires 15+ console.warn calls/min with large error objects —
  //   JSON.stringify on each was causing freezes even after TCC was disabled in
  //   Tampermonkey, because the console patch persists for the page session.
  // ── v5.8.9 ────────────────────────────────────────────────────────────────
  // • Freeze fix (foreground tab, UI minimized/icon): syncPendingScheduledAt()
  //   now additionally requires viewMode===0 && chainStartTime — it's only useful
  //   when the full panel is open and a chain is active, so running it every second
  //   in icon/mini mode or between chains was pure wasted work causing freezes even
  //   with the UI "disabled". Notification sort similarly gated on chainStartTime.
  // ── v5.8.8 ────────────────────────────────────────────────────────────────
  // • Freeze fix (Opera/background tabs): syncPendingScheduledAt(), the timer-cell
  //   DOM patch loop, and the notification sort in the 1s tick now skip entirely
  //   when document.hidden is true. These were the primary source of background
  //   freeze that 5.7.5 didn't have — 5.7.5 was stable overnight because it ran
  //   significantly less work per tick. The poll functions had their guards added
  //   in v5.8.6; these are the remaining heavy operations in the 1s interval.
  // ── v5.8.7 ────────────────────────────────────────────────────────────────
  // • Fix: browser tag was missing from /factions/{fid}/members writes (fbRegisterMember
  //   and fbHeartbeat). presenceMap is populated from members, not lobby, so m.browser
  //   was always undefined — session badges showed version only, no browser name.
  // ── v5.8.6 ────────────────────────────────────────────────────────────────
  // • Rebased on v5.7.5: restored all @connect headers (cloudfunctions.net etc)
  //   and _ua.includes("tornpda") detection dropped in v5.8.1–5.8.5, which
  //   silently blocked all tccProxy calls on TornPDA (root cause of FB polls:0).
  // • Added window.flutter_inappwebview to isTornPDA detection (additive).
  // • Added _browserTag; written to Firebase presence on all lobby/member writes.
  // • Multi-session presence: one row per player with per-session version+browser
  //   badges — multi-client users no longer inflate the online count.
  // • Freeze fix: pollFactionChain, fbPollOnce, pollFactionAttacks now skip when
  //   document.hidden; visibilitychange catchup fires immediately on re-focus.
  // • Idle poll rate: chain poll starts at 30s (CHAIN_POLL_IDLE_MS), switches to
  //   5.3s automatically when a chain session starts, back to 30s when it ends.
  // • Rate-limit backoff: error 5 on chain poll skips 4 cycles (~20s).
  // • ATTACKS_POLL_MS raised 7s → 15s.
  // • Debug console: Copy Report button above log; Clear button in footer;
  //   verbose toggles removed. Minimize no longer leaves 500px height shell.
  // Cloud Function proxy for TornPDA lobby writes — TornPDA's GM bridge only
  // supports GET/POST; this function accepts a POST and writes /lobby/{uid}
  // via Admin SDK. Set to null to disable (falls back to direct PUT, desktop only).
  // Deploy functions/index.js to your Firebase project, then paste the URL here.
  const LOBBY_PROXY_URL  = "https://lobbywrite-mic6zyuycq-uc.a.run.app";
  // Universal Firebase proxy for TornPDA — handles all GET/PUT/DELETE operations.
  // Deploy functions/index.js (tccProxy), add the URL here, then paste into TornPDA.
  const TCC_PROXY_URL    = "https://us-central1-syph-s-war-overhaul.cloudfunctions.net/tccProxy";
  const SCRIPT_RAW_URL     = "https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js";
  const SCRIPT_INSTALL_URL = "https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/torn-chain-coordinator.user.js";

  // ─── Timing constants ─────────────────────────────────────────────────────
  const CHAIN_POLL_MS        = 5300;  // prime-offset vs fbPollOnce(3000) — avoids 10s collision
  const CHAIN_POLL_IDLE_MS   = 30000; // slow poll when no chain active — saves ~10 API calls/min/user
  const PRESENCE_HEARTBEAT   = 15000;
  const PRESENCE_TIMEOUT     = 90000;   // 90s — 6× heartbeat interval, tolerates dropped beats
  const HIT_DELAY_MS         = 4 * 60 * 1000;
  const HIT_INTERVAL         = 5 * 60 * 1000;
  const CHAIN_CONFIRM_HITS   = 10;
  const CHAIN_END_DEBOUNCE   = 8000;
  const TIMER_FUDGE_SEC      = 0;
  const ATTACKS_POLL_MS      = 7000;   // 7s — prime vs CHAIN_POLL_MS(5300) and fbPollOnce(3000)

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
  const SK_DBG_POS_X      = "chain_dbg_pos_x";   // debug console last position
  const SK_DBG_POS_Y      = "chain_dbg_pos_y";
  const SK_DBG_OPEN       = "chain_dbg_open";      // bool: debug console open across page loads
  const SK_DBG_MINIMIZED  = "chain_dbg_minimized"; // bool: debug console minimized state
  // FIX #2: persist chain session so reload doesn't lose history
  const SK_SESSION_ID     = "chain_session_id";
  const SK_SESSION_START  = "chain_session_start";
  const SK_SESSION_MIN    = "chain_session_min";
  const SK_CHAIN_COUNT    = "chain_live_count";
  const SK_ATTACK_CURSOR  = "chain_attack_cursor";  // epoch seconds of last seen attack
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
  const SK_DEBUG_CONSOLE    = "chain_debug_console";          // bool: show debug console panel
  const SK_SHOW_BROWSER     = "chain_show_browser";           // bool: show browser tag in online presence

  // ─── App state ────────────────────────────────────────────────────────────
  // Read API key: localStorage first (survives TM UUID changes on reinstall /
  // paste-install), fall back to GM storage (works with proper TM auto-updates).
  // TornPDA blocks localStorage — detected early so we skip it on PDA.
  const _ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  // TornPDA's UA varies by version — check multiple known signals.
  // Falls back to dataset attribute set by some TornPDA builds.
  const isTornPDA = _ua.includes("TornPDA") || _ua.includes("torn_pda") ||
    _ua.includes("Dart") || _ua.includes("tornpda") ||
    document.documentElement.dataset.tornpda === "true" ||
    typeof window.tornpda !== "undefined" ||
    typeof window.flutter_inappwebview !== "undefined";

  // ── Browser tag — written to Firebase presence so peers can see which
  // client each session is using. Detected once at boot from the UA string.
  const _browserTag = (() => {
    if (isTornPDA) return "TornPDA";
    const ua = _ua.toLowerCase();
    if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
    if (ua.includes("edg/") || ua.includes("edge")) return "Edge";
    if (ua.includes("firefox") || ua.includes("gecko/")) return "Firefox";
    if (ua.includes("safari") && !ua.includes("chrome")) return "Safari";
    if (ua.includes("chrome")) return "Chrome";
    return "Browser";
  })();

  // ── localStorage-mirrored GM storage ────────────────────────────────────────
  // Opera GX + Violentmonkey has a known bug where GM_setValue data doesn't
  // survive page navigation when the script was installed by pasting (new UUID
  // each install wipes stored values). Mirror all settings to localStorage as a
  // fallback so they survive regardless. TornPDA blocks localStorage — skipped there.
  // Read priority: GM_getValue first (correct value), fall back to localStorage.
  // Write: always writes both so they stay in sync.
  const LS_SETT_PREFIX = "tcc_sett_";

  function _gmGet(key, def) {
    const gmVal = GM_getValue(key, null);
    if (gmVal !== null && gmVal !== undefined) return gmVal;
    if (_lsAvailable) {
      try {
        const raw = localStorage.getItem(LS_SETT_PREFIX + key);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          // Write back to GM storage so future reads hit GM first
          GM_setValue(key, parsed);
          return parsed;
        }
      } catch(_) {}
    }
    return def;
  }
  function _gmSet(key, val) {
    GM_setValue(key, val);
    if (_lsAvailable) {
      try { localStorage.setItem(LS_SETT_PREFIX + key, JSON.stringify(val)); } catch(_) {}
    }
  }

  let tornApiKey = "";
  if (!isTornPDA) {
    try { tornApiKey = (localStorage.getItem("tcc_api_key") || "").trim(); } catch { /**/ }
  }
  if (!tornApiKey) tornApiKey = (GM_getValue(SK_API_KEY, "") || "").trim();
  // TornPDA: GM storage is wiped on each paste (new UUID). localStorage is blocked.
  // sessionStorage survives page navigation within a TornPDA session — use as fallback.
  if (!tornApiKey && isTornPDA) {
    try { tornApiKey = (sessionStorage.getItem("tcc_api_key") || "").trim(); } catch { /**/ }
  }
  if (tornApiKey) {
    if (!isTornPDA) { try { localStorage.setItem("tcc_api_key", tornApiKey); } catch { /**/ } }
    GM_setValue(SK_API_KEY, tornApiKey);
    if (isTornPDA) { try { sessionStorage.setItem("tcc_api_key", tornApiKey); } catch { /**/ } }
  }
  let panelW        = _gmGet(SK_PANEL_W, 380);
  // Enforce minimum width in case a narrower value was saved previously
  if (panelW < 360) { panelW = 380; _gmSet(SK_PANEL_W, panelW); }
  let panelH        = _gmGet(SK_PANEL_H, null);
  // viewMode: read from GM storage (desktop) or sessionStorage (TornPDA — GM UUID
  // is wiped on every paste-install so GM_getValue always returns null there).
  // Default: icon (1) on desktop, full (0) on TornPDA only if nothing saved yet.
  let viewMode;
  {
    const gmVal = GM_getValue(SK_VIEW_MODE, null);
    if (gmVal !== null && gmVal !== undefined) {
      viewMode = gmVal;
    } else if (isTornPDA) {
      try {
        const ss = sessionStorage.getItem("tcc_view_mode");
        viewMode = ss !== null ? parseInt(ss) : 0;
      } catch(_) { viewMode = 0; }
    } else {
      viewMode = 0; // Default full panel — never restore icon/mini from stale LS
    }
  }

  // ─── User settings state ──────────────────────────────────────────────────
  let settShowDoneHits   = _gmGet(SK_SHOW_DONE_HITS,   true);
  let settCompactMode    = _gmGet(SK_COMPACT_MODE,     false);
  let settNotifySound    = _gmGet(SK_NOTIFY_SOUND,     false);
  let settTimerFudge     = _gmGet(SK_TIMER_FUDGE_USR,  0);
  let settPanelOpacity   = _gmGet(SK_PANEL_OPACITY,    0.96);
  let settWarnThreshold  = _gmGet(SK_WARN_THRESHOLD,   90);
  let settDangerThreshold= _gmGet(SK_DANGER_THRESHOLD, 30);
  let settShowBonusAlert = _gmGet(SK_SHOW_BONUS_ALERT, true);
  let settMiniShowCount  = _gmGet(SK_MINI_SHOW_COUNT,  true);
  let settAutoExpandDue  = _gmGet(SK_AUTO_EXPAND_DUE,  false);
  let settDebugConsole   = _gmGet(SK_DEBUG_CONSOLE,    false);
  let settShowBrowser    = _gmGet(SK_SHOW_BROWSER,     true);

  // Boot-time resync: force-write all settings back to both GM and localStorage.
  // On Opera GX with Violentmonkey, paste-installing creates a new UUID namespace
  // so GM storage appears empty on page load. The localStorage mirror catches this,
  // but only if the previous session wrote to the same LS key. By re-writing every
  // setting on every boot we ensure both stores are fresh regardless of which one
  // was authoritative this load — so the *next* navigation always has a valid fallback.
  (function _resyncSettings() {
    _gmSet(SK_SHOW_DONE_HITS,   settShowDoneHits);
    _gmSet(SK_COMPACT_MODE,     settCompactMode);
    _gmSet(SK_NOTIFY_SOUND,     settNotifySound);
    _gmSet(SK_TIMER_FUDGE_USR,  settTimerFudge);
    _gmSet(SK_PANEL_OPACITY,    settPanelOpacity);
    _gmSet(SK_WARN_THRESHOLD,   settWarnThreshold);
    _gmSet(SK_DANGER_THRESHOLD, settDangerThreshold);
    _gmSet(SK_SHOW_BONUS_ALERT, settShowBonusAlert);
    _gmSet(SK_MINI_SHOW_COUNT,  settMiniShowCount);
    _gmSet(SK_AUTO_EXPAND_DUE,  settAutoExpandDue);
    _gmSet(SK_DEBUG_CONSOLE,    settDebugConsole);
    _gmSet(SK_SHOW_BROWSER,     settShowBrowser);
  })();
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
  let hitMap        = new Map(); // computed union of pendingMap + doneMap — rebuilt by _invalidateHitCache
  let pendingMap    = new Map(); // user-queued hits — /hits/pending in Firebase
  let doneMap       = new Map(); // scraped done hits — /hits/done/{sessionId} in Firebase
  // ── Hit-derived caches — null means dirty, recompute on next read ──────────
  // Invalidated by _invalidateHitCache() at every hitMap mutation site.
  // Avoids repeated spread+filter+reduce/sort on the 1s tick hot path.
  let _highestDoneCache   = null;  // cached result of getHighestDoneHitNum()
  let _sortedPendingCache = null;  // cached [...pending].sort() for the tick cell loop
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
  let liveChainSecs    = null;   // DOM observer timer — the ONLY source for display
  let lastTimerReadAt  = null;   // performance.now() when DOM timer was last read
  let liveChainCount   = null;
  let lastKnownCount   = null;
  let chainConfirmed   = false;
  let chainHit1Time    = null;
  let scrapedHitIds    = new Set();
  let chainSessionId   = null;
  let chainStartTime   = null;
  let chainEndDebounce = null;
  let sessionMinHitNum = null;
  let chainCooldownSecs   = null;   // seconds remaining on cooldown (from API)
  let _chainStartPending  = false;   // true while waiting for Firebase session before creating a new one
  let chainCooldownReadAt = null;   // performance.now() when cooldown was last read
  let apiTimerSecs        = null;   // API chain timeout — SCHEDULING USE ONLY, never displayed
  let apiTimerReadAt      = null;   // performance.now() when that API poll arrived
  let chainTimerObserver  = null;   // MutationObserver on Torn chain timer element
  let timerRetryInterval  = null;   // fallback retry for DOM observer
  let _cachedTimerEl      = null;   // cached Torn chain timer DOM element
  let networkLatestVersion = null;  // highest version seen across all online clients
  let clientVersionMap     = new Map(); // fbUid → version string for all active clients
  let heartbeatFailCount   = 0;     // consecutive heartbeat lobby failures → triggers re-auth
  // Suppress transient Firebase errors during the first 10s of page load.
  const _bootGraceUntil = Date.now() + 10000;
  let lastAttackId         = null;  // highest attack id seen — used for incremental polling
  let attackPollInterval   = null;  // handle for pollFactionAttacks interval
  let _hospRecheckInterval = null;  // handle for periodic hospital status re-poll
  let hasLimitedKey        = null;  // null=unknown, true=confirmed, false=insufficient
  let _attackBackoffSkips  = 0;     // polls to skip after error 5 (too many requests)
  let _attackBackoffLevel  = 0;     // exponential level — resets after successful poll
  let _startTimeCorrected  = false; // true once chain.start has corrected our warmup estimate
  let _cachedSessionRestored = false; // true when session was pre-loaded from GM cache

  // ── Restore session state from GM storage ────────────────────────────────
  // Restoring chainSessionId/chainStartTime lets applyPatch render scraped hits
  // immediately on page reload without waiting for Firebase. The values are
  // treated as provisional — if Firebase delivers a different session ID,
  // handleRemoteSession will overwrite them. If Firebase confirms the same ID,
  // we keep the restored cursor and skip a redundant backfill poll.
  {
    const cachedId    = GM_getValue(SK_SESSION_ID,    "") || "";
    const cachedStart = GM_getValue(SK_SESSION_START, "") || "";
    const cachedCursor= GM_getValue(SK_ATTACK_CURSOR, "") || "";
    if (cachedId && cachedStart) {
      const startMs = Number(cachedStart);
      const ageMs   = Date.now() - startMs;
      // Only restore if session is less than 2 hours old (same guard as handleRemoteSession)
      if (ageMs < 2 * 60 * 60 * 1000 && ageMs > 0) {
        chainSessionId  = cachedId;
        chainStartTime  = startMs;
        if (cachedCursor) _lastAttackEnded = Number(cachedCursor);
        // Fire an immediate incremental poll once factionId is available (boot completes).
        // Without this, new hits since the cached cursor wait up to 7s for the first interval tick.
        _cachedSessionRestored = true;
      }
    }
  }

  // ── Persist session state helper ──────────────────────────────────────────
  function persistSession() {
    // Persist session state to GM storage so page navigation restores it instantly
    // without waiting for Firebase. This eliminates "Waiting for Data" on tab switch.
    GM_setValue(SK_CHAIN_COUNT,    liveChainCount || "");
    GM_setValue(SK_SESSION_ID,     chainSessionId || "");
    GM_setValue(SK_SESSION_START,  chainStartTime || "");
    GM_setValue(SK_ATTACK_CURSOR,  _lastAttackEnded !== null ? _lastAttackEnded : "");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase path helpers
  // ══════════════════════════════════════════════════════════════════════════
  const auth = () => fbToken ? `?auth=${fbToken}` : "";
  const fBase = () => `${FIREBASE_DB_URL}/factions/${factionId}`;

  const P = {
    root:        () => `${fBase()}.json${auth()}`,
    // Legacy flat hits path — used only for migration detection
    hits:        () => `${fBase()}/hits.json${auth()}`,
    // Phase 2: split pending/done paths
    pendingHits:     ()        => `${fBase()}/hits/pending.json${auth()}`,
    pendingHit:      id        => `${fBase()}/hits/pending/${id}.json${auth()}`,
    pendingHitField: (id, f)   => `${fBase()}/hits/pending/${id}/${f}.json${auth()}`,
    doneHits:        sid       => `${fBase()}/hits/done/${sid}.json${auth()}`,
    doneHit:         (sid, id) => `${fBase()}/hits/done/${sid}/${id}.json${auth()}`,
    doneHitField:    (sid, id, f) => `${fBase()}/hits/done/${sid}/${id}/${f}.json${auth()}`,
    session:     () => `${fBase()}/session.json${auth()}`,
    perms:       () => `${fBase()}/permissions.json${auth()}`,
    perm:        uid => `${fBase()}/permissions/${uid}.json${auth()}`,
    members:     () => `${fBase()}/members.json${auth()}`,
    member:      uid => `${fBase()}/members/${uid}.json${auth()}`,
    memberById:  id  => `${fBase()}/members/torn_${id}.json${auth()}`,
    memberMe:    ()  => ownId ? `${fBase()}/members/torn_${ownId}.json${auth()}` : null,
    lobbyBootstrap:  () => fbUid ? `${FIREBASE_DB_URL}/lobby/${fbUid}.json${auth()}` : null,
    lobbyMe:         () => fbUid ? `${FIREBASE_DB_URL}/lobby/${fbUid}.json${auth()}` : null,
    lobbyMeField:    f  => fbUid ? `${FIREBASE_DB_URL}/lobby/${fbUid}/${f}.json${auth()}` : null,
    lobbyAll:        () => `${FIREBASE_DB_URL}/lobby.json${auth()}`,
    whitelist:       () => `${FIREBASE_DB_URL}/whitelist.json${auth()}`,
    whitelistEntry:  fid => `${FIREBASE_DB_URL}/whitelist/${fid}.json${auth()}`,
    clientVersion:   key => `${FIREBASE_DB_URL}/meta/clientVersions/${key}.json${auth()}`,
    clientVersions:  ()  => `${FIREBASE_DB_URL}/meta/clientVersions.json${auth()}`,
    latestVersion:   ()  => `${FIREBASE_DB_URL}/meta/latestVersion.json${auth()}`,
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
      flex-direction:column !important;
      /* touch-action is NOT set here — it would block scroll on #chain-panel-inner.
         touch-action:none belongs on the drag handle (#chain-panel-header) only. */
      transition:border-radius .15s, width .15s, height .15s !important;
    }

    /* ══ View modes ══════════════════════════════════════════════════════════ */

    /* ── view-full: complete board ── */
    #chain-panel.view-full {
      max-height:calc(100vh - 20px) !important;  /* cap at viewport — inner scrolls */
      display:flex !important; flex-direction:column !important;
    }

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
    #chain-panel.view-mini #chain-outside-bar,
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
    #chain-panel.view-icon #chain-outside-bar,
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
      touch-action:none !important;
    }
    #chain-panel-header:active { cursor:grabbing !important; }
    #chain-panel-inner { overflow-y:auto !important; flex:1 !important; padding:4px 0 !important;
      touch-action:pan-y !important;
    }
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
    #chain-timer-value.ct-danger { color:#ff5555 !important; animation:chain-pulse 1s ease-in-out infinite alternate !important; will-change:opacity !important; }
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
    /* FIX (4.9.9): background-color animations are not GPU-compositable in Chrome and force
       main-thread repaints at 60fps. Replaced with opacity animation on a ::before pseudo-element
       approach — but since we can't use ::before in GM_addStyle easily, we use opacity directly
       on the element. This allows Chrome to compositor-promote the animation off the main thread. */
    @keyframes chain-pulse { from{opacity:0.6} to{opacity:1.0} }

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
      flex-shrink:0; cursor:pointer; display:flex; align-items:center; gap:5px;
      user-select:none;
    }
    .chain-sett-section-hdr:first-child { border-top:none; padding-top:2px; margin-top:0; }
    .chain-sett-section-hdr .chain-sett-section-arrow {
      font-size:7px; transition:transform .15s; display:inline-block; color:#445; flex-shrink:0;
    }
    .chain-sett-section-hdr.open .chain-sett-section-arrow { transform:rotate(90deg); }
    .chain-sett-section-body { display:none; flex-direction:column; }
    .chain-sett-section-body.open { display:flex; }
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

    #chain-panel-inner::-webkit-scrollbar { width:5px; }
    #chain-panel-inner::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:3px; }

    .chain-hit-row {
      display:grid !important; grid-template-columns:48px 1fr 1fr 58px 20px 18px !important;
      align-items:center !important; gap:0 5px !important; padding:4px 10px !important;
      border-left:3px solid transparent !important; font-size:11px !important; transition:background .1s !important;
    }
    .chain-hit-row:hover        { background:rgba(255,255,255,.04) !important; }
    .chain-hit-row.due          { border-left-color:#44ff88 !important; animation:chain-row-pulse 1s ease-in-out infinite alternate !important; will-change:opacity !important; }
    .chain-hit-row.soon         { border-left-color:#ffcc66 !important; }
    .chain-hit-row.waiting      { border-left-color:#445 !important; }
    .chain-hit-row.done         { opacity:.35 !important; border-left-color:#222 !important; }
    .chain-hit-row.hosp-waiting { border-left-color:#6699cc !important; background:rgba(80,120,200,.04) !important; }
    .chain-hit-row.hosp-waiting .chain-hit-target::before { content:"🏥 " !important; }
    .chain-hit-row.hosp-waiting .chain-hit-attack { opacity:.25 !important; pointer-events:none !important; }
    .chain-hit-row.hosp-unreachable { border-left-color:#cc4444 !important; background:rgba(200,40,40,.06) !important; opacity:.65 !important; }
    .chain-hit-row.hosp-unreachable .chain-hit-target::before { content:"⛔ " !important; }
    .chain-hit-row.hosp-unreachable .chain-hit-attack { opacity:.15 !important; pointer-events:none !important; }
    .chain-hit-row.untracked    { border-left-color:#ff8c00 !important; opacity:.5 !important; font-style:italic !important; }
    /* FIX #4: unclaimed placeholder row */
    .chain-hit-row.unclaimed    { border-left-color:#334 !important; border-left-style:dashed !important; opacity:.5 !important; }
    .chain-hit-row.unclaimed .chain-hit-target { color:#ff8888 !important; }
    /* Bonus chain hit — gold highlight */
    .chain-hit-row.bonus        { background:rgba(255,200,0,.10) !important; border-left-color:#ffd700 !important; }
    .chain-hit-row.bonus .chain-hit-num { color:#ffd700 !important; }
    /* FIX (4.9.9): Same compositor fix — opacity instead of background-color. */
    @keyframes chain-row-pulse { from{opacity:0.75} to{opacity:1.0} }

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
        <button id="chain-swt-btn" class="chain-hbtn" title="Syph's War Timers" style="display:none!important;">⚕</button>
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
        <div class="chain-gear-menu-item" id="chain-gmenu-trackerdata" style="display:none">🗄 Tracker Data</div>
        <div class="chain-gear-menu-item" id="chain-gmenu-manage" style="display:none">⚙ Permissions</div>
        <div style="height:1px;background:rgba(255,255,255,.08);margin:2px 4px"></div>
        <div class="chain-gear-menu-item" id="chain-gmenu-debug" style="display:none">🔬 Debug Console</div>
        <div style="height:1px;background:rgba(255,255,255,.08);margin:2px 4px"></div>
        <div class="chain-gear-menu-item" id="chain-gmenu-settings">⚙️ Settings</div>
      </div>

      <!-- Bug dropdown menu (kept for compat) -->
      <div id="chain-bug-menu" style="display:none">
        <div class="chain-bug-menu-item" id="chain-bug-report-item">🪲 Report a Bug</div>
        <div class="chain-bug-menu-item" id="chain-bug-tracker-item">📋 View Bug Tracker</div>
      </div>

      <!-- Tracker Data popover -->
      <div id="chain-trackerdata-popover" class="chain-popover" style="position:absolute;top:42px;left:8px;right:8px;border:1px solid rgba(120,160,255,.3);gap:8px;">
        <div style="font-size:12px;font-weight:700;color:#aac4ff;margin-bottom:2px;">🗄 Tracker Data</div>
        <button id="chain-td-refresh" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(68,200,255,.35);background:rgba(40,160,220,.12);color:#66ccff;font-size:12px;cursor:pointer;text-align:left;">🔄 Refresh Data — re-fetch attack history from current chain start</button>
        <div style="height:1px;background:rgba(255,255,255,.08)"></div>
        <button id="chain-td-wipe" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,80,80,.35);background:rgba(200,40,40,.12);color:#ff8888;font-size:12px;cursor:pointer;text-align:left;">❌ Wipe Tracker — clear all hits and session from Firebase</button>
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
<div style="font-size:10px;color:#778;margin-top:-4px">Requires <b>Limited</b> access for attack tracking</div>
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
          <div class="chain-sett-section-hdr" data-section="display"><span class="chain-sett-section-arrow">▶</span>🖥 Display</div>
          <div class="chain-sett-section-body" id="chain-sett-body-display">

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

            <label class="chain-sett-row">
              <span class="chain-sett-label">Show browser in presence</span>
              <span class="chain-sett-desc">Display browser tag (Chrome, Firefox…) next to version in online list</span>
              <input type="checkbox" id="sett-show-browser" class="chain-sett-toggle">
            </label>

            <div class="chain-sett-row chain-sett-row-slider">
              <span class="chain-sett-label">Panel opacity</span>
              <span class="chain-sett-desc">Background transparency of the panel</span>
              <div class="chain-sett-slider-wrap">
                <input type="range" id="sett-opacity" class="chain-sett-slider" min="50" max="100" step="5">
                <span id="sett-opacity-val" class="chain-sett-slider-val">96%</span>
              </div>
            </div>

          </div>

          <!-- Section: Timer -->
          <div class="chain-sett-section-hdr" data-section="timer"><span class="chain-sett-section-arrow">▶</span>⏱ Timer</div>
          <div class="chain-sett-section-body" id="chain-sett-body-timer">

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

          </div>

          <!-- Section: Behaviour -->
          <div class="chain-sett-section-hdr" data-section="behaviour"><span class="chain-sett-section-arrow">▶</span>🎯 Behaviour</div>
          <div class="chain-sett-section-body" id="chain-sett-body-behaviour">

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

          </div>

          <!-- Section: Debug -->
          <div class="chain-sett-section-hdr" data-section="debug"><span class="chain-sett-section-arrow">▶</span>🔬 Debug</div>
          <div class="chain-sett-section-body" id="chain-sett-body-debug">

            <label class="chain-sett-row">
              <span class="chain-sett-label">Show debug console button</span>
              <span class="chain-sett-desc">Adds a 🔬 Debug Console entry to the ⚙️ menu (off by default)</span>
              <input type="checkbox" id="sett-debug-console" class="chain-sett-toggle">
            </label>

          </div>

          <!-- Section: Reset -->
          <div class="chain-sett-section-hdr" data-section="reset"><span class="chain-sett-section-arrow">▶</span>🔧 Reset</div>
          <div class="chain-sett-section-body" id="chain-sett-body-reset">
            <div style="display:flex;gap:6px;padding:6px 0 2px;">
              <button id="sett-reset-pos" class="chain-sett-action-btn">Reset Position</button>
              <button id="sett-reset-size" class="chain-sett-action-btn">Reset Size</button>
              <button id="sett-reset-all" class="chain-sett-action-btn danger">Reset All</button>
            </div>
            <div id="chain-sett-status" style="font-size:10px;color:#44ff88;min-height:13px;text-align:center;padding-bottom:2px;"></div>
          </div>

          <div class="chain-sett-section-hdr" data-section="companions"><span class="chain-sett-section-arrow">▶</span>📦 Install Companion Scripts</div>
          <div class="chain-sett-section-body" id="chain-sett-body-companions">
            <div style="padding:6px 0 4px;font-size:11px;color:#aaa;line-height:1.4;">
              Optional scripts that work alongside TCC.
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;">
              <div>
                <div style="font-size:12px;font-weight:700;color:#eee;">Syph's War Timers</div>
                <div style="font-size:10px;color:#888;margin-top:2px;">Hospital timers &amp; abroad tracking on faction pages</div>
              </div>
              <a href="https://raw.githubusercontent.com/Kreinas1995/kreinas1995.github.io/main/TornChain/Syphs-War-Timers.user.js" target="_blank"
                 style="flex-shrink:0;padding:5px 10px;border-radius:6px;font-size:11px;
                        border:1px solid rgba(68,255,136,.3);background:rgba(68,255,136,.08);
                        color:#44ff88;text-decoration:none;white-space:nowrap;cursor:pointer;">
                ↓ Install
              </a>
            </div>
          </div>

        </div>
        <button id="chain-settings-close" style="padding:5px 0;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#888;flex-shrink:0;margin-top:6px;">Close</button>
      </div>
    </div>

    <!-- SWT popover -->
    <div id="chain-swt-popover" class="chain-popover" style="left:8px;right:8px;border:1px solid rgba(68,255,136,.25);max-height:85vh;overflow:hidden;">
      <div style="font-size:12px;font-weight:700;color:#44ff88;letter-spacing:.3px;flex-shrink:0;">⚕ Syph's War Timers</div>
      <div style="display:flex;flex-direction:column;gap:0;overflow-y:auto;flex:1;padding-top:4px;">

        <!-- Master toggle -->
        <div class="chain-sett-row" style="padding:8px 0 6px;border-bottom:1px solid rgba(255,255,255,.07);">
          <label class="chain-sett-label" style="font-size:12px;font-weight:700;color:#eee;">Enable War Timers</label>
          <input type="checkbox" id="swt-enabled-cb" class="chain-sett-cb">
        </div>

        <!-- Faction page filters -->
        <div style="font-size:10px;font-weight:700;color:#556;letter-spacing:.4px;text-transform:uppercase;padding:8px 0 4px;">Faction Pages</div>
        <div class="chain-sett-row">
          <label class="chain-sett-label">Show on friendly pages <span class="chain-sett-desc">(your faction)</span></label>
          <input type="checkbox" id="swt-friendly-cb" class="chain-sett-cb">
        </div>
        <div class="chain-sett-row">
          <label class="chain-sett-label">Show on enemy pages <span class="chain-sett-desc">(other factions)</span></label>
          <input type="checkbox" id="swt-enemy-cb" class="chain-sett-cb">
        </div>

        <!-- Sorting -->
        <div style="font-size:10px;font-weight:700;color:#556;letter-spacing:.4px;text-transform:uppercase;padding:8px 0 4px;">Sorting</div>
        <div class="chain-sett-row">
          <label class="chain-sett-label">War sort <span class="chain-sett-desc">(hospitalised first)</span></label>
          <input type="checkbox" id="swt-sort-cb" class="chain-sett-cb">
        </div>

        <!-- API Key -->
        <div style="font-size:10px;font-weight:700;color:#556;letter-spacing:.4px;text-transform:uppercase;padding:8px 0 4px;">API Key</div>
        <div style="display:flex;align-items:center;gap:6px;padding:2px 0 6px;">
          <span id="swt-key-display" style="font-family:monospace;font-size:11px;color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">—</span>
          <button id="swt-key-show-btn" class="chain-sett-action-btn" title="Show/hide key" style="flex-shrink:0;min-width:28px;">👁</button>
          <button id="swt-key-clear-btn" class="chain-sett-action-btn" title="Clear key" style="flex-shrink:0;">Clear</button>
        </div>
        <button id="swt-key-set-btn" class="chain-sett-action-btn" style="width:100%;padding:6px 0;font-size:11px;">Set API Key…</button>
        <div id="swt-status" style="font-size:10px;color:#44ff88;min-height:13px;text-align:center;padding:4px 0 2px;"></div>
      </div>
      <button id="chain-swt-close" style="padding:5px 0;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#888;flex-shrink:0;margin-top:6px;">Close</button>
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
      <div id="chain-banner-limitedkey" class="chain-banner warn" style="display:none">⚠ Attack tracking unavailable — requires a Limited API key AND faction API access enabled on your position (ask your leader).</div>

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
    <div id="chain-outside-bar" style="display:none;align-items:center;padding:5px 8px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0;gap:6px;">
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
      if (outsideBar) outsideBar.style.display = "flex";
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

  // Persist viewMode to GM storage + sessionStorage (TornPDA fallback)
  function _saveViewMode(v) {
    _gmSet(SK_VIEW_MODE, v);
    if (isTornPDA) { try { sessionStorage.setItem("tcc_view_mode", v); } catch(_) {} }
  }

  // View button: full→icon, icon→mini, mini→full
  viewBtn.onclick = e => {
    e.stopPropagation();
    viewMode = (viewMode + 1) % 3;
    _saveViewMode(viewMode);
    applyViewMode();
  };

  // Tapping the icon button panel → expand to mini (not full).
  panel.addEventListener("click", e => {
    if (viewMode !== 1) return;
    if (e.target === viewBtn || e.target.closest("#chain-panel-header button")) return;
    if (panel.dataset.justDragged === "1") { delete panel.dataset.justDragged; return; }
    viewMode = 2;
    _saveViewMode(viewMode);
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
  // showErrorBanner: shows chain-banner-debug but suppressed during boot grace.
  function showErrorBanner(msg) {
    if (Date.now() < _bootGraceUntil) return;
    showBanner("chain-banner-debug", true, msg);
  }

  // ── Close all popovers ────────────────────────────────────────────────────
  function closeAllPopovers() {
    [apiPopover, managePopover, presencePopover,
     document.getElementById("chain-whitelist-popover"),
     document.getElementById("chain-bug-menu"),
     document.getElementById("chain-bug-popover"),
     document.getElementById("chain-tracker-popover"),
     document.getElementById("chain-trackerdata-popover"),
     document.getElementById("chain-gear-menu"),
     document.getElementById("chain-settings-popover"),
     document.getElementById("chain-swt-popover"),
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
      _gmSet(SK_PANEL_W,panelW); _gmSet(SK_PANEL_H,panelH);
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
        _gmSet(SK_PANEL_W,panelW); _gmSet(SK_PANEL_H,panelH);
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
    if (isTornPDA)  { try { sessionStorage.setItem("tcc_api_key", tornApiKey); } catch { /**/ } }
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
    const gTrackerData = document.getElementById("chain-gmenu-trackerdata");
    const gManage    = document.getElementById("chain-gmenu-manage");
    const gWhitelist = document.getElementById("chain-gmenu-whitelist");
    if (gTrackerData) gTrackerData.style.display = canClear ? "" : "none";
    if (gManage)      gManage.style.display      = isLeaderOrCoLeader ? "" : "none";
    if (gWhitelist)   gWhitelist.style.display   = isOwner ? "" : "none";
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
    const _gWire = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
    _gWire("chain-gmenu-bug", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      closeAllPopovers(); closeBugPopovers(); openBugTracker();
    });
    _gWire("chain-gmenu-whitelist", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      whitelistBtn.click();
    });
    _gWire("chain-gmenu-trackerdata", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      closeAllPopovers();
      const pop = document.getElementById("chain-trackerdata-popover");
      if (pop) pop.classList.add("open");
    });
    _gWire("chain-td-refresh", e => {
      e.stopPropagation(); closeAllPopovers();
      // Reset attack cursor and re-fetch from chain start — fills "Waiting for Data" gaps
      // without wiping Firebase. Safe to run at any time during an active chain.
      _lastAttackEnded = null;
      _attackPollInFlight = false;
      pollFactionAttacks();
    });
    _gWire("chain-td-wipe", e => {
      e.stopPropagation(); closeAllPopovers();
      clearBtn.click();
    });
    _gWire("chain-gmenu-manage", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      manageBtn.click();
    });
    _gWire("chain-gmenu-settings", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      const sp = document.getElementById("chain-settings-popover");
      if (sp) { closeAllPopovers(); sp.classList.add("open"); if (window._chainOpenSettings) window._chainOpenSettings(); }
    });
    _gWire("chain-gmenu-debug", e => {
      e.stopPropagation(); gearMenu.classList.remove("open");
      if (window._chainToggleDebugConsole) window._chainToggleDebugConsole();
    });
  })();

  // ── Settings popover close ───────────────────────────────────────────────
  const settingsClose = document.getElementById("chain-settings-close");
  if (settingsClose) settingsClose.onclick = closeAllPopovers;

  // ── SWT integration ──────────────────────────────────────────────────────
  (function wireSwtIntegration() {
    const swtBtn      = document.getElementById("chain-swt-btn");
    const swtPopover  = document.getElementById("chain-swt-popover");
    const swtClose    = document.getElementById("chain-swt-close");
    const swtStatus   = document.getElementById("swt-status");

    if (!swtBtn || !swtPopover) return;

    // Close button
    if (swtClose) swtClose.onclick = closeAllPopovers;

    // Open popover on button click
    swtBtn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = swtPopover.classList.contains("open");
      closeAllPopovers();
      if (!isOpen) {
        refreshSwtPanel();
        swtPopover.classList.add("open");
      }
    });

    function setSwtStatus(msg, color) {
      if (!swtStatus) return;
      swtStatus.textContent = msg;
      swtStatus.style.color = color || "#44ff88";
      if (msg) setTimeout(() => { if (swtStatus.textContent === msg) swtStatus.textContent = ""; }, 2500);
    }

    function refreshSwtPanel() {
      const bridge = _xw.__swtBridge;
      if (!bridge) return;

      const enabledCb  = document.getElementById("swt-enabled-cb");
      const friendlyCb = document.getElementById("swt-friendly-cb");
      const enemyCb    = document.getElementById("swt-enemy-cb");
      const sortCb     = document.getElementById("swt-sort-cb");
      const keyDisplay = document.getElementById("swt-key-display");

      if (enabledCb)  enabledCb.checked  = bridge.enabled;
      if (friendlyCb) friendlyCb.checked = bridge.showFriendly;
      if (enemyCb)    enemyCb.checked    = bridge.showEnemy;
      if (sortCb)     sortCb.checked     = bridge.sortEnabled;
      if (keyDisplay) {
        keyDisplay.textContent = bridge.apiKey
          ? (bridge.showKey ? bridge.apiKey : bridge.getApiKeyMasked())
          : "No key set";
      }
    }

    function wireCheckboxSWT(id, setter) {
      const cb = document.getElementById(id);
      if (!cb) return;
      cb.addEventListener("change", () => {
        try {
          const bridge = _xw.__swtBridge;
          if (bridge) { bridge[setter](cb.checked); setSwtStatus("Saved"); }
        } catch(e) { console.warn("[TCC/SWT]", e); }
      });
    }

    wireCheckboxSWT("swt-enabled-cb",  "setEnabled");
    wireCheckboxSWT("swt-friendly-cb", "setShowFriendly");
    wireCheckboxSWT("swt-enemy-cb",    "setShowEnemy");
    wireCheckboxSWT("swt-sort-cb",     "setSort");

    const showBtn  = document.getElementById("swt-key-show-btn");
    const clearBtn = document.getElementById("swt-key-clear-btn");
    const setBtn   = document.getElementById("swt-key-set-btn");

    if (showBtn) showBtn.onclick = () => {
      try {
        const bridge = _xw.__swtBridge;
        if (bridge) { bridge.setShowKey(!bridge.showKey); refreshSwtPanel(); }
      } catch(e) {}
    };

    if (clearBtn) clearBtn.onclick = () => {
      try {
        const bridge = _xw.__swtBridge;
        if (bridge) { bridge.setApiKey(""); refreshSwtPanel(); setSwtStatus("Key cleared", "#ff8888"); }
      } catch(e) {}
    };

    if (setBtn) setBtn.onclick = () => {
      try {
        const bridge = _xw.__swtBridge;
        const current = bridge?.apiKey || "";
        const input = prompt("Enter your Torn Public API key for Syph's War Timers:", current);
        if (input === null) return;
        if (bridge) { bridge.setApiKey(input); refreshSwtPanel(); setSwtStatus("Key saved"); }
      } catch(e) {}
    };

    // ── Detection poll — show button when SWT is installed ─────────────────
    let swtFound = false;
    function checkSwtPresence() {
      try {
        if (swtFound) return;
        if (_xw.__swtBridge?.installed) {
          swtFound = true;
          swtBtn.style.removeProperty("display");
          // If TCC's factionId is available, share it with SWT
          if (typeof factionId !== "undefined" && factionId && _xw.__swtBridge) {
            _xw.__swtBridge.tccFactionId = factionId;
          }
        }
      } catch(e) {}
    }

    checkSwtPresence();
    setInterval(() => { try { checkSwtPresence(); } catch(e) {} }, 2000);
  })();

  // ── Settings: wire all controls ──────────────────────────────────────────
  (function wireSettings() {
    function applyPanelOpacity(v) {
      panel.style.setProperty("background", `rgba(16,18,24,${v})`, "important");
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

    // ── Debug console ─────────────────────────────────────────────────────────
    // A self-contained overlay panel that tracks freeze events (via rAF), Firebase
    // poll timing, and key state variables. Toggled from Settings → Debug Console.
    // Designed to be the first tool grabbed when a user reports jank or sync issues.
    let _dbgPanel = null;
    let _dbgRafActive = false;
    let _dbgLastTick = 0;
    let _dbgDragging = false, _dbgDragOX = 0, _dbgDragOY = 0, _dbgPosSaveTimer = null;
    let _dbgVerbosePoll = false;      // verbose Firebase poll logging
    let _dbgVerboseMutations = false; // verbose MutationObserver logging
    let _dbgFreezeLog   = [];       // { time, gap }
    let _dbgPollLog     = [];       // { time, ms }
    let _dbgConsoleLogs = [];       // { time, level, msg } — intercepted console output
    let _dbgLastPollTime = 0;
    let _dbgTotalFreezes = 0;
    let _dbgPollCount    = 0;
    const DBG_FREEZE_THRESHOLD = 150;
    const DBG_LOG_MAX = 200;        // keep last 200 console lines

    // ── HTML escape helper ──
    function _escHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    // ── Console interception ──
    // Patch console.log/warn/error once so all TCC output is captured in _dbgConsoleLogs.
    // MUST be wrapped in try/catch: on Opera/Violentmonkey console is a frozen native
    // object. Assigning console.log = fn throws TypeError, which without this catch
    // would escape wireSettings() and kill all subsequent module-level code including
    // fetchOwnProfile() — leaving Firebase permanently disconnected.
    (function _patchConsole() {
      try {
        ["log","warn","error"].forEach(level => {
          const orig = console[level].bind(console);
          console[level] = function(...args) {
            orig(...args);
            // Only capture TCC messages — Torn/Sendbird fires dozens of warns/min and
            // running JSON.stringify on their large error objects on every call causes
            // measurable freezes even when TCC is disabled in Tampermonkey (the patch
            // persists for the page session). Filter to [ChainCoord] prefix only.
            const first = args[0];
            if (typeof first !== "string" || !first.includes("[ChainCoord]")) return;
            const msg = args.map(a => {
              if (a instanceof Error) return a.message + (a.stack ? "\n" + a.stack.split("\n").slice(1,3).join("\n") : "");
              try { return (typeof a === "object" && a !== null) ? JSON.stringify(a) : String(a); }
              catch(_) { return String(a); }
            }).join(" ");
            _dbgConsoleLogs.push({ time: new Date().toLocaleTimeString(), level, msg });
            if (_dbgConsoleLogs.length > DBG_LOG_MAX) _dbgConsoleLogs.shift();
            if (_dbgPanel) _dbgRender();
          };
        });
      } catch(_) {
        // Console is frozen (Opera/Violentmonkey) — skip patching, debug console
        // log capture won't work but everything else functions normally.
      }
    })();

    function _dbgRafLoop(now) {
      if (!_dbgRafActive) return;
      const gap = now - _dbgLastTick;
      if (_dbgLastTick > 0 && gap > DBG_FREEZE_THRESHOLD) {
        _dbgTotalFreezes++;
        _dbgFreezeLog.unshift({ time: new Date().toLocaleTimeString(), gap: Math.round(gap) });
        if (_dbgFreezeLog.length > DBG_LOG_MAX) _dbgFreezeLog.pop();
      }
      _dbgLastTick = now;
      requestAnimationFrame(_dbgRafLoop);
    }

    // Called by fbPollOnce after each successful poll — wired below
    function _dbgRecordPoll() {
      const now = performance.now();
      _dbgPollCount++;
      if (_dbgLastPollTime > 0) {
        const interval = Math.round(now - _dbgLastPollTime);
        _dbgPollLog.unshift({ time: new Date().toLocaleTimeString(), ms: interval });
        if (_dbgPollLog.length > DBG_LOG_MAX) _dbgPollLog.pop();
      }
      _dbgLastPollTime = now;
    }

    function _dbgRender() {
      if (!_dbgPanel) return;
      const _pn = performance.now();

      // DOM timer (display source)
      const domSecs = liveChainSecs !== null && lastTimerReadAt !== null
        ? Math.max(0, Math.floor(liveChainSecs - (_pn - lastTimerReadAt) / 1000)) : null;
      const domAge  = lastTimerReadAt !== null ? Math.round((_pn - lastTimerReadAt) / 1000) : null;
      const domStr  = domSecs !== null ? `${Math.floor(domSecs/60)}:${String(domSecs%60).padStart(2,"0")} (read ${domAge}s ago)` : "— (no DOM timer)";

      // API timer (scheduling only — NEVER displayed)
      const apiSecs = apiTimerSecs !== null && apiTimerReadAt !== null
        ? Math.max(0, Math.floor(apiTimerSecs - (_pn - apiTimerReadAt) / 1000)) : null;
      const apiAge  = apiTimerReadAt !== null ? Math.round((_pn - apiTimerReadAt) / 1000) : null;
      const apiStr  = apiSecs !== null ? `${Math.floor(apiSecs/60)}:${String(apiSecs%60).padStart(2,"0")} (read ${apiAge}s ago)` : "—";

      const obsColor = chainTimerObserver ? "#44ff88" : "#ff5555";
      const obsState = chainTimerObserver ? "ATTACHED ✓" : "MISSING ✗";
      const elInfo   = _cachedTimerEl
        ? `${_cachedTimerEl.tagName}.${String(_cachedTimerEl.className||"").split(" ")[0]}`.slice(0,28)
        : "none";
      const retryStr = timerRetryInterval ? "running" : "off";

      // ── Stats pane ──
      const statsDiv = document.getElementById("tcc-dbg-stats");
      if (statsDiv) {
        statsDiv.innerHTML =
          `<span style="color:#778">DOM timer ▶</span><span style="color:#44ff88;font-size:9px">${domStr}</span>` +
          `<span style="color:#778">API timer ✗</span><span style="color:#ff8844;font-size:9px">${apiStr}</span>` +
          `<span style="color:#778">Observer</span><span style="color:${obsColor}">${obsState}</span>` +
          `<span style="color:#778">Retry loop</span><span style="color:#aaa">${retryStr}</span>` +
          `<span style="color:#778">Cached el</span><span style="color:#aaa;font-size:8px">${elInfo}</span>` +
          `<span style="color:#778">Chain count</span><span style="color:#ffcc66">${liveChainCount ?? "—"}</span>` +
          `<span style="color:#778">chainStart</span><span style="color:#aaa;font-size:8px">${chainStartTime ? new Date(chainStartTime).toLocaleTimeString() : "—"}</span>` +
          `<span style="color:#778">Session</span><span style="color:#aaa;font-size:8px">${chainSessionId ? chainSessionId.slice(0,14)+"…" : "none"}</span>` +
          `<span style="color:#778">Hits</span><span style="color:#aaa">${hitMap.size}</span>` +
          `<span style="color:#778">FB polls</span><span style="color:#aaa">${_dbgPollCount}</span>` +
          `<span style="color:#778">Faction</span><span style="color:#aaa">${factionId || "—"}</span>` +
          `<span style="color:#778">Auth uid</span><span style="color:#aaa;font-size:9px">${fbUid ? fbUid.slice(0,8)+"…" : "—"}</span>` +
          `<span style="color:#778">TornPDA</span><span style="color:${isTornPDA ? "#44ff88" : "#556"}">${isTornPDA ? "yes ✓" : "no"}</span>` +
          `<span style="color:#778">Key stored</span><span style="color:${tornApiKey ? "#44ff88" : "#ff8844"}">${tornApiKey ? "yes ✓" : "missing ✗"}</span>`;
      }

      // ── Freeze log pane ──
      const freezeLogDiv = document.getElementById("tcc-dbg-freezelog");
      if (freezeLogDiv) {
        const now2 = Date.now();
        const totalMs2 = now2 - _bg.firstSeen;
        const totMin2  = Math.floor(totalMs2 / 60000);
        const totSec2  = Math.floor((totalMs2 % 60000) / 1000);
        let fhtml = `<span style="color:#445">Tracked ${totMin2}m${totSec2}s | ` +
          `<span style="color:${_bg.freezeCount>0?"#ff8888":"#44ff88"}">${_bg.freezeCount} freeze${_bg.freezeCount!==1?"s":""}</span> | ` +
          `XHR ${_bg.xhrTotal} (${_bg.xhrErr} err)</span><br>`;
        if (_bg.freezeLog.length) {
          _bg.freezeLog.slice(0, 8).forEach(f => {
            fhtml += `<span style="color:#445">${f.time}</span> <span style="color:#ff8888">⚠ ${f.gap}ms</span><br>`;
          });
          if (_bg.freezeLog.length > 8) {
            fhtml += `<span style="color:#334">…${_bg.freezeLog.length - 8} more — copy report for full list</span>`;
          }
        } else {
          fhtml += `<span style="color:#334">No freezes recorded yet</span>`;
        }
        freezeLogDiv.innerHTML = fhtml;
      }

      // ── Log pane: console output only (freezes are in the freeze log section) ──
      const logDiv = document.getElementById("tcc-dbg-log");
      if (logDiv) {
        const wasAtBottom = logDiv.scrollHeight - logDiv.scrollTop - logDiv.clientHeight < 30;
        const visible = _dbgConsoleLogs.slice(-20);
        let html = "";
        if (!visible.length) {
          html = `<div style="color:#334;padding:4px 0">No log entries yet.</div>`;
        }
        visible.forEach(e => {
          const col = e.level === "error" ? "#ff8888" : e.level === "warn" ? "#ffcc66" : "#aaa";
          const lbl = e.level === "error" ? "ERR" : e.level === "warn" ? "WRN" : "LOG";
          html += `<div style="color:${col};word-break:break-all"><span style="color:#445">${e.time}</span> <b>${lbl}</b> ${_escHtml(e.msg)}</div>`;
        });
        logDiv.innerHTML = html;
        if (wasAtBottom) logDiv.scrollTop = logDiv.scrollHeight;
      }
    }

    // applyDebugConsole: controls visibility of the 🔬 gear menu button.
    // The actual console window is opened/closed by toggleDebugConsole() via that button.
    function applyDebugConsole(on) {
      const btn = document.getElementById("chain-gmenu-debug");
      const sep = btn && btn.previousElementSibling; // the <hr>-style divider before it
      if (btn) btn.style.display = on ? "" : "none";
      if (sep) sep.style.display = on ? "" : "none";
      // If the setting is turned off while the window is open, close it
      if (!on && _dbgPanel) { _dbgPanel.remove(); _dbgPanel = null; _dbgRafActive = false; }
    }

    // toggleDebugConsole: opens the debug window. State persists across page loads.
    // Minimize collapses to title bar only; close removes and saves closed state.
    let _dbgMinimized = _gmGet(SK_DBG_MINIMIZED, false);

    function _dbgApplyMinimized(val) {
      _dbgMinimized = val;
      _gmSet(SK_DBG_MINIMIZED, val);
      if (!_dbgPanel) return;
      const body = _dbgPanel.querySelector(".tcc-dbg-body");
      const minBtn = document.getElementById("tcc-dbg-min");
      if (val) {
        if (body) body.style.display = "none";
        _dbgPanel.style.width = "auto";
        _dbgPanel.style.minWidth = "180px";
        _dbgPanel.style.height = "";
        _dbgPanel.style.maxHeight = "";
        _dbgPanel.style.overflow = "visible";
        if (minBtn) minBtn.textContent = "▲";
      } else {
        if (body) body.style.display = "";
        _dbgPanel.style.width = "340px";
        _dbgPanel.style.minWidth = "";
        _dbgPanel.style.height = "auto";
        _dbgPanel.style.maxHeight = "90vh";
        _dbgPanel.style.overflow = "hidden";
        if (minBtn) minBtn.textContent = "▼";
      }
    }

    function toggleDebugConsole() {
      if (_dbgPanel) {
        _dbgPanel.remove(); _dbgPanel = null;
        _dbgRafActive = false;
        if (_dbgRenderInterval) { clearInterval(_dbgRenderInterval); _dbgRenderInterval = null; }
        _gmSet(SK_DBG_OPEN, false);
        return;
      }
      _gmSet(SK_DBG_OPEN, true);
      _dbgPanel = document.createElement("div");
      _dbgPanel.id = "tcc-debug-panel";
      const _dbgSavedX = GM_getValue(SK_DBG_POS_X, null);
      const _dbgSavedY = GM_getValue(SK_DBG_POS_Y, null);
      const _dbgInitTop   = (_dbgSavedY !== null) ? _dbgSavedY + "px" : "80px";
      const _dbgInitLeft  = (_dbgSavedX !== null) ? _dbgSavedX + "px" : null;
      const _dbgInitRight = (_dbgSavedX !== null) ? "auto" : "20px";
      Object.assign(_dbgPanel.style, {
        position: "fixed", top: _dbgInitTop, right: _dbgInitRight, zIndex: "999997",
        background: "rgba(10,12,18,0.97)", color: "#e8e8e8",
        fontFamily: "monospace", fontSize: "10px",
        borderRadius: "8px", border: "1px solid rgba(100,160,255,.25)",
        width: "340px", userSelect: "text", lineHeight: "1.5",
        boxShadow: "0 4px 24px rgba(0,0,0,.7)",
        display: "flex", flexDirection: "column",
        height: "auto", maxHeight: "90vh", overflow: "hidden",
      });
      if (_dbgInitLeft) _dbgPanel.style.left = _dbgInitLeft;

      // ── Title bar (drag handle) ──
      const titleBar = document.createElement("div");
      Object.assign(titleBar.style, {
        display: "flex", alignItems: "center", gap: "6px",
        padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,.08)",
        cursor: "grab", flexShrink: "0", userSelect: "none",
        background: "rgba(100,160,255,.07)", borderRadius: "8px 8px 0 0",
      });
      titleBar.innerHTML =
        `<span style="color:#88bbff;font-weight:700;font-size:11px;flex:1">🔬 TCC Debug Console <span style="color:#334;font-size:10px;font-weight:400">v${CURRENT_VERSION}</span></span>` +
        `<button id="tcc-dbg-min" style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#aaa;font-size:11px;cursor:pointer;line-height:1;padding:2px 9px;border-radius:4px;margin-right:6px" title="Minimize/Maximize">▼</button>` +
        `<button id="tcc-dbg-close" style="background:rgba(255,60,60,.15);border:1px solid rgba(255,80,80,.3);color:#ff8888;font-size:13px;cursor:pointer;line-height:1;padding:2px 7px;border-radius:4px" title="Close">✕</button>`;
      _dbgPanel.appendChild(titleBar);

      // ── Collapsible body wrapper ──
      const bodyWrap = document.createElement("div");
      bodyWrap.className = "tcc-dbg-body";
      Object.assign(bodyWrap.style, { display: "flex", flexDirection: "column", overflow: "hidden", flex: "1" });

      // ── Stats row ──
      const statsDiv = document.createElement("div");
      statsDiv.id = "tcc-dbg-stats";
      Object.assign(statsDiv.style, {
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px",
        padding: "6px 10px 4px", fontSize: "10px", flexShrink: "0",
        borderBottom: "1px solid rgba(255,255,255,.06)",
      });
      bodyWrap.appendChild(statsDiv);

      // ── Freeze log section ──
      // Header: label + Reset button. Body: XHR counts + persisted freeze events.
      const freezeHdr = document.createElement("div");
      Object.assign(freezeHdr.style, {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "3px 10px 1px", flexShrink: "0",
      });
      freezeHdr.innerHTML =
        `<span style="font-size:9px;font-weight:700;color:#66ccff;letter-spacing:.4px;text-transform:uppercase">📋 Freeze Log (persisted)</span>` +
        `<button id="tcc-dbg-freeze-reset" style="font-size:9px;padding:1px 6px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,80,80,.3);background:rgba(255,60,60,.1);color:#ff8888">Reset</button>`;
      bodyWrap.appendChild(freezeHdr);
      const freezeDiv = document.createElement("div");
      freezeDiv.id = "tcc-dbg-freezelog";
      Object.assign(freezeDiv.style, {
        overflowY: "auto", padding: "2px 10px 4px",
        fontSize: "10px", fontFamily: "monospace",
        height: "78px", flexShrink: "0",
        borderBottom: "1px solid rgba(255,255,255,.06)",
        color: "#aaa",
      });
      bodyWrap.appendChild(freezeDiv);

      // ── Copy Report button (above console log for quick access) ──
      const copyTopDiv = document.createElement("div");
      Object.assign(copyTopDiv.style, {
        display: "flex", gap: "5px", padding: "3px 10px",
        borderTop: "1px solid rgba(255,255,255,.06)", flexShrink: "0",
      });
      copyTopDiv.innerHTML =
        `<button id="tcc-dbg-copy" style="flex:1;background:rgba(100,160,255,.15);border:1px solid rgba(100,160,255,.3);color:#88bbff;border-radius:4px;padding:3px 0;font-size:10px;cursor:pointer;font-family:monospace">Copy report</button>`;
      bodyWrap.appendChild(copyTopDiv);

      // ── Console log area ──
      const logDiv = document.createElement("div");
      logDiv.id = "tcc-dbg-log";
      Object.assign(logDiv.style, {
        overflowY: "auto", padding: "4px 6px",
        fontSize: "10px", fontFamily: "monospace",
        flex: "1", minHeight: "60px", maxHeight: "180px",
        borderBottom: "1px solid rgba(255,255,255,.06)",
      });
      bodyWrap.appendChild(logDiv);

      // ── Footer: Clear button — always visible, never scrolled away ──
      const footerDiv = document.createElement("div");
      Object.assign(footerDiv.style, {
        display: "flex", gap: "5px", padding: "5px 10px 7px",
        flexShrink: "0", borderTop: "1px solid rgba(255,255,255,.08)",
        background: "rgba(10,12,18,0.97)",
      });
      footerDiv.innerHTML =
        `<button id="tcc-dbg-clear" style="flex:1;background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.25);color:#ff8888;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:monospace">Clear log</button>`;
      bodyWrap.appendChild(footerDiv);
      _dbgPanel.appendChild(bodyWrap);

      document.body.appendChild(_dbgPanel);

      // Apply saved minimized state, then wire buttons
      _dbgApplyMinimized(_dbgMinimized);
      const _minBtn = document.getElementById("tcc-dbg-min");
      if (_minBtn) {
        _minBtn.addEventListener("mousedown", e => e.stopPropagation());
        _minBtn.addEventListener("touchstart", e => e.stopPropagation(), { passive: true });
        _minBtn.addEventListener("click", e => { e.stopPropagation(); _dbgApplyMinimized(!_dbgMinimized); });
      }
      const _closeBtn = document.getElementById("tcc-dbg-close");
      if (_closeBtn) {
        _closeBtn.addEventListener("mousedown", e => e.stopPropagation());
        _closeBtn.addEventListener("touchstart", e => e.stopPropagation(), { passive: true });
        _closeBtn.addEventListener("click", e => { e.stopPropagation(); toggleDebugConsole(); });
      }

      // Wire freeze log reset button
      const _freezeResetBtn = document.getElementById("tcc-dbg-freeze-reset");
      if (_freezeResetBtn) {
        _freezeResetBtn.addEventListener("click", e => {
          e.stopPropagation();
          if (confirm("Reset all persisted freeze/XHR counters? This clears data accumulated across all page loads.")) {
            _bgResetPersisted();
            _dbgRender();
          }
        });
      }

      // Wire footer buttons
      document.getElementById("tcc-dbg-copy").onclick = () => {
        const chainSecs = liveChainSecs !== null && lastTimerReadAt !== null
          ? Math.max(0, Math.floor(liveChainSecs - (performance.now() - lastTimerReadAt) / 1000)) : null;
        const chainStr = chainSecs !== null ? `${Math.floor(chainSecs/60)}:${String(chainSecs%60).padStart(2,"0")}` : "—";
        const lines = [
          `TCC Debug Report — ${new Date().toISOString()}`,
          `Version: ${CURRENT_VERSION}`,
          `Browser: ${navigator.userAgent}`,
          `Chain timer: ${chainStr} | count: ${liveChainCount ?? "—"} | hits: ${hitMap.size}`,
          `Freezes (debug console): ${_dbgTotalFreezes} | Freezes (background): ${_bg.freezeCount}`,
          `XHR total: ${_bg.xhrTotal} | XHR errors: ${_bg.xhrErr} | FB polls: ${_dbgPollCount}`,
          ``,
          _bgGenerateReport(),
          ``,
          `Console log:`,
          ..._dbgConsoleLogs.map(e => `  [${e.level}] ${e.time} ${e.msg}`),
        ].join("\n");
        navigator.clipboard.writeText(lines).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = lines; document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); ta.remove();
        });
        const btn = document.getElementById("tcc-dbg-copy");
        if (btn) { btn.textContent = "Copied!"; setTimeout(() => { if (btn) btn.textContent = "Copy report"; }, 1500); }
      };
      document.getElementById("tcc-dbg-clear").onclick = () => {
        // "Clear log" only clears the console log — freeze data is persisted
        // separately and requires the Reset button in the freeze log section.
        _dbgConsoleLogs = []; _dbgFreezeLog = []; _dbgPollLog = [];
        _dbgTotalFreezes = 0; _dbgPollCount = 0; _dbgLastPollTime = 0;
        _dbgRender();
      };

      // Verbose logging controlled via _dbg flags — no UI toggles needed

      // ── Drag logic (mouse + touch; position saved to GM storage on drag end) ──
      function _dbgStartDrag(clientX, clientY) {
        _dbgDragging = true;
        const r = _dbgPanel.getBoundingClientRect();
        _dbgDragOX = clientX - r.left;
        _dbgDragOY = clientY - r.top;
      }
      titleBar.addEventListener("mousedown", ev => {
        if (ev.target.id === "tcc-dbg-close") return;
        _dbgStartDrag(ev.clientX, ev.clientY);
        titleBar.style.cursor = "grabbing";
        ev.preventDefault();
      });
      titleBar.addEventListener("touchstart", ev => {
        if (ev.target.id === "tcc-dbg-close") return;
        const t = ev.touches[0];
        _dbgStartDrag(t.clientX, t.clientY);
        ev.preventDefault();
      }, { passive: false });
      // mousemove/mouseup/touchmove/touchend wired once at module level below

      // Start RAF + render interval
      _dbgRafActive = true;
      _dbgLastTick = performance.now();
      requestAnimationFrame(_dbgRafLoop);
      _dbgRender();
      if (!_dbgRenderInterval) _dbgRenderInterval = setInterval(_dbgRender, 1000);
    }
    let _dbgRenderInterval = null;

    // Module-level drag handlers — wired once, work across panel re-opens
    function _dbgMove(clientX, clientY) {
      if (!_dbgDragging || !_dbgPanel) return;
      const maxX = window.innerWidth  - _dbgPanel.offsetWidth;
      const maxY = window.innerHeight - _dbgPanel.offsetHeight;
      const nx = Math.max(0, Math.min(clientX - _dbgDragOX, maxX));
      const ny = Math.max(0, Math.min(clientY - _dbgDragOY, maxY));
      _dbgPanel.style.left  = nx + "px";
      _dbgPanel.style.top   = ny + "px";
      _dbgPanel.style.right = "auto";
    }
    function _dbgEndDrag() {
      if (!_dbgDragging) return;
      _dbgDragging = false;
      if (!_dbgPanel) return;
      // Debounce save — only write after dragging settles
      clearTimeout(_dbgPosSaveTimer);
      _dbgPosSaveTimer = setTimeout(() => {
        GM_setValue(SK_DBG_POS_X, parseInt(_dbgPanel.style.left));
        GM_setValue(SK_DBG_POS_Y, parseInt(_dbgPanel.style.top));
      }, 300);
    }
    document.addEventListener("mousemove", ev => { _dbgMove(ev.clientX, ev.clientY); });
    document.addEventListener("mouseup",   _dbgEndDrag);
    document.addEventListener("touchmove", ev => {
      if (!_dbgDragging) return;
      ev.preventDefault();
      _dbgMove(ev.touches[0].clientX, ev.touches[0].clientY);
    }, { passive: false });
    document.addEventListener("touchend",  _dbgEndDrag);

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
      const ssbr = document.getElementById("sett-show-browser");
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
      const sdc  = document.getElementById("sett-debug-console");

      if (sd)   sd.checked   = settShowDoneHits;
      if (sc)   sc.checked   = settCompactMode;
      if (sb)   sb.checked   = settShowBonusAlert;
      if (smc)  smc.checked  = settMiniShowCount;
      if (ssbr) ssbr.checked = settShowBrowser;
      if (ss)   ss.checked   = settNotifySound;
      if (sae)  sae.checked  = settAutoExpandDue;
      if (sdc)  sdc.checked  = settDebugConsole;

      if (sop)  { sop.value  = Math.round(settPanelOpacity * 100); }
      if (sopv) { sopv.textContent = Math.round(settPanelOpacity * 100) + "%"; }
      if (sw)   { sw.value   = settWarnThreshold; }
      if (swv)  { swv.textContent  = settWarnThreshold + "s"; }
      if (sdg)  { sdg.value  = settDangerThreshold; }
      if (sdgv) { sdgv.textContent = settDangerThreshold + "s"; }
      if (sf)   { sf.value   = settTimerFudge; }
      if (sfv)  { sfv.textContent  = (settTimerFudge >= 0 ? "+" : "") + settTimerFudge + "s"; }

      // Re-apply debug console visibility every open — ensures the gear menu
      // item stays in sync if anything altered it since the last open.
      applyDebugConsole(settDebugConsole);
    }

    // wireCheckbox: confirmed fix from 4.9.10-opera-debug build.
    // Fires on change, click, and label-click — covers all browser paths.
    function wireCheckbox(id, fn) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => fn(el.checked));
      el.addEventListener("click",  () => setTimeout(() => fn(el.checked), 0));
      const lbl = el.closest("label");
      if (lbl) lbl.addEventListener("click", () => setTimeout(() => fn(el.checked), 0));
    }

    // Toggle handlers
    wireCheckbox("sett-show-done", v => {
      settShowDoneHits = v; _gmSet(SK_SHOW_DONE_HITS, v); scheduleRender();
    });
    wireCheckbox("sett-compact", v => {
      settCompactMode = v; _gmSet(SK_COMPACT_MODE, v); applyCompactMode(v);
    });
    wireCheckbox("sett-bonus-alert", v => {
      settShowBonusAlert = v; _gmSet(SK_SHOW_BONUS_ALERT, v); scheduleRender();
    });
    wireCheckbox("sett-mini-count", v => {
      settMiniShowCount = v; _gmSet(SK_MINI_SHOW_COUNT, v); applyMiniCountVisibility(v);
    });
    wireCheckbox("sett-show-browser", v => {
      settShowBrowser = v; _gmSet(SK_SHOW_BROWSER, v);
      // Re-render presence popover if it's currently open
      if (presencePopover && presencePopover.classList.contains("open")) renderPresence();
    });
    wireCheckbox("sett-sound", v => {
      settNotifySound = v; _gmSet(SK_NOTIFY_SOUND, v); if (v) playDueSound();
    });
    wireCheckbox("sett-auto-expand", v => {
      settAutoExpandDue = v; _gmSet(SK_AUTO_EXPAND_DUE, v);
    });
    wireCheckbox("sett-debug-console", v => {
      settDebugConsole = v; _gmSet(SK_DEBUG_CONSOLE, v); applyDebugConsole(v);
    });

    // ── Collapsible section headers ───────────────────────────────────────────
    // All sections start collapsed. Clicking a header toggles its body.
    (function wireCollapsibleSections() {
      try {
        const settBody = document.getElementById("chain-settings-body");
        if (!settBody) return;
        settBody.querySelectorAll(".chain-sett-section-hdr[data-section]").forEach(hdr => {
          const section = hdr.dataset.section;
          const body    = document.getElementById("chain-sett-body-" + section);
          if (!body) return;
          // Start collapsed
          hdr.classList.remove("open");
          body.classList.remove("open");
          hdr.addEventListener("click", e => {
            e.stopPropagation();
            const isOpen = body.classList.contains("open");
            hdr.classList.toggle("open", !isOpen);
            body.classList.toggle("open", !isOpen);
          });
        });
      } catch (_) { /**/ }
    })();

    // Slider handlers
    document.getElementById("sett-opacity")?.addEventListener("input", e => {
      const v = parseInt(e.target.value) / 100;
      settPanelOpacity = v; _gmSet(SK_PANEL_OPACITY, v);
      applyPanelOpacity(v);
      const sopv = document.getElementById("sett-opacity-val");
      if (sopv) sopv.textContent = Math.round(v * 100) + "%";
    });
    document.getElementById("sett-warn")?.addEventListener("input", e => {
      // Yellow must always be strictly above red — clamp upward if needed
      const raw = parseInt(e.target.value);
      settWarnThreshold = Math.max(raw, settDangerThreshold + 10);
      e.target.value = settWarnThreshold;
      _gmSet(SK_WARN_THRESHOLD, settWarnThreshold);
      const swv = document.getElementById("sett-warn-val");
      if (swv) swv.textContent = settWarnThreshold + "s";
    });
    document.getElementById("sett-danger")?.addEventListener("input", e => {
      // Red must always be strictly below yellow — clamp downward if needed
      const raw = parseInt(e.target.value);
      settDangerThreshold = Math.min(raw, settWarnThreshold - 10);
      e.target.value = settDangerThreshold;
      _gmSet(SK_DANGER_THRESHOLD, settDangerThreshold);
      const sdgv = document.getElementById("sett-danger-val");
      if (sdgv) sdgv.textContent = settDangerThreshold + "s";
    });
    document.getElementById("sett-fudge")?.addEventListener("input", e => {
      settTimerFudge = parseInt(e.target.value); _gmSet(SK_TIMER_FUDGE_USR, settTimerFudge);
      const sfv = document.getElementById("sett-fudge-val");
      if (sfv) sfv.textContent = (settTimerFudge >= 0 ? "+" : "") + settTimerFudge + "s";
    });

    // Reset buttons
    document.getElementById("sett-reset-pos")?.addEventListener("click", () => {
      [SK_POS_X_FULL, SK_POS_Y_FULL, SK_POS_X_ICON, SK_POS_Y_ICON, SK_POS_X_MINI, SK_POS_Y_MINI, SK_POS_X, SK_POS_Y, SK_DBG_POS_X, SK_DBG_POS_Y].forEach(k => GM_setValue(k, null));
      const px = Math.max(0, window.innerWidth - panelW - 12);
      panel.style.left = px + "px"; panel.style.top = "120px";
      settStatusMsg("Position reset ✓");
    });
    document.getElementById("sett-reset-size")?.addEventListener("click", () => {
      panelW = 380; panelH = null;
      _gmSet(SK_PANEL_W, panelW); _gmSet(SK_PANEL_H, null);
      panel.style.width = panelW + "px"; panel.style.height = "";
      settStatusMsg("Size reset ✓");
    });
    document.getElementById("sett-reset-all")?.addEventListener("click", () => {
      if (!confirm("Reset ALL settings to defaults?")) return;
      [SK_SHOW_DONE_HITS, SK_COMPACT_MODE, SK_NOTIFY_SOUND, SK_TIMER_FUDGE_USR,
       SK_PANEL_OPACITY, SK_WARN_THRESHOLD, SK_DANGER_THRESHOLD, SK_SHOW_BONUS_ALERT,
       SK_MINI_SHOW_COUNT, SK_AUTO_EXPAND_DUE, SK_DEBUG_CONSOLE, SK_SHOW_BROWSER,
       SK_PANEL_W, SK_PANEL_H,
       SK_POS_X_FULL, SK_POS_Y_FULL, SK_POS_X_ICON, SK_POS_Y_ICON, SK_POS_X_MINI, SK_POS_Y_MINI
      ].forEach(k => _gmSet(k, null));
      settShowDoneHits = true; settCompactMode = false; settNotifySound = false;
      settTimerFudge = 0; settPanelOpacity = 0.96; settWarnThreshold = 90;
      settDangerThreshold = 30; settShowBonusAlert = true; settMiniShowCount = true;
      settAutoExpandDue = false; settDebugConsole = false; settShowBrowser = true;
      applyDebugConsole(false);
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
    applyDebugConsole(settDebugConsole);

    // Auto-restore debug console if it was open during the last session
    if (_gmGet(SK_DBG_OPEN, false) && settDebugConsole) {
      setTimeout(toggleDebugConsole, 800);
    }

    // Expose functions needed by gear menu wiring (outside this IIFE's scope)
    window._chainOpenSettings       = openSettingsPopover;
    window._chainToggleDebugConsole = toggleDebugConsole;
    // Wire shared _dbg object so outer-scope poll/MO code can reach inner functions/flags
    _dbg.recordPoll = _dbgRecordPoll;
  })();

  clearBtn.onclick = () => {
    if (!canClear || !factionId) return;
    if (!confirm("Clear the entire chain list for your faction?")) return;
    fbClearHits();
    fbDelete(P.session());
    chainSessionId = null;
    chainStartTime = null;
    pendingMap.clear(); doneMap.clear();
    _invalidateHitCache();
    GM_setValue(SK_ATTACK_CURSOR, "");
    GM_setValue(SK_SESSION_ID,    "");
    GM_setValue(SK_SESSION_START, "");
    scheduleRender();
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
    pendingMap.set(outsideHit.id, outsideHit);
    _invalidateHitCache();
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

  // Per-session badge: shows "vX.Y.Z (Browser)" for each active session of a player.
  function sessionBadgeHtml(ver, browser) {
    if (!ver && !browser) return "";
    const parse = v => v ? v.split(".").map(Number) : [0,0,0];
    const [ma, fe, bf]    = parse(CURRENT_VERSION);
    const [ma2, fe2, bf2] = parse(ver);
    let color;
    if (!ver)                                        color = "#556";
    else if (ma2===ma && fe2===fe && bf2===bf)        color = "#44ff88";
    else if (ma2===ma && fe2===fe)                    color = "#ffee44";
    else if (ma2===ma)                                color = "#ff9933";
    else                                              color = "#ff4444";
    const verPart     = ver     ? `v${escHtml(ver)}`          : "?";
    const browserPart = (browser && settShowBrowser) ? ` (${escHtml(browser)})` : "";
    return `<span class="chain-presence-ver" style="color:${color};font-size:10px" title="${escHtml(ver||"unknown")} · ${escHtml(browser||"unknown")}">${verPart}${browserPart}</span>`;
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

    // Group by player name — one row per person, with per-session version+browser badges.
    const byName = new Map(); // name → { tornId, sessions:[{uid,ver,browser,lastSeen}], bestLastSeen }
    presenceMap.forEach((m, uid) => {
      if (!m || !m.name) return;
      const ver      = m.version || clientVersionMap.get(uid) || null;
      const browser  = m.browser || (m.platform === "TornPDA" ? "TornPDA" : null);
      const lastSeen = m.lastSeen || 0;
      if (!byName.has(m.name)) byName.set(m.name, { tornId: m.tornId, sessions: [], bestLastSeen: 0 });
      const entry = byName.get(m.name);
      entry.sessions.push({ uid, ver, browser, lastSeen });
      if (lastSeen > entry.bestLastSeen) entry.bestLastSeen = lastSeen;
      if (!entry.tornId && m.tornId) entry.tornId = m.tornId;
    });

    // Online: active within PRESENCE_TIMEOUT, one row per player
    const onlineEntries = [...byName.entries()]
      .filter(([, e]) => (now - e.bestLastSeen) < PRESENCE_TIMEOUT);
    const online = sortMeFirst(onlineEntries, ([, e]) => {
      const me = e.tornId === ownId || e.sessions.some(s => {
        const m = presenceMap.get(s.uid); return m && m.name === ownName;
      });
      return me ? "" : (byName.get(onlineEntries[0]?.[0])?.sessions[0]?.ver || "");
    });

    // Offline: one row per player, most recent session
    const seenNames = new Set();
    const offlineEntries = [...byName.entries()].filter(([name, e]) => {
      if ((now - e.bestLastSeen) < PRESENCE_TIMEOUT) return false;
      if (!e.sessions.some(s => s.ver)) return false;
      if (seenNames.has(name)) return false;
      seenNames.add(name); return true;
    });
    const offline = sortMeFirst(offlineEntries, ([, e]) => e.sessions[0]?.ver || "");

    // Recompute networkLatestVersion from presenceMap — always in sync with main poll,
    // no separate fetch delay. Covers both online and recently-offline members.
    recomputeNetworkLatestVersion();

    updateOnlineCount();

    if (!online.length) {
      presenceList.innerHTML = `<div style="font-size:11px;color:#445;text-align:center;padding:4px">No one else online</div>`;
    } else {
      online.forEach(([name, entry]) => {
        const row   = document.createElement("div");
        row.className = "chain-presence-row";
        const isMe  = entry.tornId === ownId || name === ownName;
        const badges = entry.sessions.map(s => sessionBadgeHtml(s.ver, s.browser)).join(" ");
        row.innerHTML = `<span class="chain-presence-dot"></span><span class="chain-presence-name">${escHtml(name)}${isMe?" (you)":""}</span>${badges}`;
        presenceList.appendChild(row);
      });
    }

    // Offline section
    if (offlineList && offlineToggle && offlineLabel) {
      offlineLabel.textContent = `OFFLINE (${offline.length})`;
      offlineToggle.style.display = offline.length ? "" : "none";
      offline.forEach(([name, entry]) => {
        const row = document.createElement("div");
        row.className = "chain-presence-row offline";
        const bestVer     = entry.sessions.map(s=>s.ver).filter(Boolean).sort((a,b)=>isNewerVersion(b,a)?-1:1)[0] || null;
        const bestBrowser = entry.sessions[0]?.browser || null;
        row.innerHTML = `<span class="chain-presence-dot offline"></span><span class="chain-presence-name">${escHtml(name)}</span>${sessionBadgeHtml(bestVer, bestBrowser)}`;
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
          _xhrTracked({
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
    const savedH = _gmGet(SK_ADMIN_H, 200);
    inbox.style.height = Math.min(MAX_H, Math.max(MIN_H, savedH)) + "px";

    let resizing=false, startY=0, startH=0;
    function onStart(cy) { resizing=true; startY=cy; startH=inbox.offsetHeight; document.body.style.userSelect="none"; }
    function onMove(cy)  { if(!resizing) return;
      // Handle is ABOVE the inbox. Drag down = shrink, drag up = grow.
      inbox.style.height = Math.min(MAX_H, Math.max(MIN_H, startH-(cy-startY)))+"px"; }
    function onEnd()     { if(!resizing) return; resizing=false; document.body.style.userSelect=""; _gmSet(SK_ADMIN_H, inbox.offsetHeight); }

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
    const savedH = _gmGet(SK_TRACKER_H, 440);
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
      _gmSet(SK_TRACKER_H, trackerPopover.offsetHeight);
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
      fbRequest({
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
    _xhrTracked({
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
                  fbRequest({
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
    fbRequest({
      method: "PUT", url: sentinelUrl,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(1),
      timeout: 10000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          // Confirmed owner — clean up sentinel immediately
          fbRequest({ method: "DELETE", url: sentinelUrl, timeout: 5000,
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
      _xhrTracked({
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
        fbRequest({
          method: "PUT", url: lobbyUrl,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ name: ownName, tornId: ownId, factionId: factionId||"", lastSeen: Date.now(), browser: _browserTag, version: CURRENT_VERSION }),
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
  function hitRowClass(rem, hosp, untracked, hospReleaseAt) {
    if(untracked) return"untracked";
    if(hosp) {
      // If the target won't be out of hospital before the chain window closes,
      // flag as unreachable so it's visually distinct and won't block the queue.
      const chainWindowMs = chainTimerMs();
      if (hospReleaseAt && chainWindowMs > 0 && hospReleaseAt > Date.now() + chainWindowMs) {
        return "hosp-unreachable";
      }
      return"hosp-waiting";
    }
    if(rem<=0)    return"due";
    if(rem<=60000)return"soon";
    return"waiting";
  }

  // chainTimerMs() — DOM observer ONLY. NEVER uses apiTimerSecs.
  function chainTimerMs() {
    if (liveChainSecs !== null && lastTimerReadAt !== null) {
      return Math.max(0, (liveChainSecs * 1000) - (performance.now() - lastTimerReadAt));
    }
    return 0;
  }

  // chainTimerMsForScheduling() — DOM observer only, used for hit window calculations.
  function chainTimerMsForScheduling() {
    if (liveChainSecs !== null && lastTimerReadAt !== null && liveChainCount !== null) {
      return Math.max(0, (liveChainSecs - (performance.now() - lastTimerReadAt) / 1000)) * 1000;
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
    // Allow API timer as fallback so offsets are correct immediately on page load,
    // before the DOM observer attaches.  chainTimerMsForScheduling() handles both sources.
    const hasTimer = liveChainSecs !== null && lastTimerReadAt !== null;
    if (!hasTimer) return;
    const pending = [...hitMap.values()]
      .filter(h => h.status !== "done")
      .sort((a, b) => (a.chainHitNum || a.hitNumber) - (b.chainHitNum || b.hitNumber));
    if (!pending.length) return;

    // Absolute wall-clock instant when the current chain window expires.
    const chainExpiresAt = Date.now() + chainTimerMsForScheduling();

    // The hit number the chain needs right now.
    // For offset math we use liveChainCount + 1 from the live Torn timer, which is
    // the most up-to-date source. However, after confirmation we must never let
    // currentHitNum fall below CHAIN_CONFIRM_HITS + 1 (11) — if Firebase lags and
    // liveChainCount is still low, using it raw would make hits 11+ show giant offsets.
    const chainConfirmedNow = liveChainCount !== null && liveChainCount >= CHAIN_CONFIRM_HITS;
    const currentHitNum = liveChainCount !== null
      ? Math.max(liveChainCount + 1, chainConfirmedNow ? CHAIN_CONFIRM_HITS + 1 : 1)
      : getHighestDoneHitNum() + 1;

    pending.forEach(h => {
      const hitNum = h.chainHitNum || h.hitNumber;
      // During warmup: hits ≤ CHAIN_CONFIRM_HITS (10) share the current window
      // (offset=0). Hits beyond 10 are already past confirmation so stagger them
      // relative to hit 10 (+1 interval for hit 11, +2 for hit 12, etc.).
      // Post-confirmation: normal stagger from currentHitNum.
      let offset;
      if (!chainConfirmedNow) {
        offset = hitNum <= CHAIN_CONFIRM_HITS ? 0 : hitNum - CHAIN_CONFIRM_HITS;
      } else {
        offset = Math.max(0, hitNum - currentHitNum);
      }
      const computed = chainExpiresAt + offset * HIT_INTERVAL;
      // Always apply hosp override — if the target is in hosp past their slot
      // time, push scheduledAt out so the "out in X" label and timer are correct.
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
  // Sort done hits ascending by chainHitNum, deduplicated — one entry per slot.
  // Only shows hits belonging to the current chain session so stale done hits
  // from a previous chain don't bleed into a new chain's board while Firebase
  // propagates the /hits delete.
  function getDoneHits() {
    const all = [...hitMap.values()].filter(h => {
      if (h.status !== "done") return false;
      // If a sessionId is recorded on the hit, only show it when it matches
      // the current session. Hits without sessionId (pre-5.x) are shown always
      // to avoid breaking backwards compatibility.
      if (h.sessionId && chainSessionId && h.sessionId !== chainSessionId) return false;
      return true;
    });
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
  // Invalidate hit-derived caches. Call at every hitMap mutation point.
  function _invalidateHitCache() {
    _highestDoneCache   = null;
    _sortedPendingCache = null;
    // Rebuild hitMap as the union of pendingMap (user queue) and doneMap (scraped history).
    // doneMap is iterated first so pendingMap entries win on key collision (shouldn't happen
    // but pending hits are higher priority).
    hitMap = new Map([...doneMap, ...pendingMap]);
  }

  // Remove a hit from whichever sub-map it lives in
  function _deleteFromMaps(id) {
    pendingMap.delete(id);
    doneMap.delete(id);
  }

  function getHighestDoneHitNum() {
    if (_highestDoneCache !== null) return _highestDoneCache;
    // No session filter — used for slot numbering; higher watermark from a stale
    // session is safer than resetting to 0 and misnumbering new hits.
    _highestDoneCache = [...hitMap.values()]
      .filter(h => h.status === "done" && h.chainHitNum)
      .reduce((m, h) => Math.max(m, h.chainHitNum), 0);
    return _highestDoneCache;
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
          fbPut(P.pendingHitField(h.id, "hitNumber"), newNum);
        }
      }
    });
  }

  // resolveHospGaps: called after hitMap changes (new hit queued, Firebase poll).
  //
  // For each pending hit blocked by hospital (hospReleaseAt > its natural chain slot):
  //   1. Compute how many slots back it needs to move (slotsBack).
  //   2. For each vacated natural slot:
  //      a. Pull the earliest non-hosp, non-gap hit from after that slot forward.
  //      b. If no filler, create an unspecified gap entry in Firebase.
  //   3. Push the hosp hit's scheduledAt to its release-aligned slot.
  //   4. Delete unspecified gaps that are now covered by real hits.
  //
  // Uses the same natural-slot formula as syncPendingScheduledAt so the two
  // functions agree on what "natural" means.
  function resolveHospGaps() {
    if (!fbConfigured() || !fbToken) return;

    // ── Stale gap cleanup ───────────────────────────────────────────────────
    // Unspecified gaps were created to buffer hosp-blocked hits. They become
    // stale when: (a) the hosp hit was removed from the queue, or (b) the target
    // came out of hospital and their hospReleaseAt has passed. In either case,
    // delete the gaps so they don't linger as phantom Unclaimed rows.
    const hospHits = [...hitMap.values()]
      .filter(h => h.status !== "done" && h.hospReleaseAt && !h.unspecified);
    const now = Date.now();

    // A gap is stale if no active hosp-blocked hit has its scheduledAt ahead of the gap.
    // Simpler: any unspecified gap whose scheduledAt is in the past (or whose paired
    // hosp hit has hospReleaseAt <= now) should be cleaned up.
    [...hitMap.values()]
      .filter(h => h.unspecified && h.status === "pending")
      .forEach(gap => {
        // A gap is needed only if there's an active hosp hit whose scheduledAt is
        // beyond this gap (meaning this gap is buffering it). If no such hit exists,
        // the gap is stale — delete it regardless of whether it's past or future.
        const stillNeeded = hospHits.some(h =>
          h.hospReleaseAt > now && h.scheduledAt > gap.scheduledAt
        );
        if (!stillNeeded) {
          _deletedHitIds.add(gap.id);
          fbDelete(P.pendingHit(gap.id));
          _deleteFromMaps(gap.id);
          _invalidateHitCache();
        }
      });
    // ── End stale gap cleanup ───────────────────────────────────────────────

    // chainTimerMsForScheduling() returns 0 when no timer is active — natural slots
    // all collapse to Date.now(), which is still correct: any hospReleaseAt > now
    // will trigger gap creation, and slots get correct times once the timer attaches.
    const chainExpiresAt = Date.now() + chainTimerMsForScheduling();
    const chainConfirmedNow = liveChainCount !== null && liveChainCount >= CHAIN_CONFIRM_HITS;
    const currentHitNum = liveChainCount !== null
      ? Math.max(liveChainCount + 1, chainConfirmedNow ? CHAIN_CONFIRM_HITS + 1 : 1)
      : getHighestDoneHitNum() + 1;

    function naturalSlotForHit(h) {
      const hitNum = h.chainHitNum || h.hitNumber;
      let offset;
      if (!chainConfirmedNow) {
        offset = hitNum <= CHAIN_CONFIRM_HITS ? 0 : hitNum - CHAIN_CONFIRM_HITS;
      } else {
        offset = Math.max(0, hitNum - currentHitNum);
      }
      return chainExpiresAt + offset * HIT_INTERVAL;
    }

    let pending = [...hitMap.values()]
      .filter(h => h.status !== "done")
      .sort((a, b) => (a.chainHitNum || a.hitNumber) - (b.chainHitNum || b.hitNumber));

    if (!pending.length) return;

    let changed = false;

    for (const h of pending) {
      if (!h.hospReleaseAt || h.unspecified) continue;

      const naturalSlot = naturalSlotForHit(h);
      if (h.hospReleaseAt <= naturalSlot) continue; // hosp clears before natural slot — no gap

      const slotsBack = Math.ceil((h.hospReleaseAt - naturalSlot) / HIT_INTERVAL);
      if (slotsBack <= 0) continue;

      // Refresh pending after each modification
      pending = [...hitMap.values()]
        .filter(x => x.status !== "done")
        .sort((a, b) => (a.chainHitNum || a.hitNumber) - (b.chainHitNum || b.hitNumber));

      for (let s = 0; s < slotsBack; s++) {
        const gapTime = naturalSlot + s * HIT_INTERVAL;

        // Already have a real (non-gap) hit at this slot time?
        const occupied = [...hitMap.values()].find(x =>
          x.status !== "done" && x !== h && !x.unspecified &&
          Math.abs(x.scheduledAt - gapTime) < 5000
        );
        if (occupied) continue;

        // Try to pull the earliest eligible non-hosp hit from a later slot
        const allPending = [...hitMap.values()]
          .filter(x => x.status !== "done" && x !== h && !x.unspecified &&
                       !(x.hospReleaseAt && x.hospReleaseAt > gapTime) &&
                       x.scheduledAt > gapTime + 5000)
          .sort((a, b) => a.scheduledAt - b.scheduledAt);
        const filler = allPending[0] || null;

        if (filler) {
          filler.scheduledAt = gapTime;
          fbPut(P.pendingHitField(filler.id, "scheduledAt"), gapTime);
          changed = true;
          continue;
        }

        // No filler — create an unspecified gap if not already present
        const existingGap = [...hitMap.values()].find(x =>
          x.unspecified && x.status !== "done" && Math.abs(x.scheduledAt - gapTime) < 5000
        );
        if (existingGap) continue;

        const gapId = `gap_${(chainSessionId||"s").slice(0,8)}_${Math.round(gapTime/1000)}_${Math.random().toString(36).slice(2,5)}`;
        const gapHit = {
          id: gapId, hitNumber: 0, targetId: null, targetName: "Unclaimed",
          claimedBy: null, claimedAt: Date.now(), scheduledAt: gapTime,
          hospReleaseAt: null, attackUrl: null, status: "pending",
          outside: true, unspecified: true, sessionId: chainSessionId,
        };
        pendingMap.set(gapId, gapHit);
        _invalidateHitCache();
        gapHit._fbCommitted = true;
        fbPut(P.pendingHit(gapId), gapHit);
        changed = true;
      }

      // Push the hosp hit to its release-aligned slot
      const newHospSlot = naturalSlot + slotsBack * HIT_INTERVAL;
      if (Math.abs(h.scheduledAt - newHospSlot) >= 1000) {
        h.scheduledAt = newHospSlot;
        fbPut(P.pendingHitField(h.id, "scheduledAt"), newHospSlot);
        changed = true;
      }
    }

    // Clean up unspecified gaps whose slot time is now covered by a real hit
    const realSlotTimes = new Set(
      [...hitMap.values()]
        .filter(h => h.status !== "done" && !h.unspecified)
        .map(h => Math.round(h.scheduledAt / 1000))
    );
    for (const h of [...hitMap.values()]) {
      if (!h.unspecified || h.status === "done") continue;
      if (realSlotTimes.has(Math.round(h.scheduledAt / 1000))) {
        _deletedHitIds.add(h.id);
        fbDelete(P.pendingHit(h.id));
        _deleteFromMaps(h.id);
        _invalidateHitCache();
        changed = true;
      }
    }

    // ── Sort hosp hits by release time so earliest-releasing fills earliest slot ──
    // When multiple hosp targets are queued, they should occupy slots in release-time
    // order: the target who gets out soonest should be assigned the earliest open slot.
    // Without this, insertion order determines position, which can put a target out
    // in 8 minutes at slot 88 while a slot 82 gap sits unclaimed.
    const hospPending = [...hitMap.values()]
      .filter(h => h.status !== "done" && h.hospReleaseAt && !h.unspecified)
      .sort((a, b) => a.hospReleaseAt - b.hospReleaseAt);

    if (hospPending.length > 1) {
      // Collect their current scheduledAt values, sort ascending
      const hospSlots = hospPending.map(h => h.scheduledAt).sort((a, b) => a - b);
      // Reassign: earliest release time gets earliest slot
      let hospChanged = false;
      hospPending.forEach((h, i) => {
        if (Math.abs(h.scheduledAt - hospSlots[i]) >= 1000) {
          h.scheduledAt = hospSlots[i];
          fbPut(P.pendingHitField(h.id, "scheduledAt"), hospSlots[i]);
          changed = true;
          hospChanged = true;
        }
      });
    }

    if (changed) { reNumberPending(); scheduleRender(); }
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
    fbRequest({
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
            showErrorBanner("❌ Firebase "+r.status+": "+msg);
          } catch { syncDot.title="Sync error "+r.status; showErrorBanner("❌ Firebase error "+r.status+": "+r.responseText); }
        }
      },
      onerror(e)  { setSyncDot("error"); showErrorBanner("❌ Network error reaching Firebase. Check @connect firebaseio.com in script header."); console.warn("[ChainCoord] Firebase PUT network error", e && e.status, e && e.statusText); },
      ontimeout(){ setSyncDot("error"); showErrorBanner("❌ Firebase PUT timed out — DB may be unreachable."); console.warn("[ChainCoord] Firebase PUT timeout"); },
    });
  }

  function fbDelete(url, onDone) {
    if (!fbConfigured()) return;
    fbRequest({
      method:"DELETE", url,
      timeout:10000,
      onload(r) { if(r.status>=200&&r.status<300&&onDone)onDone(); },
      onerror(){}, ontimeout(){},
    });
  }

  function fbGet(url, onData) {
    if (!fbConfigured()) return;
    if (isTornPDA && TCC_PROXY_URL) {
      _tccProxy("GET", url, null,
        (r) => { try { if (r.status >= 200 && r.status < 300) onData(JSON.parse(r.responseText)); } catch(e) { console.warn("[ChainCoord] fbGet proxy parse error", e); } },
        () => { console.warn("[ChainCoord] fbGet proxy onerror", url.replace(/auth=[^&]+/,"auth=***").slice(0,60)); },
        () => { console.warn("[ChainCoord] fbGet proxy timeout", url.replace(/auth=[^&]+/,"auth=***").slice(0,60)); },
        10000
      );
      return;
    }
    _xhrTracked({
      method:"GET", url, timeout:10000,
      headers: { "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" },
      onload(r) {
        try { if(r.status>=200&&r.status<300) onData(JSON.parse(r.responseText)); }
        catch(e) { console.warn("[ChainCoord] fbGet parse error", e, r && r.responseText && r.responseText.slice(0,80)); }
      },
      onerror()  { console.warn("[ChainCoord] fbGet onerror", url && url.replace(/auth=[^&]+/,"auth=***").slice(0,80)); },
      ontimeout(){ console.warn("[ChainCoord] fbGet timeout", url && url.replace(/auth=[^&]+/,"auth=***").slice(0,80)); },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Firebase anonymous auth
  // ══════════════════════════════════════════════════════════════════════════
  function fbSignInAnon(cb) {
    let _settled = false;
    _xhrTracked({
      method:"POST",
      url:`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify({returnSecureToken:true}),
      timeout:10000,
      onload(r) {
        if (_settled) { console.log("[ChainCoord] fbSignInAnon onload ignored (settled)"); return; }
        _settled = true;
        try {
          const d = JSON.parse(r.responseText);
          if (!d.idToken) {
            console.warn("[ChainCoord] Firebase anon auth failed:", r.responseText);
            showBanner("chain-banner-status", true, "⚠ Firebase auth failed — check API key or project settings.");
          }
          if (d.refreshToken) {
            fbRefreshToken = d.refreshToken;
            const expiresIn = parseInt(d.expiresIn || 3600);
            setTimeout(fbRefreshIdToken, (expiresIn - 300) * 1000);
          }
          cb(d.idToken||null, d.localId||null);
        } catch(e) { console.warn("[ChainCoord] Firebase auth parse error",e); cb(null,null); }
      },
      onerror(e)  {
        if (_settled) { console.log("[ChainCoord] fbSignInAnon onerror ignored (settled)"); return; }
        _settled = true;
        console.warn("[ChainCoord] Firebase auth network error",e); cb(null,null);
      },
      ontimeout(){
        if (_settled) return;
        _settled = true;
        console.warn("[ChainCoord] Firebase auth timeout"); cb(null,null);
      },
    });
  }

  function fbRefreshIdToken() {
    if (!fbRefreshToken) return;
    let _settled = false;
    _xhrTracked({
      method:"POST",
      url:`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify({ grant_type:"refresh_token", refresh_token:fbRefreshToken }),
      timeout:10000,
      onload(r) {
        if (_settled) return; _settled = true;
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
            fbSignInAnon((token, uid) => { if (token) fbToken = token; });
          }
        } catch(e) { console.warn("[ChainCoord] Token refresh parse error",e); }
      },
      onerror()  {
        if (_settled) return; _settled = true;
        console.warn("[ChainCoord] Token refresh network error — will retry"); setTimeout(fbRefreshIdToken, 30000);
      },
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
    // TornPDA: lobby write goes through _tccProxy via fbPut → fbRequest
    if (!isTornPDA) fbPut(lobbyUrl, { name: ownName, tornId: ownId, factionId: factionId, lastSeen: Date.now(), browser: _browserTag, version: CURRENT_VERSION });
    // Member record keyed by torn_{tornId} — stable across page loads, no dedup needed.
    // One-time GET at boot to check if a newer-version peer has written a version
    // we should preserve. After this read, _memberVersionToWrite is set and
    // fbHeartbeat() uses it directly — no more GET on every heartbeat.
    fbGet(P.memberMe(), existing => {
      const storedVer = existing && existing.version ? existing.version : null;
      if (storedVer && isNewerVersion(storedVer, CURRENT_VERSION)) {
        // Another device has written a newer version — preserve it in heartbeats
        _memberVersionToWrite = storedVer;
      } else {
        _memberVersionToWrite = CURRENT_VERSION;
      }
      _memberVersionConfirmed = true;
      fbPut(P.memberMe(), { name: ownName, tornId: ownId, lastSeen: Date.now(), version: _memberVersionToWrite, browser: _browserTag });
    });
    fbPut(P.clientVersion("torn_"+ownId), { version: CURRENT_VERSION, name: ownName, lastSeen: Date.now() });
  }

  // FIX A (v5.2.0): Eliminated nested fbGet inside fbHeartbeat.
  // Previously: PUT lobby → GET memberMe → PUT memberMe + PUT clientVersion
  //             = 4 GM XHR calls/15s = 960/hr accumulating nested closures.
  // Now:        PUT lobby → PUT memberMe + PUT clientVersion
  //             = 3 GM XHR calls/15s, no nesting.
  // Version protection: _memberVersionConfirmed tracks whether we've seen a
  // newer version stored by another device. Once confirmed we write that version
  // instead of CURRENT_VERSION so we never downgrade a peer's newer write.
  let _memberVersionConfirmed = false;
  let _memberVersionToWrite   = CURRENT_VERSION;  // safe default: our own version

  function fbHeartbeat() {
    if (!factionId || !ownId || !fbUid || !fbConfigured()) return;
    const now = Date.now();
    const lobbyUrl = P.lobbyMe();
    if (!lobbyUrl) return;

    // Write lobby first — member write is authorized by rules reading lobby.factionId.
    // No nested GET needed — version is cached in _memberVersionToWrite.
    // TornPDA: fbRequest routes this PUT through _tccProxy automatically.
    fbRequest({
      method: "PUT", url: lobbyUrl,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ name: ownName, tornId: ownId, factionId: factionId, lastSeen: now, browser: _browserTag, version: CURRENT_VERSION }),
      timeout: 8000,
      onload(r) {
        if (r.status >= 200 && r.status < 300) {
          heartbeatFailCount = 0;
          // Write member record using cached version — no inner GET needed.
          // _memberVersionToWrite starts as CURRENT_VERSION and is only updated
          // if fbRegisterMember() reads a newer version stored by another device.
          fbPut(P.memberMe(), { name: ownName, tornId: ownId, lastSeen: Date.now(), version: _memberVersionToWrite, browser: _browserTag });
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
    if (attackPollInterval)   { clearInterval(attackPollInterval);   attackPollInterval   = null; }
    if (heartbeatInterval)    { clearInterval(heartbeatInterval);    heartbeatInterval    = null; }
    if (versionPollInterval)  { clearInterval(versionPollInterval);  versionPollInterval  = null; }
    if (ownerCleanupInterval) { clearInterval(ownerCleanupInterval); ownerCleanupInterval = null; }
    if (ssePollInterval)      { clearInterval(ssePollInterval);      ssePollInterval      = null; }
    if (_hospRecheckInterval) { clearInterval(_hospRecheckInterval); _hospRecheckInterval = null; }
    // Disconnect DOM timer observer — re-attaches when setupTimerObserver retry fires
    if (chainTimerObserver)   { chainTimerObserver.disconnect();     chainTimerObserver   = null; }
    if (timerRetryInterval)   { clearInterval(timerRetryInterval);   timerRetryInterval   = null; }
    _cachedTimerEl = null;
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

  // Catch-up poll: fires immediately when the tab becomes visible again after being hidden.
  let _visibilityWired = false;
  function _wireVisibilityCatchup() {
    if (_visibilityWired) return;
    _visibilityWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      fbPollOnce();
      pollFactionChain();
    });
  }

  let pollInFlight = false;
  function fbPollOnce() {
    if (!factionId || !fbConfigured()) return;
    if (document.hidden) return;  // skip while tab hidden — catchup fires on visibilitychange
    if (pollInFlight) return;  // skip if previous poll hasn't returned yet
    pollInFlight = true;

    // TornPDA: Firebase GETs have silent callbacks — route through proxy
    if (isTornPDA && TCC_PROXY_URL) {
      _tccProxy("GET", P.root(), null,
        (r) => {
          pollInFlight = false;
          if (r && r.status >= 200 && r.status < 300) {
            try {
              if (r.responseText === lastPollResponse) { setSyncDot("live"); return; }
              lastPollResponse = r.responseText;
              const data = JSON.parse(r.responseText);
              queuePatch("/", data);
              if (_dbg.recordPoll) _dbg.recordPoll();
              setSyncDot("live");
              showBanner("chain-banner-debug", false);
            } catch(e) { console.warn("[ChainCoord] Poll parse error", e); }
          } else {
            setSyncDot("error");
            console.warn("[ChainCoord] Poll failed", r && r.status);
          }
        },
        () => { pollInFlight = false; setSyncDot("error"); },
        () => { pollInFlight = false; setSyncDot("error"); },
        8000
      );
      return;
    }

    _xhrTracked({
      method: "GET",
      url: P.root(),
      headers: { "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" },
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
            queuePatch("/", data);
            if (_dbg.recordPoll) _dbg.recordPoll();
            if (_dbg.verbosePoll) console.log("[ChainCoord] Poll OK — status:", r.status, "| bytes:", r.responseText.length, "| changed:", r.responseText !== lastPollResponse);
            setSyncDot("live");
            showBanner("chain-banner-debug", false);
          } catch(e) {
            const snippet = r.responseText ? r.responseText.slice(0, 120) : "(empty)";
            console.warn("[ChainCoord] Poll parse error:", e.message || String(e), "| response:", snippet);
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
            showErrorBanner("❌ Poll failed "+r.status+": "+msg);
            console.warn("[ChainCoord] Poll failed", r.status, r.responseText);
          }
        }
      },
      onerror()  { pollInFlight=false; setSyncDot("error"); showErrorBanner("❌ Poll network error — check @connect firebaseio.com"); },
      ontimeout(){ pollInFlight=false; setSyncDot("error"); },
    });
  }

  // ── Patch debounce ────────────────────────────────────────────────────────
  // GM_xmlhttpRequest callbacks for fbPollOnce, pollFactionChain, and fbHeartbeat
  // can all land within the same ~100ms window (their intervals share common
  // multiples at ~15s and ~30s). Without debouncing, each callback independently
  // calls applyPatch → reNumberPending → scheduleRender, triggering multiple
  // hitMap rebuilds and innerHTML rewrites in a single event loop drain — causing
  // the ~2.5s paint stall User D experiences every ~10s on Chrome.
  //
  // queuePatch collapses all patches arriving within 50ms into one deferred batch.
  // The RAF-debounced scheduleRender() already collapses the render calls; this
  // handles the upstream CPU work (JSON processing, hitMap rebuild) that happens
  // before scheduleRender is even reached.
  let _patchDebounceTimer = null;
  let _pendingPatches     = [];

  function queuePatch(path, data) {
    _pendingPatches.push({ path, data });
    if (_patchDebounceTimer) return;
    _patchDebounceTimer = setTimeout(() => {
      _patchDebounceTimer = null;
      const batch = _pendingPatches.splice(0);
      // If the batch contains a root ("/") patch, it supersedes all others —
      // the root payload already contains hits, session, members, and permissions.
      // Applying individual sub-patches on top would double-process the same data.
      const rootPatch = batch.find(p => p.path === "/");
      if (rootPatch) {
        applyPatch("/", rootPatch.data);
      } else {
        for (const { path, data } of batch) applyPatch(path, data);
      }
    }, 50);
  }

    // Route a Firebase patch to the right handler
  function applyPatch(path, data) {
    if (path === "/hits") {
      // Root /hits delivery — could be old flat format (migration) or new split format
      if (data === null) {
        pendingMap.clear(); doneMap.clear(); _deletedHitIds.clear(); _invalidateHitCache();
      } else if (data && typeof data === "object") {
        // New format: data has "pending" and/or "done" sub-keys
        if ("pending" in data || "done" in data) {
          _applyPendingData(data.pending || null);
          _applyDoneData(data.done || null);
        } else {
          // Legacy flat format — migrate in place
          _migrateFlatHits(data);
        }
        _invalidateHitCache();
      }
      reNumberPending(); resolveHospGaps(); setSyncDot("live"); scheduleRender();
      return;
    }

    if (path === "/hits/pending") {
      _applyPendingData(data);
      _invalidateHitCache();
      reNumberPending(); resolveHospGaps(); setSyncDot("live"); scheduleRender();
      return;
    }

    const doneSessionMatch = path.match(/^\/hits\/done\/([^/]+)$/);
    if (doneSessionMatch) {
      if (doneSessionMatch[1] === chainSessionId) {
        _applyDoneData(data ? { [doneSessionMatch[1]]: data } : null);
        _invalidateHitCache();
      }
      setSyncDot("live"); scheduleRender();
      return;
    }


    const pendingHitMatch = path.match(/^\/hits\/pending\/([^/]+)$/);
    if (pendingHitMatch) {
      const id = pendingHitMatch[1];
      if (data === null) {
        pendingMap.delete(id);
        _deletedHitIds.delete(id);
      } else if (!_deletedHitIds.has(id) && data && data.status && data.targetName) {
        data._fbCommitted = true;
        pendingMap.set(id, data);
      }
      _invalidateHitCache(); reNumberPending(); setSyncDot("live"); scheduleRender();
      return;
    }

    const pendingHitFieldMatch = path.match(/^\/hits\/pending\/([^/]+)\/(.+)$/);
    if (pendingHitFieldMatch) {
      const [, id, field] = pendingHitFieldMatch;
      if (pendingMap.has(id)) {
        const parts = field.split("/");
        let obj = pendingMap.get(id);
        for (let i = 0; i < parts.length - 1; i++) { if (!obj[parts[i]]) obj[parts[i]] = {}; obj = obj[parts[i]]; }
        obj[parts[parts.length - 1]] = data;
        _invalidateHitCache(); reNumberPending(); setSyncDot("live"); scheduleRender();
      }
      return;
    }

    const doneHitMatch = path.match(/^\/hits\/done\/([^/]+)\/([^/]+)$/);
    if (doneHitMatch) {
      const [, sid, id] = doneHitMatch;
      if (sid !== chainSessionId) return; // ignore other sessions
      if (data === null) {
        doneMap.delete(id);
      } else if (data && data.status && data.targetName) {
        data._fbCommitted = true;
        doneMap.set(id, data);
      }
      _invalidateHitCache(); setSyncDot("live"); scheduleRender();
      return;
    }

    const doneHitFieldMatch = path.match(/^\/hits\/done\/([^/]+)\/([^/]+)\/(.+)$/);
    if (doneHitFieldMatch) {
      const [, sid, id, field] = doneHitFieldMatch;
      if (sid !== chainSessionId || !doneMap.has(id)) return;
      const parts = field.split("/");
      let obj = doneMap.get(id);
      for (let i = 0; i < parts.length - 1; i++) { if (!obj[parts[i]]) obj[parts[i]] = {}; obj = obj[parts[i]]; }
      obj[parts[parts.length - 1]] = data;
      _invalidateHitCache(); setSyncDot("live"); scheduleRender();
      return;
    }

    // Legacy flat /hits/{id} paths — handle for migration period
    const hitMatch = path.match(/^\/hits\/([^/]+)$/);
    if (hitMatch && !["pending","done"].includes(hitMatch[1])) {
      const id = hitMatch[1];
      if (data === null) {
        pendingMap.delete(id); doneMap.delete(id);
        _deletedHitIds.delete(id);
      } else if (!_deletedHitIds.has(id) && data && data.status && data.targetName) {
        data._fbCommitted = true;
        if (data.status === "done") doneMap.set(id, data);
        else pendingMap.set(id, data);
      }
      _invalidateHitCache(); reNumberPending(); setSyncDot("live"); scheduleRender();
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
        if ("hits" in data) {
          const hits = data.hits;
          if (hits === null) {
            pendingMap.clear(); doneMap.clear(); _deletedHitIds.clear();
          } else if (hits && typeof hits === "object") {
            if ("pending" in hits || "done" in hits) {
              // New split format
              _applyPendingData(hits.pending || null);
              _applyDoneData(hits.done || null);
            } else {
              // Legacy flat format
              _migrateFlatHits(hits);
            }
          }
          _invalidateHitCache();
          scrapedHitIds.clear();
          for (const h of doneMap.values()) {
            if (h.chainHitNum && chainSessionId)
              scrapedHitIds.add((chainSessionId||"nosession") + "_hit_" + h.chainHitNum);
          }
        }
        if ("session" in data) handleRemoteSession(data.session || null);
        permissions = (data.permissions && typeof data.permissions==="object") ? data.permissions : {};
        presenceMap.clear();
        if (data.members && typeof data.members==="object") {
          Object.entries(data.members).forEach(([uid,m]) => { if(m) presenceMap.set(uid,m); });
        }
        fbSyncLobbyPresence();
        recomputeNetworkLatestVersion();
        updateOnlineCount();
        reNumberPending();
        resolveHospGaps();
        updateClearBtn();
        setSyncDot("live");
        scheduleRender();
      } else {
        showBanner("chain-banner-debug", true, "⚠ SSE root: data was null/empty — rules may be blocking read");
        setTimeout(()=>showBanner("chain-banner-debug",false), 8000);
      }
    }
  }

  // ── applyPatch helpers ───────────────────────────────────────────────────

  function _applyPendingData(data) {
    if (data === null) {
      pendingMap.clear(); return;
    }
    if (!data || typeof data !== "object") return;
    // Merge — add/update hits present in Firebase
    Object.entries(data).forEach(([id, h]) => {
      if (!h || !h.status || !h.targetName) {
        if (!_deletedHitIds.has(id)) { _deletedHitIds.add(id); fbDelete(P.pendingHit(id)); }
        return;
      }
      if (_deletedHitIds.has(id)) return;
      h._fbCommitted = true;
      pendingMap.set(id, h);
    });
    // Remove hits Firebase deleted
    for (const [id, h] of pendingMap) {
      if (!(id in data) && h._fbCommitted && !_deletedHitIds.has(id)) pendingMap.delete(id);
    }
    _deletedHitIds.forEach(id => { if (!(id in data)) _deletedHitIds.delete(id); });
  }

  function _applyDoneData(data) {
    // data is { [sessionId]: { [hitId]: hit } } or null
    if (!data || typeof data !== "object") { doneMap.clear(); return; }
    const sessionHits = data[chainSessionId];
    doneMap.clear();
    if (!sessionHits || typeof sessionHits !== "object") return;
    Object.entries(sessionHits).forEach(([id, h]) => {
      if (h && h.status && h.targetName) {
        h._fbCommitted = true;
        doneMap.set(id, h);
      }
    });
  }

  function _migrateFlatHits(data) {
    // Legacy: data is { [hitId]: hit } flat structure — migrate to split paths
    if (!data || typeof data !== "object") return;
    const toWritePending = [];
    const toWriteDone = [];
    Object.entries(data).forEach(([id, h]) => {
      if (!h || !h.status || !h.targetName) return;
      h._fbCommitted = true;
      if (h.status === "done") {
        doneMap.set(id, h);
        toWriteDone.push([id, h]);
      } else {
        pendingMap.set(id, h);
        toWritePending.push([id, h]);
      }
    });
    // Write to new paths and delete old flat nodes
    if (chainSessionId) {
      toWriteDone.forEach(([id, h]) => fbPut(P.doneHit(chainSessionId, id), h));
    }
    toWritePending.forEach(([id, h]) => fbPut(P.pendingHit(id), h));
    // Delete the old flat /hits/{id} nodes
    Object.keys(data).forEach(id => fbDelete(`${fBase()}/hits/${id}.json${auth()}`));
    console.log("[ChainCoord] Migrated", Object.keys(data).length, "flat hits to split pending/done structure");
  }

  // ── Hit path helpers — route to pending or done based on status ───────────
  function _hitPath(hit) {
    return hit.status === "done"
      ? P.doneHit(chainSessionId || "nosession", hit.id)
      : P.pendingHit(hit.id);
  }
  function _hitFieldPath(hitId, field) {
    const hit = hitMap.get(hitId);
    if (!hit) return P.pendingHitField(hitId, field); // fallback
    return hit.status === "done"
      ? P.doneHitField(chainSessionId || "nosession", hitId, field)
      : P.pendingHitField(hitId, field);
  }

  function fbWriteHit(hit) {
    hit._fbCommitted = true;
    const isPending = hit.status !== "done";
    if (isPending) {
      pendingMap.set(hit.id, hit);
      fbPut(P.pendingHit(hit.id), hit);
    } else {
      doneMap.set(hit.id, hit);
      fbPut(P.doneHit(chainSessionId || "nosession", hit.id), hit);
    }
    _invalidateHitCache();
    reNumberPending();
    resolveHospGaps();
    scheduleRender();
  }

  function fbUpdateHitField(hitId, field, value) {
    fbPut(_hitFieldPath(hitId, field), value);
    if (pendingMap.has(hitId)) {
      pendingMap.get(hitId)[field] = value;
    } else if (doneMap.has(hitId)) {
      doneMap.get(hitId)[field] = value;
    }
    _invalidateHitCache();
    reNumberPending();
    scheduleRender();
  }

  function fbUpdateHit(hitId, updates) {
    if (!hitMap.has(hitId)) return;
    const hit = { ...hitMap.get(hitId), ...updates };
    const wasPending = pendingMap.has(hitId);
    const nowDone = hit.status === "done";

    if (wasPending && nowDone) {
      // Transitioning pending → done: move from pendingMap to doneMap
      pendingMap.delete(hitId);
      fbDelete(P.pendingHit(hitId));
      doneMap.set(hitId, hit);
      fbPut(P.doneHit(chainSessionId || "nosession", hitId), hit);
    } else if (wasPending) {
      pendingMap.set(hitId, hit);
      fbPut(P.pendingHit(hitId), hit);
    } else {
      doneMap.set(hitId, hit);
      fbPut(P.doneHit(chainSessionId || "nosession", hitId), hit);
    }
    _invalidateHitCache();
    reNumberPending();
    scheduleRender();
  }

  function fbClearHits() {
    fbDelete(P.pendingHits());
    if (chainSessionId) fbDelete(P.doneHits(chainSessionId));
    pendingMap.clear();
    doneMap.clear();
    _invalidateHitCache();
    scheduleRender();
  }

  function fbClearPending() {
    fbDelete(P.pendingHits());
    pendingMap.clear();
    _invalidateHitCache();
    scheduleRender();
  }

  function fbClearDone(sessionId) {
    if (sessionId) fbDelete(P.doneHits(sessionId));
    doneMap.clear();
    _invalidateHitCache();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Session management
  // ══════════════════════════════════════════════════════════════════════════
  function onChainStart(startMs) {
    if (chainSessionId) return; // already have a session — spurious call

    const oldSessionId = chainSessionId; // null here but kept for clarity
    chainStartTime = startMs || Date.now();
    chainSessionId = `s_${chainStartTime}_${Math.random().toString(36).slice(2,7)}`;
    lastAttackId    = null;
    _lastAttackEnded = null;
    _attackPollInFlight = false;
    _startTimeCorrected = false;
    // New chain: clear the pending queue (old targets don't carry over)
    // and clear done hits from any previous session.
    fbClearPending();
    if (oldSessionId) fbClearDone(oldSessionId);
    doneMap.clear();
    GM_setValue(SK_ATTACK_CURSOR, "");
    GM_setValue(SK_SESSION_ID,    "");
    GM_setValue(SK_SESSION_START, "");
    fbPut(P.session(), { id: chainSessionId, startTime: chainStartTime });
    persistSession();
    pollFactionAttacks();
  }

  function onChainEnd() {
    if (chainEndDebounce) { clearTimeout(chainEndDebounce); chainEndDebounce = null; }
    if (!chainSessionId) return;
    const endedSessionId = chainSessionId;
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
    lastAttackId      = null;
    _lastAttackEnded  = null;
    _attackPollInFlight = false;
    _startTimeCorrected = false;
    GM_setValue(SK_ATTACK_CURSOR, "");
    GM_setValue(SK_SESSION_ID,    "");
    GM_setValue(SK_SESSION_START, "");
    // Clear done hits from Firebase + memory.
    fbDelete(P.doneHits(endedSessionId));
    doneMap.clear();
    _invalidateHitCache();
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
        doneMap.clear();
        _invalidateHitCache();
        persistSession();
        scheduleRender();
      }
    } else if (data.id && data.id !== chainSessionId) {
      const remoteStart = data.startTime || 0;
      const ageMs = Date.now() - remoteStart;
      if (ageMs > 2 * 60 * 60 * 1000) {
        console.warn("[ChainCoord] Ignoring stale remote session, age:", Math.round(ageMs/60000), "min");
        return;
      }
      const oldSessionId = chainSessionId;
      // New session from another client — clear pending queue (new chain = fresh targets)
      // and clear done hits from old session.
      if (oldSessionId) {
        fbClearPending();
        fbClearDone(oldSessionId);
      } else {
        // First session we've seen — just clear local pending in case of stale GM data
        pendingMap.clear();
      }
      doneMap.clear();
      chainSessionId   = data.id;
      chainStartTime   = remoteStart || Date.now();
      sessionMinHitNum = null;
      _chainStartPending = false;
      scrapedHitIds.clear();
      _invalidateHitCache();
      persistSession();
      _lastAttackEnded = null;
      _attackPollInFlight = false;
      pollFactionAttacks();
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


  // ══════════════════════════════════════════════════════════════════════════
  //  Chain timer — DOM observer (accurate) + API fallback (coarse)
  //  Ported from v4.9.17. Reads the Torn chain bar timer directly from the
  //  page DOM so the displayed countdown matches exactly what Torn shows.
  //  The API (chain.timeout) lags by up to 20s — DOM is authoritative.
  // ══════════════════════════════════════════════════════════════════════════

  function findChainTimerEl() {
    if (_cachedTimerEl && document.contains(_cachedTimerEl) && parseTimerText(_cachedTimerEl.textContent) !== null) {
      return _cachedTimerEl;
    }
    _cachedTimerEl = null;

    // Fast CSS selector scan — covers sidebar chain bar on most pages,
    // and the attack-page header "[class*=labelTitle]" which contains "2 (02:02)".
    // labelTitle is confirmed from MHT analysis of page.php?sid=attack.
    // parseTimerText extracts MM:SS from within any text, so "2 (02:02)" works.
    const sels = [
      '[class*="bar-timeleft"]',
      '[class*="chainTimer"] [class*="counter"]',
      '[class*="chain-timer"]',
      '[class*="chainInfo"] [class*="timer"]',
      '[class*="chainInfo"] [class*="timeLeft"]',
      '[class*="chainInfo"] [class*="time-left"]',
      '[class*="chainTimer"] [class*="timeLeft"]',
      // Attack page: labelsContainer > labelContainer > labelTitle contains "N (M:SS)"
      '[class*="labelTitle"]:not(#chain-panel *)',
      '[class*="chain"] [class*="time"]:not(#chain-panel *)',
    ];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        if (el && parseTimerText(el.textContent) !== null) { _cachedTimerEl = el; return el; }
      } catch {/**/ }
    }

    // Walk children of chain-bar widget (tooltip render on other pages)
    const cw = document.querySelector('[class*="chain-bar"]:not(#chain-panel *)')
             || document.querySelector('[class*="chain"]:not(#chain-panel *)');
    if (cw) {
      for (const el of cw.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        if (parseTimerText(el.textContent) !== null) { _cachedTimerEl = el; return el; }
      }
    }

    // TornPDA: tooltip renders as a portal appended to document.body.
    // Walk recent body children (portals are typically last) for any leaf
    // element whose text contains a MM:SS timer pattern.
    if (isTornPDA) {
      const bodyChildren = [...document.body.children];
      // Search from end (most recently added) — portal is usually last
      for (let i = bodyChildren.length - 1; i >= Math.max(0, bodyChildren.length - 5); i--) {
        const portal = bodyChildren[i];
        if (portal.id === 'chain-panel' || portal.id === 'tcc-debug-panel') continue;
        for (const el of portal.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          if (parseTimerText(el.textContent) !== null) {
            console.log('[ChainCoord] TornPDA: found timer in portal', portal.className, 'text:', el.textContent.trim().slice(0,30));
            _cachedTimerEl = el; return el;
          }
        }
      }
    }

    return null;
  }

  function onDomTimerUpdate(rawSecs) {
    if (rawSecs === null || rawSecs === 0) return;
    const prevSecs = liveChainSecs;
    // DOM observer is the SOLE authoritative source for display.
    liveChainSecs   = rawSecs;
    lastTimerReadAt = performance.now();
    updateChainTimerUI();
    // Detect timer reset: timer jumped UP by more than 60s — a hit just landed and
    // the chain window reset to ~5:00. Fire immediate chain API polls to sync the
    // count and re-anchor all scheduled hits before the next regular poll fires.
    if (prevSecs !== null && rawSecs > prevSecs + 60) {
      pollFactionChain();
      setTimeout(pollFactionChain, 1500);  // second pass for API propagation lag
    }
  }

  // Mobile Torn conditionally renders the chain bar tooltip only on tap/hover.
  // We dispatch a synthetic pointerenter to force-render the element, hiding
  // the visual flash via a portal watcher. Ported verbatim from v4.9.17.
  //
  // FIX B (v5.2.0): Singleton guard — only one trigger sequence can run at a time.
  // Previously, every onChainApiData call (every 5.3s when chainTimerObserver was
  // absent) created a new independent set of 50ms intervals that overlapped with
  // prior generations. After ~2hrs this could yield dozens of stacked 50ms intervals.
  let _tooltipTriggerActive = false;
  function scheduleTooltipTrigger() {
    if (_tooltipTriggerActive) return;   // FIX B: skip if already running
    _tooltipTriggerActive = true;
    let attempts = 0;
    let cancelled = false;
    const tryAttach = () => {
      if (cancelled) { _tooltipTriggerActive = false; return; }
      if (chainTimerObserver) { _tooltipTriggerActive = false; return; }
      if (startChainTimerObserver()) { _tooltipTriggerActive = false; return; }

      const chainBar = document.querySelector('[class*="chain-bar"]:not(#chain-panel *)');
      // On pages without a chain-bar (attack page), still retry via the loop.
      if (chainBar) {
        const hiddenPortals = new Set();
        const hideNode = n => {
          n.style.setProperty('visibility', 'hidden', 'important');
          hiddenPortals.add(n);
          nodeWatcher.observe(n, { attributes: true, attributeFilter: ['style', 'class'] });
        };
        const isTooltipNode = n =>
          n instanceof Element && (
            n.matches('[class*="tooltip"],[class*="floating"],[data-floating-ui-portal],[class*="popup"],[class*="Popup"],[class*="Tooltip"]')
            || n.querySelector('[class*="bar-timeleft"],[class*="chainTimer"]')
          );
        const nodeWatcher = new MutationObserver(mutations => {
          for (const m of mutations) {
            if (m.type === 'attributes' && hiddenPortals.has(m.target)) {
              m.target.style.setProperty('visibility', 'hidden', 'important');
            }
          }
        });
        let _lastPortalChildCount = document.body.children.length;
        const portalWatcher = setInterval(() => {
          const currentCount = document.body.children.length;
          if (currentCount !== _lastPortalChildCount) {
            _lastPortalChildCount = currentCount;
            for (const child of document.body.children) {
              if (!hiddenPortals.has(child) && isTooltipNode(child)) hideNode(child);
            }
          }
          hiddenPortals.forEach(n => {
            if (n.isConnected) n.style.setProperty('visibility', 'hidden', 'important');
          });
        }, 50);

        chainBar.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, cancelable: true }));
        chainBar.dispatchEvent(new MouseEvent('mouseenter',    { bubbles: true, cancelable: true }));

        const dismissAndRestore = () => {
          chainBar.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, cancelable: true }));
          chainBar.dispatchEvent(new MouseEvent('mouseleave',    { bubbles: true, cancelable: true }));
          setTimeout(() => {
            clearInterval(portalWatcher);
            nodeWatcher.disconnect();
            hiddenPortals.forEach(n => n.style.removeProperty('visibility'));
            hiddenPortals.clear();
            _tooltipTriggerActive = false;  // FIX B: release lock after cleanup
          }, 300);
        };

        let polls = 0;
        const findAndAttach = setInterval(() => {
          polls++;
          if (startChainTimerObserver()) {
            clearInterval(findAndAttach);
            cancelled = true;
            dismissAndRestore();
          } else if (polls >= 20) {
            clearInterval(findAndAttach);
            cancelled = true;
            dismissAndRestore();
          }
        }, 50);
      } else {
        // No chain-bar found this attempt — release if out of retries
        if (attempts >= 14) _tooltipTriggerActive = false;
      }

      if (++attempts < 15) setTimeout(tryAttach, 500);
      if (chainTimerObserver) { cancelled = true; _tooltipTriggerActive = false; }
    };
    tryAttach();
  }

  // TornPDA touch-based tooltip trigger.
  // Dispatches touchstart/touchend + click on the chain bar to force Torn to
  // render the tooltip DOM, then immediately tries to attach the observer.
  // Hides any tooltip portal that appears (same portal-watcher approach as desktop).
  // Runs once, retries every 2s until observer attaches (or 30 attempts).
  let _touchTriggerActive = false;
  function scheduleTouchTooltipTrigger() {
    if (_touchTriggerActive || chainTimerObserver) return;
    _touchTriggerActive = true;
    let attempts = 0;
    const tryTouch = () => {
      if (chainTimerObserver) { _touchTriggerActive = false; return; }

      const chainBar = document.querySelector('[class*="chain-bar"]:not(#chain-panel *)');
      if (!chainBar) {
        if (++attempts < 30) setTimeout(tryTouch, 2000);
        else _touchTriggerActive = false;
        return;
      }

      // Tap the chain bar to open the tooltip. No hiding — let it show briefly.
      // We just need the timer element to appear in the DOM so we can attach the MO.
      const rect = chainBar.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const mkTouch = () => { try { return new Touch({ identifier: Date.now(), target: chainBar, clientX: cx, clientY: cy, pageX: cx, pageY: cy }); } catch { return null; } };
      const t = mkTouch();
      if (t) {
        chainBar.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
        chainBar.dispatchEvent(new TouchEvent('touchend',   { bubbles: true, cancelable: true, touches: [],  targetTouches: [],  changedTouches: [t] }));
      } else {
        chainBar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      }

      // Poll for the timer element. Once found, attach observer then close tooltip
      // with a single pointerdown outside — don't fight floating-ui with repeated events.
      let polls = 0;
      const findAndAttach = setInterval(() => {
        polls++;
        const attached = startChainTimerObserver();
        if (attached || polls >= 20) {
          clearInterval(findAndAttach);
          if (attached) {
            // Close cleanly with a single outside pointerdown — one shot, no loop
            setTimeout(() => {
              document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
              document.body.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
              document.body.dispatchEvent(new MouseEvent('click',         { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
            }, 50);
            _touchTriggerActive = false;
          } else if (++attempts < 15) {
            setTimeout(tryTouch, 2000);
          } else {
            _touchTriggerActive = false;
          }
        }
      }, 50);
    };
    setTimeout(tryTouch, 1000);
  }

  function startChainTimerObserver() {
    if (chainTimerObserver) { chainTimerObserver.disconnect(); chainTimerObserver = null; }
    _cachedTimerEl = null;
    const timerEl = findChainTimerEl();
    if (!timerEl) return false;
    if (timerRetryInterval) { clearInterval(timerRetryInterval); timerRetryInterval = null; }
    onDomTimerUpdate(parseTimerText(timerEl.textContent));
    chainTimerObserver = new MutationObserver(() => {
      if (!document.contains(timerEl)) {
        // Element removed from DOM (TornPDA tooltip portal closed)
        chainTimerObserver.disconnect(); chainTimerObserver = null;
        _cachedTimerEl = null;
        if (isTornPDA) scheduleTouchTooltipTrigger();
        else startTimerRetryLoop();
        return;
      }
      const secs = parseTimerText(timerEl.textContent);
      if (secs === null) {
        chainTimerObserver.disconnect(); chainTimerObserver = null;
        _cachedTimerEl = null;
        startTimerRetryLoop();
      } else {
        onDomTimerUpdate(secs);
      }
    });
    chainTimerObserver.observe(timerEl, { characterData: true, childList: true, subtree: true });
    // Also observe the parent for removal (TornPDA portal gets removed when tooltip closes)
    if (isTornPDA && timerEl.parentElement) {
      chainTimerObserver.observe(timerEl.parentElement, { childList: true });
    }
    return true;
  }

  function startTimerRetryLoop() {
    if (timerRetryInterval) return;
    timerRetryInterval = setInterval(() => {
      if (chainTimerObserver) { clearInterval(timerRetryInterval); timerRetryInterval = null; return; }
      startChainTimerObserver();
    }, 2000);
  }

  // Boot: try to attach immediately, then rely on timerRetryInterval (2s) to keep
  // retrying.  We deliberately avoid a subtree:true MutationObserver on document.body
  // — on dynamic pages like loader.php (attack) that fires hundreds of times per second
  // and blocks GM_xmlhttpRequest callbacks, breaking all API features.
  // Desktop: full observer + tooltip trigger.
  // TornPDA: try direct attach first (bar-timeleft is often in DOM without a tap),
  // then fall back to simulated touch tap on the chain bar to force tooltip render.
  if (!isTornPDA) {
    startChainTimerObserver();
    startTimerRetryLoop();
    scheduleTooltipTrigger();
  } else {
    // Try direct attach immediately — works if bar-timeleft is already in the DOM.
    startChainTimerObserver();
    startTimerRetryLoop();
    // Also schedule a touch-based trigger for pages where the timer only renders
    // inside a tap-triggered tooltip (TornPDA renders these on touchstart/click).
    scheduleTouchTooltipTrigger();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Chain API poll — count + session detection
  // ══════════════════════════════════════════════════════════════════════════
  let _chainPollIsActive    = false; // true = 5.3s rate, false = 30s idle rate
  let _chainPollBackoffSkips = 0;    // skip N ticks after rate-limit (error 5)

  function _maybeRescheduleChainPoll() {
    const shouldBeActive = chainStartTime !== null;
    if (shouldBeActive === _chainPollIsActive) return;
    _chainPollIsActive = shouldBeActive;
    if (factionPollInterval) { clearInterval(factionPollInterval); factionPollInterval = null; }
    factionPollInterval = setInterval(pollFactionChain, _chainPollIsActive ? CHAIN_POLL_MS : CHAIN_POLL_IDLE_MS);
  }

  function pollFactionChain() {
    if (!tornApiKey || !factionId) return;
    if (document.hidden) return;  // skip while tab hidden — catchup fires on visibilitychange
    if (_chainPollBackoffSkips > 0) { _chainPollBackoffSkips--; return; }
    _xhrTracked({
      method: "GET",
      url: `https://api.torn.com/v2/faction/chain?key=${encodeURIComponent(tornApiKey)}`,
      timeout: 8000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);
          if (d && d.error) {
            if ((d.error.code ?? d.error) === 5) {
              _chainPollBackoffSkips = 4;
              console.warn("[ChainCoord] pollFactionChain rate-limited (err 5) — backing off 4 polls");
            }
          } else if (d && d.chain) {
            onChainApiData(d.chain);
          }
        } catch { /**/ }
        _maybeRescheduleChainPoll();
      },
      onerror()  { },
      ontimeout(){ },
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
    // The Torn API documents cooldown as "seconds remaining" but in practice
    // returns a Unix epoch timestamp. Detect epoch values (> 1 year in seconds)
    // and convert to a remaining-seconds duration.
    if (newCooldown > 0) {
      const EPOCH_THRESHOLD = 86400 * 365; // > 1yr of seconds must be an epoch
      const cooldownRemaining = newCooldown > EPOCH_THRESHOLD
        ? Math.max(0, newCooldown - Math.floor(Date.now() / 1000))
        : newCooldown;
      if (cooldownRemaining > 0) {
        chainCooldownSecs   = cooldownRemaining;
        chainCooldownReadAt = performance.now();
      } else {
        chainCooldownSecs   = null;
        chainCooldownReadAt = null;
      }
    } else if (chainCooldownSecs !== null && newCooldown === 0) {
      // Cooldown just finished
      chainCooldownSecs   = null;
      chainCooldownReadAt = null;
    }

    // ── API timer — scheduling math ONLY, NEVER written to display vars ────
    // The API chain.timeout is a coarse integer that lags by 1-30s.
    // Writing it to any display variable causes the visible timer to jump
    // backward on every poll. liveChainSecs/lastTimerReadAt (DOM only) are
    // the SOLE display source and are never touched here.
    if (newTimeout > 0) {
      apiTimerSecs   = newTimeout;
      apiTimerReadAt = performance.now();
    } else if (newTimeout === 0 && newCount === 0) {
      // Chain confirmed dead — clear scheduling state AND display state.
      apiTimerSecs    = null;
      apiTimerReadAt  = null;
      liveChainSecs   = null;
      lastTimerReadAt = null;
      liveChainCount  = null;
      lastKnownCount  = null;
      updateChainTimerUI();
    }

    if (newTimeout === 0 && newCount === 0 && chainSessionId) {
      // Chain is dead — always use the debounce, never fire onChainEnd() immediately.
      // Immediate firing was the primary cause of spurious queue wipes: a single
      // API poll returning timeout=0 (lag, rate limit, brief blip) destroyed everything.
      if (!chainEndDebounce) {
        chainEndDebounce = setTimeout(onChainEnd, CHAIN_END_DEBOUNCE);
      }
      return;
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
        // Don't immediately create a new session — wait briefly for Firebase to
        // deliver the existing session via handleRemoteSession (fbPollOnce runs
        // every 3s). If no session arrives within 4s, we're the first on a new chain.
        if (!_chainStartPending) {
          _chainStartPending = true;
          const _pendingApiStart = apiStartMs || Date.now();
          setTimeout(() => {
            _chainStartPending = false;
            if (!chainSessionId) onChainStart(_pendingApiStart);
          }, 4000);
        }
      } else if (apiStartMs && chainStartTime) {
        const drift = apiStartMs - chainStartTime;
        if (Math.abs(drift) > 10 * 60 * 1000) {
          // Difference > 10 minutes — genuinely a different chain.
          // Use debounce for onChainEnd to avoid wiping state on a single bad poll.
          if (!chainEndDebounce) {
            chainEndDebounce = setTimeout(() => {
              onChainEnd();
              setTimeout(() => onChainStart(apiStartMs), 500);
            }, CHAIN_END_DEBOUNCE);
          }
          return;
        } else if (chainStart > 0 && Math.abs(drift) > 3000 && !_startTimeCorrected) {
          // chain.start is the authoritative Torn value (non-zero = confirmed).
          // Our warmup estimate drifted — correct it in place without wiping hits.
          // _startTimeCorrected flag prevents this from firing every poll interval.
          _startTimeCorrected = true;
          chainStartTime = apiStartMs;
          fbPut(P.session(), { id: chainSessionId, startTime: chainStartTime });
          persistSession();
          // Reset attack cursor so next poll re-fetches from the corrected start time.
          _lastAttackEnded = null;
          _attackPollInFlight = false;
          pollFactionAttacks();
        }
      }
      // Chain active but no DOM observer — try to trigger tooltip render
      if (!isTornPDA && !chainTimerObserver) scheduleTooltipTrigger();
      if (isTornPDA  && !chainTimerObserver) scheduleTouchTooltipTrigger();
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
    // Timer source: DOM observer ONLY (liveChainSecs/lastTimerReadAt).
    // apiTimerSecs is NEVER used for display — it is coarse and causes jumps.
    const hasDomTimer = liveChainSecs !== null && lastTimerReadAt !== null;

    // Compute cooldown remaining once — used throughout this function.
    // Exposed as module-level getter so renderHitList and handleTargetClaim
    // can query cooldown state without duplicating the math.
    const cooldownRemaining = (chainCooldownSecs !== null && chainCooldownReadAt !== null)
      ? Math.max(0, Math.round(chainCooldownSecs - (performance.now() - chainCooldownReadAt) / 1000))
      : 0;
    const isCoolingDown = cooldownRemaining > 0;

    // ── Cooldown takes full priority — suppress timer, count badge, warming msg ──
    // Chain is finished; there is no "next hit". Show only the cooling banner.
    if (isCoolingDown) {
      // Full-panel timer area
      chainTimerVal.textContent = "—"; chainTimerVal.className = "ct-none";
      // Count badge + warming msg — hide both
      chainCountBadge.className = "none"; warmingMsg.style.display = "none";
      // Mini pill — show cooldown text, no count
      pillTimer.textContent = "Cooling down"; pillTimer.className = "ct-cool";
      if (pillCount) pillCount.textContent = "";
      // Cooling banner with live countdown
      const mm = Math.floor(cooldownRemaining / 60);
      const ss = String(cooldownRemaining % 60).padStart(2, "0");
      if (cooldownTimer) cooldownTimer.textContent = `${mm}:${ss}`;
      coolingMsg.style.display = "";
      return;
    }

    // ── Normal chain-active / no-chain display ─────────────────────────────
    coolingMsg.style.display = "none";

    if (!hasDomTimer) {
      chainTimerVal.textContent="—"; chainTimerVal.className="ct-none";
      chainCountBadge.className="none"; warmingMsg.style.display="none";
      pillTimer.textContent="No Chain"; pillTimer.className="ct-none";
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
  }

  // Returns true if the chain is currently in its post-completion cooldown window.
  // Used by renderHitList and handleTargetClaim to suppress queue interactions.
  function isChainCoolingDown() {
    if (chainCooldownSecs === null || chainCooldownReadAt === null) return false;
    return Math.max(0, chainCooldownSecs - (performance.now() - chainCooldownReadAt) / 1000) > 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Faction attacks API poll — paginated for large chains (100k+ hits)
  //
  //  Two modes:
  //  • Catch-up  (no prior data): paginate from chainStartTime forward, page by
  //    page (1000 attacks/page), until we've accounted for all done hits up to
  //    liveChainCount OR we find chain hit #1 with a timestamp matching chainStart.
  //  • Incremental (ongoing): fetch only attacks newer than lastAttackEnded to
  //    avoid re-processing the entire history on every 7s poll.
  //
  //  Uses sort=asc so pages advance chronologically; pagination cursor is the
  //  `ended` timestamp of the last attack in each page (+1s to avoid re-fetching
  //  the boundary attack).
  // ══════════════════════════════════════════════════════════════════════════
  let _attackPollInFlight = false;
  let _lastAttackEnded    = null;  // epoch seconds — cursor for incremental polling

  function _handleAttackApiError(d) {
    const errCode = d.error.code ?? d.error;
    if (errCode === 7 || errCode === 16 || errCode === 2) {
      // 7  = no faction API access on this member's position
      // 16 = key access level too low (needs Limited)
      // 2  = bad key
      hasLimitedKey = false;
      showBanner("chain-banner-limitedkey", true);
      if (attackPollInterval) { clearInterval(attackPollInterval); attackPollInterval = null; }
    } else if (errCode === 5) {
      // Too many requests — exponential backoff: skip 2^level polls (max 8 = ~56s)
      _attackBackoffLevel = Math.min(_attackBackoffLevel + 1, 3);
      _attackBackoffSkips = Math.pow(2, _attackBackoffLevel); // 2, 4, or 8 skipped polls
      console.warn("[ChainCoord] pollFactionAttacks error 5 — backing off for", _attackBackoffSkips, "polls (~" + (_attackBackoffSkips * 7) + "s)");
    } else {
      console.warn("[ChainCoord] pollFactionAttacks error:", errCode, d.error.error || "");
    }
  }

  function pollFactionAttacks() {
    if (!tornApiKey || !factionId || !chainStartTime) return;
    if (document.hidden) return;  // skip while tab hidden
    if (_attackPollInFlight) return;  // don't stack concurrent paginated polls
    // Backoff: skip this poll tick if we're in a rate-limit cooldown
    if (_attackBackoffSkips > 0) { _attackBackoffSkips--; return; }

    // Incremental: if we've already fetched up to some point in this session,
    // only fetch attacks newer than that cursor. This keeps ongoing polls cheap.
    // Catch-up: start from chainStartTime when we have no prior data.
    const fromTs = _lastAttackEnded !== null
      ? _lastAttackEnded + 1          // +1s past last seen attack
      : Math.floor(chainStartTime / 1000);

    _attackPollInFlight = true;
    _fetchAttackPage(fromTs, 0);
  }

  function _fetchAttackPage(fromTs, pageCount) {
    // Safety cap: max 20 pages per poll cycle (20,000 attacks) to avoid runaway
    // API usage. On a 100k chain, 20 pages catches up 20k attacks per 7s interval.
    // With the incremental cursor, steady-state is always 1 page.
    if (pageCount >= 20) {
      _attackPollInFlight = false;
      return;
    }

    _xhrTracked({
      method: "GET",
      url: `https://api.torn.com/v2/faction/attacks?limit=1000&sort=asc&from=${fromTs}&key=${encodeURIComponent(tornApiKey)}`,
      timeout: 15000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);

          if (d && d.error) {
            _handleAttackApiError(d);
            _attackPollInFlight = false;
            return;
          }

          if (hasLimitedKey === false) {
            hasLimitedKey = true;
            showBanner("chain-banner-limitedkey", false);
          }
          hasLimitedKey = true;
          _attackBackoffLevel = 0; // successful poll — reset backoff

          const attacks = d.attacks || [];
          if (!attacks.length || !chainStartTime) {
            _attackPollInFlight = false;
            return;
          }

          onFactionAttacksData(attacks);

          // Advance cursor to last attack in this page
          const lastAtk = attacks[attacks.length - 1];
          if (lastAtk && lastAtk.ended) {
            _lastAttackEnded = lastAtk.ended;
            GM_setValue(SK_ATTACK_CURSOR, _lastAttackEnded);
          }

          // Paginate if this page was full — there may be more attacks
          if (attacks.length === 1000) {
            // Only continue if we still need more done hits
            const highestDone = getHighestDoneHitNum();
            const needed = liveChainCount || 0;
            if (highestDone < needed) {
              // More chain hits to catch up on — fetch next page
              _fetchAttackPage(_lastAttackEnded + 1, pageCount + 1);
              return;
            }
          }

          _attackPollInFlight = false;
        } catch(e) {
          console.warn("[ChainCoord] attack page parse error:", e);
          _attackPollInFlight = false;
        }
      },
      onerror()  { _attackPollInFlight = false; },
      ontimeout(){ _attackPollInFlight = false; },
    });
  }

  function onFactionAttacksData(attacks) {
    // attacks[] from v2 — each entry has:
    //   id, started (epoch), ended (epoch), chain (hit number in chain),
    //   attacker: { id, name, faction: { id } },
    //   defender: { id, name },
    //   result, respect_gain, is_stealthed
    //
    // Filter to only attacks by our faction within the current chain session.
    // chain.start from /faction/chain gives us the epoch the chain began.
    // We use chainStartTime (ms) already stored in state — convert to seconds.

    // Subtract 60s buffer from chainStartSec — during warmup (hits 1-9) Torn's API
    // returns chain.start = 0, so we estimate from timeout. That estimate can land
    // several seconds AFTER the actual first hit, causing early warmup hits to be
    // filtered out. 60s of headroom ensures we never miss a hit at chain start.
    const chainStartSec = Math.floor(chainStartTime / 1000) - 60;
    const apiCount      = liveChainCount || 0;

    // Track the highest attack id seen for future incremental polling
    let maxId = lastAttackId || 0;

    let earliestHitTime = chainHit1Time;

    for (const atk of attacks) {
      // Only our faction's attacks
      if (!atk.attacker || !atk.attacker.faction || String(atk.attacker.faction.id) !== String(factionId)) continue;

      // Must have a chain number (chain: 0 means not part of a chain)
      const chainHitNum = atk.chain;
      if (!chainHitNum || chainHitNum < 1) continue;

      // Must be within current session time window
      if (atk.ended < chainStartSec) continue;

      // API count is the ceiling — don't accept hits beyond what chain confirms.
      // +1 buffer for API lag: the attacks endpoint can return a hit before the
      // chain count poll has updated (both have independent intervals).
      if (apiCount > 0 && chainHitNum > apiCount + 1) continue;

      // Track highest id
      if (atk.id > maxId) maxId = atk.id;

      const attackTime  = atk.ended * 1000;
      const targetId    = String(atk.defender.id);
      const targetName  = atk.defender.name || `Player #${targetId}`;
      const attackerName= atk.attacker.name || "Unknown";
      const attackUrl   = `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`;

      const dedupKey = (chainSessionId || "nosession") + "_hit_" + chainHitNum;
      if (scrapedHitIds.has(dedupKey)) continue;
      scrapedHitIds.add(dedupKey);

      // chainConfirmed logic (mirrors old scraper)
      if (chainHitNum === 1 && (!earliestHitTime || attackTime < earliestHitTime))
        earliestHitTime = attackTime;
      if (chainHitNum >= CHAIN_CONFIRM_HITS && earliestHitTime !== null)
        if (attackTime - earliestHitTime <= 5 * 60000) chainConfirmed = true;

      // Skip slot if already marked done
      const slotDone = [...hitMap.values()].some(h =>
        h.status === "done" && (h.chainHitNum === chainHitNum || h.hitNumber === chainHitNum)
      );
      if (slotDone) continue;

      // Try to match a pending queued hit by targetId
      const matchedEntry = [...hitMap.entries()].find(([, h]) =>
        h.status === "pending" && String(h.targetId) === targetId
      );

      // Try to consume an unspecified / outside hit
      let outsideEntry = null;
      if (!matchedEntry) {
        outsideEntry = [...hitMap.entries()].find(([, h]) =>
          h.status === "pending" && (h.outside || !h.targetId) &&
          ((h.chainHitNum != null && h.chainHitNum === chainHitNum) ||
           (h.chainHitNum == null && h.hitNumber === chainHitNum)) &&
          (!h.claimedBy || h.claimedBy === attackerName)
        ) || null;
        if (!outsideEntry) {
          const oeCandidates = [...hitMap.entries()]
            .filter(([, h]) => h.status === "pending" && (h.outside || !h.targetId) &&
              (!h.claimedBy || h.claimedBy === attackerName))
            .sort((a, b) => (a[1].hitNumber || 0) - (b[1].hitNumber || 0));
          outsideEntry = oeCandidates[0] || null;
        }
      }

      if (matchedEntry) {
        fbUpdateHit(matchedEntry[0], {
          status: "done", doneAt: attackTime,
          hitNumber: chainHitNum, chainHitNum,
          claimedBy: attackerName, targetId, targetName,
        });
      } else if (outsideEntry) {
        fbUpdateHit(outsideEntry[0], {
          status: "done", doneAt: attackTime,
          hitNumber: chainHitNum, chainHitNum,
          claimedBy: attackerName, targetId, targetName,
        });
      } else {
        // Untracked hit — write a scraped done entry
        const slotTaken = [...hitMap.values()].some(h =>
          h.status === "done" && (h.chainHitNum === chainHitNum || h.hitNumber === chainHitNum)
        );
        const untrackedId = "scraped_" + dedupKey;
        if (!slotTaken && !hitMap.has(untrackedId)) {
          fbWriteHit({
            id: untrackedId, hitNumber: chainHitNum, chainHitNum,
            targetId, targetName, claimedBy: attackerName,
            claimedAt: attackTime, scheduledAt: attackTime,
            hospReleaseAt: null, attackUrl,
            status: "done", doneAt: attackTime,
            untracked: true, scraped: true, sessionId: chainSessionId,
          });
        }
      }
    }

    if (maxId > (lastAttackId || 0)) lastAttackId = maxId;
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
      if (hit.unspecified && !hit.claimedBy) {
        rc = "unclaimed";  // system gap placeholder
      } else {
        rc = showDash ? "waiting" : hitRowClass(showNow ? 0 : rem, hosp, hit.untracked, hit.hospReleaseAt);
      }
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
    const isOutside = (hit.outside || !hit.targetId) && !isDone && !hit.unspecified;
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
        fbDelete(P.pendingHit(hitId));
        _deleteFromMaps(hitId);
        _invalidateHitCache();

        // If the removed hit was hosp-blocked, delete the unspecified gap placeholders
        // that resolveHospGaps created to hold its place. Without this they linger as
        // phantom Unclaimed rows permanently.
        if (hit.hospReleaseAt) {
          const gapsToDelete = [...hitMap.values()]
            .filter(h => h.unspecified && h.status === "pending" &&
                         h.scheduledAt >= (deletedScheduledAt - HIT_INTERVAL * 0.5) &&
                         h.scheduledAt < deletedScheduledAt);
          gapsToDelete.forEach(g => {
            _deletedHitIds.add(g.id);
            fbDelete(P.pendingHit(g.id));
            _deleteFromMaps(g.id);
          });
        }

        // Shift remaining pending hits' scheduledAt to close the gap
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
      fbPut(P.pendingHitField(h.id, "scheduledAt"), h.scheduledAt);
    });

    reNumberPending();
    scheduleRender();
  }

  function renderPanel() {
    // syncPendingScheduledAt is NOT called here — the 1s tick calls it every second,
    // so calling it again in renderPanel (rAF-queued immediately after the tick) was a
    // redundant double-call on every poll cycle. Removed v5.8.23 to reduce Opera/Edge CPU.
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
      // During cooldown the chain is finished — no next hit exists.
      if (isChainCoolingDown()) {
        pillNext.textContent = "—";
        pillNext.style.color = "#7ecfff";
        pillNext.dataset.attackUrl = "";
        if (pillSep) pillSep.style.display = "none";
      // liveChainCount = hits already completed. The next hit needed = liveChainCount + 1.
      } else if (liveChainCount !== null) {
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
        // Skip hits from a different session — stale data from a previous chain
        if (h.sessionId && chainSessionId && h.sessionId !== chainSessionId) continue;
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

      // All pending hits — with "Unclaimed" gap rows for any missing slot numbers.
      // This handles the case where a hosp-unreachable hit lands at e.g. slot 14
      // while slots 11-13 have no queued hits — they should show as Unclaimed rather
      // than simply disappearing, so the chain coordinator can see actionable gaps.
      {
        const chainWinMs = chainTimerMs();
        let expectedNum = liveChainCount !== null
          ? Math.max(liveChainCount + 1, liveChainCount >= CHAIN_CONFIRM_HITS ? CHAIN_CONFIRM_HITS + 1 : 1)
          : (getHighestDoneHitNum() + 1);
        // Tracks whether sticky-now has already been assigned to a gap row,
        // so we don't also assign it to the hit that follows the gap.
        let stickyGiven = false;

        pendingHits.forEach((hit, i) => {
          const hitNum = hit.chainHitNum || hit.hitNumber;
          // Fill any gap between expectedNum and this hit's slot with Unclaimed rows.
          // Only fill gaps after chain is confirmed (hit 10+) — warmup slots all show
          // NOW so gaps there are normal (hits claimed out of order is fine early on).
          if (hitNum > expectedNum && liveChainCount !== null && liveChainCount >= CHAIN_CONFIRM_HITS - 1) {
            for (let gap = expectedNum; gap < hitNum; gap++) {
              const isFirstRow = !stickyGiven && i === 0 && gap === expectedNum;
              const currentHitNumForGap = liveChainCount + 1;
              const offset = Math.max(0, gap - currentHitNumForGap);
              const gapMs = chainWinMs > 0 ? Math.max(0, chainWinMs + offset * HIT_INTERVAL) : 0;
              const gapSec = Math.round(gapMs / 1000);
              const gapTxt = gapMs <= 0 ? "NOW" : `${Math.floor(gapSec/60)}:${String(gapSec%60).padStart(2,"0")}`;
              const gapCls = gapMs <= 0 ? "due" : gapMs <= 90000 ? "soon" : "wait";
              if (isFirstRow) stickyGiven = true;
              // Slot ≤ liveChainCount means the hit already happened — show "Waiting for Data".
              // Slot > liveChainCount means it hasn't happened yet — show "Unclaimed".
              // +1 buffer: the API count lags by up to 5s after a hit lands, so a slot
              // one ahead of liveChainCount may already have happened. Prefer "Waiting
              // for Data" over "Unclaimed" when ambiguous — false negatives are less
              // confusing than a slot falsely showing as unclaimed for several seconds.
              const gapIsHit = liveChainCount !== null && gap <= liveChainCount + 1;
              const gapLabel = gapIsHit ? "Waiting for Data" : "Unclaimed";
              const gapRowCls = gapIsHit ? "waiting" : "unclaimed";
              html += `<div class="chain-hit-row ${gapRowCls}${isFirstRow ? " sticky-now" : ""}" data-hit-id="" data-queue-pos="-1">` +
                `<span class="chain-hit-num">${gap}</span>` +
                `<span class="chain-hit-claimer">—</span>` +
                `<span class="chain-hit-target" style="${gapIsHit ? "color:#445;font-style:italic" : ""}">${gapLabel}</span>` +
                `<span class="chain-hit-timer ${gapIsHit ? "wait" : gapCls}">${gapIsHit ? "—" : (liveChainSecs !== null ? gapTxt : "—")}</span>` +
                `<span></span><span></span></div>`;
            }
          }
          // If a gap row already claimed sticky-now, shift this hit's queuePos by 1
          // so hitRowHtml won't also mark it sticky-now (queuePos===0 triggers that).
          const adjustedPos = stickyGiven && i === 0 ? 1 : i;
          html += hitRowHtml(hit, adjustedPos, now);
          expectedNum = hitNum + 1;
        });
      }

      // Placeholder when chain is live but queue is empty.
      // nextSlot ≤ liveChainCount: hit already happened → "Waiting for Data"
      // nextSlot > liveChainCount: not yet happened → "Unclaimed"
      if (pendingHits.length === 0 && allDoneBySlot.size === 0 && liveChainCount !== null) {
        const nextSlot = getHighestDoneHitNum() + 1;
        // +1 buffer for API lag — same as gap row logic above
        const slotIsHit = nextSlot <= liveChainCount + 1;
        const disp = Math.round(chainTimerMs() / 1000);
        const t = liveChainSecs !== null ? `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}` : "—";
        const slotLabel = slotIsHit ? "Waiting for Data" : "Unclaimed";
        const slotRowCls = slotIsHit ? "waiting" : "unclaimed";
        const slotTimer = slotIsHit ? "—" : t;
        const slotTimerCls = slotIsHit ? "wait" : (disp<=30?"due":disp<=90?"soon":"wait");
        html += `<div class="chain-hit-row ${slotRowCls} sticky-now"><span class="chain-hit-num">${nextSlot}</span><span class="chain-hit-claimer">—</span><span class="chain-hit-target" style="${slotIsHit ? "color:#445;font-style:italic" : ""}">${slotLabel}</span><span class="chain-hit-timer ${slotTimerCls}">${slotTimer}</span><span></span><span></span></div>`;
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
  let _lastTickSecs = null;      // deduplicate updateChainTimerUI calls in tick
  let _timerRetryCount = 0;     // rapid-retry counter when chain active but no timer
  let _timerCellTick  = 0;      // counts ticks for cell-loop rate-limiting
  setInterval(() => {
    // Skip all expensive work when no chain is active — between chains this tick
    // should cost nothing regardless of tab visibility (two-monitor setups keep
    // document.hidden=false even when the user isn't watching the Torn tab).
    if (!chainStartTime && !liveChainCount) {
      updateTopBarBadge();  // keep badge cleared
      return;
    }

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

    // Re-anchor pending hit scheduledAt values to the live DOM timer so that
    // pendingCountdownMs() ticks smoothly at 1s rather than in Firebase poll steps.
    if (!document.hidden && viewMode === 0 && chainStartTime) syncPendingScheduledAt();

    // Rapid-retry: if a chain session is active but apiTimerSecs hasn't loaded yet
    // (e.g. first page load before CHAIN_POLL_MS fires), poll immediately every tick
    // for the first 15s, then back off.  Also fires on the attack page where the user
    // just made a hit and the timer just reset.
    // Rapid-retry only fires when chain is active but timer hasn't loaded yet.
    // Once apiTimerSecs is set we stop — the normal CHAIN_POLL_MS interval takes over.
    // The drift-guard in onChainApiData prevents subsequent polls from resetting the timer.
    // Rapid-retry fires until the DOM observer attaches (liveChainSecs set).
    if (chainStartTime && liveChainSecs === null && tornApiKey && factionId) {
      _timerRetryCount++;
      if (_timerRetryCount <= 15) {
        pollFactionChain();
      }
    } else if (liveChainSecs !== null && _timerRetryCount > 0) {
      // Timer just loaded — stop rapid-retry and trigger a render so gap rows appear.
      _timerRetryCount = 0;
      scheduleRender();
    }

    // Patch timer cells — only when panel is fully visible (view-full) and tab is visible.
    // In icon/mini mode the rows are display:none so writes are wasted work.
    // Skip entirely when document.hidden — was the primary cause of background freeze.
    if (viewMode === 0 && !document.hidden) {
      // Pre-hoist shared values outside the loop
      const sortedPending = [...hitMap.values()]
        .filter(h => h.status === "pending")
        .sort((a, b) => a.hitNumber - b.hitNumber);
      const currentHitNum = liveChainCount !== null ? Math.max(liveChainCount + 1, liveChainCount >= CHAIN_CONFIRM_HITS ? CHAIN_CONFIRM_HITS + 1 : 1) : getHighestDoneHitNum() + 1;
      // Use the cached panel inner reference to scope querySelector — avoids scanning the whole document
      const _panelInner = document.getElementById("chain-panel-inner");

      // Rate-limit the per-cell DOM patch loop: run every 2 ticks when the timer
      // is above the danger threshold (default 30s). Below that, update every tick
      // so the critical countdown stays sharp. This halves cell-loop DOM work during
      // normal chain operation without any visible difference to users.
      _timerCellTick++;
      const inDanger    = tickSecs !== null && tickSecs <= settDangerThreshold;
      const runCellLoop = inDanger || (_timerCellTick % 2 === 0);

      if (_panelInner && runCellLoop) {
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
          const newRc   = showDash ? "waiting" : hitRowClass(dispRem, hosp, hit?.untracked || false, hit?.hospReleaseAt || null);
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
      } // end if (_panelInner && runCellLoop)

      if (sortedPending.length > 0 || liveChainSecs !== null) {
        const nh = sortedPending[0];
        if (nh) {
          const rem0 = pendingCountdownMs(0, sortedPending);
          nextTimer.textContent = rem0 <= 0 ? "NOW" : formatTime(rem0);
          nextTimer.className   = hitTimerClass(rem0);
        } else if (liveChainSecs !== null) {
          const rem  = chainTimerMs();
          const disp = Math.round(rem/1000);
          nextTimer.textContent = `${Math.floor(disp/60)}:${String(disp%60).padStart(2,"0")}`;
          nextTimer.className   = hitTimerClass(rem);
        }
      }

      // ── Auto-expand + sound notification when OWN hit becomes due ──────────
      // Reuses sortedPending already computed above — no additional allocation.
      if ((settNotifySound || settAutoExpandDue) && !document.hidden && chainStartTime) {
        const myPending = sortedPending.filter(h => h.claimedBy === ownName);
        if (myPending.length) {
          const first = myPending[0];
          const rem = Math.max(0, first.scheduledAt - Date.now());
          if (rem < 1000 && !_notifiedHitIds.has(first.id)) {
            _notifiedHitIds.add(first.id);
            playDueSound();
            if (settAutoExpandDue && viewMode !== 0) {
              viewMode = 0; _saveViewMode(viewMode); applyViewMode();
            }
          } else if (rem > 5000) {
            _notifiedHitIds.delete(first.id);
          }
        }
        // Purge stale notified IDs (hits now done or removed) — only when map is non-empty
        if (_notifiedHitIds.size > 0) {
          _notifiedHitIds.forEach(id => {
            const h = hitMap.get(id);
            if (!h || h.status === "done") _notifiedHitIds.delete(id);
          });
        }
      }
    }

    // Top-bar chain badge (all pages)
    updateTopBarBadge();
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

    // Determine where to insert the new hit.
    //
    // Default: always append to the end of the queue.
    //
    // Exception: if the target is in hosp, find the earliest existing slot where
    // slotTime >= hospReleaseMs, insert there, and shift all hits from that point
    // onward back by one HIT_INTERVAL so valid targets move up to fill the gap.
    //
    // Non-hosp targets always go to the end — we never pull them forward past
    // existing hits (that would displace people who queued earlier).

    let insertSlot;
    let insertIdx; // position in activeHits before which the new hit is inserted

    if (!activeHits.length) {
      insertSlot = Math.max(now, earliest);
      insertIdx  = 0;
    } else {
      const lastSlot   = activeHits[activeHits.length - 1].scheduledAt;
      const appendSlot = lastSlot + HIT_INTERVAL;

      if (!isInHosp) {
        // Not in hosp — always append at the end, no reordering needed.
        insertSlot = appendSlot;
        insertIdx  = activeHits.length;
      } else {
        // In hosp — find the last *real* (non-unspecified) hit to compute append point,
        // so Unclaimed gap slots don't artificially push the hosp target further out.
        // The gap-filling block below will then consume the appropriate unspecified slot.
        const realHits = activeHits.filter(h => !h.unspecified);
        const realLastSlot = realHits.length ? realHits[realHits.length - 1].scheduledAt : now;
        const realAppendSlot = realLastSlot + HIT_INTERVAL;
        if (realAppendSlot >= hospReleaseMs) {
          insertSlot = realAppendSlot;
        } else {
          const extraIntervals = Math.ceil((hospReleaseMs - realAppendSlot) / HIT_INTERVAL);
          insertSlot = realAppendSlot + extraIntervals * HIT_INTERVAL;
        }
        insertIdx = activeHits.length; // position adjusted by gap-filling block below
      }
    }

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

    // Non-hosp hits fill the earliest unspecified gap before appending to end.
    if (!isInHosp) {
      const gaps = [...hitMap.values()]
        .filter(h => h.unspecified && h.status === "pending")
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      if (gaps.length > 0) {
        const gap = gaps[0];
        newHit.scheduledAt = gap.scheduledAt;
        _deletedHitIds.add(gap.id);
        fbDelete(P.pendingHit(gap.id));
        _deleteFromMaps(gap.id);
        _invalidateHitCache();
      }
    } else {
      // Hosp hits fill the earliest unspecified gap whose slot time >= hospReleaseMs.
      // This prevents them being pushed to the very end of the queue behind all
      // Unclaimed gaps — they take the first open slot they can actually use.
      const gaps = [...hitMap.values()]
        .filter(h => h.unspecified && h.status === "pending" && h.scheduledAt >= hospReleaseMs)
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      if (gaps.length > 0) {
        const gap = gaps[0];
        newHit.scheduledAt = gap.scheduledAt;
        _deletedHitIds.add(gap.id);
        fbDelete(P.pendingHit(gap.id));
        _deleteFromMaps(gap.id);
        _invalidateHitCache();
      }
    }

    // Add to hitMap first, THEN reNumber so hitNumber is correct before write.
    // Pass skipWrite=true to reNumberPending: existing hits already have the right
    // numbers, and the new hit is about to be written in full by fbWriteHit below —
    // a field-level hitNumber PUT here would create a zombie partial node.
    pendingMap.set(newHit.id, newHit);
    _invalidateHitCache();
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
  //  Hospital status re-poll
  //  Runs every 30s. Re-fetches user/basic for each pending hit that has a
  //  hospReleaseAt set (target was in hospital when queued). Updates the stored
  //  hospReleaseAt and writes the corrected scheduledAt back to Firebase.
  //  Also picks up targets that got hospitalized AFTER being queued (hospReleaseAt
  //  was null at claim time but target is now in hospital).
  // ══════════════════════════════════════════════════════════════════════════
  function recheckHospTargets() {
    if (!tornApiKey || !chainSessionId) return;
    const toCheck = [...hitMap.values()].filter(h =>
      h.status === "pending" && h.targetId && h.sessionId === chainSessionId
    );
    if (!toCheck.length) return;

    // Stagger requests 500ms apart to avoid hammering the rate limit
    toCheck.forEach((hit, i) => {
      setTimeout(() => {
        if (!hitMap.has(hit.id)) return; // hit was deleted while we waited
        _xhrTracked({
          method: "GET",
          url: `https://api.torn.com/user/${encodeURIComponent(hit.targetId)}?selections=basic&key=${encodeURIComponent(tornApiKey)}`,
          timeout: 10000,
          onload(r) {
            try {
              const d = JSON.parse(r.responseText);
              if (!d || d.error) return;
              const h = hitMap.get(hit.id);
              if (!h || h.status !== "pending") return;

              const state = (d.status?.state || "").toLowerCase();
              const hospTs = d.status?.until || 0;
              const isInHosp = state === "hospital" && hospTs > 0;
              const newHospMs = isInHosp ? hospTs * 1000 : 0;
              const oldHospMs = h.hospReleaseAt || 0;

              // Only update if hospital status has actually changed
              if (newHospMs === oldHospMs) return;

              h.hospReleaseAt = newHospMs || null;
              // Recalculate scheduledAt: if still in hosp, push slot out to hosp release
              if (newHospMs > 0 && newHospMs > h.scheduledAt) {
                h.scheduledAt = newHospMs;
              } else if (!newHospMs && oldHospMs > 0) {
                // Target left hospital early — pull slot back to now if it was hosp-extended
                h.scheduledAt = Math.max(Date.now(), h.scheduledAt - (oldHospMs - newHospMs));
              }
              pendingMap.set(hit.id, h);
              fbWriteHit(h);
              reNumberPending();
              scheduleRender();
            } catch(_) {}
          },
          onerror()  {},
          ontimeout() {},
        });
      }, i * 500);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Target claim handler
  // ══════════════════════════════════════════════════════════════════════════
  function handleTargetClaim(btn, targetId, targetName, attackUrl) {
    if (!tornApiKey)    { alert("Click the API button to set your Torn API key first."); return; }
    if (!factionId)     { alert("Could not detect your faction — make sure your API key is set."); return; }
    if (!fbConfigured()){ alert("Firebase is not configured yet — see FIREBASE_SETUP.md."); return; }
    if (isChainCoolingDown()) { alert("Chain is cooling down — queueing is disabled until the next chain starts."); return; }

    const already = [...hitMap.values()].find(h=>h.status==="pending"&&h.targetId===targetId);
    if (already) { alert(`${targetName} is already queued as hit #${already.hitNumber}.`); return; }

    const resetBtn = () => {
      btn.disabled=false; btn.classList.remove("loading");
      if (btn.dataset.iconDefault) { btn.innerHTML = btn.dataset.iconDefault; btn.style.color=""; }
      else { btn.textContent="🎯"; }
    };

    btn.disabled=true; btn.classList.add("loading"); btn.textContent="⏳";

    _xhrTracked({
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
    if((h.includes("loader.php")||h.includes("page.php"))&&h.includes("sid=attack")) return h;
    return h.startsWith("http")?h:"https://www.torn.com"+h;
  }

  // Page detection
  const IS_FACTIONS_PAGE   = /factions\.php/.test(window.location.pathname);
  const IS_LIST_PAGE       = /page\.php/.test(window.location.pathname) &&
                             /sid=list/.test(window.location.search);
  const IS_PROFILE_PAGE    = /profiles\.php/.test(window.location.pathname);
  const IS_ATTACK_PAGE     = (/loader\.php/.test(window.location.pathname) ||
                              /page\.php/.test(window.location.pathname)) &&
                             /sid=attack/.test(window.location.search);
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
    const attackA = document.querySelector('a[href*="page.php?sid=attack"], a[href*="user2ID='+targetId+'"]');
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
      let attackUrl=`https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`;
      if(row){const al=row.querySelector('a[href*="page.php?sid=attack"]');if(al)attackUrl=extractAttackUrl(al);}
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

    const attackUrl = `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`;

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
    _xhrTracked({
      method: "GET",
      // v2: combine basic + members + rankedwars in one round-trip
      url: `https://api.torn.com/v2/faction?selections=basic,members,rankedwars&key=${encodeURIComponent(tornApiKey)}`,
      timeout: 15000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);
          if (!d || d.error) return;

          // ── basic ──────────────────────────────────────────────────────
          // v2 basic: leader_id, co_leader_id (not "co-leader")
          factionLeader   = String(d.basic?.leader_id   || d.leader_id   || "");
          factionCoLeader = String(d.basic?.co_leader_id || d.co_leader_id || "0");
          isLeaderOrCoLeader = (ownId === factionLeader) ||
            (factionCoLeader !== "0" && ownId === factionCoLeader);

          // ── members ────────────────────────────────────────────────────
          // v2 members: array of { id, name, ... }
          factionMembers = {};
          const membersArr = d.members || [];
          membersArr.forEach(m => { if (m.id && m.name) factionMembers[String(m.id)] = m.name; });

          // ── rankedwars ─────────────────────────────────────────────────
          // v2 rankedwars: array, active wars have no `winner` yet
          warOpponentFactionIds.clear();
          inRankedWar = false;
          const wars = d.rankedwars || [];
          wars.forEach(w => {
            if (w.winner) return;  // finished — skip
            inRankedWar = true;
            if (w.factions) w.factions.forEach(f => {
              if (String(f.id) !== String(factionId)) warOpponentFactionIds.add(String(f.id));
            });
          });

          updateClearBtn();
        } catch { /**/ }
      },
    });
  }
  // Safety-net timer — clears "Connecting…" if it hangs beyond 30s.
  // On TornPDA, Torn API callbacks are sometimes silently dropped on first
  // page load. Auto-retry fetchOwnProfile up to 5 times at 3s intervals
  // before falling through to the 30s timeout message.
  let _connectWatchdog = null;
  let _pdaRetryCount = 0;

  // TornPDA suppresses setTimeout during page load. Add a touchstart listener
  // as a guaranteed trigger — first user touch fires fetchOwnProfile if stuck.
  if (isTornPDA) {
    const _touchRetry = () => {
      document.removeEventListener("touchstart", _touchRetry, true);
      if (_pdaRetryCount === 0) {
        const statusBanner = document.getElementById("chain-banner-status");
        const noKeyBanner  = document.getElementById("chain-banner-nokey");
        const isConnecting = statusBanner && statusBanner.style.display !== "none" &&
                             statusBanner.textContent.includes("Connecting");
        const needsKey     = noKeyBanner && noKeyBanner.style.display !== "none";
        if (isConnecting || needsKey) {
          console.log("[ChainCoord] TornPDA touch-triggered retry");
          fetchOwnProfile();
        }
      }
    };
    document.addEventListener("touchstart", _touchRetry, { capture: true, once: true });
  }
  function _startConnectWatchdog() {
    if (_connectWatchdog) clearTimeout(_connectWatchdog);
    if (isTornPDA && _pdaRetryCount < 5) {
      _connectWatchdog = setTimeout(() => {
        _connectWatchdog = null;
        const statusBanner = document.getElementById("chain-banner-status");
        if (statusBanner && statusBanner.style.display !== "none" &&
            statusBanner.textContent.includes("Connecting")) {
          // Re-attempt key load in case it wasn't available at boot
          if (!tornApiKey) {
            try { tornApiKey = (sessionStorage.getItem("tcc_api_key") || "").trim(); } catch { /**/ }
            if (!tornApiKey) tornApiKey = (GM_getValue(SK_API_KEY, "") || "").trim();
          }
          _pdaRetryCount++;
          showBanner("chain-banner-status", true, "Connecting… (retry " + _pdaRetryCount + ")");
          console.log("[ChainCoord] TornPDA auto-retry #" + _pdaRetryCount + " hasKey=" + !!tornApiKey);
          if (tornApiKey) {
            fetchOwnProfile();
          } else {
            // Key still missing — schedule another retry
            _startConnectWatchdog();
          }
        }
      }, 3000);
      return;
    }
    _connectWatchdog = setTimeout(() => {
      _connectWatchdog = null;
      const statusBanner = document.getElementById("chain-banner-status");
      if (statusBanner && statusBanner.style.display !== "none" &&
          statusBanner.textContent.includes("Connecting")) {
        showBanner("chain-banner-status", false);
        showBanner("chain-banner-debug", true,
          "⚠ Connection timed out. Check: (1) API key is valid, " +
          "(2) googleapis.com and firebaseio.com are reachable, " +
          "(3) no VPN/adblocker blocking Firebase. Try reloading the page.");
      }
    }, 30000);
  }
  function _clearConnectWatchdog() {
    if (_connectWatchdog) { clearTimeout(_connectWatchdog); _connectWatchdog = null; }
    _pdaRetryCount = 0;  // reset retry count on successful connect
  }

  function fetchOwnProfile() {
    // On TornPDA, re-attempt key load from all sources in case it wasn't available
    // at script init time (sessionStorage may be slow to initialise on some builds).
    if (isTornPDA && !tornApiKey) {
      try { tornApiKey = (sessionStorage.getItem("tcc_api_key") || "").trim(); } catch { /**/ }
      if (!tornApiKey) tornApiKey = (GM_getValue(SK_API_KEY, "") || "").trim();
    }
    if (!tornApiKey) { showBanner("chain-banner-nokey",true); return; }
    console.log("[ChainCoord] fetchOwnProfile: keyLen=" + tornApiKey.length + " retry=" + _pdaRetryCount);
    clearAllIntervals();
    lastPollResponse = null;
    showBanner("chain-banner-nokey",false);
    showBanner("chain-banner-status",true,"Connecting…");
    _startConnectWatchdog();

    _xhrTracked({
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

          if(!factionId||factionId==="0"){showBanner("chain-banner-nofact",true);return;}
          showBanner("chain-banner-nofact",false);

          if(!fbConfigured()){showBanner("chain-banner-nofb",true);return;}
          showBanner("chain-banner-nofb",false);

          fetchFactionBasic();
          pollFactionChain();

          fbSignInAnon((token,uid)=>{
            fbToken = token;
            fbUid   = uid;

            if (!token || !uid) {
              showBanner("chain-banner-status", false); _clearConnectWatchdog();
              const pdaNote = isTornPDA ? " (TornPDA: Firebase auth may be blocked — check @connect in script header)" : "";
              showBanner("chain-banner-debug", true, "⚠ Firebase auth failed — anonymous sign-in returned no token." + pdaNote);
              return;
            }

            const lobbyBootstrapUrl = P.lobbyMe();
            showBanner("chain-banner-status", true, "Connecting…");
            fbRequest({
              method:"PUT", url: lobbyBootstrapUrl,
              headers:{"Content-Type":"application/json"},
              data: JSON.stringify({ name: ownName, tornId: ownId, factionId: factionId, lastSeen: Date.now(), browser: _browserTag, version: CURRENT_VERSION }),
              timeout:10000,
              onload(r) {
                if (r.status>=200 && r.status<300) {
                  setSyncDot("live");
                  showBanner("chain-banner-status", false); _clearConnectWatchdog();
                  fbCleanOwnLobbyEntries();
                  fbRegisterMember();
                  fbProbeOwner();
                  checkForUpdate();
                  fbCheckWhitelist(allowed => {
                    if (!allowed) {
                      showBanner("chain-banner-locked", true);
                      setSyncDot("error");
                      return;
                    }
                    showBanner("chain-banner-locked", false);
                    fbStartMainListener();
                    _wireVisibilityCatchup();
                    pollFactionChain();
                    // Start at idle rate — _maybeRescheduleChainPoll switches to 5.3s once a chain is detected
                    _chainPollIsActive = false;
                    if (!factionPollInterval) factionPollInterval = setInterval(pollFactionChain, CHAIN_POLL_IDLE_MS);
                    if (!attackPollInterval)  attackPollInterval  = setInterval(pollFactionAttacks, ATTACKS_POLL_MS);
                    if (_cachedSessionRestored) { _cachedSessionRestored = false; pollFactionAttacks(); }
                    if (!_hospRecheckInterval) _hospRecheckInterval = setInterval(recheckHospTargets, 30000);
                    if (!isTornPDA && !timerRetryInterval) startTimerRetryLoop();
                    if (!isTornPDA && !chainTimerObserver) scheduleTooltipTrigger();
                    if (IS_ATTACK_PAGE) setTimeout(pollFactionChain, 2000);
                  });
                } else {
                  setSyncDot("error");
                  showBanner("chain-banner-status", false); _clearConnectWatchdog();
                  let msg = r.responseText;
                  try { msg = JSON.parse(r.responseText).error || msg; } catch { /**/ }
                  showBanner("chain-banner-debug", true, "❌ Lobby check-in failed "+r.status+": "+msg);
                  console.warn("[ChainCoord] Lobby check-in failed", r.status, r.responseText);
                }
              },
              onerror(e)  { setSyncDot("error"); showBanner("chain-banner-status", false); _clearConnectWatchdog(); showBanner("chain-banner-debug", true, "❌ Lobby check-in network error | err=" + JSON.stringify(e||{})); },
              ontimeout() { setSyncDot("error"); showBanner("chain-banner-status", false); _clearConnectWatchdog(); showBanner("chain-banner-debug", true, "❌ Lobby check-in timed out"); },
            });

            if (!heartbeatInterval) heartbeatInterval = setInterval(fbHeartbeat, PRESENCE_HEARTBEAT);
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
  function checkForUpdate() {
    _xhrTracked({
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
        // Only the owner can write /meta/latestVersion (Firebase rules enforce this).
        // Gate on isOwner client-side too so non-owners never attempt the write and
        // never see a spurious 401 banner.
        if (fbConfigured() && fbUid && isOwner) {
          const lvUrl = P.latestVersion();
          if (lvUrl) {
            fbRequest({
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
                  // Only show banner for unexpected errors — 401/403 would mean the
                  // isOwner probe was wrong, which shouldn't happen.
                  if (wr.status !== 401 && wr.status !== 403) {
                    showBanner("chain-banner-debug", true,
                      `⚠ latestVersion write failed (${wr.status}): ${msg}`);
                  }
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
  // ── Attack page: detect fight result → trigger immediate chain polls ─────
  // When the user Leaves, Mugs, or Hospitalizes an opponent, Torn adds a new
  // row to the action log table.  We watch for it and immediately fire both
  // polls so the timer resets and the attack is recorded as fast as possible.
  if (IS_ATTACK_PAGE) {
    (function watchAttackResult() {
      let _resultFired = false;
      const RESULT_RE = /\b(leave|left|mug|mugged|hospitali[sz]e[ds]?)\b/i;

      function checkRow(row) {
        if (_resultFired) return;
        if (!RESULT_RE.test(row.textContent || '')) return;
        _resultFired = true;
        // Immediate: refresh timer + attack log
        setTimeout(() => { pollFactionChain(); pollFactionAttacks(); }, 300);
        // Second pass 2.5s later to catch the timer reset from the API
        setTimeout(() => { pollFactionChain(); }, 2500);
      }

      function attachToActionLog() {
        const tbody = document.querySelector(
          'table[class*="action"] tbody, [class*="actionLog"] tbody, ' +
          '[class*="action-log"] tbody, [class*="log-wrap"] tbody, ' +
          '.action-log tbody, #log-list tbody'
        );
        if (!tbody) return false;
        // Check any rows already present
        tbody.querySelectorAll('tr').forEach(checkRow);
        if (_resultFired) return true;
        new MutationObserver(mutations => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1) checkRow(node);
            }
          }
        }).observe(tbody, { childList: true });
        return true;
      }

      if (!attachToActionLog()) {
        const retryObs = new MutationObserver(() => {
          if (attachToActionLog()) retryObs.disconnect();
        });
        retryObs.observe(document.body, { childList: true, subtree: true });
      }
    })();
  }

  renderPanel();
  console.log(`[ChainCoord] Boot: isTornPDA=${isTornPDA}, hasKey=${!!tornApiKey}, keyLen=${tornApiKey.length}`);
  if (isTornPDA && !tornApiKey) {
    const noKeyBanner = document.getElementById("chain-banner-nokey");
    if (noKeyBanner) noKeyBanner.textContent = "⚠ No API key — tap the API button to enter your key (TornPDA: key must be re-entered after each script update).";
  }
  if (isTornPDA && tornApiKey) {
    // Simulate pressing Save on the API key popover — this uses the exact same
    // code path that works when the user taps Save manually, bypassing any
    // timing issues with GM_xmlhttpRequest during script initialisation.
    const apiInputEl = document.getElementById("chain-api-input");
    const apiSaveEl  = document.getElementById("chain-api-save");
    if (apiInputEl && apiSaveEl) {
      apiInputEl.value = tornApiKey;
      apiSaveEl.click();
    } else {
      fetchOwnProfile();
    }
  } else {
    fetchOwnProfile();
  }
  if (!isTornPDA) injectTargetButtons();
  updateVersionUI();   // set initial badge state before Firebase connects
  // checkForUpdate() is called from inside the lobby check-in callback, once fbUid
  // is confirmed — this guarantees the Firebase write succeeds (auth is ready).
  // No blind setTimeout needed here anymore.

})();
