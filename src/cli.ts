import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  readZipDeep, zipToVault, mergeZipMd,
  backupToBasesVault, backupToMarkdown, listDatabases,
} from "./engine";

const HELP = `notion-bases — Notion → Obsidian, databases and all. No API token.

Usage:
  npx notion-bases <export.zip | backup.json> [options]
  npx notion-bases --watch <file | folder> --out <vault> [options]
  npx notion-bases --list <backup.json>

Inputs (auto-detected):
  export.zip    A Notion "Markdown & CSV" export (Settings → Export). No token needed.
  backup.json   A Restora backup. The only input that yields real typed .base files.

Options:
  --out <dir>      Output folder (default: <input>-vault). With --md, an output file.
  --md             Plain merged Markdown instead of an Obsidian vault.
  --only "A,B"     Convert only these databases, by name (.json backups only).
  --list           List database names + row counts in a backup, then exit.
  --watch <path>   Re-convert whenever the file/folder changes (folder = newest .json/.zip).
  --interval <s>   Watch poll interval in seconds (default 10).
  -h, --help       Show this help.

Examples:
  npx notion-bases backup.json --out ./MyVault       # databases → real Obsidian Bases
  npx notion-bases backup.json --only "Tasks,Projects"
  npx notion-bases --list backup.json

Keep an Obsidian vault auto-updated from Notion (token-free, one-way, local):
  npx @restora/cli backup --to local --dir ~/notion-backups   # then: restora schedule --daily 09:00
  npx notion-bases --watch ~/notion-backups --out ~/ObsidianVault/Notion
`;

type Args = {
  _: string[]; out: string | null; md: boolean; help: boolean;
  watch: boolean; list: boolean; only: string[] | null; interval: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], out: null, md: false, help: false, watch: false, list: false, only: null, interval: 10 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--md") a.md = true;
    else if (x === "--out" || x === "-o") a.out = argv[++i];
    else if (x === "--watch") a.watch = true;
    else if (x === "--list") a.list = true;
    else if (x === "--only") a.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--interval") a.interval = Math.max(1, parseInt(argv[++i] || "10", 10) || 10);
    else if (x === "-h" || x === "--help") a.help = true;
    else a._.push(x);
  }
  return a;
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  process.exit(1);
}

function stem(input: string): string {
  return basename(input).replace(/\.(zip|json)$/i, "") || "notion";
}

