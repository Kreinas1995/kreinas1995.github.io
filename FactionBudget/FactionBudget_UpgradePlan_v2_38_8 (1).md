# FactionBudget v2.38.8 → Future Upgrades Plan

**Source file:** `FactionBudgetv2_38_8.html`
**Resume:** Upload file + this plan, say "Resume upgrade plan from section X"

---

## Completed in v2.38.8
- B-1: Payment log redesigned — per-player collapsible cards showing Name, profile link, days remaining, Xanax total, $1M total, combined units, units to lifetime
- B-2: 🐛 Tester button on each player card — prompts to mark as tester. Stored in `hv_v1_testers`, shown in TESTERS section
- B-3: VIEW LOG button inside each player card expands raw event entries inline
- B-4: REFUND/RESTORE button per event entry — updates player unit count immediately via `_renderPaymentLogModal()`
- B-5: Modal sections: LIFETIME MEMBERS / TESTERS / ACTIVE / EXPIRED — each collapsible `<details>`
- B-6: Tester list persisted in `hv_v1_testers`. EXPORT button downloads JSON via `exportPaymentData()`
- B-7: GRANT TESTER button + player-name input — adds to tester list at runtime
- B-8: Faction whitelist — ADD FACTION with ID + label + notes. Stored in `hv_v1_faction_whitelist`. REMOVE per entry
- `adminClearAll` wipes `hv_v1_testers` + `hv_v1_faction_whitelist`. Storage inspector includes both. Full backup export includes both arrays

## Completed in v2.38.7
- UPGRADE-1: `hv_v1_ptprice` + `hv_v1_ptphist` added to adminClearAll wipe, storage inspector, in-memory reset
- UPGRADE-8: OC form double-click prevention (`window._ocSubmitting` 2s flag)
- PARTIAL-4: `detectCat()` non-Xanax drugs now return `'Drug'` category; Drug rate input + Drug:98 default added
- UPGRADE-6: Expired access gate shows personalised lapsed message with renewal instructions
- PARTIAL-6: Expiry warning banner when <24h remains (dismissible, skips lifetime/faction)
- BUG: Member card body now shows unpaid items only (was lifetime totals)
- BUG: $ stats button now on paid/grayed cards too
- BUG: Faction Income card includes war income in all render paths
- BUG: Outgoing display-time name resolution handles bare numeric IDs
- NOTE: OC tab shows clarifying label that its period is controlled by Faction Income card pill
- F-5: `toMemberId` stored on log-sourced outgoing entries; name resolution priority faction > prices > #ID
- F-6: Supply cost / P&L outgoing filter restricted to confirmed faction members only

## Completed in v2.38.6
- A-1: $ button on owed cards reveals lifetime stats panel
- A-2: New items (since last MARK PAID) highlighted yellow in stats panel + dot on card subtitle
- F-5: Outgoing receiver name resolution improved
- F-6: Non-faction sends excluded from supply cost

## Completed in v2.38.5
- BUG-A: Supply cost card + P&L include personal outgoing sends when tracking enabled
- OC: Manual entry form collapsed by default
- OC: Inline reward + respect editing on manual log entries
- OC: Member checkboxes replaced with searchable auto-fill grid

---

## SECTION A — Member Owed Card Redesign

**Status:** ✅ A-1 and A-2 complete.

---

## SECTION B — Access Payment Log Redesign

**Status:** ✅ ALL COMPLETE (B-1 through B-8)

---

## SECTION C — Separate Access Payment File (Security)

- [ ] **C-1:** Create `FactionBudget/current/access.js` on GitHub.
- [ ] **C-2:** After API key verify, if `player_id === OWNER_ID`, dynamically inject `<script src="...access.js">`.
- [ ] **C-3:** `access.js` contains tester list, faction whitelist logic, full payment log renderer.
- [ ] **C-4:** Non-owners never load `access.js`.
- [ ] **C-5:** Update `STRUCTURE.md`.

---

## SECTION D — Admin Panel Reorganization

