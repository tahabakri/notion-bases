/*
 * notion-bases engine — dependency-free converters from a Notion export to an Obsidian vault.
 *
 * Ported 1:1 from Restora's in-browser converter (notion-convert.js). The ONLY changes from the
 * browser original are the three host couplings:
 *   - DecompressionStream('deflate-raw')  ->  zlib.inflateRawSync   (readZip)
 *   - atob(...)                           ->  Buffer.from(b64,'base64')  (b64ToBytes)
 *   - window.RestoraConvert = {...}       ->  ESM exports
 * TextEncoder / TextDecoder are global in Node 20+. Everything else is byte-identical.
 *
 * Inputs it understands:
 *   - a Notion native export .zip (Markdown & CSV) — zero-config, no token
 *   - a Restora backup .json (BackupFile: databases -> dataSources -> pages -> blocks)
 *
 * Public API:
 *   readZip(arrayBuffer) -> Promise<[{name, data:Uint8Array}]>
 *   writeZip([{name, data:Uint8Array}]) -> Uint8Array          // method-0 stored + CRC32 (valid zip)
 *   backupToMarkdown(backup) -> string                          // merged .md (json)
 *   mergeZipMd(files, {strip}) -> {text, mdCount, csvCount}     // merged .md (zip)
 *   zipToVault(files, {frontmatter, wikilinks}) -> {pages, attachments, note}        // obsidian, zip
 *   backupToVault(backup, {frontmatter, wikilinks}) -> {pages, attachments, note}    // obsidian flat, json
 *   backupToBasesVault(backup, {wikilinks}) -> {pages, attachments, note}            // obsidian Bases, json
 */
import { inflateRawSync } from "node:zlib";

var enc = new TextEncoder();
var dec = new TextDecoder();

// ---------- rich text + blocks → markdown ----------
function plain(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map(function (r) { return (r && r.plain_text) || ""; }).join("");
}
function richToMd(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map(function (s) {
    var t = (s && s.plain_text) || ""; if (!t) return "";
    var a = (s && s.annotations) || {};
    if (a.code) t = "`" + t + "`";
    if (a.bold) t = "**" + t + "**";
    if (a.italic) t = "_" + t + "_";
    if (a.strikethrough) t = "~~" + t + "~~";
    if (s.href) t = "[" + t + "](" + s.href + ")";
    return t;
  }).join("");
}
var LIST = { bulleted_list_item: 1, numbered_list_item: 1, to_do: 1, toggle: 1 };
function fileUrl(d) { return (d && d.external && d.external.url) || (d && d.file && d.file.url) || ""; }

// opts: { wikilinks:bool, resolveImage:fn(d)->url }
function blockToMd(b, indent, out, opts) {
  opts = opts || {};
  var pad = new Array(indent + 1).join("  "); var type = (b && b.type) || ""; var d = (b && b[type]) || {};
  var txt = function () { return richToMd(d.rich_text); };
  if (type === "heading_1") out.push("# " + txt());
  else if (type === "heading_2") out.push("## " + txt());
  else if (type === "heading_3") out.push("### " + txt());
  else if (type === "paragraph") out.push(txt());
  else if (type === "bulleted_list_item") out.push(pad + "- " + txt());
  else if (type === "numbered_list_item") out.push(pad + "1. " + txt());
  else if (type === "to_do") out.push(pad + "- [" + (d.checked ? "x" : " ") + "] " + txt());
  else if (type === "toggle") out.push(pad + "- " + txt());
  else if (type === "quote") out.push("> " + txt());
  else if (type === "callout") out.push("> " + (d.icon && d.icon.emoji ? d.icon.emoji + " " : "") + txt());
  else if (type === "code") { out.push("```" + (d.language && d.language !== "plain text" ? d.language : "")); out.push(plain(d.rich_text)); out.push("```"); }
  else if (type === "divider") out.push("---");
  else if (type === "equation") out.push("$$" + (d.expression || "") + "$$");
  else if (type === "bookmark" || type === "embed" || type === "link_preview") { if (d.url) out.push(d.url); }
  else if (type === "image" || type === "file" || type === "pdf" || type === "video" || type === "audio") {
    var url = opts.resolveImage ? opts.resolveImage(d) : (fileUrl(d) || (d.restora_key ? "(file: " + d.restora_key + ")" : ""));
    out.push("![" + (plain(d.caption) || type) + "](" + url + ")");
  }
  else if (type === "child_page") out.push(opts.wikilinks ? "[[" + (d.title || "Untitled page") + "]]" : "**" + (d.title || "Untitled page") + "** _(sub-page)_");
  else if (type === "child_database") out.push("**" + (d.title || "Untitled database") + "** _(database)_");
  else if (type === "table") {
    var rows = (b.children || []).filter(function (c) { return c.type === "table_row"; });
    rows.forEach(function (r, i) {
      var cells = ((r.table_row && r.table_row.cells) || []).map(function (c) { return richToMd(c).replace(/\|/g, "\\|"); });
      out.push("| " + cells.join(" | ") + " |");
      if (i === 0) out.push("| " + cells.map(function () { return "---"; }).join(" | ") + " |");
    });
    return;
  }
  if (Array.isArray(b.children) && type !== "table") {
    var ci = LIST[type] ? indent + 1 : indent;
    for (var k = 0; k < b.children.length; k++) blockToMd(b.children[k], ci, out, opts);
  }
}