function writeOne(outDir: string, name: string, content: string | Uint8Array) {
  const full = join(outDir, ...name.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  if (typeof content === "string") writeFileSync(full, content, "utf8");
  else writeFileSync(full, content);
}

function writeVault(outDir: string, vault: { pages: any[]; attachments: any[] }) {
  for (const p of vault.pages) writeOne(outDir, p.name, p.markdown);
  for (const a of vault.attachments || []) writeOne(outDir, a.name, a.data);
}

function loadBackup(raw: Buffer): any {
  let b: any;
  try { b = JSON.parse(raw.toString("utf8")); }
  catch {
    throw new Error('That file is neither a .zip nor valid JSON.\n' +
      '  Export from Notion as “Markdown & CSV” (a .zip), or pass a Restora backup .json.');
  }
  if (!b || !Array.isArray(b.databases)) {
    throw new Error('That .json doesn\'t look like a Restora backup (expected a top-level "databases" array).');
  }
  return b;
}

function onlySet(args: Args): Set<string> | null {
  return args.only && args.only.length ? new Set(args.only.map((s) => s.toLowerCase().trim())) : null;
}

// Convert one input file once. Returns { note, hint? }. Throws on failure (caller handles).
async function convertOnce(input: string, args: Args): Promise<{ note: string; hint?: string }> {
  const raw = readFileSync(input);
  const isZip = raw.length > 4 && raw[0] === 0x50 && raw[1] === 0x4b &&
    (raw[2] === 0x03 || raw[2] === 0x05 || raw[2] === 0x07);
  const only = onlySet(args);

  if (isZip) {
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const files = await readZipDeep(ab as ArrayBuffer);
    if (only) console.error("  Note: --only needs a .json backup; a .zip has no database structure — converting everything.");
    if (args.md) {
      const out = args.out || stem(input) + ".md";
      const res = mergeZipMd(files, { strip: true });
      writeFileSync(out, res.text, "utf8");
      return { note: `${res.mdCount} page(s) → ${out}` + (res.csvCount ? ` (${res.csvCount} CSV table(s) skipped)` : "") };
    }
    const out = args.out || stem(input) + "-vault";
    const vault = zipToVault(files, { frontmatter: true, wikilinks: true });
    writeVault(out, vault);
    return {
      note: `${vault.note.replace(/ — ready for Obsidian\.$/, "")} → ${out}/`,
      hint: "  Note: a Notion .zip doesn't carry database schema, so databases arrive as plain\n" +
        "  notes — not typed Obsidian Bases. Point this tool at a backup .json for real .base files.",
    };
  }

  const b = loadBackup(raw);
  if (only) {
    const dbs = listDatabases(b);
    const have = new Set(dbs.map((d: any) => String(d.name).toLowerCase().trim()));
    const missing = [...only].filter((n) => !have.has(n));
    if (missing.length) {
      const avail = dbs.map((d: any) => `"${d.name}"`).join(", ");
      throw new Error(`No database named ${missing.map((m) => `"${m}"`).join(", ")}.\n  Available: ${avail || "(none)"}`);
    }
  }
  if (args.md) {
    const out = args.out || stem(input) + ".md";
    writeFileSync(out, backupToMarkdown(b, { only }), "utf8");
    return { note: `Markdown → ${out}` };
  }
  const out = args.out || stem(input) + "-vault";
  const vault = backupToBasesVault(b, { wikilinks: true, only });
  writeVault(out, vault);
  return { note: `${vault.note} → ${out}/` };
}

function statOf(p: string) { try { return statSync(p); } catch { return null; } }

// Resolve the file to convert: the target if a file, else the newest .json/.zip in the folder.
function resolveTarget(target: string): { file: string; mtime: number; size: number } | null {
  const st = statOf(target);
  if (!st) return null;
  if (st.isDirectory()) {
    let best: { file: string; mtime: number; size: number } | null = null;
    for (const name of readdirSync(target)) {
      if (!/\.(json|zip)$/i.test(name)) continue;
      const full = join(target, name);
      const s = statOf(full);
      if (!s || !s.isFile()) continue;
      if (!best || s.mtimeMs > best.mtime) best = { file: full, mtime: s.mtimeMs, size: s.size };
    }
    return best;
  }
  return { file: target, mtime: st.mtimeMs, size: st.size };
}

function stamp(): string { return new Date().toTimeString().slice(0, 8); }

async function watchLoop(target: string, args: Args) {
  if (!args.out) args.out = args.md ? "notion.md" : "notion-vault";
  const isDir = !!statOf(target)?.isDirectory();
  console.log(`watching ${target}${isDir ? " (newest .json/.zip)" : ""} → ${args.out}`);
  console.log(`refresh every ${args.interval}s · Ctrl-C to stop\n`);

  let lastKey = "";
  const tick = async () => {
    const t = resolveTarget(target);
    if (!t) return;
    const key = t.file + ":" + t.mtime + ":" + t.size;
    if (key === lastKey) return;
    try {
      const r = await convertOnce(t.file, args);
      lastKey = key;
      console.log(`↻ ${stamp()}  ${basename(t.file)} → ${r.note}`);
    } catch (e: any) {
      console.error(`✗ ${stamp()}  ${(e?.message || "convert failed").split("\n")[0]} (will retry)`);
    }
  };
  await tick();
  setInterval(tick, args.interval * 1000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (args._.length === 0 && !args.watch)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  // --list: print database names + row counts, then exit.
  if (args.list) {
    const input = args._[0];
    if (!input) return fail("Usage: notion-bases --list <backup.json>");
    let raw: Buffer;
    try { raw = readFileSync(input); } catch { return fail(`Couldn't read "${input}".`); }
    let b: any;
    try { b = loadBackup(raw); } catch (e: any) { return fail(e.message); }
    const dbs = listDatabases(b);
    console.log(`${dbs.length} database(s) in ${basename(input)}:`);
    for (const d of dbs) console.log(`  ${d.name}  —  ${d.rows} row${d.rows === 1 ? "" : "s"}`);
    if (dbs.length) console.log(`\nConvert a subset:  notion-bases ${basename(input)} --only "${dbs.slice(0, 2).map((d: any) => d.name).join(",")}"`);
    return;
  }

  // --watch: poll the file/folder and re-convert on change.
  if (args.watch) {
    const target = args._[0];
    if (!target) return fail("Usage: notion-bases --watch <file | folder> --out <vault>");
    if (!statOf(target)) return fail(`Couldn't find "${target}".`);
    return watchLoop(target, args);
  }

  // Single run.
  const input = args._[0];
  if (!statOf(input)) return fail(`Couldn't read "${input}".`);
  let res;
  try { res = await convertOnce(input, args); }
  catch (e: any) { return fail(e?.message || "Couldn't convert that file."); }
  console.log("✓ " + res.note);
  if (res.hint) console.log(res.hint);
}

main().catch((err) => { console.error(err); process.exit(1); });
