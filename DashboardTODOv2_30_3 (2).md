# HighVibes Faction Dashboard — Rolling TODO Log
**Current Version:** v2.30.3  
**File:** FactionDashboardv2_30_3.html  
**Repo:** kreinas1995.github.io  
**API Reference:** https://tornapi.tornplayground.eu/  
**Last Updated:** 2026-04-11  

---

## SESSION WORKFLOW
Each session:
1. Pick 1–2 tasks from the priority queue below
2. Copy working file: `cp /mnt/user-data/uploads/FactionDashboardv2_30_3.html /home/claude/FactionDashboardv2_30_3.html`
3. Make targeted edits with `str_replace` (never rewrite full file)
4. **After each completed task:** immediately output HTML + TODO via `present_files` — do not wait until the end of the session
5. Update this TODO: bump version, mark tasks done, update CHANGELOG
6. **Before hitting tool limit:** output current files and log resume point (see Safe Output Protocol below)

---

## SAFE OUTPUT PROTOCOL

Progress is lost if the session hits a tool/token limit mid-task without saving. To prevent this:

**After every completed task (not just at session end):**
- Bump the version in HTML (`APP_VERSION` const + `<title>`)
- Copy to `/mnt/user-data/outputs/FactionDashboardvX_X_X.html`
- Update and output this TODO as `DashboardTODOvX_X_X.md` (matching HTML version) via `present_files`
- This ensures the last clean state is always recoverable

**When approaching the tool limit (or when told to "continue"):**
- Do NOT start a new task
- Output whatever is complete and stable
- Add a **## RESUME POINT** note at the top of this file (below the header) with:
  - Exact next task ID
  - What was already done this session
  - The next `str_replace` target or function to edit, if mid-task
- Then call `present_files` on both HTML and TODO
- Start fresh next session from the resume point

**The goal:** every session ends with a working, versioned HTML file. Never leave the user with only in-progress edits that haven't been output.

---

## USAGE COST ESTIMATES (Conservative, Claude Pro)
| Task Size | Approx Tool Calls | Risk |
|-----------|-------------------|------|
| Small (targeted str_replace, 1–3 hunks) | 4–6 | Low |
| Medium (2–5 hunks, logic change) | 6–10 | Medium |
| Large (new tab/feature, 10+ hunks) | 12–20 | High — split across sessions |

**Rule:** If a task exceeds ~15 tool calls, split it. Save state in this file.

---

## SESSION TOKEN BURN RATE — HOW TO ESTIMATE ACCURATELY

Tool call count estimates per task are useful but incomplete. The real limit is **total tokens processed in a rolling window**, not message count. Per-tool estimates will always be off because token cost scales with context size, not just actions taken.

### Why per-tool estimates drift
- Every message Claude sends re-reads the **entire conversation history**. A long session with a large TODO file loaded means each tool call costs significantly more than the same call at session start.
- This TODO file itself adds substantial input tokens on every turn. The longer the session, the more expensive each subsequent call becomes.
- Limits fluctuate with Anthropic server load — peak hours (roughly 8 AM–2 PM ET weekdays) tighten limits even if token count is the same.

### How to track your actual burn rate
- **Settings > Usage** in your Claude account shows a progress bar for the current 5-hour session window. Check it before starting and midway through a session. Note: it updates with a delay, not in real time.
- **Third-party tools** like ClaudeOrb or claude-token-guard (browser extensions) show session percentage, countdown to reset, and estimated cost live in the interface. Useful if you hit limits frequently.
- **As a rule of thumb:** a session that starts with this TODO file loaded is burning more tokens per turn than a fresh context. Treat the first tool call of a session as a baseline — if the TODO + HTML file are both loaded, budget conservatively.

### Practical habits for this project
- **Keep sessions short and focused.** Pick 1–2 tasks max. A session that does 3 small tasks cleanly is more efficient than one that attempts a large task and runs out mid-implementation.
- **Don't reload both files if you only need one.** If the task doesn't require the HTML (e.g. triage, TODO update), don't upload it. Fewer tokens in context = more runway per session.
- **Output after every task, not just at session end.** Each completed task should immediately produce a versioned HTML + updated TODO. Never accumulate multiple tasks before saving.
- **Summarize state into this file before ending.** The RESUME POINT section is the compressed handoff — a fresh Claude instance reading it costs far less than one inheriting a long conversation.
- **Edit, don't follow up.** If a str_replace misses, edit the previous message rather than sending a correction. This trims conversation weight.
- **Split large tasks explicitly.** When a task says "12–20 tool calls — split if needed," plan the split point in advance and save it in the session log before hitting the limit. Don't wait until you're cut off.

