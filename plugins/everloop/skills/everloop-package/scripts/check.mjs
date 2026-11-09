#!/usr/bin/env node
/**
 * check.mjs — run EverLoop's house rules over an app directory and print a report.
 * Uses the SAME everloop-rules.json + rules-engine the EverLoop server uses on upload,
 * so a clean local check means these rules pass on upload too.
 *
 *   node ./scripts/check.mjs <app-dir>
 *
 * Exit code 0 = passes (no blocking errors), 1 = blocked, 2 = bad invocation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPackage, formatReport, fileKind } from "./rules-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, "..", "everloop-rules.json");
const SKIP_DIRS = new Set(["node_modules", ".git", ".everloop", ".claude", "dist-zip"]);
const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".jsx", ".ts", ".tsx"]);

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

function main() {
  const appDir = process.argv[2];
  if (!appDir) {
    console.error("Usage: node check.mjs <app-dir>");
    process.exit(2);
  }
  if (!fs.existsSync(appDir)) {
    console.error(`No such directory: ${appDir}`);
    process.exit(2);
  }
  const rulesDoc = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));

  const all = walk(appDir);
  const textFiles = all
    .filter((f) => TEXT_EXT.has(path.extname(f.rel).toLowerCase()))
    .map((f) => ({ path: f.rel, text: fs.readFileSync(f.full, "utf8") }));

  const hasIndexHtml = all.some((f) => f.rel === "index.html");
  const hasConnector = all.some((f) => /(^|\/)everloop-connector\.js$/.test(f.rel));

  const result = scanPackage(rulesDoc, textFiles, { hasIndexHtml, hasConnector });

  console.log(`EverLoop check — rules v${rulesDoc.rulesVersion} — ${textFiles.length} file(s) scanned\n`);
  console.log(formatReport(result));
  process.exit(result.passed ? 0 : 1);
}

main();
