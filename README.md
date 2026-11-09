# everloop-connector

The EverLoop **Plug-and-Play SDK** *and* the private **Claude Code marketplace** that ships it to Edu teams.
One repo, two jobs:

- **SDK** (`connector/`, `shared/`, `sample-app/`) — the connector an app uses to talk to EverLoop, and the
  house-rules both the skill and the EverLoop server enforce. Edit here, then `npm run build`.
- **Marketplace** (`.claude-plugin/`, `plugins/`) — the installable plugin wrapping the `everloop-package`
  skill. This is what Edu teams add to Claude Code.

```
.claude-plugin/marketplace.json              # marketplace (repo root → enables `add owner/repo`)
plugins/everloop/
├── .claude-plugin/plugin.json               # plugin manifest (bump "version" to release)
└── skills/everloop-package/                 # the skill
    ├── SKILL.md                             # ← canonical (hand-written)
    ├── scripts/{check,pack}.mjs             # ← canonical
    ├── everloop-connector.js                # ← generated (minified) by `npm run build`
    ├── everloop-connector.d.ts              # ← generated
    ├── everloop-rules.json                  # ← generated
    └── scripts/rules-engine.mjs             # ← generated
connector/  shared/  sample-app/  scripts/   # SDK sources + build tooling
```

## For the Edu team — install once

```
/plugin marketplace add Everloop-AG/everloop-connector
/plugin install everloop@everloop-connector
```

Then in any app repo, tell Claude **"make this EverLoop ready"** (the skill auto-triggers on its
description), or run `/everloop:everloop-package`. Update later with `/plugin update`.

> Private repo auth uses your existing GitHub login (`gh auth login` or SSH). If a teammate can
> `git clone` the repo, they can add the marketplace.

## For EverLoop engineers — edit & release

```
npm install          # once (installs esbuild)
npm run build        # minify connector (~7 KB) + re-inject into the skill & sample
npm run demo         # check + pack the sample app end-to-end (sanity check)
```

To release a new version of the skill/connector/rules:
1. Edit the canonical sources (`connector/`, `shared/`, or `plugins/.../SKILL.md`).
2. `npm run build` (re-vendors the generated files).
3. Bump `plugins/everloop/.claude-plugin/plugin.json` `"version"`.
4. Commit + push. Edu teams get it via `/plugin update`.

**Rule parity:** the EverLoop server's upload checker (plan P1.4) vendors `shared/everloop-rules.json` +
`shared/rules-engine.mjs` from this repo so it returns the identical verdict to the skill's `check`. `pack`
stamps `sha256(everloop-rules.json)` into `manifest.rulesHash`; the server rejects a mismatch, so an
out-of-date skill is bounced at upload with "run the skill again" — no silent drift.

See the full design in the backend repo: `docs/everloop-plug-and-play-plan.md`.