### When to start a fresh session
If you're mid-task and notice responses slowing or getting truncated, end the session cleanly: output current file state, log exactly where you stopped and what the next `str_replace` target is, then start fresh. Continuing a degraded session burns tokens without reliable output.

---

## ✅ COMPLETED (do not re-implement)

| ID | What | Version |
|----|------|---------|
| P0-A | TODO file + str_replace workflow established | v2.21 |
| P1-1 | `filter(i.name\|\|i.item_name)` inventory field fix | v2.22 |
| P1-3 | API key skip on page load — `autoVerifyStoredKey()` added | v2.23 |
| P1-5 | OC 1.0 via `crimenews`, v2 gated behind `_totalPaid > 0` | v2.23 |
| P1-2 | Inventory two-column plushie/flower layout with MV per row | v2.25 |
| P1-4 | Debug event log delta, `_prevEventTs` persisted to localStorage | v2.27–28 |
| BUG-INIT-1* | `gateLaunchDashboard` + stored-key auto-run added | v2.30 |
| BUG-RATE-1* | `pages()` 300ms delay + error-5 retry added | v2.30 |
| BUG-OC-1* | OC v2 fetch attempt removed from init/fetchAll, v2 buttons collapsible | v2.30 |
| BUG-DEBUG-1* | `logError()` + `S.errorLog` wired, error log tab added | v2.29 |
| BUG-DEBUG-2* | Error log CLEAR button + live badge added | v2.29 |
| BUG-SYNC-1 | Sub-15min sync options removed (Live/1min/5min). Min interval now 15min. | v2.30.2 |
| BUG-INV-4 | Inventory columns split into Qty / Unit MV / Total (was single mislabeled MV column) | v2.30.2 |
| BUG-INV-3 | Fallback warning banner — confirmed already rendered once above both columns, not duplicated | v2.30.3 |
| BUG-INV-2 | Fallback warning updated: "ESTIMATED — received items only. Gifts/trades not included." | v2.30.3 |
| BUG-RATE-2 | Rate meter now shows 60s rolling avg out of 100 (Torn's actual cap, not internal 75) | v2.30.3 |
| BUG-MUS-1 | Nonexistent plushies in museum list — context doc corrected to 13 verified items; PLUSHIE_SET in HTML was already correct | v2.30.3 |
| BUG-MUS-2 | Nonexistent flowers in museum list — context doc corrected to 11 verified items; FLOWER_SET + FLOWER_NAMES in HTML were already correct | v2.30.3 |

> *Marked done in session logs but **not yet confirmed working** by user testing. Treat as "implemented, needs verification" — re-open if bugs resurface.

---

## 🔴 OPEN BUGS — PRIORITY ORDER

### [BUG-INIT-1] Page refresh re-runs initialization *(needs verification)*
- **Symptom:** Full init screen re-appears on every page reload even with stored key
- **Expected:** If `hv_initialized=true` AND `hv_key` exists AND no fatal errors in `S.errorLog` → skip init, run `fetchAll` only
- **Note:** Fix was implemented in v2.30.0 but user has not confirmed it's resolved. Re-open if still happening.
- **Est:** 4–6 tool calls if still broken

### [BUG-RATE-1] Too many API calls too fast *(needs verification)*
- **Symptom:** Init hitting rate limits, calls fire faster than Torn allows
- **Limits:** User is capped at 100 calls/min by Torn. Our target: peak ≤50/min during init, ≤15/min during background sync
- **Fix spec:**
  - `pages()` delay between pages: 300ms → **1200ms** (= 50/min)
  - `paginatedFetch()` / background sync delay: → **4000ms** between pages (= 15/min)
  - Global budget check: if >40 calls in last 60s, pause before next call
- **Note:** Partial fix in v2.30.0 (300ms delay + retry). Actual 1200ms/4000ms delays may not have been applied yet — verify.
- **Est:** 4–6 tool calls if still incomplete

### [BUG-RESPECT-1] War bonus drastically overcounting
- **Symptom:** "ALL" period shows 74,774 war bonus respect. Actual value should be ~1,526 (one Bronze I rank-up confirmed at ts=1775361656)
- **Root cause:** Regex `/received\s+([\d,]+)\s+bonus\s+respect/i` matches chain respect entries and other unrelated news text in `S.attackNews` (thousands of entries scanned)
- **Fix:** Tighten regex to only match the specific rank-up format:
  `ranked up from X to Y and received N bonus respect`
- **Also:** War bonus should only count rank-up entries, not repeat-match. The war bonus result should survive re-init via localStorage.
- **Est:** 4–6 tool calls

### [BUG-PTS-1] Point price fetch failing
- **Symptom:** Point price shows $0 or fails to load in inventory column
- **Root cause:** `market/367` itemmarket endpoint returning wrong field or error
- **Fix:** Switch to `torn/?selections=stats` → `stats.points_averagecost` (confirmed returning ~$42,805 = 24h average price, close enough)
- **Also remove:** `market/367` fetch entirely from init and fetchAll. Simpler endpoint, no extra permissions needed.
- **Est:** 3–4 tool calls

### [BUG-INV-1] Inventory not loading — key missing permissions
- **Symptom:** Inventory tab shows "Regenerate key with user/inventory access" warning. `user/inventory` data is empty.
- **Root cause:** Current API key was not generated with the `user/inventory` checkbox checked
- **Fix part 1:** UI already shows warning + GET KEY button — confirmed working. No change needed here.
- **Fix part 2:** Audit `openCustomKeyUrl()` to ensure ALL needed permissions are included in the generated key URL. Current known gaps:
  - ADD: `torn=stats` (needed for `points_averagecost` point price)
  - ADD: `market` selection (future use)
  - REMOVE: `market/367` itemmarket approach from key URL (replaced by `torn/stats`)
  - CONFIRM: `user=basic,events,inventory,log` and `faction=basic,donations,currency,armorynews,mainnews,attacknews,crimenews` are all present
- **Est:** 3–4 tool calls

### [BUG-OC-1] OC log API access still being attempted *(needs verification)*
- **Symptom:** `faction/crimes&ID=XXXXX` returns [16] — inaccessible on custom key. Error may still be surfacing.
- **Fix:** Remove OC detail fetch loop from init and fetchAll entirely. Replace with manual entry placeholder:
  - Tap any OC success row → input fields for $ and respect appear inline
  - Persist manual entries to `hv_oc_manual` localStorage
  - Show "—" in $ column when no manual entry exists (no error shown to user)
- **Note:** Suppression was added in v2.29–30. Verify [16] no longer appears in gErr banner for OC fetches.
- **Est:** 8–10 tool calls for manual entry UI if not yet built

### [BUG-INIT-2] Init progress bar jumpy, no section labels
- **Symptom:** Progress bar jumps by section with no context. % and ETA shown but not useful.
- **Fix:** Replace current progress UI with:
  - Labeled list of sections to load (e.g. "User Data", "Faction News", "Inventory", etc.)
  - Each section starts with a red indicator
  - On completion: ✓ green checkmark or ✗ red X per section
  - Single **elapsed time** counter below (e.g. `Elapsed: 4s`) — no ETA, no %
  - Smooth per-section updates (not batched)
- **Est:** 5–7 tool calls

### [BUG-DEBUG-1] Errors not logging to error console *(needs verification)*
- **Symptom:** API errors (e.g. error code 16) visible in API console but not appearing in Error Log tab
- **Fix:** Ensure all `iconsole(...,'err')` calls inside `runInitialize` also call `logError()`
- **Est:** 3–4 tool calls if still broken

### [BUG-DEBUG-2] Error console missing copy button *(needs verification)*
- **Symptom:** Debug report has a ⎘ COPY button; error log does not
- **Fix:** Add ⎘ COPY button to error log section header, same pattern as debug report
- **Est:** 2 tool calls if still missing

### [BUG-DEBUG-3] API console does not copy to clipboard on tap
- **Symptom:** Tapping the API console text does nothing
- **Fix:** Add `onclick` handler to `initConsole` div that copies its `textContent` to clipboard
- **Est:** 1–2 tool calls

### [BUG-DEBUG-4] user/log entries not showing in debug event log
- **Symptom:** Debug Events tab does not include entries fetched by `fetchOutgoingLog()`
- **Fix:** Ensure `fetchOutgoingLog` results are surfaced in the debug events view. Either add entries to the existing event log display or add a separate "Outgoing Log" section in the Debug tab.
- **Est:** 3–4 tool calls

---

## 🟠 NEW FEATURES — PRIORITIZED

### [FEAT-PNL-1] Net P&L — personal item send reimbursement tracking
- **Request:** When the user sends personal items (e.g. Xanax) to faction members, this is a personal cost. Net P&L should reflect this so the user can request reimbursement from faction funds.
- **Implementation:**
  - Track outgoing personal item sends via `user/log` (title="Item send", confirmed working)
  - Calculate total Market Value of sent items
  - Subtract from Net P&L as a personal cost line
  - Add a **"Faction Reimbursement"** pay card in the Items tab
  - Pay card shows: items sent, total MV owed, "Request Reimbursement" button
  - Button creates a pending payout from faction funds to self (same flow as other pay cards)
- **Depends on:** `fetchOutgoingLog` working correctly (user/log key permission required)
- **Est:** 10–14 tool calls — split if needed

### [FEAT-WAR-1] War funds — manual HTML paste option
- **Request:** War report page is firewalled and cannot be accessed directly via API. Need a manual fallback.
- **Implementation:**
  - Add a "Paste War Report HTML" textarea in the War Funds tab
  - User pastes raw HTML from the war report page
  - Parse HTML to extract member names, scores, and calculate payouts using existing tiered logic
  - Display result using same war funds layout
- **Est:** 10–14 tool calls

### [FEAT-WAR-2] War funds split adds to faction P&L
- **Request:** When a war payout is calculated and distributed, the total payout amount should be recorded as faction income in Net P&L.
- **Implementation:** When war payout is finalized, add the total split amount to the P&L income tracker (same mechanism as donation income)
- **Est:** 4–6 tool calls
- **Depends on:** [FEAT-WAR-1] for manual paste path, or existing war data if already loaded

---

## 🟢 BACKLOG / FUTURE

| ID | Description |
|----|-------------|
| P1-6 | OC `attributeOCPayouts` field audit — verify join key and amount field when v2 access is available |
| P2-1 | `user/log` outgoing regex tuning — run Debug → user/log sample and share exact `title` field value for pattern matching |
| P2-2 | GitHub integration — evaluate GitHub MCP or structure output filenames for direct repo replacement |
| P3-1 | OC v2 full support — auto-detect when key has crimes access and switch from v1 |
| P3-2 | War funds API import — wire war data parsing when not firewalled |
| P3-3 | Session cost display in UI — show estimated API usage per action in Admin/Debug tab |

---

## PRIORITY ORDER FOR NEXT SESSION

### 🔴 Fix first (usability blockers)
1. **[BUG-RESPECT-1]** War bonus overcounting — tighten regex to rank-up format only
2. **[BUG-PTS-1]** Point price — switch to `torn/stats` → `points_averagecost`, remove `market/367`
3. **[BUG-INV-1]** Audit and fix `openCustomKeyUrl()` permissions (add `torn=stats`, remove `market/367`)
4. **[BUG-RATE-1]** Verify/apply 1200ms init delay + 4000ms background sync delay

### 🟠 High priority (visible/broken UI)
5. **[BUG-INV-3]** Deduplicate fallback warning banner
6. **[BUG-INV-2]** Label receipt fallback as "ESTIMATED — received items only"
7. **[BUG-RATE-2]** Rate meter → 60s rolling avg, labeled out of 100
8. **[BUG-OC-1]** Verify [16] suppression working; build manual entry UI if not yet done

### 🟡 Medium (debug/UX polish)
9. **[BUG-INIT-1]** Verify page refresh no longer re-inits
10. **[BUG-DEBUG-1]** Verify errors logging to Error Log tab
11. **[BUG-DEBUG-2]** Verify/add error log copy button
12. **[BUG-DEBUG-3]** Add API console tap-to-copy
13. **[BUG-DEBUG-4]** Wire user/log entries into debug events view
14. **[BUG-INIT-2]** Init progress bar — section checklist with elapsed time

### 🟢 New features (after bugs resolved)
17. **[FEAT-PNL-1]** Personal item send reimbursement + Faction Reimbursement pay card
18. **[FEAT-WAR-1]** War funds HTML paste input
19. **[FEAT-WAR-2]** War payout adds to P&L income

---

## CHANGELOG

### v2.30.3 (current)
- Fallback warning text updated: now clearly states "ESTIMATED — received items only" and explains gifts/trades are not included.
- BUG-INV-3: Confirmed no duplicate banner — warning already renders once above both columns.
- Rate meter: now shows true 60s rolling average out of 100 (Torn's actual cap). Removed 10s extrapolation. Internal safety limit of 75 retained for `rateSleep()` blocking but not shown to user.

### v2.30.2
- Sync rate options: removed Live (~30s), 1min, 5min. Minimum sync interval now 15min.
- Inventory columns: split from 2 columns (Qty, MV) into 3 (Qty, Unit MV, Total). Grid updated to `1fr auto auto auto`. Unit MV shows per-item market price; Total shows qty × unit MV.

### v2.30.1
- Inventory tab: receipt fallback with warning + GET KEY link
- Auto-verify: stored key silently verified on load, dashboard auto-launches
- Init progress: blocks dashboard until fetchAll resolves
- `logError()` + `S.errorLog`: all API errors captured, capped at 100
- [16] gErr suppression for OC detail fetches
- Debug tab: Error Log section with color-coded table, CLEAR button, live badge
- `gateLaunchDashboard`: no double-click required
- `runInitialize`: sets status to LIVE on completion
- `pages()`: 300ms delay + error-5 retry (3x, 15s backoff)
- `paginatedFetch()`: error-5 retry with 12s backoff
- OC panel: v2 buttons in collapsible details section
- Debug panel: grouped USER/FACTION/MARKET with market/367 test button
- `hv_oc_manual` added to wipe lists

### v2.28.0
- `_prevEventTs` persisted to `hv_prev_event_ts` localStorage — NEW ONLY survives reload
- Restored on init, cleared on clearKey
- `buildColumn` dead variables removed
- `clearKey` resets `_logTitlesSeen` and `deltaFilterOn`

### v2.27.0
- `mergeEventLog` delta bug fixed — `lastEventTs` advances correctly each sync
- `S._prevEventTs` as separate delta baseline; `renderDebugEvents` uses it for NEW tagging
- Inventory columns mobile breakpoint — stacks to 1 col below 640px (`.inv-columns`)
- Debug report EVENT LOG section added

### v2.25.0
- Two-column inventory layout: Plushies (blue) | Flowers (green)
- Per-item rows with qty color coding (red=0, yellow<3, green≥3) + MV per row
- Column footer: Total MV, Total Point Conversion, Total Point Value, Museum Day +10% block
- Summary stat row at top: Total MV, Total Pts, Pts Value, Museum Day Diff
- Point price badge in header, refreshable

### v2.24.0
- Access gate redesign: scanline/boot terminal aesthetic, hex logo pulse
- GET API KEY button visible before verify
- Verify → INITIALIZE SYSTEM button (no auto-launch)

### v2.23.0
- `autoVerifyStoredKey()`: silently verifies faction membership on load, skips gate if valid
- OC 1.0 legacy path rewritten: parses crime type, success/fail, reward, log links, participants
- `useV2` now requires actual `_totalPaid > 0`, not just array length
- OC panel header shows v1 active status

### v2.22.0
- `fetchOutgoingLog()`: uses `user/log`, pattern-matches item-send entries by title keyword
- Delta-fetch using last outgoing ts. Silent fail if key lacks log access.
- Wired into syncEvents + fetchAll

### v2.21.0
- `faction/currency` debug shows `money: $X`
- `S.inventory` persisted to `hv_inventory` localStorage
- `_ocV2Running` flag prevents double-runs
- Error code 16 shows inline "Generate new key ↗" link
- Version badge + APP_VERSION updated

### v2.20.x and earlier
- War payout calculator with tiered logic
- Configurable sliders + roster tab
- Live sync with 15-min default interval

---

## CONTEXT FOR STANDALONE CLAUDE INSTANCE

### Project
HighVibes faction dashboard for Torn City RPG. Single HTML file hosted at kreinas1995.github.io. No backend — all data via Torn API, persisted in localStorage.

### Tech stack
- Pure HTML/CSS/JS, no framework
- Torn API v1 (primary) + v2 (faction/crimes — blocked [16])
- localStorage for all persistence
- Font: Space Mono + Syne via Google Fonts
- Color system: `--accent` (green), `--accent2` (teal), `--accent3` (yellow), `--accent4` (red), `--accent5` (blue)

### Key state object (S)
`S.key, S.faction, S.donations, S.events, S.receipts, S.outgoing, S.wars, S.armoryNews, S.attackNews` (mainnews respect entries), `S.crimeNews` (attacknews), `S._crimeLog` (crimenews), `S.ocRaw, S._ocCrimes, S.inventory, S.eventLog, S.errorLog, S.pointPrice, S.respectPeriod`

### Key localStorage keys
`hv_key, hv_rcpts, hv_paid, hv_rates, hv_sync_rate, hv_wars, hv_card_periods, hv_outgoing, hv_inventory, hv_event_log, hv_last_event_ts, hv_prev_event_ts, hv_oc_manual, hv_ptprice, hv_ptphist, hv_initialized, hv_access, hv_access_bypass`

### API key URL — openCustomKeyUrl()
**Current selections:**
`user=basic,events,inventory,log | faction=basic,donations,currency,armorynews,mainnews,attacknews,crimenews | torn=items`

**Required changes:**
- ADD: `torn=stats` (for `points_averagecost` — point price)
- ADD: `market` (for future use)
- REMOVE: `market/367` itemmarket approach entirely (replaced by `torn/stats`)

### Rate limiting
- `API_LIMIT` = 75 internally. Display to user as out of 100 (Torn's actual cap).
- `rateSleep()` blocks when `apiCallLog.length >= API_LIMIT`
- `pages()` delay: needs to be **1200ms** between pages (50 calls/min)
- `paginatedFetch()` / background sync: needs **4000ms** between pages (15 calls/min)
- Torn hard limit: 100 calls/min per key

### Known API behaviors
- `user/events` — max 25 entries per call; sender-blind for item sends
- `faction/crimenews` — OC 1.0 data, 225 entries available ✅
- `faction/crimes` (v2) — requires elevated key; always returns [16] on custom key
- `faction/crimes&ID=X` — OC detail fetch; always [16] — **do not attempt, use manual entry**
- `faction/currency` — flat response (not nested), special-cased in parser
- `user/inventory` — field may be `name` OR `item_name` depending on key version
- `user/log` — title="Item send", data.items=[{id,uid,qty}], data.receiver=playerID (confirmed)
- `torn/?selections=stats` → `points_averagecost` = 24h average point price (~$42,805 confirmed) ✅
- `faction/armorynews` — 25 entries, tracks outgoing armory items

### Museum item lists (hardcoded)

**Plushies (13 — verified vs Torn wiki April 2026):**
Camel, Chamois, Jaguar, Kitten, Lion, Monkey, Nessie, Panda, Red Fox, Sheep, Stingray, Teddy Bear, Wolverine

**Flowers (11 — verified vs Torn wiki April 2026):**
African Violet, Banana Orchid, Ceibo Flower, Cherry Blossom, Crocus, Dahlia, Edelweiss, Heather, Orchid, Peony, Tribulus Omanense

---

## ⚡ RESUME POINT
**Next task:** [BUG-RESPECT-1] — War bonus regex overcounting  
**Status:** Not started. No partial edits in progress.  
**File to edit:** `FactionDashboardv2_30_3.html`  
**Where to look:** `S.attackNews.forEach` block around line 2748 — regex `/received\s+([\d,]+)\s+bonus\s+respect/i` needs tightening to rank-up format only: `ranked up from X to Y and received N bonus respect`

---

## NEXT SESSION CHECKLIST
1. [ ] Upload latest HTML file (`FactionDashboardv2_30_3.html`)
2. [ ] Upload this TODO file (`DashboardTODOv2_30_3.md`)
3. [ ] Check RESUME POINT above for exact next task
4. [ ] Copy HTML to working dir: `cp /mnt/user-data/uploads/FactionDashboardv2_30_3.html /home/claude/FactionDashboardv2_30_3.html`
5. [ ] Implement with `str_replace` only — no full file rewrites
6. [ ] Output `FactionDashboardvX_X_X.html` + `DashboardTODOvX_X_X.md` after **each completed task**, not just at session end
7. [ ] Before hitting tool limit: output files and update RESUME POINT
