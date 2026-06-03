#!/usr/bin/env node
// Brimful dispatcher. Watching/deciding is pure code and costs ZERO tokens; limit
// is spent only inside the task loop (the real work).
//
//   tick            One decision cycle: act once, then exit. Use from cron.
//   watch [secs]    Loop tick every N seconds (default 900). Use from launchd/tmux.
//
// Flags:
//   --dry-run       Decide and print, but never launch claude. Always free.
//
// Each tick: 1) resume a due interrupted task, else 2) drain the top backlog item
// when under pace and idle, else 3) hold. Tasks now loop to completion and survive
// fresh limit hits by re-queuing themselves for the next window.

import fs from "node:fs";
import { LOCK_PATH, PAUSE_PATH } from "./paths.mjs";
import { loadConfig, computeState, loadQueue, saveQueue, readBacklog, markDone } from "./lib.mjs";
import { runTaskLoop, log } from "./runner.mjs";

const LOCK_STALE_MS = 6 * 3600 * 1000;

function acquireLock() {
  try {
    const st = fs.statSync(LOCK_PATH);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    /* no lock */
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

function queueResume(q, dir, prompt, resumeAfterMs) {
  q.push({
    id: `r${Date.now()}`,
    dir,
    prompt,
    resumeAfter: new Date(resumeAfterMs).toISOString(),
    registeredAt: new Date().toISOString(),
    status: "pending",
  });
}

function applyResumeOutcome(cfg, due, res, q) {
  switch (res.status) {
    case "done":
      due.status = "done";
      due.ranAt = new Date().toISOString();
      log(`resume done after ${res.iterations} turn(s): ${due.dir}`);
      break;
    case "limited": {
      due.status = "continued:next-window";
      queueResume(q, due.dir, cfg.continuePrompt, res.resetAt);
      log(`resume hit limit again; re-queued for ${new Date(res.resetAt).toLocaleString()}.`);
      break;
    }
    case "budget-stop": {
      const weekEnd = computeState(cfg).weekEnd.getTime();
      due.status = "pending";
      due.resumeAfter = new Date(weekEnd).toISOString();
      log(`resume paused at budget cap; deferred to weekly reset ${new Date(weekEnd).toLocaleString()}.`);
      break;
    }
    default:
      due.status = `paused:${res.status}`;
      log(`resume paused (${res.status}) after ${res.iterations} turn(s). Needs manual review.`);
  }
}

function tryResume(cfg, dryRun) {
  const q = loadQueue();
  const now = Date.now();
  const due = q
    .filter((j) => j.status === "pending" && Date.parse(j.resumeAfter) <= now)
    .sort((a, b) => Date.parse(a.resumeAfter) - Date.parse(b.resumeAfter))[0];
  if (!due) return false;

  if (!fs.existsSync(due.dir)) {
    log(`resume skipped, dir missing: ${due.dir}`);
    due.status = "error:dir-missing";
    saveQueue(q);
    return true;
  }
  log(`resume due: ${due.dir}`);
  const res = runTaskLoop(cfg, { cwd: due.dir, prompt: due.prompt, label: "resume", firstUsesContinue: true }, dryRun);
  if (dryRun) return true;
  applyResumeOutcome(cfg, due, res, q);
  saveQueue(q);
  return true;
}

function tryDrain(cfg, dryRun) {
  const s = computeState(cfg);
  if (s.usedPct == null) return log("drain skipped: not calibrated."), false;
  if (s.usedPct >= cfg.targetPct) return log(`drain skipped: at ${s.usedPct.toFixed(1)}% >= target ${cfg.targetPct}%.`), false;
  if (s.deltaPct >= 0) return log(`drain skipped: on pace (delta ${s.deltaPct.toFixed(1)}%).`), false;
  if (s.idleMinutes < cfg.idleMinutes) return log(`drain skipped: active ${s.idleMinutes.toFixed(1)}m ago.`), false;

  const backlog = readBacklog();
  if (!backlog.length) return log("drain skipped: backlog empty (good problem)."), false;

  const item = backlog[0];
  const cwd = item.dir || cfg.defaultWorkdir;
  if (!fs.existsSync(cwd)) return log(`drain skipped: workdir missing: ${cwd}`), false;

  log(`draining backlog [p${item.priority}]: ${item.text}`);
  const res = runTaskLoop(cfg, { cwd, prompt: item.text, label: "drain", firstUsesContinue: false }, dryRun);
  if (dryRun) return true;

  if (res.status === "done") {
    markDone(item.text);
    log(`backlog item complete after ${res.iterations} turn(s): ${item.text}`);
  } else if (res.status === "limited") {
    const q = loadQueue();
    queueResume(q, cwd, `Continue this backlog task: ${item.text}`, res.resetAt);
    saveQueue(q);
    log(`backlog item hit limit; queued to continue at ${new Date(res.resetAt).toLocaleString()}.`);
  } else {
    log(`backlog item stopped (${res.status}); left in backlog for a later tick.`);
  }
  return true;
}

function tick(cfg, dryRun) {
  if (fs.existsSync(PAUSE_PATH)) return log("paused (.brimful-pause present). Holding.");
  if (!acquireLock()) return log("another dispatch holds the lock. Skipping.");
  try {
    if (tryResume(cfg, dryRun)) return;
    if (tryDrain(cfg, dryRun)) return;
    log("hold: nothing to do.");
  } finally {
    releaseLock();
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mode = args.find((a) => !a.startsWith("--")) || "tick";
const cfg = loadConfig();

if (mode === "watch") {
  const secs = parseInt(args.find((a) => /^\d+$/.test(a)) || "900", 10);
  log(`watch every ${secs}s${dryRun ? " (dry-run)" : ""}.`);
  const loop = () => {
    try {
      tick(cfg, dryRun);
    } catch (e) {
      log(`tick error: ${e.message}`);
    }
  };
  loop();
  setInterval(loop, secs * 1000);
} else if (mode === "tick") {
  tick(cfg, dryRun);
} else {
  console.error("Usage: dispatch tick|watch [secs] [--dry-run]");
  process.exit(1);
}
