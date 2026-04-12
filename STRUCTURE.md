# Repository Structure — kreinas1995.github.io

> Reference file for Claude. Describes the layout, conventions, and how the site works so changes are made correctly.

---

## Overview

Static GitHub Pages site for **Syph's Tools** — a collection of Torn City web utilities. No build step, no framework. Everything is plain HTML/CSS/JS served directly from the repo root.

Live URL: `https://kreinas1995.github.io`

---

## Top-Level Files

| File | Purpose |
|---|---|
| `index.html` | Landing page. Dynamically renders tool cards by reading `config.json`. |
| `config.json` | Single source of truth for all tools listed on the homepage. |
| `README.md` | Minimal placeholder (currently just says "text"). |
| `STRUCTURE.md` | This file. |

---

## Directory Structure

```
kreinas1995.github.io/
├── index.html                  ← Homepage (reads config.json)
├── config.json                 ← Tool registry
├── README.md
├── STRUCTURE.md
│
├── FactionBudget/
│   ├── current/
│   │   └── FactionBudgetv2_37_1.html   ← Latest active version
│   └── Old/
│       └── FactionBudgetv2_*.html      ← Archived older versions
│
├── Training/
│   ├── current/
│   │   └── Trainingv1_0_0.html         ← WIP tool (latest version)
│   └── Old/                            ← Archived older versions
│
├── War/
│   ├── current/
│   │   └── Warv1_0_0.html              ← WIP tool (latest version)
│   └── Old/                            ← Archived older versions
│
└── legacy/
    └── *.md                            ← Old planning/resume docs (not served)
```

---

## Tool Folder Convention

Each tool lives in its own top-level folder and follows this pattern:

```
<ToolName>/
├── current/          ← Always contains the single latest version being linked to
│   └── <ToolName>v<major>_<minor>_<patch>.html
└── Old/              ← Previous versions kept for reference (optional)
    └── <ToolName>v*.html
```

- **`current/`** — only one HTML file lives here at a time (the active version).
- **`Old/`** — older versioned files are moved here when a new version is released.
- Version format in filenames: `v<major>_<minor>_<patch>` (e.g. `v2_37_1`).

---

## How `index.html` Works

The homepage has **no static HTML for tools** — it is all generated at runtime from `config.json`:

1. Fetches `config.json` on page load.
2. For each tool, fetches the `currentFolder` directory listing and finds the newest versioned `.html` file by parsing the `v<major>_<minor>_<patch>` version in filenames.
3. Renders a **hero card** (`heroStyle: true`) or a **WIP card** (`heroStyle: false`) based on the config.

---

## `config.json` Schema

```jsonc
{
  "tools": [
    {
      "id": "factionBudget",          // Used as HTML element id suffix
      "name": "Faction Budget Dashboard",
      "shortName": "Faction Budget",
      "description": "...",
      "status": "ACTIVE",             // Display string only
      "badge": "Live",                // Text shown in badge chip
      "badgeStyle": "accent",         // CSS var suffix: "accent" | "wip"
      "currentFolder": "FactionBudget/current/",  // Path to current/ dir
      "features": ["Vault & P&L", "..."],  // Feature tag pills (hero card only)
      "stats": [                      // Stat row at bottom of hero card
        { "label": "Tools", "value": "11" },
        { "label": "Status", "value": "ACTIVE", "color": "accent" }
      ],
      "heroStyle": true,              // true = large hero card; false = WIP grid card
      "progress": null                // null for active tools; { pct: 35, label: "35% — ..." } for WIP
    }
  ]
}
```

**Rules:**
- Exactly **one** tool should have `"heroStyle": true` (the featured/active one). It renders above the WIP grid.
- WIP tools (`heroStyle: false`) appear in a 2-column grid below the hero card.
- `currentFolder` must end with a trailing slash.
- `features` and `stats` are ignored for WIP cards.

---

## Adding a New Tool

1. Create `<ToolName>/current/<ToolName>v<x>_<y>_<z>.html`.
2. Add an entry to `config.json` following the schema above.
3. That's it — `index.html` will auto-detect and link to the file.

## Releasing a New Version of an Existing Tool

1. Move the old file from `<ToolName>/current/` to `<ToolName>/Old/`.
2. Place the new file in `<ToolName>/current/` with the updated version number in its filename.
3. No changes to `config.json` or `index.html` needed — version detection is automatic.

---

## Styling Notes (index.html)

- Fonts: **Syne** (headings) and **Space Mono** (body/monospace) from Google Fonts.
- Color palette lives in `:root` CSS variables:
  - `--accent` `#3dd68c` — primary green
  - `--accent3` `#f0c040` — yellow used for WIP chips
  - `--bg` `#0a0e14`, `--surface` `#111720`, `--text` `#e8edf5`
- Each tool HTML file is self-contained (its own styles, scripts, and API logic inline).

---

## Legacy Folder

`legacy/` contains old planning markdown files (`DashboardTODOv2_30_3.md`, `HV_RESUME_*.md`). These are **not linked from the site** and are kept for historical reference only. Do not add new files here.
