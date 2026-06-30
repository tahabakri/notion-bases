import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  readZipDeep, zipToVault, mergeZipMd,
  backupToBasesVault, backupToMarkdown,
} from "./engine";

const HELP = `notion-bases — Notion → Obsidian, databases and all. No API token.

Usage:
  npx notion-bases <export.zip | backup.json> [options]

Inputs (auto-detected):
  export.zip    A Notion "Markdown & CSV" export (Settings → Export). No token needed.
  backup.json   A Restora backup. The only input that yields real typed .base files.

Options:
  --out <dir>   Output folder (default: <input>-vault). With --md, an output file.
  --md          Plain merged Markdown instead of an Obsidian vault.
  -h, --help    Show this help.

Examples:
  npx notion-bases Export.zip
  npx notion-bases Export.zip --out ./MyVault
  npx notion-bases backup.json          # databases become real Obsidian Bases
  npx notion-bases Export.zip --md      # one clean Markdown file
`;

function parseArgs(argv: string[]) {
  const args: { _: string[]; out: string | null; md: boolean; help: boolean } =
    { _: [], out: null, md: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--md") args.md = true;
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const input = args._[0];
  let raw: Buffer;
  try { raw = readFileSync(input); }
  catch { return fail(`Couldn't read "${input}".`); }

  // Auto-detect: PK magic bytes → zip; otherwise try JSON (a Restora backup).
  const isZip = raw.length > 4 && raw[0] === 0x50 && raw[1] === 0x4b &&
    (raw[2] === 0x03 || raw[2] === 0x05 || raw[2] === 0x07);

  if (isZip) {
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    let files;
    try { files = await readZipDeep(ab as ArrayBuffer); }
    catch (e: any) { return fail(e?.message || "Couldn't read that .zip."); }

    if (args.md) {
      const out = args.out || stem(input) + ".md";
      let res;
      try { res = mergeZipMd(files, { strip: true }); }
      catch (e: any) { return fail(e?.message || "Couldn't convert that export."); }
      writeFileSync(out, res.text, "utf8");
      console.log(`✓ ${res.mdCount} page(s) → ${out}` +
        (res.csvCount ? `  (${res.csvCount} CSV table(s) not included — see below)` : ""));
    } else {
      const out = args.out || stem(input) + "-vault";
      let vault;
      try { vault = zipToVault(files, { frontmatter: true, wikilinks: true }); }
      catch (e: any) { return fail(e?.message || "Couldn't convert that export."); }
      writeVault(out, vault);
      console.log(`✓ ${vault.note.replace(/ — ready for Obsidian\.$/, "")} → ${out}/`);
    }
    // One quiet, factual note — not a pitch. A .zip has no schema, so databases can't become Bases.
    console.log("  Note: a Notion .zip doesn't carry database schema, so databases arrive as plain");
    console.log("  notes — not typed Obsidian Bases. Point this tool at a backup .json for real .base files.");
    return;
  }

  // JSON path (a Restora backup).
  let b: any;
  try { b = JSON.parse(raw.toString("utf8")); }
  catch {
    return fail('That file is neither a .zip nor valid JSON.\n' +
      '  Export from Notion as “Markdown & CSV” (a .zip), or pass a Restora backup .json.');
  }
  if (!b || !Array.isArray(b.databases)) {
    return fail('That .json doesn\'t look like a Restora backup (expected a top-level "databases" array).');
  }

  if (args.md) {
    const out = args.out || stem(input) + ".md";
    writeFileSync(out, backupToMarkdown(b), "utf8");
    console.log(`✓ Markdown → ${out}`);
    return;
  }

  const out = args.out || stem(input) + "-vault";
  let vault;
  try { vault = backupToBasesVault(b, { wikilinks: true }); }
  catch (e: any) { return fail(e?.message || "Couldn't convert that backup."); }
  writeVault(out, vault);
  console.log(`✓ ${vault.note}`);
  console.log(`  → ${out}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
