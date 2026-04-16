# FactionBudget Dashboard — Code Structure Reference

**Last Updated:** 2026-04-16  
**Version:** 2.40.10  
**File:** `FactionBudget/current/FactionBudgetv2_40_10.html`  
**Total lines:** ~7,919

> ⚠️ **Maintenance note:** Update this document whenever functions are added, removed, or significantly refactored. Keeping it current makes AI-assisted debugging dramatically faster.

---

## 1. File Overview

Single self-contained HTML file for a **Torn City faction budget/finance dashboard**. No external build tools, no frameworks — pure HTML + vanilla JS + inline CSS.

| Section | Line range | Description |
|---|---|---|
| `<head>` / `<style>` (main) | 1–256 | Google Fonts import, full CSS theme |
| `<style>` (animation) | 259 | `@keyframes scan` for loading shimmer |
| Inline styles (access gate) | ~260–307 | Spinner/gate-specific CSS |
| `<body>` / HTML | 308–1102 | All panels, modals, DOM structure |
| `<script>` | 1103–7904 | All JavaScript (version constants → access gate boot) |

**Purpose:** Tracks faction vault balance, member payouts, OC (Organized Crime) income, armory/supply usage, war funds, and museum inventory — all via the Torn API using a user-supplied API key.

---

## 2. HTML Structure Map

All major sections are direct children or near-top descendants of `<body class="app">`.

| DOM ID | Line | Description |
|---|---|---|
| `#accessGate` | 308 | Full-screen overlay (fixed, z-index 2000). Shown to unverified users. Contains API key input and verify button. Hidden once access is granted. |
| `#mainApp` | 376 | Root wrapper for the entire dashboard (hidden until access verified). |
| `#changelogModal` | 405 | Full-screen modal (z-index 1000). Displays version changelog. Opened by `showChangelog()`. |
| `#paymentLogModal` | 425 | Full-screen modal (z-index 1000). Displays payment log. Opened by `showPaymentLog()`. |
| `#apiSetup` | 444 | API key entry form. Shown when no key is stored. Contains `#apiKeyInput` and connect button. |
| `#initScreen` | 473 | Initialization progress panel. Shown during first-run deep fetch. Contains step list and elapsed time. |
| `#keyBar` | 521 | Persistent bar showing active API key info, sync button, and console toggle. Hidden until initialized. |
| `#refreshBar` | 535 | Shows last sync time, progress bar (`#rFill`), rate meter (`#rateMeterFill`), and refresh countdown. |
| `#statGrid` | 543 | 6-card stat grid (2→3→6 columns, responsive). Each `.sc` card is clickable to cycle periods. |
| `#mainTabs` | 601 | Tab bar. Tabs call `switchTab(name)`. Badges use `.tbadge` class. |
| `#panel-vault` | 616 | **Vault** — faction vault balance, member balances table, net available. Default active panel. |
| `#panel-supply` | 621 | **Supply** — armory items sent to members; consumable tracking toggle. |
| `#panel-inventory` | 641 | **Inventory** — museum set (plushie/flower) tracker, manual counts, purchase log, delta. |
| `#panel-members` | 667 | **Members** — member usage table populated by `renderMemberUsage()`. |
| `#panel-oc` | 672 | **OC** — Organized Crime income log, active assignments, debug panel (`#ocDebugPanel`). |
| `#panel-receipts` | 747 | **Receipts** — owed payouts, receipt log, outgoing items, rate settings. |
| `#panel-respect` | 790 | **Respect** — faction respect stats from attack news; period selector. |
| `#panel-war` | 832 | **War** — war fund tracker; import from URL or paste; per-war cut settings. |
| `#panel-log` | 885 | **Log** — armory news log table. |
| `#panel-debug` | 894 | **Debug** — event log viewer, delta filter, API test runner, copy button, error log. |
| `#panel-admin` | 937 | **Admin** — export/import, manual receipts, storage inspector, audit log, deep fetch, wipe. |

### Key sub-elements within panels

| Element | Panel | Purpose |
|---|---|---|
| `#ocDebugPanel` | `#panel-oc` | Toggle-able OC debug sub-panel (3 tabs: Income / Raw Data / Member Matching) |
| `#ocDbgIncome` | `#ocDebugPanel` | Income tab content area |
| `#ocDbgRaw` | `#ocDebugPanel` | Raw Data tab content area |
| `#ocDbgMatch` | `#ocDebugPanel` | Member Matching tab content area |
| `#rateMeterFill` / `#rateMeterLabel` | `#refreshBar` | Visual API rate meter |
| `#cWrap` / `#cLines` | body | Inline console log (appears below key bar) |
| `#postConsole` / `#cLinesPost` | `#keyBar` | Secondary console panel (toggled by key bar) |
| `#errLogTbl` | `#panel-debug` | Error log table |
| `#gErr` | `#mainApp` | API error banner (shown for error code 16) |

---

## 3. CSS Architecture

### Theme Variables (`:root`, line ~10)

```css
:root {
  --bg:       #0a0d0f   /* page background */
  --surface:  #111418   /* card/panel background */
  --surface2: #181d22   /* slightly lighter surface (table headers) */
  --border:   #1e2530   /* border color */
  --accent:   #7fff6e   /* primary green — active tabs, values, badges */
  --accent2:  #3dd68c   /* secondary green — progress bar, ok log */
  --accent3:  #f0c040   /* yellow — warnings, active period pills */
  --accent4:  #ff6b6b   /* red — errors, danger buttons */
  --accent5:  #7eb8ff   /* blue — info log, links */
  --text:     #e8edf2   /* primary text */
  --muted:    #5a6a7a   /* secondary/muted text */
  --muted2:   #3a4550   /* very muted (disabled state background) */
}
```

### Key Class Naming Conventions

| Class prefix / name | Usage |
|---|---|
| `.sc` | Stat card container (`.sc-label`, `.sc-value`, `.sc-sub`, `.sc-period`) |
| `.sc.active-period` | Currently-selected period card highlighted with `--accent3` border |
| `.mem-tip` | OC member name cell — click toggles tooltip. Needs `.tip-open` to show tooltip. |
| `.mem-tip-box` | Tooltip content box inside `.mem-tip`. `display:none` by default, `display:block` when parent has `.tip-open`. |
| `.tip-open` | Added to `.mem-tip` by JS click handler to show tooltip |
| `.pill` / `.pill.on` | Filter toggle button (type filter, etc.) |
| `.period-pill` / `.period-pill.on` | Time period selector (1d / 7d / 30d / 90d / 1y / all) |
| `.pills` | Container for `.pill` buttons |
| `.period-pills` | Container for `.period-pill` buttons |
| `.tw` | Table wrapper — `overflow-x:auto` for mobile scroll |
| `.tab` / `.tab.active` | Navigation tab button |
| `.tbadge` | Red badge on tab button (unread count) |
| `.panel` / `.panel.active` | Content panels — only `.active` panel is `display:block` |
| `.btn-sm` | Small monospace button |
| `.btn-primary` | Green primary action button |
| `.btn-danger` | Red danger/destructive button |
| `.status-dot` | 8px dot indicator (`.live` = green blink, `.loading` = yellow blink, `.error` = red) |
| `.pg` | Plushie grid (3→5 columns responsive) |
| `.og` | OC grid (2→3 columns responsive) |
| `.inv-sets-grid` | Inventory sets grid (responsive) |
| `.war-member-grid` | War members grid (2→3 columns responsive) |
| `.oc-form` | OC member override form grid (1→4 columns responsive) |

