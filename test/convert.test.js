import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  readZip, readZipDeep, writeZip, zipToVault, backupToBasesVault, backupToMarkdown,
} from "../dist/engine.js";

const E = new TextEncoder();
const D = new TextDecoder();

// Build a method-8 (deflate) zip by hand to exercise the inflateRawSync path that real Notion
// exports use. CRC is left 0 — readZip does not verify it.
function makeDeflateZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = E.encode(e.name);
    const comp = new Uint8Array(deflateRawSync(Buffer.from(e.data)));
    const lh = new Uint8Array(30 + nameB.length); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, 8, true);
    dv.setUint32(14, 0, true); dv.setUint32(18, comp.length, true); dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, nameB.length, true); lh.set(nameB, 30);
    parts.push(lh, comp);
    const ch = new Uint8Array(46 + nameB.length); const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(10, 8, true); cdv.setUint32(16, 0, true);
    cdv.setUint32(20, comp.length, true); cdv.setUint32(24, e.data.length, true);
    cdv.setUint16(28, nameB.length, true); cdv.setUint32(42, offset, true); ch.set(nameB, 46);
    central.push(ch);
    offset += lh.length + comp.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22); const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true); edv.setUint32(12, cdSize, true); edv.setUint32(16, offset, true);
  const total = offset + cdSize + 22, out = new Uint8Array(total); let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  for (const c of central) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}

test("writeZip → readZip round-trips stored entries byte-for-byte", async () => {
  const entries = [
    { name: "a.txt", data: E.encode("hello world") },
    { name: "dir/b.bin", data: new Uint8Array([0, 1, 2, 3, 250, 255]) },
  ];
  const back = await readZip(writeZip(entries).buffer);
  assert.equal(back.length, 2);
  assert.equal(D.decode(back.find((f) => f.name === "a.txt").data), "hello world");
  assert.deepEqual([...back.find((f) => f.name === "dir/b.bin").data], [0, 1, 2, 3, 250, 255]);
});

test("readZip inflates deflate (method 8) entries — the Notion-export path", async () => {
  const body = "# Title\n\n" + "lorem ipsum ".repeat(50);
  const z = makeDeflateZip([{ name: "note.md", data: E.encode(body) }]);
  const files = await readZip(z.buffer);
  assert.equal(files.length, 1);
  assert.equal(D.decode(files[0].data), body);
});

test("readZipDeep descends into Notion's nested/multi-part export zips", async () => {
  // Notion delivers an OUTER zip containing ExportBlock-…-Part-1.zip with the real Markdown inside.
  const inner = makeDeflateZip([{ name: "Roadmap abc.md", data: E.encode("# Roadmap\n\nhi") }]);
  const outer = makeDeflateZip([{ name: "ExportBlock-x-Part-1.zip", data: inner }]);
  const files = await readZipDeep(outer.buffer);
  assert.ok(files.some((f) => /Roadmap abc\.md$/.test(f.name)), "found the .md nested one level deep");
  // a normal (non-nested) export is unaffected
  const flat = await readZipDeep(makeDeflateZip([{ name: "note.md", data: E.encode("# Note") }]).buffer);
  assert.equal(flat.length, 1);
  assert.equal(D.decode(flat[0].data), "# Note");
});

test("zipToVault strips id-hashes, rewrites images, makes wikilinks", async () => {
  const hash = "0123456789abcdef0123456789abcdef";
  const md = `# My Page ${hash}\n\nSee [Other](Other%20Page%20${hash}.md) and an image:\n\n![pic](My%20Page/diagram.png)\n`;
  const files = await readZip(makeDeflateZip([
    { name: `My Page ${hash}.md`, data: E.encode(md) },
    { name: "My Page/diagram.png", data: new Uint8Array([137, 80, 78, 71]) },
  ]).buffer);
  const vault = zipToVault(files, { frontmatter: true, wikilinks: true });
  const page = vault.pages[0];
  assert.equal(page.name, "My Page.md", "title hash stripped from filename");
  assert.match(page.markdown, /title: "My Page"/, "frontmatter title set");
  assert.match(page.markdown, /\[\[Other\]\]/, "internal link → wikilink");
  assert.match(page.markdown, /!\[pic\]\(attachments\/diagram\.png\)/, "image rewritten to attachments/");
  assert.ok(vault.attachments.some((a) => a.name === "attachments/diagram.png"), "image is an attachment");
});

const BACKUP = {
  databases: [
    {
      title: "Tasks",
      dataSources: [{
        name: "Tasks",
        properties: { Name: { type: "title" }, Count: { type: "number" }, Done: { type: "checkbox" }, Project: { type: "relation" } },
        pages: [{
          id: "p1",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Alpha" }] },
            Count: { type: "number", number: 3 },
            Done: { type: "checkbox", checkbox: true },
            Project: { type: "relation", relation: [{ id: "p2" }] },
          },
          blocks: [],
        }],
      }],
    },
    {
      title: "Projects",
      dataSources: [{
        name: "Projects",
        properties: { Name: { type: "title" } },
        pages: [{ id: "p2", properties: { Name: { type: "title", title: [{ plain_text: "Website" }] } }, blocks: [] }],
      }],
    },
  ],
  files: {},
};

test("backupToBasesVault emits typed frontmatter, resolved relations, and a .base view", () => {
  const vault = backupToBasesVault(BACKUP, { wikilinks: true });
  const alpha = vault.pages.find((p) => p.name === "Tasks/Alpha.md");
  assert.ok(alpha, "row note written into the database folder");
  assert.match(alpha.markdown, /^Count: 3$/m, "number is an unquoted YAML scalar");
  assert.match(alpha.markdown, /^Done: true$/m, "checkbox is a real boolean");
  assert.match(alpha.markdown, /\[\[Website\]\]/, "relation resolved to a wikilink by title");

  const base = vault.pages.find((p) => p.name === "Tasks/Tasks.base");
  assert.ok(base, ".base file written for the database");
  assert.match(base.markdown, /type: table/, ".base declares a table view");
  assert.match(base.markdown, /file\.inFolder\("Tasks"\)/, ".base scopes to its folder");
  assert.match(base.markdown, /file\.ext == "md"/, ".base excludes itself — only .md note rows");
  assert.match(base.markdown, /displayName/, ".base preserves column display names");
});

test("backupToMarkdown merges a backup into one document", () => {
  const md = backupToMarkdown(BACKUP);
  assert.match(md, /# Notion export —/);
  assert.match(md, /Alpha/);
  assert.match(md, /Website/);
});