- [ ] **D-1:** Move console log (cLines) from main dashboard header into Admin panel only.
- [ ] **D-2:** Admin panel entry shows confirmation popup.
- [ ] **D-3:** Admin panel main menu: Data Management / Debug Tools / Access Payments / Storage Inspector / Audit Log.
- [ ] **D-4:** Error log always pinned at bottom of Admin panel.
- [ ] **D-5:** Debug panel only accessible from Admin → Debug Tools (not standalone tab).

---

## SECTION E — Supply Tab Overhaul

- [ ] **E-1:** Supply tab works like Inventory — manually set base quantities, auto-updated from armory log.
- [ ] **E-2:** Complete item lists per category from S.prices (medical, booster, drug, alcohol, candy, explosive).
- [ ] **E-3:** Visibility menu: Show All / Show Owned toggle per category.
- [ ] **E-4:** Settings per item: Overstocked / Normal / Low / Critical thresholds + Essential tickbox.
- [ ] **E-5:** Colors affect qty text only (Essential = full row red at 0).
- [ ] **E-6:** Cache in `hv_v1_supply_inventory`.
- [ ] **E-7:** Debug button: "Test faction items API fetch".

---

## SECTION F — Personal Supply Reimbursement

- [ ] **F-1:** Personal supply sends create self-reimbursement card in Owed overview (separate section).
- [ ] **F-2:** "Reimburse Me" card shows items sent by type/qty/MV/total.
- [ ] **F-3:** MARK PAID / PAY flow for self-reimbursement.
- [ ] **F-4:** Audit log entries in own category "SELF — Supply Reimbursement".
- [x] **F-5:** Xanax sender name resolution fixed.
- [x] **F-6:** Non-faction sends filtered from supply cost.

---

## SECTION G — Remaining Partials

- [ ] **PARTIAL-1:** `attributeOCPayouts()` field names — run `ocRawDiag()` on live key, report `depositFunds` field names.
- [ ] **PARTIAL-2:** `fetchInvPurchases()` auto-call in `fetchAll()` and `runInitialize()` when `S.invDeltaTs > 0`.
- [x] **PARTIAL-4:** `detectCat()` non-Xanax drug labeling fixed.
- [ ] **PARTIAL-5:** `syncEvents()` pagination — use paginatedFetch up to 3 pages since `lastKnownEventTs`.
- [x] **PARTIAL-6:** Expiry warning banner (<24h) added.

---

## SECTION H — Remaining Upgrades

- [x] UPGRADE-1: `hv_v1_ptprice` + `hv_v1_ptphist` to `adminClearAll` wipe ✅
- [ ] UPGRADE-2: Display refresh / bg fetch coordination
- [ ] UPGRADE-3: Event log 2000-entry cap warning
- [ ] UPGRADE-4: Receipt dedup ID simplified
- [ ] UPGRADE-5: `scheduleBgFetch` timer leak fix
- [x] UPGRADE-6: Access gate lapsed membership message ✅
- [ ] UPGRADE-7: P&L supply cost subtract returns
- [x] UPGRADE-8: OC form double-click prevention ✅
- [ ] UPGRADE-9: `fetchOutgoingLog()` pagination
- [ ] UPGRADE-10: Armory log load-more

---

## Known Active Bugs (as of v2.38.8)

| ID | Description | Notes |
|----|-------------|-------|
| BUG-SUPPLY-DISPLAY | Supply tab shows `$0` total line | Armory disbursements need faction/armory key permission (Error 16). Not a code bug — needs key with correct checkboxes ticked. |
| PARTIAL-1 | OC v2 field names unknown | Need live key with faction/crimes access to run `ocRawDiag()` and get field names |
| B-PROFILE-LINK | Player profile links in payment cards use placeholder XID=0 | Player ID not stored in event text — would need to cross-reference S.faction.members by name at render time |

---

## SESSION BOOTSTRAP (Read First — Every Session)

