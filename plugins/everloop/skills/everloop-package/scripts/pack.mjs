#!/usr/bin/env node
/**
 * pack.mjs — validate, stamp and zip an app into an EverLoop package.
 * Pure Node (no dependencies); writes a deterministic STORE zip so it works the
 * same on macOS, Linux and Windows without the `zip` binary.
 *
 *   node ./scripts/pack.mjs <app-dir> [--version X.Y.Z]
 *
 * Steps: validate manifest → final rule check → stamp rulesHash + connector version →
 * bump version → update .everloop/id-map.json → write <packageId>-<version>.zip.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { scanPackage, formatReport } from "./rules-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, "..", "everloop-rules.json");
const CONNECTOR_PATH = path.join(__dirname, "..", "everloop-connector.js");
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude"]);
const SKIP_EXT = new Set([".zip"]);
const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".jsx", ".ts", ".tsx"]);
const ID_RE = /^[a-z0-9-]{3,64}$/;

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

// ---- deterministic STORE zip ----------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x21; // 1980-01-01 (deterministic)

function zipStore(entries) {
  // entries: [{ name, data:Buffer }]
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // method = store
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + e.data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// ---- fs helpers -----------------------------------------------------------
function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, base, out);
    else if (!SKIP_EXT.has(path.extname(name).toLowerCase()))
      out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || "");
  if (!m) return "1.0.0";
  return `${m[1]}.${m[2]}.${+m[3] + 1}`;
}

// ---- main -----------------------------------------------------------------
function main() {
  const appDir = process.argv[2];
  if (!appDir || !fs.existsSync(appDir)) die("Usage: node pack.mjs <app-dir> [--version X.Y.Z]");
  const vIdx = process.argv.indexOf("--version");
  const forcedVersion = vIdx > -1 ? process.argv[vIdx + 1] : null;

  // manifest
  const manifestPath = path.join(appDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) die("manifest.json not found. Run the `manifest` step first.");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return die("manifest.json is not valid JSON: " + e.message);
  }

  // structural validation
  if (manifest.entry && manifest.entry !== "index.html") die(`manifest.entry must be "index.html".`);
  if (!fs.existsSync(path.join(appDir, "index.html"))) die("index.html must exist at the package root.");
  if (!manifest.packageId || !ID_RE.test(manifest.packageId))
    die("manifest.packageId must match [a-z0-9-]{3,64}.");

  const ids = new Map();
  const checkId = (item, kind) => {
    if (!ID_RE.test(item.id || "")) die(`${kind} id "${item.id}" must match [a-z0-9-]{3,64}.`);
    if (ids.has(item.id)) die(`Duplicate id "${item.id}" (ids must be unique within the package).`);
    ids.set(item.id, kind);
  };
  for (const a of manifest.activities || []) {
    checkId(a, "activity");
    if (a.type && !["activity", "quiz"].includes(a.type)) die(`activity "${a.id}" type must be activity|quiz.`);
  }
  for (const ac of manifest.achievements || []) {
    checkId(ac, "achievement");
    if (ac.kind && !["badge", "tiered", "counter"].includes(ac.kind))
      die(`achievement "${ac.id}" kind must be badge|tiered|counter.`);
    if (ac.checkedBy && !["app", "everloop"].includes(ac.checkedBy))
      die(`achievement "${ac.id}" checkedBy must be app|everloop.`);
    if (ac.icon && !fs.existsSync(path.join(appDir, ac.icon)))
      die(`achievement "${ac.id}" icon "${ac.icon}" does not exist in the package.`);
  }

  // connector present?
  const files = walk(appDir);
  const hasConnector = files.some((f) => /(^|\/)everloop-connector\.js$/.test(f.rel));
  if (!hasConnector) die("everloop-connector.js not found. Run the `connect` step first.");

  // final rule check (parity with upload)
  const textFiles = files
    .filter((f) => TEXT_EXT.has(path.extname(f.rel).toLowerCase()))
    .map((f) => ({ path: f.rel, text: fs.readFileSync(f.full, "utf8") }));
  const rulesDoc = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
  const scan = scanPackage(rulesDoc, textFiles, { hasIndexHtml: true, hasConnector: true });
  if (!scan.passed) {
    console.error(formatReport(scan));
    die("Rule check failed — fix the MUST FIX items above and re-run pack.");
  }

  // stamp rulesHash + connector version
  const rulesHash = crypto.createHash("sha256").update(fs.readFileSync(RULES_PATH)).digest("hex");
  const connectorSrc = fs.readFileSync(CONNECTOR_PATH, "utf8");
  // readable build has `LIB_VERSION = "x"`; minified build keeps it only in the /*! banner */
  const connectorVersion =
    (/LIB_VERSION\s*=\s*"([^"]+)"/.exec(connectorSrc) || [])[1] ||
    (/\bv(\d+\.\d+\.\d+)\b/.exec(connectorSrc.slice(0, 400)) || [])[1] ||
    "unknown";
  manifest.rulesHash = rulesHash;
  manifest.connector = { version: connectorVersion };
  manifest.schemaVersion = rulesDoc.schemaVersion;

  // version
  manifest.version = forcedVersion || bumpPatch(manifest.version);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) die(`version "${manifest.version}" must be semver X.Y.Z.`);

  // id-map: stable IDs across versions; warn on disappearances (P1.6)
  const idMapDir = path.join(appDir, ".everloop");
  const idMapPath = path.join(idMapDir, "id-map.json");
  let idMap = { ids: {} };
  if (fs.existsSync(idMapPath)) {
    try {
      idMap = JSON.parse(fs.readFileSync(idMapPath, "utf8"));
    } catch {}
  }
  idMap.ids = idMap.ids || {};
  for (const [id, kind] of ids) {
    if (!idMap.ids[id]) idMap.ids[id] = { kind, firstVersion: manifest.version };
  }
  const missing = Object.keys(idMap.ids).filter((id) => !ids.has(id));
  if (missing.length) {
    console.warn(
      `⚠ These IDs existed before and are missing now (rename/drop?): ${missing.join(", ")}.\n` +
        `  EverLoop will ask you to confirm this on upload, and will keep existing student progress for them.`,
    );
  }
  fs.mkdirSync(idMapDir, { recursive: true });
  fs.writeFileSync(idMapPath, JSON.stringify(idMap, null, 2));

  // write stamped manifest back
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // build zip (index.html + everything, at root; re-read so the updated manifest is included)
  const entries = walk(appDir).map((f) => ({ name: f.rel, data: fs.readFileSync(f.full) }));
  const zipName = `${manifest.packageId}-${manifest.version}.zip`;
  const zipBuf = zipStore(entries);
  fs.writeFileSync(path.join(appDir, zipName), zipBuf);

  // summary
  const kb = (zipBuf.length / 1024).toFixed(0);
  console.log(`✓ Packed ${zipName}`);
  console.log(`  package : ${manifest.packageId} v${manifest.version} — "${manifest.title || ""}"`);
  console.log(`  activities : ${(manifest.activities || []).length}`);
  console.log(`  achievements: ${(manifest.achievements || []).length}`);
  console.log(`  files : ${entries.length}   size: ${kb} KB`);
  console.log(`  connector v${connectorVersion} · rulesHash ${rulesHash.slice(0, 12)}…`);
  console.log(`\nHand ${zipName} to the EverLoop upload screen.`);
}

main();