function pageTitle(props) {
  for (var key in props) { var v = props[key]; if (v && v.type === "title") return plain(v.title) || "Untitled"; }
  return "Untitled";
}
function propVal(v) {
  if (!v || typeof v !== "object") return null;
  switch (v.type) {
    case "select": return v.select && v.select.name;
    case "status": return v.status && v.status.name;
    case "multi_select": return (v.multi_select || []).map(function (o) { return o.name; }).join(", ") || null;
    case "date": return v.date ? [v.date.start, v.date.end].filter(Boolean).join(" → ") : null;
    case "number": return v.number != null ? String(v.number) : null;
    case "checkbox": return v.checkbox ? "✓" : "✗";
    case "url": return v.url || null;
    case "email": return v.email || null;
    case "phone_number": return v.phone_number || null;
    case "rich_text": return plain(v.rich_text) || null;
    case "people": return (v.people || []).map(function (p) { return p.name; }).filter(Boolean).join(", ") || null;
    case "relation": return v.relation && v.relation.length ? v.relation.length + " linked" : null;
    default: return null;
  }
}
// opts.skipProps: omit the inline "- **Prop:** value" list (used by the Bases path, where
// properties live in YAML frontmatter and a duplicate body list would be redundant/ugly).
function pageToMd(page, opts?: any) {
  opts = opts || {};
  var lines = [];
  if (!opts.frontmatter) lines.push("# " + pageTitle(page.properties), "");
  if (!opts.skipProps) {
    var props = [];
    for (var name in (page.properties || {})) {
      var v = page.properties[name]; if (v && v.type === "title") continue;
      var t = propVal(v); if (t) props.push("- **" + name + ":** " + t);
    }
    if (props.length) { lines = lines.concat(props); lines.push(""); }
  }
  (page.blocks || []).forEach(function (bl) { blockToMd(bl, 0, lines, opts); });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

// Merged markdown (json mode).
function backupToMarkdown(b) {
  if (!b || !Array.isArray(b.databases)) throw new Error("That doesn't look like a Restora backup (.json).");
  var docs = [];
  (b.databases || []).forEach(function (db) {
    (db.dataSources || []).forEach(function (ds) {
      docs.push("<!-- " + (ds.name || db.title || "Database") + " -->");
      (ds.pages || []).forEach(function (p) { docs.push(pageToMd(p)); });
    });
  });
  var names = (b.databases || []).map(function (d) { return d.title; }).filter(Boolean);
  return "# Notion export — " + (names.join(", ") || "Notion backup") + "\n\n_Converted from a Restora backup._\n\n" + docs.join("\n---\n\n");
}

// ---------- filenames / hashes ----------
function stripHashes(s) { return s.replace(/ [0-9a-f]{32}(?=(\.|\/|$))/g, ""); }
function basename(p) { try { p = decodeURIComponent(p); } catch (e) {} return p.split("/").pop(); }
function safeName(s) { return (s || "Untitled").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120); }
function uniq(used, name) {
  var base = name.replace(/\.md$/i, ""), n = name, i = 2;
  while (used[n.toLowerCase()]) { n = base + " " + i + ".md"; i++; }
  used[n.toLowerCase()] = 1; return n;
}

