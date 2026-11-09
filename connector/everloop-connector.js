/*!
 * everloop-connector.js — the app's ONLY way to talk to EverLoop.
 * v1.0.0 · schema v1 · zero dependencies · framework-agnostic.
 *
 * HOW IT WORKS (see docs/everloop-plug-and-play-plan.md §6, §11):
 *   The app runs inside a sandboxed, null-origin iframe on play.<everloop-domain>.
 *   It has NO network (CSP connect-src 'none'), NO cookies, NO storage. Its one and
 *   only channel to the outside world is a single MessagePort that the EverLoop host
 *   page transfers in once at startup. This library owns that port. The app never
 *   sees it and never talks to the port directly.
 *
 *   The app only ever:
 *     1. CALLS events ....... EverLoop.started(id), .scored(id, s, max), .completed(id),
 *                             .achievement(id, tier?), .reward(id), .progress(id, {saveSlot})
 *        Each returns a Promise that resolves with EverLoop's authoritative confirmation.
 *     2. READS state ........ EverLoop.progress.get(id) / .all(), EverLoop.achievements.list(),
 *                             EverLoop.student.displayName
 *     3. SUBSCRIBES ......... EverLoop.onUpdate(state => ...)  — fires on every confirmation.
 *
 *   The app renders ONLY from reads/onUpdate/confirmations — never from its own guess.
 *   EverLoop decides scores (for server-marked quizzes), achievements and reward amounts.
 *   EverLoop.reward() only *requests* a payout; the amount always comes back from the server.
 *
 * PREVIEW MODE: opened outside EverLoop (not in an iframe), or with ?everloop_preview=
 * new|halfway|finished, the connector loads sample data and logs events to the console,
 * so the Edu team can build and test every state locally. Nothing is ever paid in preview.
 */
