#!/usr/bin/env node
/**
 * vendor.mjs — inject the CANONICAL connector + rule-spec into the places that must
 * ship their own copy. Run after editing anything in connector/ or shared/
 * (or just run `npm run build`, which minifies then calls this).
 *
 * Canonical sources:
 *   connector/everloop-connector.js (+ .min.js build output, + .d.ts)
 *   shared/everloop-rules.json, shared/rules-engine.mjs
 *
 * Injected into:
 *   plugins/everloop/skills/everloop-package/   — the skill Edu teams run (ships the MINIFIED connector)
 *   sample-app/                                  — the reference app (readable connector)
 *
 * The EverLoop server vendors the same shared/ files at its P1.4 checker path. `pack`
 * stamps sha256(everloop-rules.json) into manifest.rulesHash and the server rejects a
 * mismatch, so a stale copy fails loudly at upload instead of drifting silently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = "plugins/everloop/skills/everloop-package";
const copies = [
  ["connector/everloop-connector.min.js", `${SKILL}/everloop-connector.js`],
  ["connector/everloop-connector.d.ts", `${SKILL}/everloop-connector.d.ts`],
  ["shared/everloop-rules.json", `${SKILL}/everloop-rules.json`],
  ["shared/rules-engine.mjs", `${SKILL}/scripts/rules-engine.mjs`],
  ["connector/everloop-connector.js", "sample-app/everloop-connector.js"],
];

for (const [from, to] of copies) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) {
    console.error(`✗ missing ${from}` + (from.endsWith(".min.js") ? " — run `npm run build` first." : ""));
    process.exit(1);
  }
  const dst = path.join(root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`vendored  ${from}  ->  ${to}`);
}
console.log("\nDone. Commit the changes and push; Edu teams get them via `/plugin update`.");