// ---------- YAML frontmatter + wikilink transforms ----------
// Quote a YAML key only when it isn't a plain word (Obsidian property names allow spaces/_/-).
function yamlKey(k) { return /^[A-Za-z0-9_][A-Za-z0-9 _-]*$/.test(k) ? k : JSON.stringify(k); }
// Emit a YAML scalar with the right *type*: bools + finite numbers + ISO dates unquoted, the
// rest JSON-quoted (handles colons, '#', and [[wikilinks]] safely).
function yamlScalar(v) {
  if (v === true || v === false) return v ? "true" : "false";
  if (typeof v === "number" && isFinite(v)) return String(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) return v;
  return JSON.stringify(String(v));
}
function frontmatter(fields) {
  var ks = Object.keys(fields).filter(function (k) {
    var v = fields[k];
    return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });
  if (!ks.length) return "";
  var y = "---\n";
  ks.forEach(function (k) {
    var v = fields[k], key = yamlKey(k);
    if (Array.isArray(v)) { y += key + ":\n"; v.forEach(function (x) { y += "  - " + yamlScalar(x) + "\n"; }); }
    else y += key + ": " + yamlScalar(v) + "\n";
  });
  return y + "---\n\n";
}
// Notion md page links: [Text](Some%20Page%20<hash>.md) -> [[Text]]
function toWikilinks(md) { return md.replace(/\[([^\]]+)\]\(([^)]+\.md)\)/g, "[[$1]]"); }

// ---------- .zip (Notion native export) → merged markdown ----------
function mergeZipMd(files, opts) {
  opts = opts || {};
  var strip = opts.strip !== false;
  var mds = files.filter(function (f) { return /\.md$/i.test(f.name); });
  if (!mds.length) throw new Error("No Markdown files found in that zip — export from Notion as “Markdown & CSV”.");
  var csvCount = files.filter(function (f) { return /\.csv$/i.test(f.name); }).length;
  mds.sort(function (a, b) { return a.name.localeCompare(b.name); });
  var parts = mds.map(function (f) {
    var title = basename(f.name).replace(/\.md$/i, ""); if (strip) title = stripHashes(title);
    var body = dec.decode(f.data); if (strip) body = body.replace(/ [0-9a-f]{32}(?=[)\s.])/g, "");
    return "# " + title + "\n\n" + body.replace(/^#\s.*\n/, "").trim() + "\n";
  });
  return { text: parts.join("\n\n---\n\n"), mdCount: mds.length, csvCount: csvCount };
}

// ---------- → Obsidian vault ({pages:[{name,markdown}], attachments:[{name,data}], note}) ----------
function zipToVault(files, opts) {
  opts = opts || {};
  var mds = files.filter(function (f) { return /\.md$/i.test(f.name); });
  if (!mds.length) throw new Error("No Markdown files found in that zip — export from Notion as “Markdown & CSV”.");
  // non-md, non-csv, non-directory files become attachments (images, pdfs, etc.)
  var assets = files.filter(function (f) { return !/\.(md|csv)$/i.test(f.name) && !/\/$/.test(f.name); });
  var attachments = assets.map(function (f) { return { name: "attachments/" + basename(f.name), data: f.data }; });
  var used = {};
  var pages = mds.map(function (f) {
    var title = stripHashes(basename(f.name).replace(/\.md$/i, ""));
    var body = dec.decode(f.data).replace(/^#\s.*\n/, "").replace(/ [0-9a-f]{32}(?=[)\s.\/])/g, "").trim();
    // rewrite image links to the attachments folder
    body = body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, path) {
      var bn = basename(path); return "![" + alt + "](attachments/" + bn + ")";
    });
    if (opts.wikilinks !== false) body = toWikilinks(body);
    var fm = opts.frontmatter !== false ? frontmatter({ title: title, source: "Notion export" }) : "";
    return { name: uniq(used, safeName(title) + ".md"), markdown: fm + "# " + title + "\n\n" + body + "\n" };
  });
  var note = pages.length + " note(s)" + (attachments.length ? ", " + attachments.length + " attachment(s)" : "") + " — ready for Obsidian.";
  return { pages: pages, attachments: attachments, note: note };
}

function b64ToBytes(b64) { return new Uint8Array(Buffer.from(b64, "base64")); }

