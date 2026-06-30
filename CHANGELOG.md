# Changelog

## 0.2.0

- **`--watch <file | folder>`** — keep an Obsidian vault auto-updated, locally and token-free. Polls the
  file (or the newest `.json`/`.zip` in a folder) and re-converts whenever it changes. Pairs with a
  scheduled local Restora backup for a one-way Notion → Obsidian refresh, no server, store-nothing.
  `--interval <seconds>` sets the poll rate (default 10). Uses Node built-ins only — still zero deps.
- **`--only "A,B"`** — convert only the named databases (`.json` backups). Matched by name,
  case-insensitive; an unknown name lists the available ones.
- **`--list <backup.json>`** — print the database names + row counts in a backup, so you know what to
  pass to `--only`.

## 0.1.2

- Fix: handle Notion's nested / multi-part export zips. Notion often delivers an export as an outer
  `.zip` that contains `ExportBlock-…-Part-1.zip` (and `Part-2.zip`, … for large workspaces); the
  converter now descends into inner zips automatically instead of reporting "No Markdown files found".

## 0.1.1

- Fix: a database's `.base` view no longer lists its own `.base` file as an empty row. The view now
  filters to Markdown notes (`file.ext == "md"`) in addition to the folder, so the result count and
  rows reflect only the database's pages.

## 0.1.0

Initial release.

- Convert a Notion **Markdown & CSV export (.zip)** into an Obsidian vault — no API token: clean
  Markdown, id-hashes stripped, images moved into `attachments/`, internal links → `[[wikilinks]]`,
  YAML frontmatter.
- Convert a **Restora backup (.json)** into a vault where each database becomes a folder of one
  note-per-row with **typed** frontmatter (numbers, booleans, dates), relations resolved to
  `[[wikilinks]]`, and a real **`.base`** table view.
- Auto-detects the input type. `--md` emits plain merged Markdown; `--out` sets the destination.
- Runs fully locally. Zero runtime dependencies.