### Sacred Constants — NEVER change without explicit instruction
```
FACTION_ID     = 50825
OWNER_ID       = '2348580'    // Sypharius — used for owner-only feature gating
OWNER_NAME     = 'Sypharius'  // Display only
ACCESS_KEY     = 'hv_access'
XANAX_ITEM_ID  = 206
```

### File Rules
- **Never rename the HTML file** — `manifest.json` and `config.json` reference it by exact name
- **`APP_VERSION` inside must match the filename version number**
  - e.g. file = `FactionBudgetv2_38_8.html` → `const APP_VERSION = '2.38.8'`
- **Never touch** `manifest.json`, `config.json`, or anything in `Old/` folders
- **Deploy path:** `FactionBudget/current/FactionBudgetv2_XX_XX.html`

### Patch Workflow (Every Session)
1. Copy source HTML to working file with new version number
2. Write ops plan MD before touching any code
3. Make changes using Python file I/O (not sed/str_replace — file has Unicode chars that break those tools)
4. Bump `APP_VERSION`, `<title>`, version badge div
5. Add changelog entry at top of `CHANGELOG` array
6. Verify with `grep` / Python checks after each change
7. Copy to `/mnt/user-data/outputs/`
8. Output both the HTML and updated plan MD

### Unicode Warning
The file contains non-ASCII characters (em dashes, arrows, etc.). Always use:
```python
with open(file, 'rb') as f:
    c = f.read().decode('utf-8')
# ... make changes ...
with open(file, 'wb') as f:
    f.write(c.encode('utf-8'))
```
**Never use `sed` with Unicode content — it corrupts the file.**

### Const Block Location
All top-level `const` declarations live at lines ~5–67, before `CHANGELOG` and before the IIFE. Add new top-level consts here only.

### localStorage Key Prefix
All keys use `hv_v1_` prefix. When adding new persisted state, add the key to:
1. `adminClearAll()` wipe array
2. Storage inspector keys array
3. In-memory reset in `adminClearAll()`
4. `S` state object initial declaration
5. IIFE restore block

### Session Resume Priority Order
1. **Section C** (access.js split) — architectural security improvement
2. **Section D** (admin panel reorganization) — medium UX
3. **Sections E, F-1 to F-4** (supply overhaul + reimbursement) — large, own session
4. **Sections G, H** remaining partials/upgrades — fill-in as capacity allows

**Notes from partial run**
Let me read the plan and orient before touching anything.Priority order is C → D → E/F → G/H. Section C requires deploying a separate file to GitHub which can't happen here — so I'll skip to **Section D** (Admin Panel Reorganization) as the top actionable item. Let me read the source file state first.Good. Now I have a clear picture of the full structure. Let me plan Section D carefully before writing any code:

**D-1:** Move `cLines` / `cLinesPost` / `postConsole` / CONSOLE button out of the key bar — console only lives inside Admin panel
**D-2:** Admin tab click shows a confirmation popup before revealing the panel
**D-3:** Admin panel gets a top-level menu: Data Management / Debug Tools / Access Payments / Storage Inspector / Audit Log — each as a clickable section that expands the relevant content
**D-4:** Error log always pinned at bottom of Admin panel (already there, just ensure always visible)
**D-5:** Debug tab removed from tabs bar; accessible only via Admin → Debug Tools

Let me look at more structure before writing:Now I have full orientation. Let me write the complete Section D implementation script:The replace deleted too much — the old debug panel string wasn't matching exactly. The file shrunk catastrophically. Let me restore from the output and use a different approach:Good. The issue was that I tried to replace the old debug panel + admin as one string — the exact whitespace didn't match. I need to make two separate targeted replacements. Let me approach this more carefully — operate on each piece independently:Now I have clean boundaries. Let me do this correctly with a single Python script that operates on precise character positions:All checks passed. Now add the new JS functions and fix `switchTab` to not reference `debug`:`clog` still writes to `cLinesPost` — it's fine, that ID still exists inside the admin console section. The check was looking at the wrong slice. Let me verify integrity and output:
