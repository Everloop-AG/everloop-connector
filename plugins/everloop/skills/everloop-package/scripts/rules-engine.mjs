/**
 * rules-engine.mjs — the ONE static checker shared by the Claude skill (`check`)
 * and the EverLoop server (upload P1.4). Byte-identical rules + identical engine
 * ⇒ identical verdict, by construction. Pure: no I/O, no deps.
 *
 * The server imports this same module (compiled/copied) at its P1.4 path, and the
 * skill vendors it under scripts/. `rulesHash` (sha256 of everloop-rules.json) is
 * stamped into manifest.json by `pack`; the server hard-rejects on hash mismatch,
 * so a stale skill fails loudly instead of silently diverging.
 */

/** Classify a file path into a rule domain. */
export function fileKind(path) {
  const p = path.toLowerCase();
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".jsx") || p.endsWith(".ts") || p.endsWith(".tsx"))
    return "js";
  return "other";
}

/**
 * Scan one file's text against all content rules that apply to its kind.
 * @returns {Array<{ruleId,severity,file,line,column,excerpt,message,fix}>}
 */
export function scanFile(rulesDoc, path, text) {
  const kind = fileKind(path);
  const findings = [];
  for (const rule of rulesDoc.rules) {
    if (!rule.pattern) continue; // manifest-only rules handled elsewhere
    if (!rule.applies.includes(kind)) continue;
    const re = new RegExp(rule.pattern, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      const before = text.slice(0, idx);
      const line = before.split("\n").length;
      const column = idx - before.lastIndexOf("\n");
      const lineText = text.split("\n")[line - 1] || "";
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        file: path,
        line,
        column,
        excerpt: lineText.trim().slice(0, 200),
        message: rule.message,
        fix: rule.fix,
      });
      if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
    }
  }
  return findings;
}

/**
 * Scan a whole package.
 * @param {object} rulesDoc  parsed everloop-rules.json
 * @param {Array<{path:string,text:string}>} files  text files in the package
 * @param {object} [opts] { hasIndexHtml, hasConnector, connectorVersion, supportedConnectorVersions }
 * @returns {{findings:Array, errors:number, warnings:number, passed:boolean}}
 */
export function scanPackage(rulesDoc, files, opts = {}) {
  let findings = [];
  for (const f of files) findings = findings.concat(scanFile(rulesDoc, f.path, f.text));

  // manifest-level rules (structural, not regex)
  const manifestRule = (id) => rulesDoc.rules.find((r) => r.id === id);
  if (opts.hasIndexHtml === false) {
    const r = manifestRule("entry-must-exist");
    if (r) findings.push({ ruleId: r.id, severity: r.severity, file: "(package)", line: 0, column: 0, excerpt: "", message: r.message, fix: r.fix });
  }
  if (opts.hasConnector === false) {
    const r = manifestRule("connector-required");
    if (r) findings.push({ ruleId: r.id, severity: r.severity, file: "(package)", line: 0, column: 0, excerpt: "", message: r.message, fix: r.fix });
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  return { findings, errors, warnings, passed: errors === 0 };
}

/** Render findings as a plain-language report (used by the skill's `check` step). */
export function formatReport(result) {
  if (result.findings.length === 0) return "✓ No issues found. This package is ready to pack.";
  const lines = [];
  lines.push(`Found ${result.errors} blocking issue(s) and ${result.warnings} warning(s):\n`);
  for (const f of result.findings) {
    const tag = f.severity === "error" ? "✗ MUST FIX" : "⚠ review";
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`${tag}  [${f.ruleId}]  ${loc}`);
    if (f.excerpt) lines.push(`    ${f.excerpt}`);
    lines.push(`    ${f.message}`);
    lines.push(`    Fix: ${f.fix}\n`);
  }
  lines.push(result.passed ? "Verdict: PASSES (warnings are advisory)." : "Verdict: BLOCKED until the MUST FIX items are resolved.");
  return lines.join("\n");
}