### Responsive Breakpoints

| Breakpoint | Applied to |
|---|---|
| `min-width: 500px` | `.pg` (plushie grid 3-col), `.og` (oc grid 2-col), `.ls` (filter input 200px), `.oc-form` N/A |
| `min-width: 600px` | `.stat-grid` (3-col), `.oc-form` (4-col), `.inv-sets-grid` (3-col) |
| `min-width: 640px` | `.inv-columns` (2-col) |
| `min-width: 700px` | `.pg` (plushie grid 5-col) |
| `min-width: 900px` | `.og` (oc grid 3-col), `.inv-sets-grid` (4-col), `.war-member-grid` (3-col) |
| `min-width: 1000px` | `.stat-grid` (6-col) |
| `max-width: 599px` | Mobile-specific overrides |

---

## 4. JavaScript Function Index

All functions defined in the `<script>` block (lines 1103–7904).

### 4.1 State & Config (lines 1103–1995)

| Function / Constant | Line | Description |
|---|---|---|
| `APP_VERSION` | 1113 | Current version string `'2.40.10'` |
| `VERSION_URL` | 1115 | GitHub API URL for version check |
| `REPO_BASE` | 1116 | Base URL for raw file access |
| `PLUSHIE_SET` / `FLOWER_SET` | 1120–1136 | Canonical museum set item name arrays |
| `PLUSHIE_SET_PTS` / `FLOWER_SET_PTS` | 1138–1139 | Points per completed set (10 each) |
| `MUSEUM_DAY_BONUS` | 1140 | +10% bonus on Museum Day |
| `CONSUMABLE_TYPES` | 1142 | Set of consumable item type strings |
| `isConsumable(type)` | 1142 | Returns true if item type is a consumable (excluding flowers/plushies) |
| `OC_CRIME_TYPES` | 1157 | Array of OC crime type strings |
| `OC_CRIME_MEMBERS` | 1158 | Map of crime type → required member count |
| `CARD_PERIOD_ORDER` | 1164 | `['1d','7d','30d','90d','1y','all']` — order for period cycling |
| `ACCESS_KEY` / `FACTION_ID` / `OWNER_ID` | 1167–1169 | Access gate constants |
| `ACCESS_DURATION_MS` | 1171 | 7-day access window in ms |
| `XANAX_ITEM_ID` | 1174 | Item ID 206 — used for access payment verification |
| `CHANGELOG` | 1177 | Array of `{v, date, notes[]}` version entries |
| `SYNC_RATES` | 1946 | Array of sync rate options `{label, mins, bgInterval}` |
| `S` | 1955 | **Global state object** — see Section 5 for full schema |
| `apiCallLog` | 1990 | Rolling array of API call timestamps (last 60s) |
| `bgSyncMode` | 1991 | Boolean — true during background syncs (throttled rate) |
| `API_LIMIT` | 1992 | Hard cap: 75 calls/min |
| `BG_INTERVAL` | 1993 | ms between calls in background mode |

### 4.2 API Rate Limiting (lines 1995–2035)

| Function | Line | Description |
|---|---|---|
| `rateSleep()` | 1995 | Async. Waits if near rate limit. In bg mode: enforces minimum gap between calls. |
| `trackApiCall()` | 2009 | Records current timestamp to `apiCallLog`; calls `updateRateMeter()`. |
| `updateRateMeter()` | 2016 | Updates `#rateMeterFill` and `#rateMeterLabel` with current calls/min percentage. |
| `rateSafeGet(section, sel, extra)` | 2034 | Calls `rateSleep()` then `tGet()`. Use for background fetches. |

### 4.3 Changelog & Version Check (lines 1785–1994)

| Function | Line | Description |
|---|---|---|
| `showChangelog(updateAvailable, latestVersion, sinceVersion)` | 1785 | Populates and shows `#changelogModal`. Highlights entries newer than `sinceVersion`. |
| `glowVersionBadge(label)` | 1847 | Adds pulse animation to version badge element. |
| `showChangelogUpgrade()` | 1859 | Convenience wrapper — shows changelog for upgrade (reads `hv_upgrade_from` from localStorage). |
| `checkForUpdate(fromAdmin)` | 1863 | Async. Fetches GitHub API to find newest version filename; compares to `APP_VERSION`. |
| `doUpdate()` | 1922 | Navigates to latest version URL from GitHub contents API. |

### 4.4 Console / Logging (lines 2182–2205)

| Function | Line | Description |
|---|---|---|
| `clog(msg, type)` | 2182 | Appends a log line to `#cLines` and `#cLinesPost`. Types: `'ok'`, `'warn'`, `'err'`, `'info'`. |
| `clearConsole()` | 2193 | Clears both console elements. |
| `togglePostConsole()` | 2196 | Toggles visibility of `#postConsole` (key bar inline console). |

### 4.5 API Key & Access (lines 2204–2340)

| Function | Line | Description |
|---|---|---|
| `openCustomKeyUrl(e)` | 2204 | Opens Torn API key generation URL in a new tab. |
| `saveKey()` | 2223 | Async. Validates entered API key via `tGet('user','basic')`, saves to `hv_key`, calls `revealDash()` or `runInitialize()`. |
| `revealDash()` | 2260 | Shows the dashboard (key bar, refresh bar, stat grid, tabs). Sets title and version badge. |
| `checkExpiryWarning()` | 2287 | Shows banner if API key expires within 7 days. |
| `clearSessionState()` | 2304 | Resets all non-persistent S properties (faction, donations, news, logs) without clearing receipts/wars/etc. |
| `clearKey()` | 2313 | Clears stored API key and reloads page. |

### 4.6 Initialization (lines 2336–2680)

