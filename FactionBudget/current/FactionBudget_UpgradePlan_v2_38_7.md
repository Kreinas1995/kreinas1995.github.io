# FactionBudget v2.38.7 → Future Upgrades Plan

**Source file:** `FactionBudgetv2_38_7.html`
**Resume:** Upload file + this plan, say "Resume upgrade plan from section X"

---

## Completed in v2.38.7
- UPGRADE-1: `hv_v1_ptprice` + `hv_v1_ptphist` added to adminClearAll wipe, storage inspector, in-memory reset
- UPGRADE-8: OC form double-click prevention (`window._ocSubmitting` 2s flag)
- PARTIAL-4: `detectCat()` non-Xanax drugs now return `'Drug'` category; Drug rate input + Drug:98 default added
- UPGRADE-6: Expired access gate shows personalised lapsed message with renewal instructions
- PARTIAL-6: Expiry warning banner when <24h remains (dismissible, skips lifetime/faction)
- BUG: Member card body now shows unpaid items only (was lifetime totals)
- BUG: $ stats button now on paid/grayed cards too
- BUG: Faction Income card includes war income in all render paths (renderOC was overwriting cOC without war)
- BUG: Outgoing display-time name resolution handles bare numeric IDs (e.g. `2622687`) not just `#`-prefixed
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

**Current behavior:** Modal shows flat table of all payment events.

**Requested changes:**
- [ ] **B-1:** Collapse per-player — one compact button per unique player. Tap to expand stats card: Name, ID, Torn profile link, Days Remaining, Total Xanax sent, Total $1M sent, Total combined units, Units remaining to lifetime.
- [ ] **B-2:** `🐛` bug icon button on each stats card → "Mark {name} as Tester?" prompt.
- [ ] **B-3:** Keep existing event log view via "View Event Log" button inside modal.
- [ ] **B-4:** Refund button per event in event log — marks refunded, updates player unit count.
- [ ] **B-5:** Sections: LIFETIME MEMBERS / TESTERS / WHITELISTED FACTIONS / all other active users.
- [ ] **B-6:** Tester list — base64 obfuscated constant in JS, decoded at runtime. Export button.
- [ ] **B-7:** "Grant Tester Access" button — input player ID, adds to obfuscated tester list (requires redeploy).
- [ ] **B-8:** Faction whitelist — "Add Faction" button (ID, Amount Paid, Notes). Stored in `hv_v1_faction_whitelist`.

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
- [x] **F-5:** Xanax sender name resolution fixed (faction.members > prices > #ID, bare numeric IDs handled).
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

## Known Active Bugs (as of v2.38.7)

| ID | Description | Notes |
|----|-------------|-------|
| BUG-SUPPLY-DISPLAY | Supply tab shows `$0` total line | Armory disbursements need faction/armory key permission (Error 16). Not a code bug — needs key with correct checkboxes ticked. |
| PARTIAL-1 | OC v2 field names unknown | Need live key with faction/crimes access to run `ocRawDiag()` and get field names |

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
  - e.g. file = `FactionBudgetv2_38_7.html` → `const APP_VERSION = '2.38.7'`
- **Never touch** `manifest.json`, `config.json`, or anything in `Old/` folders
- **Deploy path:** `FactionBudget/current/FactionBudgetv2_XX_XX.html`

### Patch Workflow (Every Session)
1. Copy source HTML to working file with new version number
2. Write ops plan MD before touching any code
3. Make changes
4. Bump `APP_VERSION`, `<title>`, version badge div
5. Add changelog entry at top of `CHANGELOG` array
6. Syntax check: extract `<script>` block, run `node --check`
7. Verify no duplicate top-level `const` declarations (`grep -o '^const ...' | sort | uniq -d`)
8. Copy to `/mnt/user-data/outputs/`
9. Output both the HTML and updated plan MD

### Const Block Location
All top-level `const` declarations live at lines ~5–67, before `CHANGELOG` and before the IIFE. Add new top-level consts here only.

### localStorage Key Prefix
All keys use `hv_v1_` prefix. When adding new persisted state, add the key to `adminClearAll()` wipe array AND the storage inspector keys array.

### Session Resume Priority Order
1. **Section B** (access payment log redesign) — medium, owner-facing
2. **Section D** (admin panel reorganization) — medium UX
3. **Section C** (access.js split) — architectural, do last
4. **Sections E, F-1 to F-4** (supply overhaul + reimbursement) — large, own session
5. **Sections G, H** remaining partials/upgrades — fill-in as capacity allows
