---
name: everloop-package
description: Turn a self-contained web app (a quiz or activity) into an EverLoop-ready package so it can communicate with EverLoop. Use when an Edu-team app needs to talk to EverLoop, or the user says "make this EverLoop ready", "package for EverLoop", "add EverLoop events/scoring/rewards", or "wire up the connector". It checks EverLoop's house rules, injects the connector, wires the event API into the app's logic (with your confirmation), builds manifest.json with stable IDs, and packs a zip with index.html at the root that passes EverLoop upload first time.
---

# EverLoop Package skill

You turn an ordinary web app into an **EverLoop package**. Work through four steps in order: **check → connect → manifest → pack**. Never skip the author's confirmation on code edits, and **never weaken a house rule to make a check pass** — if something can't be fixed, report it and stop.

## The one idea the whole thing rests on

> **EverLoop is the single source of truth. The app can only *ask*; EverLoop *decides, records and pays*.**

The app runs inside a locked-down iframe with **no network, no cookies, no storage**. Its *only* channel is a small library called the **connector** (`everloop-connector.js`), which exposes a global `EverLoop` object. Everything the app does with EverLoop goes through it:

- **Report events** (each returns a Promise that resolves with EverLoop's confirmation):
  `EverLoop.started(id)`, `EverLoop.progress(id, {saveSlot})`, `EverLoop.scored(id, score, maxScore)`, `EverLoop.completed(id)`, `EverLoop.achievement(id, tier?)`, `EverLoop.reward(id)`
- **Read state** (the app renders *only* from these, never from its own guess):
  `EverLoop.progress.get(id)`, `EverLoop.progress.all()`, `EverLoop.achievements.list()`, `EverLoop.student.displayName`, `EverLoop.onUpdate(state => ...)`

`EverLoop.reward()` only *requests* a payout — **EverLoop decides the amount**; it comes back in the confirmation as `bucks_paid`. The app must never invent a reward amount, store progress locally, or show a badge/coin it wasn't given in a confirmation.

The bundled files you work with live beside this skill:
- `./everloop-connector.js` and `./everloop-connector.d.ts` — copy into the app.
- `./scripts/check.mjs` — the rule checker (identical to EverLoop's upload checker).
- `./scripts/pack.mjs` — the packer (validates, stamps, zips).
- `./everloop-rules.json` — the house rules both checkers share.

---

## Step 1 — check

Run the rule checker over the app and explain every finding in plain words.

```
node ./scripts/check.mjs <app-dir>
```

It prints each issue as `MUST FIX` (blocking) or `review` (advisory) with the file, line and a suggested fix. For every **MUST FIX**, either apply the fix (confirm with the author first) or, if you can't, list it and stop — do not proceed to pack. Common fixes:
- External `<script>`/`<link>`/font/image URLs → download the asset into `./assets` and use a relative path.
- `fetch`/`XHR`/`WebSocket` → remove; route data through `EverLoop.*` events instead.
- `localStorage`/`sessionStorage`/`cookie` for progress → replace with `EverLoop.progress(id, {saveSlot})` + reads on resume.

The checker uses the exact same `everloop-rules.json` the server uses, so "check passes" means "upload will pass" for these rules.

## Step 2 — connect

Make the app actually talk to EverLoop.

1. **Add the connector.** Copy `everloop-connector.js` into the app (e.g. `./everloop-connector.js`) and load it in `index.html` **before** the app's own scripts:
   ```html
   <script src="./everloop-connector.js"></script>
   ```
   For a framework app, operate on the **built output** (the static `index.html` + bundled assets that will be zipped). If only source is available, build it first, then instrument the build.

2. **Find the app's key moments and wire events.** Read the code and locate where the app:
   - opens an activity/level → `await EverLoop.started(activityId)`
   - records a score/result → `await EverLoop.scored(activityId, score, maxScore)`
   - finishes an activity → `const res = await EverLoop.completed(activityId)`
   - grants a badge/star → `EverLoop.achievement(achievementId, tier?)`
   - gives a coin/reward → `EverLoop.reward(activityId)` (then show `res.bucks_paid`)
   - autosaves mid-activity → `EverLoop.progress(activityId, {saveSlot: <your blob>})`

   **Propose each wiring point to the author and get confirmation before editing** — you are changing their logic. Keep activity IDs human-readable and stable (e.g. `fractions-quiz-1`).

3. **Render from EverLoop, not from local state.** Replace any place the app paints progress/scores/badges from its own memory or storage with reads from the connector, and repaint on updates:
   ```js
   EverLoop.onUpdate(state => {
     paintProgress(state.activities);
     paintBadges(state.achievements);
   });
   ```
   On a completion, draw from the returned confirmation: `paintScore(res.record.score)`, and only show coins if `res.bucks_paid > 0`.

4. **Verify locally in preview.** Open `index.html` directly in a browser (or with `?everloop_preview=halfway`). The connector enters **preview mode**, loads sample data and logs events to the console — nothing is saved or paid. Confirm the app plays, scores, and repaints from `onUpdate`.

## Step 3 — manifest

Create/update `manifest.json` at the app root describing the package. Infer structure from the app (levels, topics, activities, achievements). **Keep IDs permanent: never regenerate an existing ID on a re-run** — reuse whatever is already in `manifest.json` / `.everloop/id-map.json`; only add IDs for genuinely new items.

```json
{
  "packageId": "math-primary",
  "version": "1.0.0",
  "title": "Primary Maths",
  "level": "P1",
  "entry": "index.html",
  "activities": [
    { "id": "fractions-quiz-1", "title": "Fractions I", "topic": "Fractions", "type": "quiz", "maxScore": 10 }
  ],
  "achievements": [
    { "id": "fractions-master", "kind": "badge", "title": "Fractions Master", "icon": "assets/badge.png", "description": "Complete all fractions quizzes", "checkedBy": "everloop" }
  ]
}
```

Rules: IDs match `[a-z0-9-]{3,64}`, unique within the package, and **permanent across versions**; `entry` is always `index.html`; every achievement `icon` path must exist in the package; `type` is `activity` or `quiz`; `kind` is `badge`, `tiered` or `counter`; `checkedBy` is `app` or `everloop` (reward-bearing achievements should be `everloop`). Do **not** put reward amounts in the manifest — EverLoop admins set those at publish time; any amounts here are ignored.

## Step 4 — pack

```
node ./scripts/pack.mjs <app-dir> [--version 1.2.0]
```

This validates the manifest, confirms `index.html` and the connector are present, stamps the shared-rules hash and connector version into the manifest, bumps the version (patch by default), records IDs in `.everloop/id-map.json` (warning if a previously-used ID disappeared — a rename/drop EverLoop will ask about), and writes `<packageId>-<version>.zip` with `index.html` at the root. It prints a summary (activities, achievements, file count, size). Hand that zip to the EverLoop upload screen.

If pack reports a problem, fix it and re-run — do not hand over a zip that pack rejected.