| Function | Line | Description |
|---|---|---|
| `paginatedFetch(section, sel, maxPg, fromTs)` | 2336 | Async. Generic paginated Torn API fetcher — keeps fetching pages until no more data or `fromTs` boundary reached. |
| `runInitialize()` | 2377 | Async. **Full deep-fetch init** — fetches all historical data (paginated armorynews, mainnews, crimenews, eventlog up to `S.initLookback` seconds back). Shows `#initScreen` with step-by-step progress. |
| `ilog(msg)` *(inner)* | 2399 | Init-screen progress logger (inside `runInitialize`). |
| `iconsole(msg, type)` *(inner)* | 2405 | Init-screen console logger (inside `runInitialize`). |
| `_tickElapsed()` *(inner)* | 2439 | Updates elapsed time display during init (inside `runInitialize`). |
| `stepStart(id, label)` *(inner)* | 2447 | Marks an init step as in-progress (inside `runInitialize`). |
| `stepDone(id, detail)` *(inner)* | 2455 | Marks an init step as complete (inside `runInitialize`). |
| `stepFail(id, detail)` *(inner)* | 2464 | Marks an init step as failed (inside `runInitialize`). |
| `setP(p, step)` *(inner)* | 2475 | Updates init progress percentage display (inside `runInitialize`). |
| `pages(section, sel, maxPg, fromTs)` *(inner)* | 2478 | Paginated fetch helper used by `runInitialize` (inside `runInitialize`). |

### 4.7 Admin Deep Fetch & Diagnostics (lines 2682–2960)

| Function | Line | Description |
|---|---|---|
| `adminDeepFetch()` | 2682 | Async. Re-fetches historical data pages from the "eldest" known entry forward; merges into existing arrays. Used from Admin panel. |
| `updateDeepFetchEldest()` | 2785 | Updates `#deepFetchEldest` display with oldest known event timestamps. |
| `adminReInitialize()` | 2800 | Clears all API caches, resets `S` session state, triggers `runInitialize()`. |
| `adminRunFullDiagnostic()` | 2827 | Async. Tests all API endpoints; populates `#diagResults` table with status/data. |
| `adminCopyDiagnostic()` | 2930 | Copies diagnostic results table to clipboard. |
| `logError(code, context, message)` | 2950 | Pushes an error entry to `S.errorLog` with timestamp. |

### 4.8 Core API Fetch (lines 2961–3060)

| Function | Line | Description |
|---|---|---|
| `tGet(section, sel, extra)` | 2961 | Async. Base Torn API fetch. Calls `trackApiCall()`, fetches, parses JSON, throws on API error. Shows `#gErr` banner for error code 16. |
| `restoreFromCache()` | 2984 | Reads `hv_v1_fetch_meta` to determine which categories are still fresh; restores them from localStorage. Returns map of cached categories. |
| `restoreFromCacheStale()` | 3041 | Like `restoreFromCache()` but accepts stale data — used for immediate first-render before sync. |
| `writeFetchMeta(categories)` | 3053 | Writes current timestamp to `hv_v1_fetch_meta` for given categories. |

### 4.9 Main Sync Cycle (lines 3060–3350)

| Function | Line | Description |
|---|---|---|
| `fetchAll(isManual, isBackground)` | 3060 | Async. **Primary sync function.** Fetches faction, vault, armory, mainnews, crimenews, event log, items, OC crimes. Saves to localStorage. Calls `renderAll()`. |
| `fetchOutgoingLog()` | 3260 | Async. Fetches `user/log` (outgoing item sends), merges into `S.outgoing`. |
| `syncEvents(silent)` | 3349 | Async. Fetches only `user/events`; re-parses receipts and outgoing. Used by manual sync button. |

### 4.10 Receipt / Payout Parsing (lines 3375–3535)

| Function | Line | Description |
|---|---|---|
| `stripHtml(s)` | 3375 | Removes HTML tags; unwraps `<a>` text. |
| `extractXid(raw)` | 3380 | Extracts `XID=(\d+)` player ID from raw HTML string. |
| `parseReceipts()` | 3385 | Parses `S.events` → new receipt objects → merges into `S.receipts` (deduped by ID). |
| `detectCat(name)` | 3505 | Maps item name to category string (`'Plushie'`, `'Flower'`, `'Xanax'`, `'Drug'`, etc.). |
| `saveReceipts()` | 3531 | Saves `S.receipts` to `hv_v1_rcpts`. |
| `saveOcOverrides()` | 3532 | Saves `S.ocOverrides` to `hv_v1_oc_overrides`. |
| `saveRespectOverrides()` | 3533 | Saves `S.respectOverrides` to `hv_v1_respect_overrides`. |
| `saveRefundedPayments()` | 3534 | Saves `S.refundedPayments` (Set) to `hv_v1_refunded_payments`. |

### 4.11 Payment Log / Rendering (lines 3537–3830)

| Function | Line | Description |
|---|---|---|
| `renderPaymentCard()` | 3537 | Renders the payment summary card in the receipts panel. |
| `parsePaymentEvents()` | 3574 | Parses `S.eventLog` for payment-type events; builds payment event objects. |
| `showPaymentLog()` | 3614 | Shows `#paymentLogModal`; calls `_renderPaymentLogModal()`. |
| `_renderPaymentLogModal()` | 3621 | Builds HTML for payment log modal (player/faction cards, sections by type). |
| `section(title, color, items, renderFn, extraButton)` *(inner)* | 3663 | Modal section builder (inside `_renderPaymentLogModal`). |
| `playerCard(p)` *(inner)* | 3676 | Renders a single player payment card (inside `_renderPaymentLogModal`). |
| `factionCard(wl)` *(inner)* | 3734 | Renders a single faction card (inside `_renderPaymentLogModal`). |
| `markAsTester(name)` | 3768 | Adds player to `S.testers` list; saves. |
| `removeTester(name)` | 3778 | Removes player from `S.testers` list; saves. |
| `grantTesterAccess()` | 3785 | Reads tester name input, validates, calls `markAsTester()`. |
| `showAddFactionWhitelist()` | 3799 | Shows faction whitelist add form. |
| `addFactionWhitelist()` | 3805 | Reads faction ID/label inputs, adds to `S.factionWhitelist`; saves. |
| `removeFactionWhitelist(id)` | 3819 | Removes faction from whitelist by ID; saves. |
| `exportPaymentData()` | 3826 | Exports payment data as downloadable JSON. |
| `togglePaymentRefund(ts)` | 3842 | Toggles `ts` in `S.refundedPayments`; saves. |

### 4.12 OC Override / Respect Override (lines 3851–3930)