function backupToVault(b, opts) {
  opts = opts || {};
  if (!b || !Array.isArray(b.databases)) throw new Error("That doesn't look like a Restora backup (.json).");
  var attachments = [], fileNameByKey = {};
  var fmap = b.files || {};
  Object.keys(fmap).forEach(function (key) {
    var name = "attachments/" + safeName(fmap[key].name || (key + ".bin"));
    fileNameByKey[key] = name;
    try { attachments.push({ name: name, data: b64ToBytes(fmap[key].data) }); } catch (e) {}
  });
  var resolveImage = function (d) {
    if (d && d.restora_key && fileNameByKey[d.restora_key]) return fileNameByKey[d.restora_key];
    return fileUrl(d) || "";
  };
  var used = {}, pages = [];
  (b.databases || []).forEach(function (db) {
    (db.dataSources || []).forEach(function (ds) {
      (ds.pages || []).forEach(function (p) {
        var title = pageTitle(p.properties);
        var fields: any = { title: title, source: "Notion" };
        var tags = []; for (var nm in (p.properties || {})) { var v = p.properties[nm]; if (v && v.type === "multi_select") tags = tags.concat((v.multi_select || []).map(function (o) { return o.name; })); }
        if (tags.length) fields.tags = tags;
        var body = pageToMd(p, { wikilinks: opts.wikilinks !== false, frontmatter: true, resolveImage: resolveImage });
        var fm = opts.frontmatter !== false ? frontmatter(fields) : "# " + title + "\n\n";
        pages.push({ name: uniq(used, safeName(title) + ".md"), markdown: fm + body });
      });
    });
  });
  if (!pages.length) throw new Error("No pages found in that backup.");
  var note = pages.length + " note(s)" + (attachments.length ? ", " + attachments.length + " attachment(s)" : "") + " — ready for Obsidian.";
  return { pages: pages, attachments: attachments, note: note };
}

// ---------- backup → Obsidian *Bases* vault (folders + .base, typed frontmatter) ----------
// Each Notion database becomes a folder of one note-per-row (property values in typed YAML
// frontmatter, relations as [[wikilinks]]) plus a <db>.base table view. Needs the .json backup
// (the schema/property types live there) — a .zip export can't do this faithfully.
function buildTitleById(b) {
  var idTitle = {};
  (b.databases || []).forEach(function (db) {
    (db.dataSources || []).forEach(function (ds) {
      (ds.pages || []).forEach(function (p) { idTitle[p.id] = pageTitle(p.properties); });
    });
  });
  return idTitle;
}
// Frontmatter/Bases-safe key. Keep the human name (Bases references it verbatim) — only strip
// chars YAML/Obsidian dislike in keys. Original label is preserved as the column displayName.
function obsidianKey(name) {
  return String(name == null ? "" : name).replace(/[:#\[\]\^|\\`]/g, " ").replace(/\s+/g, " ").trim() || "field";
}
function isoDate(d) { return d && d.start ? (d.end ? d.start + "/" + d.end : d.start) : null; }
// Notion property value → native Obsidian frontmatter value (number/bool/string/array/null).
function propToObsidian(v, idTitle) {
  if (!v || typeof v !== "object") return null;
  switch (v.type) {
    case "title": return plain(v.title) || null;
    case "rich_text": return plain(v.rich_text) || null;
    case "url": return v.url || null;
    case "email": return v.email || null;
    case "phone_number": return v.phone_number || null;
    case "number": return typeof v.number === "number" ? v.number : null;
    case "checkbox": return !!v.checkbox;
    case "select": return (v.select && v.select.name) || null;
    case "status": return (v.status && v.status.name) || null;
    case "multi_select": return (v.multi_select || []).map(function (o) { return o.name; }).filter(Boolean);
    case "people": return (v.people || []).map(function (p) { return p.name; }).filter(Boolean);
    case "files": return (v.files || []).map(function (f) { return f.name || (f.external && f.external.url) || (f.file && f.file.url) || ""; }).filter(Boolean);
    case "date": return isoDate(v.date);
    case "created_time": return v.created_time || null;
    case "last_edited_time": return v.last_edited_time || null;
    case "created_by": return (v.created_by && v.created_by.name) || null;
    case "last_edited_by": return (v.last_edited_by && v.last_edited_by.name) || null;
    case "unique_id": return v.unique_id ? ((v.unique_id.prefix ? v.unique_id.prefix + "-" : "") + v.unique_id.number) : null;
    case "relation": {
      var arr = (v.relation || []).map(function (r) { return idTitle[r.id] ? "[[" + idTitle[r.id] + "]]" : null; }).filter(Boolean);
      return arr.length ? arr : null;
    }
    case "rollup": {
      var rr = v.rollup; if (!rr) return null;
      if (rr.type === "number") return typeof rr.number === "number" ? rr.number : null;
      if (rr.type === "date") return isoDate(rr.date);
      if (rr.type === "array") {
        var out = [];
        (rr.array || []).forEach(function (x) { var val = propToObsidian(x, idTitle); if (Array.isArray(val)) out = out.concat(val); else if (val != null && val !== "") out.push(val); });
        return out.length ? out : null;
      }
      return null;
    }
    case "formula": {
      var f = v.formula; if (!f) return null;
      if (f.type === "number") return typeof f.number === "number" ? f.number : null;
      if (f.type === "boolean") return !!f.boolean;
      if (f.type === "date") return isoDate(f.date);
      if (f.type === "string") return f.string || null;
      return null;
    }
    default: return null;
  }
}
// YAML single-quoted scalar wrapping `file.inFolder("Folder")` (inner quotes stay literal).
function inFolderFilter(folder) { return "'" + ('file.inFolder("' + folder + '")').replace(/'/g, "''") + "'"; }
function uniqFolder(used, name) {
  var n = name, i = 2;
  while (used[n.toLowerCase()]) { n = name + " " + i; i++; }
  used[n.toLowerCase()] = 1; return n;
}
function basesFileYaml(folder, schema, titleName) {
  var filt = inFolderFilter(folder), usedKeys = {}, props = [], order = ["      - file.name"];
  Object.keys(schema || {}).forEach(function (n) {
    if (n === titleName) return;
    if (schema[n] && schema[n].type === "title") return;
    var key = obsidianKey(n);
    if (usedKeys[key]) return;          // first wins for the visible column
    usedKeys[key] = 1;
    props.push("  " + yamlKey(key) + ":\n    displayName: " + JSON.stringify(String(n)));
    order.push("      - note." + key);
  });
  var y = "filters:\n  and:\n    - " + filt + "\n";
  if (props.length) y += "properties:\n" + props.join("\n") + "\n";
  y += "views:\n  - type: table\n    name: " + JSON.stringify(String(folder)) + "\n";
  y += "    filters:\n      and:\n        - " + filt + "\n";
  y += "    order:\n" + order.join("\n") + "\n";
  return y;
}
function backupToBasesVault(b, opts) {
  opts = opts || {};
  if (!b || !Array.isArray(b.databases)) throw new Error("That doesn't look like a Restora backup (.json).");
  var attachments = [], fileNameByKey = {};
  var fmap = b.files || {};
  Object.keys(fmap).forEach(function (key) {
    var name = "attachments/" + safeName(fmap[key].name || (key + ".bin"));
    fileNameByKey[key] = name;
    try { attachments.push({ name: name, data: b64ToBytes(fmap[key].data) }); } catch (e) {}
  });
  var resolveImage = function (d) {
    if (d && d.restora_key && fileNameByKey[d.restora_key]) return fileNameByKey[d.restora_key];
    return fileUrl(d) || "";
  };
  var idTitle = buildTitleById(b), pages = [], usedFolders = {}, dbCount = 0, rowCount = 0;

  (b.databases || []).forEach(function (db) {
    (db.dataSources || []).forEach(function (ds) {
      dbCount++;
      var schema = ds.properties || {}, titleName = null;
      Object.keys(schema).forEach(function (n) { if (schema[n] && schema[n].type === "title") titleName = n; });
      var folder = uniqFolder(usedFolders, safeName(ds.name || db.title || "Database")), usedInFolder = {};
      (ds.pages || []).forEach(function (p) {
        rowCount++;
        var props = p.properties || {}, title = pageTitle(props), fields = {}, keyUsed = {};
        for (var nm in props) {
          var v = props[nm]; if (!v || v.type === "title") continue;
          var val = propToObsidian(v, idTitle);
          if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) continue;
          var key = obsidianKey(nm);
          if (keyUsed[key]) { var j = 2; while (keyUsed[key + " " + j]) j++; key = key + " " + j; }
          keyUsed[key] = 1; fields[key] = val;
        }
        var body = pageToMd(p, { wikilinks: opts.wikilinks !== false, frontmatter: true, skipProps: true, resolveImage: resolveImage });
        var fileName = uniq(usedInFolder, safeName(title) + ".md");
        pages.push({ name: folder + "/" + fileName, markdown: frontmatter(fields) + body });
      });
      // the .base is written even for an empty database (a valid view with zero matching rows)
      pages.push({ name: folder + "/" + safeName(folder) + ".base", markdown: basesFileYaml(folder, schema, titleName) });
    });
  });

  // standalone (non-database) pages → a top-level Pages/ folder
  var usedStandalone = {};
  (b.pages || []).forEach(function (p) {
    var title = pageTitle(p.properties);
    var body = pageToMd(p, { wikilinks: opts.wikilinks !== false, frontmatter: true, resolveImage: resolveImage });
    pages.push({ name: "Pages/" + uniq(usedStandalone, safeName(title) + ".md"), markdown: frontmatter({ title: title, source: "Notion" }) + body });
  });

  if (!pages.length) throw new Error("No pages found in that backup.");
  var note = dbCount + " database" + (dbCount === 1 ? "" : "s") + " → Bases · " + rowCount + " note" + (rowCount === 1 ? "" : "s") +
    (attachments.length ? " · " + attachments.length + " attachment(s)" : "") + ". Unzip into an Obsidian vault.";
  return { pages: pages, attachments: attachments, note: note };
}

// ---------- ZIP reader (Node zlib) ----------
function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }
function inflateRaw(bytes) { return new Uint8Array(inflateRawSync(bytes)); }
async function readZip(arrayBuffer) {
  var dv = new DataView(arrayBuffer), bytes = new Uint8Array(arrayBuffer), n = dv.byteLength, eocd = -1;
  for (var i = n - 22; i >= 0 && i >= n - 22 - 65535; i--) { if (u32(dv, i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("That doesn't look like a valid .zip file.");
  var count = u16(dv, eocd + 10), cdOffset = u32(dv, eocd + 16), entries = [], p = cdOffset;
  for (var e = 0; e < count; e++) {
    if (u32(dv, p) !== 0x02014b50) break;
    var method = u16(dv, p + 10), compSize = u32(dv, p + 20), nameLen = u16(dv, p + 28),
        extraLen = u16(dv, p + 30), commentLen = u16(dv, p + 32), localOff = u32(dv, p + 42);
    var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  var out = [];
  for (var k = 0; k < entries.length; k++) {
    var en = entries[k]; if (/\/$/.test(en.name)) continue;
    var lo = en.localOff; if (u32(dv, lo) !== 0x04034b50) continue;
    var lNameLen = u16(dv, lo + 26), lExtraLen = u16(dv, lo + 28), dataStart = lo + 30 + lNameLen + lExtraLen;
    var comp = bytes.subarray(dataStart, dataStart + en.compSize);
    var data = en.method === 0 ? comp : await inflateRaw(comp);
    out.push({ name: en.name, data: data });
  }
  return out;
}

// ---------- ZIP writer (method-0 stored + CRC32) ----------
var _crc;
function crc32(bytes) {
  if (!_crc) { _crc = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crc[n] = c >>> 0; } }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crc[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function writeZip(entries) {
  var parts = [], central = [], offset = 0;
  for (var i = 0; i < entries.length; i++) {
    var nameB = enc.encode(entries[i].name), data = entries[i].data, crc = crc32(data);
    var lh = new Uint8Array(30 + nameB.length), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true); dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true); dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    parts.push(lh, data);
    var ch = new Uint8Array(46 + nameB.length), cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true); cdv.setUint16(10, 0, true); cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true); cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameB.length, true); cdv.setUint32(42, offset, true);
    ch.set(nameB, 46); central.push(ch);
    offset += lh.length + data.length;
  }
  var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
  var eocd = new Uint8Array(22), edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, entries.length, true); edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cdSize, true); edv.setUint32(16, offset, true);
  var total = offset + cdSize + 22, outArr = new Uint8Array(total), pos = 0;
  for (var j = 0; j < parts.length; j++) { outArr.set(parts[j], pos); pos += parts[j].length; }
  for (var m = 0; m < central.length; m++) { outArr.set(central[m], pos); pos += central[m].length; }
  outArr.set(eocd, pos);
  return outArr;
}

export {
  readZip, writeZip,
  mergeZipMd, backupToMarkdown,
  zipToVault, backupToVault, backupToBasesVault,
};
