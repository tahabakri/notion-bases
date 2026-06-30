# notion-bases

**Notion → Obsidian, databases and all. No API token.**

[![npm](https://img.shields.io/npm/v/notion-bases)](https://www.npmjs.com/package/notion-bases)
[![downloads](https://img.shields.io/npm/dm/notion-bases)](https://www.npmjs.com/package/notion-bases)
[![license](https://img.shields.io/npm/l/notion-bases)](./LICENSE)
![no token required](https://img.shields.io/badge/notion%20token-not%20required-brightgreen)

Point it at a Notion export and get a clean Obsidian vault — `[[wikilinks]]`, YAML frontmatter,
attachments in a folder, and, from a backup, real **[Obsidian Bases](https://help.obsidian.md/bases)**
for your databases. It runs entirely on your machine. No account, no upload, no integration token.

```bash
npx notion-bases Export.zip
```

That's it. A folder called `Export-vault/` appears next to your file. Open it in Obsidian.

---

## Why

Notion's own "Markdown & CSV" export is a zip of `.md` files plus a `.csv` for every database, all in
folders with a 32-character hash glued onto every name. Dropped into Obsidian, links are broken, the
databases are just dead CSVs, and every note is titled `My Page 8f3c…`.

`notion-bases` turns that into a vault that actually works:

- **Clean names** — the id-hashes are stripped from files and links.
- **Real links** — internal page links become `[[wikilinks]]`.
- **Attachments** — images and files move into `attachments/` and links are rewritten.
- **Frontmatter** — page properties become YAML you can query.
- **Databases → Bases** — from a backup, each database becomes a folder of typed notes plus a real
  `.base` table view (numbers stay numbers, checkboxes stay booleans, relations become `[[wikilinks]]`).

## What it does *not* do

It gets your data **out** of Notion. It does not write back **into** Notion, and it is not a sync tool.
One direction, on purpose.

## Two inputs

| Input | How you get it | What you get |
|---|---|---|
| **`Export.zip`** | Notion → *Settings → Export* → **Markdown & CSV** | A full vault. **No token needed.** Databases come in as plain notes — a `.zip` doesn't carry their schema, so they can't become typed Bases. |
| **`backup.json`** | A [Restora](https://restora.cc) backup | The same vault **plus real `.base` files** — typed properties, relations resolved to titles, one folder per database. |

Why the split? Notion's `.zip` export simply does not include database schema (property types,
relations, views) — it flattens everything to CSV. No file-based tool can rebuild typed Bases from it.
The schema only survives in a structured backup, which is the one input that produces true `.base`
files.

## Usage

```bash
npx notion-bases <export.zip | backup.json> [options]

Options:
  --out <dir>      Output folder (default: <input>-vault). With --md, an output file.
  --md             Plain merged Markdown instead of a vault.
  --only "A,B"     Convert only these databases, by name (.json backups only).
  --list           List database names + row counts in a backup, then exit.
  --watch <path>   Re-convert whenever the file/folder changes (folder = newest .json/.zip).
  --interval <s>   Watch poll interval in seconds (default 10).
  -h, --help       Show help.
```

```bash
npx notion-bases Export.zip                       # → Export-vault/
npx notion-bases backup.json                      # databases become real Obsidian Bases
npx notion-bases backup.json --only "Tasks,Docs"  # just those databases
npx notion-bases --list backup.json               # see the database names
npx notion-bases Export.zip --md                  # one clean Markdown file
```

Install it globally if you prefer: `npm i -g notion-bases`, then `notion-bases Export.zip`.

## Keep an Obsidian vault auto-updated from Notion

`--watch` re-converts whenever its input changes — point it at a single file you re-export, or at a
**folder** and it always converts the newest `.json`/`.zip` in it. Combined with a scheduled local
[Restora](https://restora.cc) backup, that's a hands-off, **one-way, local** Notion → Obsidian refresh.
No server, no stored token in notion-bases — it only ever reads files.

```bash
# one-time: connect Restora, then schedule daily LOCAL backups to a folder
npx @restora/cli backup --to local --dir ~/notion-backups   # optionally: --databases id,id
npx @restora/cli schedule --daily 09:00

# keep the vault mirrored from those backups (token-free):
npx notion-bases --watch ~/notion-backups --out ~/ObsidianVault/Notion
```

It's a **refresh, not sync** — Notion stays the source of truth; a refresh overwrites the mirrored
notes (edit *new* notes elsewhere in your vault). Cross-device is free: your vault already lives in
iCloud/Dropbox/Obsidian Sync.

## How it works

Everything runs locally in Node — your notes never leave your machine, and nothing talks to Notion's
API. The `.zip` reader and converter are plain, dependency-free code (see [`src/`](./src)); the only
thing it touches is your input file.

## Requirements

- Node.js 20 or newer.

## License

MIT — see [LICENSE](./LICENSE).

---

### Need to restore a Notion workspace?

If you're looking to recover deleted databases, relations, rollups, or rebuild a workspace after
accidental changes, check out [Restora](https://restora.cc).