| Function | Line | Description |
|---|---|---|
| `ocOverrideSave(key)` | 3851 | Reads inline edit inputs for OC override; saves to `S.ocOverrides[key]`; re-renders OC. |
| `ocOverrideClear(key)` | 3866 | Clears `S.ocOverrides[key]`; re-renders OC. |
| `respectOverrideSave(key)` | 3872 | Reads inline respect override input; saves to `S.respectOverrides[key]`; re-renders respect. |
| `respectOverrideClear(key)` | 3881 | Clears `S.respectOverrides[key]`; re-renders respect. |
| `toggleInlineEdit(rowId)` | 3887 | Shows/hides inline edit row for a receipt. |
| `toggleExempt(id)` | 3895 | Toggles `id` in `S.exemptReceipts`; re-renders receipts. |
| `isExempt(id)` | 3901 | Returns true if receipt `id` is in `S.exemptReceipts`. |
| `saveRates()` | 3906 | Reads rate input fields; saves to `S.rates` and `hv_v1_rates`. |
| `loadRateInputs()` | 3913 | Populates rate input fields from `S.rates`. |
| `getRate(cat)` | 3919 | Returns payout rate (0–1) for category; defaults to 0.98. |

### 4.13 Refresh Bar / Sync Control (lines 3928–4040)

| Function | Line | Description |
|---|---|---|
| `setRefreshBarSyncing(isSyncing)` | 3928 | Switches refresh bar UI between "syncing" spinner and idle countdown state. |
| `updateRefreshBarIdle()` | 3944 | Updates countdown timer and progress fill in refresh bar. |
| `startCycle(elapsedMs)` | 3966 | Starts background fetch timer (`scheduleBgFetch`) and display refresh timer (`scheduleDisplayRefresh`). |
| `setSyncRate(val)` | 4001 | Sets `RMINS` and `BG_INTERVAL`; persists to `hv_v1_sync_rate`; restarts cycle. |
| `buildSyncSelector()` | 4011 | Populates sync rate `<select>` dropdown from `SYNC_RATES`. |
| `manualRefresh()` | 4024 | Triggers manual `fetchAll(true, false)`; restarts cycle. |

### 4.14 Utility Functions (lines 4038–4110)

| Function | Line | Description |
|---|---|---|
| `fmt$(n)` | 4038 | Formats number as currency string: `$1.23M`, `$456K`, `$789`. Returns `'—'` for null/NaN. |
| `ff$(n)` | 4046 | Like `fmt$` but always full integer: `$1,234,567`. |
| `fmtM(n)` | 4047 | Compact million-truncated format: `$1M`, `$456K`. |
| `fd(ts)` | 4055 | Formats unix timestamp as short date: `Apr 16, '26`. |
| `ft(ts)` | 4056 | Formats unix timestamp as date+time: `Apr 16, 2:34 PM`. |
| `lookupItem(name)` | 4058 | Finds item in `S.prices` by name (case-insensitive). |
| `parseArm(e)` | 4069 | Parses a single armory news entry into `{ts, member, item, qty, type, mv}`. |
| `inPeriod(ts, period)` | 4105 | Returns true if unix `ts` falls within `period` string (`'1d'`, `'7d'`, `'30d'`, etc.) from now. |

### 4.15 Respect Panel (lines 4116–4275)

| Function | Line | Description |
|---|---|---|
| `setRespectPeriod(el, period)` | 4116 | Sets `S.respectPeriod`; updates active pill; re-renders. |
| `renderRespect()` | 4124 | Renders the respect panel — aggregates `S.crimeNews` and `S.attackNews` within `S.respectPeriod`. |

### 4.16 Core Render Functions (lines 4273–4540)

| Function | Line | Description |
|---|---|---|
| `setStatus(t, txt)` | 4273 | Sets `#sDot` class and `#sText` content. |
| `renderAll()` | 4281 | Calls all render functions. Only calls `renderDebugEvents()` and `renderWarPanel()` if their tab is active. |
| `renderVault()` | 4290 | Renders vault panel — faction balance, member donation balances sorted table. |
| `renderInventory()` | 4370 | Renders inventory panel — set completion, delta, purchase history, manual count form. |
| `buildColumn(colType, items, accentVar)` *(inner)* | 4401 | Builds a set column (plushie or flower) for inventory (inside `renderInventory`). |
| `showInvEntryForm()` | 4533 | Shows manual inventory count entry form. |
| `cancelInvEntry()` | 4593 | Hides manual inventory form. |
| `saveManualCounts()` | 4601 | Reads manual count inputs; saves to `S.manualCounts`; re-renders. |
| `calcInvDelta()` | 4623 | Calculates inventory change since last save using `S.invDeltaTs`. |
| `fetchInvPurchases()` | 4664 | Async. Fetches market/bazaar purchase history for museum items; merges into `S.invPurchases`. |
| `fetchPointPrice()` | 4753 | Async. Fetches current points market price; updates `S.pointPrice` and `S.pointPriceHistory`. |
| `renderSupply()` | 4786 | Renders supply panel — armory items sent, by member and item type. |
| `renderMemberUsage()` | 4837 | Renders members panel — per-member armory usage totals table. |

### 4.17 OC v2 (deprecated/partial, lines 4875–4955)

> ⚠️ OC v2 API (`/faction/crimes`) requires faction-level permissions unavailable to standard keys. All active OC rendering uses v1 (crimenews). These functions exist but are not called during normal sync.

| Function | Line | Description |
|---|---|---|
| `fetchOCCrimesV2(fromTs, toTs)` | 4875 | Async. Fetches faction crimes from v2 API (disabled — requires elevated key). |
| `fetchOCPayoutsV2(fromTs, toTs)` | 4898 | Async. Fetches payout news from v2 API (disabled — unreliable attribution). |
| `attributeOCPayouts(crimes, payoutNews)` | 4920 | Matches payout news entries to crimes by timestamp proximity. |
| `refreshOCv2(fromTs)` | 4953 | Async. Orchestrates v2 OC fetch + attribution (not called during sync). |

### 4.18 OC Parsing Utilities (lines 4982–5005)

| Function | Line | Description |
|---|---|---|
| `parseCrimeType(news)` | 4982 | Extracts crime type string from raw HTML news entry. |
| `parseOCId(news)` | 4995 | Extracts OC ID from raw HTML news entry (if present). |

### 4.19 OC Debug Panel (lines 5003–5335)

| Function | Line | Description |
|---|---|---|
| `ocDebugToggle()` | 5003 | Toggles `#ocDebugPanel` visibility; auto-runs income debug on open. |
| `ocDbgTab(tab)` | 5011 | Switches active debug tab (`'income'`, `'raw'`, `'match'`, `'copy'`). Triggers corresponding render. |
| `ocDebugRun()` | 5030 | Runs income/payout reconciliation debug output — matches `S.ocRaw` payouts to `S._crimeLog` selections. |
| `ocDbgRenderRaw()` | 5081 | Renders Raw Data tab — table of all `S._crimeLog` entries with type, clean text, and raw HTML. |
| `ocDbgRenderMatch()` | 5128 | Renders Member Matching tab — traces selection→result algorithm with match status, candidates, conflict flags. |
| `ocDbgCopyAll()` | 5282 | Copies all `S._crimeLog` entries + overrides to clipboard (falls back to new window). |
| `ocDebugClearOverrides()` | 5321 | Clears all `S.ocOverrides`; saves; re-renders OC. |