(function (global) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var LIB_VERSION = "1.0.0";
  var CONFIRM_TIMEOUT_MS = 30000; // reject a pending call if no confirmation ever arrives
  var HANDSHAKE_WAIT_MS = 1500; // if no host init arrives this fast, assume preview

  // ---- internal state -------------------------------------------------------
  var port = null; // the one MessagePort to the EverLoop host (null until handshake)
  var hostOrigin = null; // origin that sent the init (trusted thereafter)
  var ready = false; // true once we've received `resume`
  var preview = false;
  var pending = {}; // event_id -> { resolve, reject, timer }
  var queued = []; // event messages made before `ready` (flushed after resume)
  var readyCbs = [];
  var updateCbs = [];

  // authoritative snapshot, replaced/patched only by the host (resume + confirms)
  var snapshot = {
    student: { displayName: "" },
    activities: {}, // id -> { status, score, maxScore, bestScore, attempts, progressPct, saveSlot, firstCompletedAt, lastPlayedAt }
    achievements: {}, // id -> { earnedAt, tier }
    bucksEarnedHere: 0,
  };

  // ---- helpers --------------------------------------------------------------
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    // RFC4122-ish fallback (preview / very old engines only)
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function emitUpdate() {
    var snap = clone(snapshot);
    for (var i = 0; i < updateCbs.length; i++) {
      try {
        updateCbs[i](snap);
      } catch (e) {
        /* a buggy app callback must never break the connector */
        console.error("[EverLoop] onUpdate callback threw:", e);
      }
    }
  }

  function markReady() {
    if (ready) return;
    ready = true;
    for (var i = 0; i < readyCbs.length; i++) {
      try {
        readyCbs[i]();
      } catch (e) {
        console.error("[EverLoop] onReady callback threw:", e);
      }
    }
    // flush anything the app fired before we were connected
    var q = queued;
    queued = [];
    for (var j = 0; j < q.length; j++) sendNow(q[j]);
  }

  // apply a host confirmation to the local snapshot
  function applyConfirm(c) {
    if (c.record && c.record.activity_id) {
      var id = c.record.activity_id;
      snapshot.activities[id] = Object.assign(
        snapshot.activities[id] || {},
        c.record,
      );
    }
    if (c.achievements_earned && c.achievements_earned.length) {
      for (var i = 0; i < c.achievements_earned.length; i++) {
        var a = c.achievements_earned[i];
        snapshot.achievements[a.achievement_id] = {
          earnedAt: a.earned_at || new Date().toISOString(),
          tier: a.tier || null,
          title: a.title || null,
        };
      }
    }
    if (typeof c.wallet_earned_here === "number") {
      snapshot.bucksEarnedHere = c.wallet_earned_here;
    } else if (typeof c.bucks_paid === "number" && c.bucks_paid > 0) {
      snapshot.bucksEarnedHere += c.bucks_paid;
    }
  }

  // ---- messaging ------------------------------------------------------------
  function sendNow(msg) {
    if (preview) return simulate(msg);
    try {
      port.postMessage(msg);
    } catch (e) {
      var p = pending[msg.event_id];
      if (p) {
        clearTimeout(p.timer);
        delete pending[msg.event_id];
        p.reject(new Error("EverLoop channel unavailable"));
      }
    }
  }

  // build an event, register its promise, send or queue it
  function emitEvent(type, activityId, extra) {
    var eventId = uuid();
    var msg = {
      type: "everloop:" + type,
      schema_version: SCHEMA_VERSION,
      event_id: eventId,
      activity_id: activityId || null,
    };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) msg[k] = extra[k];

    var promise = new Promise(function (resolve, reject) {
      pending[eventId] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          if (pending[eventId]) {
            delete pending[eventId];
            reject(new Error("EverLoop confirmation timed out for " + type));
          }
        }, CONFIRM_TIMEOUT_MS),
      };
    });

    if (ready || preview) sendNow(msg);
    else queued.push(msg); // fired before handshake — not dropped

    return promise;
  }

  // the host replies to every event with everloop:confirm (and sends resume once)
  function onPortMessage(ev) {
    var m = ev.data || {};
    if (m.type === "everloop:resume") {
      if (m.state) {
        if (m.state.student) snapshot.student = m.state.student;
        if (m.state.activities) snapshot.activities = m.state.activities;
        if (m.state.achievements) snapshot.achievements = m.state.achievements;
        if (typeof m.state.bucksEarnedHere === "number")
          snapshot.bucksEarnedHere = m.state.bucksEarnedHere;
      }
      markReady();
      emitUpdate();
      return;
    }
    if (m.type === "everloop:confirm") {
      applyConfirm(m);
      emitUpdate();
      var p = pending[m.event_id];
      if (!p) return; // confirm for an event we don't track (or already settled)
      if (m.status === "pending") return; // interim; wait for the terminal confirm
      clearTimeout(p.timer);
      delete pending[m.event_id];
      if (m.status === "rejected")
        p.reject(new Error(m.reject_reason || "EverLoop rejected the event"));
      else p.resolve(m); // accepted
      return;
    }
    // unknown message type over the port: ignore (forward-compat)
  }

  // ---- handshake ------------------------------------------------------------
  // The host posts ONE message carrying the transferred MessagePort. We accept the
  // first such message, trust its origin thereafter, and stop listening on window —
  // so nothing the app (or any other frame) posts to window can ever be mistaken
  // for the host.
  function onWindowInit(ev) {
    if (!ev.ports || !ev.ports.length) return;
    var m = ev.data || {};
    if (m.type !== "everloop:init") return;
    global.removeEventListener("message", onWindowInit);
    hostOrigin = ev.origin;
    port = ev.ports[0];
    port.onmessage = onPortMessage;
    // tell the host we're alive; it replies with `resume`
    port.postMessage({ type: "everloop:ready", schema_version: SCHEMA_VERSION });
  }

  function startPreviewIfIsolated() {
    if (port) return; // handshake already happened
    enterPreview(detectPreset());
  }

  function detectPreset() {
    try {
      var q = (global.location && global.location.search) || "";
      var m = /[?&]everloop_preview=(new|halfway|finished)/.exec(q);
      if (m) return m[1];
    } catch (e) {}
    return "new";
  }

  // ---- preview mode ---------------------------------------------------------
  function enterPreview(preset) {
    if (ready) return;
    preview = true;
    snapshot.student.displayName = "Preview Student";
    // The Edu dev may seed richer state via window.EVERLOOP_PREVIEW before load.
    var seed = global.EVERLOOP_PREVIEW;
    if (seed) {
      if (seed.activities) snapshot.activities = seed.activities;
      if (seed.achievements) snapshot.achievements = seed.achievements;
      if (seed.student) snapshot.student = seed.student;
    }
    console.info(
      "%c[EverLoop] PREVIEW MODE (" +
        preset +
        ") — events are logged, nothing is saved or paid.",
      "color:#b36b00;font-weight:bold",
    );
    markReady();
    emitUpdate();
  }

  // fabricate a plausible confirmation so the app's promises resolve locally
  function simulate(msg) {
    var type = msg.type.replace("everloop:", "");
    console.info("[EverLoop:preview] →", type, msg);
    var id = msg.activity_id;
    var rec = (id && snapshot.activities[id]) || { activity_id: id };
    if (type === "started") rec.status = "in_progress";
    if (type === "scored") {
      rec.status = "in_progress";
      rec.score = msg.score;
      rec.maxScore = msg.max_score;
      rec.bestScore = Math.max(rec.bestScore || 0, msg.score || 0);
    }
    if (type === "completed") {
      rec.status = "completed";
      if (msg.score != null) rec.score = msg.score;
    }
    if (type === "progress" && msg.save_slot != null) rec.saveSlot = msg.save_slot;
    if (id) snapshot.activities[id] = rec;

    var confirm = {
      type: "everloop:confirm",
      event_id: msg.event_id,
      status: "accepted",
      record: id ? Object.assign({ activity_id: id }, rec) : {},
      achievements_earned:
        type === "achievement"
          ? [{ achievement_id: msg.achievement_id, tier: msg.tier || null }]
          : [],
      bucks_paid: type === "reward" || type === "completed" ? 5 : 0,
    };
    // resolve asynchronously, like the real round-trip
    setTimeout(function () {
      onPortMessage({ data: confirm });
    }, 0);
  }

  // ---- public API -----------------------------------------------------------
  // `progress` is BOTH an event method and a read namespace (spec fidelity):
  //   EverLoop.progress(id, {saveSlot})  -> sends a checkpoint event
  //   EverLoop.progress.get(id) / .all() -> read restored progress
  function progress(activityId, opts) {
    opts = opts || {};
    var extra = {};
    if (opts.saveSlot !== undefined) extra.save_slot = opts.saveSlot;
    if (opts.progressPct !== undefined) extra.progress_pct = opts.progressPct;
    return emitEvent("progress", activityId, extra);
  }
  progress.get = function (id) {
    return snapshot.activities[id] ? clone(snapshot.activities[id]) : null;
  };
  progress.all = function () {
    return clone(snapshot.activities);
  };

  var EverLoop = {
    version: LIB_VERSION,
    schemaVersion: SCHEMA_VERSION,

    // --- events (each returns Promise<Confirm>) ---
    started: function (activityId) {
      return emitEvent("started", activityId);
    },
    progress: progress,
    scored: function (activityId, score, maxScore) {
      return emitEvent("scored", activityId, {
        score: score,
        max_score: maxScore,
      });
    },
    completed: function (activityId, opts) {
      opts = opts || {};
      var extra = {};
      if (opts.score !== undefined) extra.score = opts.score;
      if (opts.maxScore !== undefined) extra.max_score = opts.maxScore;
      return emitEvent("completed", activityId, extra);
    },
    achievement: function (achievementId, tier) {
      return emitEvent("achievement", null, {
        achievement_id: achievementId,
        tier: tier || null,
      });
    },
    // only *requests* a payout; the amount is decided by EverLoop and returned in the confirm
    reward: function (activityId) {
      return emitEvent("reward", activityId);
    },

    // --- reads (the app renders ONLY from these) ---
    achievements: {
      list: function () {
        return clone(snapshot.achievements);
      },
    },
    get student() {
      return { displayName: snapshot.student.displayName };
    },
    get bucksEarnedHere() {
      return snapshot.bucksEarnedHere;
    },

    // --- subscriptions / status ---
    onUpdate: function (cb) {
      if (typeof cb !== "function") return function () {};
      updateCbs.push(cb);
      if (ready) {
        try {
          cb(clone(snapshot));
        } catch (e) {}
      }
      return function off() {
        var i = updateCbs.indexOf(cb);
        if (i >= 0) updateCbs.splice(i, 1);
      };
    },
    onReady: function (cb) {
      if (typeof cb !== "function") return;
      if (ready) cb();
      else readyCbs.push(cb);
    },
    isReady: function () {
      return ready;
    },
    isPreview: function () {
      return preview;
    },
  };

  // ---- boot -----------------------------------------------------------------
  global.addEventListener("message", onWindowInit);
  // If nothing embeds us (opened directly) OR the host never handshakes, go to preview.
  var notInFrame = global.top === global.self;
  setTimeout(startPreviewIfIsolated, notInFrame ? 0 : HANDSHAKE_WAIT_MS);

  global.EverLoop = EverLoop;
  if (typeof module !== "undefined" && module.exports) module.exports = EverLoop;
})(typeof window !== "undefined" ? window : this);
