# Changelog

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