### 4.20 OC Member Override (lines 5333–5415)

| Function | Line | Description |
|---|---|---|
| `cnSaveMembers(ts, crimeType)` | 5333 | Saves manual member assignment for an OC entry (key = `ts_crimeType`). |
| `cnClearMembers(ts)` | 5360 | Clears manual member override for an OC entry. |
| `ocToggleEditMem(id)` | 5368 | Toggles inline member edit form visibility. |
| `ocFilterMembers(query, gridId)` | 5373 | Filters member checkbox grid by name query. |
| `ocUpdateMemberCheckboxes(ts, required)` | 5383 | Checks/unchecks member checkboxes to match required count. |

### 4.21 OC Banner & Rendering (lines 5403–5720)

| Function | Line | Description |
|---|---|---|
| `updateOcBanner(ocIncome, warIncome, period)` | 5403 | Updates OC income banner totals in stat grid. |
| `renderOC()` | 5423 | **Main OC render.** Parses `S._crimeLog` → completed OCs → active assignments → income summary → renders all sub-sections. |
| `memberBadge(members)` *(inner)* | 5435 | Renders inline member badge with tooltip (`.mem-tip` class) for OC row (inside `renderOC`). |

### 4.22 Receipts Rendering (lines 5720–5985)

| Function | Line | Description |
|---|---|---|
| `renderReceipts()` | 5720 | Calls `renderOwed()`, `renderRcptLog()`, `renderOutgoing()`, `updateBadge()`. |
| `renderOutgoing()` | 5722 | Renders outgoing items section (items sent from user to faction members). |
| `calcOwed(member)` | 5757 | Calculates outstanding owed amount for a member from their receipts. |
| `lastPaidTs(member)` | 5762 | Returns unix timestamp of last payment to member from `S.paidLog`. |
| `renderOwed()` | 5767 | Renders the "Owed" section — per-member outstanding payout table. |
| `markPaid(member, amount)` | 5903 | Records a payment to `S.paidLog[member]`; re-renders receipts. |
| `toggleMemberStats(id)` | 5912 | Expands/collapses per-member receipt details. |
| `renderRcptLog()` | 5918 | Renders the receipt log table with all `S.receipts` (filtered by member if `filterRcptMember` active). |
| `filterRcptMember(name)` | 5962 | Sets member filter for receipt log; re-renders. |
| `delReceipt(id)` | 5967 | Marks a receipt as deleted; saves; re-renders. |
| `updateBadge()` | 5975 | Updates `.tbadge` on Receipts tab with count of unread/owed entries. |

### 4.23 Armory Log Rendering (lines 5983–6010)

| Function | Line | Description |
|---|---|---|
| `renderArmoryLog()` | 5983 | Renders Log tab — filtered table of `S.armoryNews` entries. |

### 4.24 Stat Card Logic (lines 6008–6150)

| Function | Line | Description |
|---|---|---|
| `cycleCardPeriod(card)` | 6008 | Cycles `S.cardPeriods[card]` to next in `CARD_PERIOD_ORDER`; re-renders cards. |
| `setCardPeriod(card, period, el)` | 6027 | Sets `S.cardPeriods[card]` to specific period; saves; re-renders cards. |
| `restoreCardPeriodPills()` | 6038 | Restores active `.period-pill` state on page from `S.cardPeriods`. |
| `periodToSeconds(period)` | 6051 | Converts period string to seconds (e.g. `'30d'` → 2592000; `'all'` → `Infinity`). |
| `renderCards()` | 6062 | Renders all 6 stat cards with values filtered to each card's period. |

### 4.25 Tab Switching (lines 6147–6170)

| Function | Line | Description |
|---|---|---|
| `switchTab(name)` | 6147 | Activates `#panel-{name}`; updates `.tab.active`; calls appropriate render for tab. Triggers: `renderDebugEvents` + `renderErrorLog` (debug), `renderReceipts` (receipts), `renderArmoryLog` (log), `renderRespect` (respect), `renderWarPanel` (war), `renderInventory` (inventory), `adminInspectStorage` + `updateDeepFetchEldest` (admin). |

### 4.26 Debug Panel (lines 6167–6500)

| Function | Line | Description |
|---|---|---|
| `renderErrorLog()` | 6167 | Renders error log table from `S.errorLog`. |
| `clearErrorLog()` | 6185 | Clears `S.errorLog`; re-renders. |
| `copyErrorLog()` | 6193 | Copies error log to clipboard via `_copyText()`. |
| `renderDebugEvents()` | 6204 | Renders event log table from `S.eventLog` (full history) with delta filter support. |
| `dbgTest(section, sel, key)` | 6320 | Async. Tests a single API endpoint; displays result in debug panel. |
| `dbgRunAll()` | 6356 | Async. Runs all debug API tests; collects results. |
| `_copyText(text, onOk, onFail)` | 6497 | Tries `navigator.clipboard.writeText()`; falls back to `_copyTextFallback()`. |
| `_copyTextFallback(text, onOk, onFail)` | 6509 | Fallback copy via hidden textarea + `execCommand('copy')`; last resort selects text. |
| `dbgCopy()` | 6523 | Copies full debug event log as JSON to clipboard. |

### 4.27 Admin Panel (lines 6542–6880)

| Function | Line | Description |
|---|---|---|
| `adminExport(type)` | 6542 | Exports data as JSON download. Types: `'receipts'`, `'events'`, `'full'`. |
| `adminExportDebugHtml()` | 6586 | Exports a standalone debug HTML file with current event data. |
| `adminImport(evt)` | 6618 | Reads an uploaded JSON backup file; merges/restores receipts, wars, paidLog, rates. |
| `adminAddManualReceipt()` | 6715 | Adds a manual receipt from admin form inputs. |
| `adminInspectStorage()` | 6745 | Reads all `hv_*` localStorage keys; displays sizes and entry counts in admin panel. |
| `adminClearKey(key)` | 6790 | Clears a specific localStorage key after confirmation. |
| `adminCheckWipeInput()` | 6799 | Enables/disables the wipe button based on confirmation text. |
| `adminClearAll()` | 6812 | Wipes all user data from localStorage after typed confirmation; reloads page. |
| `adminRenderAudit()` | 6834 | Renders audit log of deleted receipts (soft-deleted entries). |
| `adminRestoreOne(id)` | 6864 | Restores a single soft-deleted receipt by ID. |
| `adminRestoreDeleted()` | 6869 | Restores all soft-deleted receipts. |

### 4.28 War Panel (lines 6881–7265)

| Function | Line | Description |
|---|---|---|
| `toggleWarPaste()` | 6881 | Shows/hides war data paste form. |
| `importWarUrl()` | 6889 | Async. Fetches war report HTML from a Arma (torn war tracker) URL; calls `parseArmaSync()`. |
| `importWarPaste()` | 6957 | Parses pasted war HTML; calls `parseArmaSync()`. |
| `parseArmaSync(html, url)` | 6990 | Parses Arma war report HTML into a war object; pushes to `S.wars`. |
| `warTotalPot(w)` | 7063 | Returns total war pot (sum of all member rewards) for a war object. |
| `warFactionCut(w)` | 7071 | Returns faction's cut of the war pot based on `w.factionCutPct`. |
| `saveWarFactionCut(idx, pct)` | 7078 | Saves faction cut percentage for war at index `idx`; re-renders. |
| `setWarPeriod(el, period)` | 7086 | Sets `S.warPeriod`; updates active pill; re-renders. |
| `clearWarData()` | 7093 | Clears `S.wars`; saves; re-renders. |
| `renderWarPanel()` | 7101 | Renders war panel — per-war totals, member payouts, period-filtered summary. |
| `removeWar(idx)` | 7247 | Removes war at index `idx`; saves; re-renders. |

### 4.29 Event Log / Delta Filter (lines 7265–7395)

| Function | Line | Description |
|---|---|---|
| `mergeEventLog()` | 7265 | Merges `S.events` into `S.eventLog` (deduped by ID); saves to localStorage. |
| `toggleDeltaFilter()` | 7315 | Toggles `S.deltaFilterOn`; re-renders debug events. |
| `parseOutgoing()` | 7323 | Parses `S.events` for outgoing item send events; updates `S.outgoing`. |

### 4.30 OC Diagnostics / Debug Utilities (lines 7388–7465)

| Function | Line | Description |
|---|---|---|
| `manualOCRefresh()` | 7388 | Async. Manual re-fetch of `faction/crimenews`; re-renders OC. |
| `ocRawDiag()` | 7403 | Async. Fetches one page of crimenews and logs raw entries to console for inspection. |
| `filterType(el, type)` | 7447 | Sets armory type filter; updates pill active state; re-renders supply. |
| `toggleTrackConsumables(checked)` | 7452 | Saves `S.trackConsumablesSent`; re-renders inventory. |

### 4.31 Access Gate (lines 7467–7900)

| Function | Line | Description |
|---|---|---|
| `getAccessRecord()` | 7467 | Reads and parses `hv_access` from localStorage. |
| `setAccessRecord(record)` | 7470 | Serializes and writes access record to `hv_access`. |
| `isAccessValid()` | 7473 | Returns true if stored access record is valid (not expired, or lifetime, or faction). |
| `accessExpiresIn()` | 7481 | Returns ms until access expires (0 if no record). |
| `checkAccessPaymentLog(logEntries)` | 7491 | Scans `user/log` entries for Xanax sends (item 206) or money sends to `OWNER_ID` with `'dashboardaccess'` message. Returns access grant object or null. |
| `verifyAndGrantAccess()` | 7541 | Async. Reads key from `#accessKeyInput`; fetches `user/basic` + `user/log`; calls `checkAccessPaymentLog()`; grants access if valid. |
| `showInitPanel(playerName, accessLabel, factionName)` | 7643 | Shows init options screen after access verified — "Launch Dashboard" button. |
| `gateLaunchDashboard()` | 7667 | Hides access gate; saves key; triggers `saveKey()` flow. |
| `showAccessGate(show)` | 7696 | Shows/hides `#accessGate`. |
| `autoVerifyStoredKey(keyVal)` | 7706 | Async. If a key and access record are stored, silently validates and auto-launches dashboard. |
| `checkAccessOnLoad()` | 7735 | Entry point called on page load — checks stored key/access; shows gate or auto-launches. |
| `silentFactionRecheck(r)` | 7782 | Async. Silently re-checks faction membership for faction-gated access. |

### 4.32 Debug Helpers (lines 7803–7870)

| Function | Line | Description |
|---|---|---|
| `dbgLogCategories()` | 7803 | Async. Fetches `user/log` with categories filter; logs results to console. |
| `dbgUserLog()` | 7821 | Async. Fetches user log and logs first 10 entries for inspection. |

### 4.33 Tooltip Binding (lines 7871–7905)

| Function | Line | Description |
|---|---|---|
| `_bindTipHover(el)` | 7871 | Attaches mouseenter/mouseleave listeners to a `.mem-tip` element for desktop hover. |
| `_closeAllTips()` | 7884 | Removes `.tip-open` from all `.mem-tip` elements on page. |
| `_closeTipsExcept(tgt)` | 7887 | Closes all `.mem-tip` tooltips except `tgt`. |

> **Tooltip system note:** After `renderOC()` generates `.mem-tip` elements, a `MutationObserver` (near end of `<script>`) calls `_bindTipHover()` on each new element. The document-level `click` handler at the bottom of the script manages toggle/close-all behavior.

---

## 5. State Object (`S`) Schema

The `S` object (initialized at line 1955) is the single source of truth for all app state. It is **not** a class — it is a plain object mutated directly throughout the codebase.

```
S = {
  // ── API Key
  key: string                   // Torn API key (also in hv_key localStorage)

  // ── Faction Data (populated by fetchAll → faction/basic)
  faction: object|null          // Raw Torn faction API response (includes .money, .members)
  donations: {}                 // {memberId: {money_balance, name, ...}} from faction/donations
  armoryNews: []                // [{timestamp, news}] from faction/armorynews — sorted newest first
  prices: {}                    // {itemId: {name, type, market_value}} from torn/items

  // ── Event Data (from user/events)
  events: []                    // Latest user/events array (current page only)
  eventLog: []                  // Full persistent event history (merged across syncs)
  lastEventTs: number           // Highest timestamp seen — used for delta detection
  _prevEventTs: number          // Previous sync's highest timestamp — used for delta filter
  deltaFilterOn: boolean        // Debug panel: show only events newer than _prevEventTs

  // ── OC Crime Data (from faction/crimenews)
  crimeNews: []                 // [{timestamp, news}] crimenews entries (crime-specific)
  ocRaw: []                     // Subset of mainnews matching OC payout patterns
  _crimeLog: []                 // All crimenews entries (sorted newest first, persisted)
  _ocCrimes: []                 // v2 enriched crime objects (unused in active code)
  _ocDetails: []                // v2 crime detail objects (unused in active code)
  _ocV2Running: boolean         // Flag: OC v2 fetch in progress
  _ocShowFailed: boolean        // OC panel: whether to show failed OCs in the log

  // ── Attack/Respect News (from faction/mainnews)
  attackNews: []                // [{timestamp, news}] mainnews filtered for /respect/
  ocOverrides: {}               // {ts_key: {reward, respect}} inline edit overrides
  respectOverrides: {}          // {ts_member_key: {respect}} inline edit overrides

  // ── Receipt / Payout Tracking
  receipts: []                  // [{id, member, memberId, item, qty, mv, cat, pct, ts, deleted, manual}]
  paidLog: {}                   // {memberName: [{ts, amount}]} payment history
  rates: {}                     // {category: percentNumber} payout rates (default 98 = 98%)
  exemptReceipts: Set           // Set of receipt IDs exempt from payout calculation
  refundedPayments: Set         // Set of payment event timestamps marked refunded

  // ── Outgoing Items
  outgoing: []                  // [{ts, member, item, qty, mv}] items sent by user to members

  // ── Inventory (Museum Sets)
  inventory: []                 // Legacy (deprecated): raw user inventory items
  manualCounts: {}              // {itemName: qty} manually entered set item counts
  invDeltaTs: number            // Unix ts of last manual count save
  invPurchases: []              // [{id, ts, item, qty, src}] market/bazaar purchases
  pointPrice: number            // Current points market price per point
  pointPriceHistory: []         // [{label, price}] 365-day rolling history
  trackConsumablesSent: boolean // Deduct consumables sent from inventory delta

  // ── War Funds
  wars: []                      // [{name, result, date, members, factionCutPct, memberPayout, ...}]
  warPeriod: string             // Active war filter period ('all', '30d', etc.)

  // ── UI State
  tab: string                   // Active tab name ('vault', 'oc', 'receipts', etc.)
  typeFilter: string            // Armory type filter ('all', 'Plushie', etc.)
  cardPeriods: {}               // {supply:'30d', oc:'30d', pnl:'30d'} per-card period setting
  respectPeriod: string         // Active period for respect tab ('1d', '7d', etc.)
  loading: boolean              // True while fetchAll is in progress
  lastSync: number|null         // Timestamp (ms) of last successful sync

  // ── Error Tracking
  errorLog: []                  // [{ts, code, context, message}] API errors

  // ── Access / Auth
  testers: []                   // [{name, grantedAt, notes}] free tester access list
  factionWhitelist: []          // [{id, label, notes, grantedAt}] whitelisted faction IDs

  // ── Init
  initLookback: number          // Seconds to look back on init (default 2592000 = 30 days)
}
```

---

## 6. Data Flow

### 6.1 First-Run Initialization

```
checkAccessOnLoad()
  └─ autoVerifyStoredKey(key)   — checks hv_key + hv_access
       ├── valid → revealDash() + fetchAll()     — skip init screen
       └── invalid → showAccessGate()
              └── verifyAndGrantAccess()
                    ├── tGet('user','basic') + tGet('user','log')
                    ├── checkAccessPaymentLog() → grant access
                    └── showInitPanel()
                           └── gateLaunchDashboard()
                                  └── saveKey()
                                         └── runInitialize()
                                                └── paginatedFetch (all endpoints up to initLookback)
                                                       └── fetchAll() → revealDash() → startCycle()
```

### 6.2 Normal Sync Cycle

```
startCycle()
  ├── scheduleBgFetch()    — every BG_INTERVAL ms
  │     └── fetchAll(false, true)   — background mode (throttled)
  │           ├── restoreFromCache()          — skip fresh categories
  │           ├── tGet('faction', 'basic,donations')
  │           ├── tGet('faction', 'currency')
  │           ├── tGet('faction', 'armorynews') [paginated]
  │           ├── tGet('faction', 'mainnews')   [paginated] → S.attackNews + S.ocRaw
  │           ├── tGet('faction', 'crimenews')  [paginated] → S._crimeLog
  │           ├── tGet('user', 'events')        → parseReceipts() + parseOutgoing()
  │           ├── tGet('torn', 'items')
  │           └── localStorage.setItem(all caches)
  │
  └── scheduleDisplayRefresh(RMINS * 60 * 1000)
        └── renderAll()    — re-renders DOM from current S state (no API calls)
```

### 6.3 Sync Events (Manual)

```
syncEvents()
  └── tGet('user', 'events') → S.events
        ├── mergeEventLog()     → S.eventLog
        ├── parseReceipts()     → S.receipts
        ├── parseOutgoing()     → S.outgoing
        ├── fetchOutgoingLog()  → S.outgoing (merges user/log)
        └── saveReceipts() + renderReceipts() + updateBadge()
```

### 6.4 Torn API → State → Render

```
Torn API endpoint
  └── tGet(section, sel)              — rate-limited fetch, tracks calls
        └── merge into S.*            — direct mutation of state object
              └── localStorage.setItem(cache key, JSON)
                    └── render*()/renderAll()    — reads S.* → builds DOM innerHTML
```

---

## 7. Known Patterns & Conventions

### Tab Switching
- Always call `switchTab(name)` — never manipulate `.tab.active` or `.panel.active` directly.
- `switchTab()` stores `S.tab` and triggers the appropriate render function.
- Panels that are expensive to render (debug, war) are **only rendered on tab switch**, not in `renderAll()`.

### Period Pills (Time Filtering)
- Stat cards use `S.cardPeriods[card]` — cycle with `cycleCardPeriod()` or set with `setCardPeriod()`.
- Respect uses `S.respectPeriod` — set with `setRespectPeriod()`.
- War uses `S.warPeriod` — set with `setWarPeriod()`.
- All periods are filtered via `inPeriod(ts, period)` or `periodToSeconds(period)`.
- Periods: `'1d'`, `'7d'`, `'30d'`, `'90d'`, `'1y'`, `'all'`.

### News Entry Format
- All news arrays (`armoryNews`, `attackNews`, `crimeNews`, `_crimeLog`, etc.) contain objects with:
  - `.timestamp` — Unix seconds
  - `.news` — Raw HTML string from Torn API (may contain `<a>` links)
- Use `stripHtml(e.news)` to get plain text; `extractXid(e.news)` for player IDs.

### Member Tooltips (OC panel)
- `renderOC()` → `memberBadge()` generates `<td class="mem-tip">` elements.
- `.tip-open` class on `.mem-tip` makes `.mem-tip-box` visible (`display:block`).
- **Desktop:** `_bindTipHover(el)` added via `MutationObserver` handles mouseenter/mouseleave.
- **Mobile:** Document-level `click` handler toggles `.tip-open` and calls `_closeTipsExcept()`.
- **Important:** `.mem-tip-box` must have `pointer-events:auto` (not `none`) or clicks/taps on the open tooltip will pass through and immediately re-close it.

### Console Logging
- `clog(msg, level)` — all runtime logging. Levels: `'ok'`, `'warn'`, `'err'`, `'info'`.
- Console is visible at `#cWrap` / `#cLines` (below key bar).
- Secondary console at `#postConsole` / `#cLinesPost` (toggled via key bar button).

### OC Selection→Result Matching
- Selections and results are both in `S._crimeLog` (`.news` field distinguishes them).
- A "selection" entry matches `/initiated a .* operation/i` or similar.
- A "result" entry matches `/succeeded|failed/i`.
- The matching algorithm in `renderOC()` is a **greedy nearest-prior-selection** approach: for each result, find the most recent selection of the same crime type within a 7-day window.
- Conflicts occur when multiple same-type OCs overlap — `ocDbgRenderMatch()` visualizes this.

### localStorage Keys

All keys use the `hv_v1_` prefix (post-migration). Legacy `hv_` keys (no version) are cleaned on first load.

| Key | Content |
|---|---|
| `hv_key` | Raw API key string |
| `hv_initialized` | `'true'` when init has run |
| `hv_access` | JSON access record `{method, grantedAt, expiry, lifetime, ...}` |
| `hv_last_seen_version` | Last `APP_VERSION` string seen (for upgrade detection) |
| `hv_upgrade_from` | Previous version (for changelog highlight) |
| `hv_pending_changelog` | `'1'` if changelog should auto-open on next load |
| `hv_cache_version` | `'v1'` cache version marker |
| `hv_v1_rcpts` | `S.receipts` JSON |
| `hv_v1_paid` | `S.paidLog` JSON |
| `hv_v1_rates` | `S.rates` JSON |
| `hv_v1_sync_rate` | `RMINS` float string |
| `hv_v1_wars` | `S.wars` JSON |
| `hv_v1_card_periods` | `S.cardPeriods` JSON |
| `hv_v1_outgoing` | `S.outgoing` JSON |
| `hv_v1_oc_overrides` | `S.ocOverrides` JSON |
| `hv_v1_respect_overrides` | `S.respectOverrides` JSON |
| `hv_v1_refunded_payments` | `S.refundedPayments` array JSON |
| `hv_v1_oc_crimes` | `S._ocCrimes` JSON |
| `hv_v1_crime_log` | `S._crimeLog` JSON |
| `hv_v1_exempt` | `S.exemptReceipts` array JSON |
| `hv_v1_ptprice` | `S.pointPrice` float string |
| `hv_v1_ptphist` | `S.pointPriceHistory` JSON |
| `hv_v1_track_consumables` | `'true'/'false'` string |
| `hv_v1_testers` | `S.testers` JSON |
| `hv_v1_faction_whitelist` | `S.factionWhitelist` JSON |
| `hv_v1_inventory` | `S.inventory` JSON (legacy) |
| `hv_v1_manual_counts` | `S.manualCounts` JSON |
| `hv_v1_inv_delta_ts` | `S.invDeltaTs` int string |
| `hv_v1_inv_purchases` | `S.invPurchases` JSON |
| `hv_v1_event_log` | `S.eventLog` JSON |
| `hv_v1_last_event_ts` | `S.lastEventTs` int string |
| `hv_v1_prev_event_ts` | `S._prevEventTs` int string |
| `hv_v1_last_sync` | Last sync timestamp (ms) string |
| `hv_v1_init_lookback` | `S.initLookback` int string |
| `hv_v1_fetch_meta` | `{category: timestamp}` freshness map |
| `hv_v1_faction_cache` | `{faction, donations}` JSON |
| `hv_v1_armory_cache` | `S.armoryNews` JSON |
| `hv_v1_mainnews_cache` | `{attackNews, ocRaw}` JSON |
| `hv_v1_attacknews_cache` | `S.crimeNews` JSON |
| `hv_v1_items_cache` | `S.prices` JSON |

---

## 8. Common Bug Locations

### 8.1 Missing Function Definitions
- HTML `onclick="..."` attributes call JS functions that may not exist yet if a new UI element is added without a corresponding implementation.
- **Check:** Search for `onclick=` in HTML; verify every function name exists in the `<script>` block.
- Past examples: `ocDbgTab()`, `ocDbgRenderRaw()`, `ocDbgRenderMatch()`, `ocDebugToggle()`.

### 8.2 OC Selection→Result Matching
- Selections and results may have ambiguous timestamps when multiple same-type crimes run concurrently.
- The greedy algorithm can mis-attribute results if two OCs of the same type complete close together.
- Use the **Member Matching** debug tab (`ocDbgRenderMatch()`) to inspect the trace.
- Override with `cnSaveMembers()` / `S.ocOverrides` for manual corrections.

### 8.3 Tooltip `pointer-events`
- `.mem-tip-box` must have `pointer-events: auto`. If set to `none`, taps on the open tooltip bubble up to `.mem-tip` and immediately re-close it (appears to never open).
- The document-level click handler must call `stopPropagation()` when handling a `.mem-tip` click to prevent double-firing.

### 8.4 Rate Limiting
- `tGet()` does NOT rate-limit itself — callers should use `rateSafeGet()` for batched background fetches.
- Background sync mode (`bgSyncMode = true`) enforces `BG_INTERVAL` ms between calls.
- Manual syncs use full `API_LIMIT` (75/min). Exceeding Torn's 100/min limit returns error code 5.

### 8.5 localStorage Size Limits
- Browsers enforce ~5–10 MB total localStorage per origin.
- `S._crimeLog` and `S.eventLog` can grow large with deep fetches.
- All `localStorage.setItem()` calls are wrapped in `try/catch` — silent failure is possible if quota is exceeded.
- Use **Admin → Inspect Storage** to check current usage.
- Previous versions had `.slice(0,2000)` caps that silently discarded old entries; these were removed in v2.40.9.

### 8.6 Event Log Delta Filter
- `S.deltaFilterOn` filters `renderDebugEvents()` to show only entries newer than `S._prevEventTs`.
- `S._prevEventTs` is updated at the start of each sync from `S.lastEventTs`.
- If `_prevEventTs` is 0 (first load), all entries show even when filter is on.

### 8.7 API Permission Errors (Code 16)
- Error code 16 = "Access level too low". Shown as a banner in `#gErr`.
- Commonly triggered by `faction/currency` or `faction/armorynews` if the API key lacks faction permissions.
- OC v2 endpoints (`/faction/crimes`) require elevated faction-level key — not available to standard keys.
