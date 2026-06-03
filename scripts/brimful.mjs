#!/usr/bin/env node
// Brimful meter + resume registration. Pure code, runs OUTSIDE the model,
// so every command here costs ZERO tokens / limit.
//
//   report              Week-to-date usage and pacing.
//   calibrate <pct>     Pin the weekly cap using the official % from `/usage`.
//   pace                One-line machine-readable signal (for the dispatcher).
//   config              Print resolved config.
//   resume add ...      Register an interrupted task to auto-continue at reset.
//   resume list         Show pending resume jobs.
//   resume clear        Remove all resume jobs.

import {
  loadConfig,
  saveConfig,
  mostRecentReset,
  sumWeek,
  computeState,
  loadQueue,
  saveQueue,
  parseWhen,
  readOfficialUsage,
  fmt,
  pct,
} from "./lib.mjs";

function cmdReport(cfg) {
  const s = computeState(cfg);
  console.log("Brimful weekly budget");
  console.log("=====================");
  console.log(`Week started:   ${s.weekStart.toLocaleString()}`);
  console.log(`Resets:         ${s.weekEnd.toLocaleString()}  (${s.daysLeft.toFixed(1)} days left)`);
  console.log(`Week elapsed:   ${pct(s.fracElapsed * 100)}`);
  console.log("");
  console.log(`Weighted usage: ${fmt(s.usage.weighted)} weighted tokens  (${s.usage.rows} API rows)`);
  console.log(
    `Raw tokens:     in ${fmt(s.usage.totals.input)} | out ${fmt(s.usage.totals.output)} | ` +
      `cacheW ${fmt(s.usage.totals.cacheCreation)} | cacheR ${fmt(s.usage.totals.cacheRead)}`
  );
  console.log("");
  if (s.usedPct == null) {
    console.log("No usage signal yet.");
    console.log("Set up the statusLine (see README) for automatic official numbers, or run:");
    console.log("  node scripts/brimful.mjs calibrate <pct>");
    return;
  }
  const ageStr = s.officialAgeMs != null ? ` (snapshot ${(s.officialAgeMs / 60000).toFixed(1)}m old)` : "";
  const srcLabel =
    {
      official: "official, live",
      "official+live": `official anchor + live delta${ageStr}`,
      estimate: "estimated (calibrated)",
      "official(stale)": `official, stale${ageStr}`,
    }[s.source] || s.source;
  console.log(`Source:         ${srcLabel}`);
  if (s.official && !s.official.stale && s.official.fiveHour) {
    const fh = s.official.fiveHour;
    const mins = fh.resetsAt ? Math.max(0, (fh.resetsAt - Date.now()) / 60000) : null;
    console.log(`Session (5h):   ${fh.pct ?? "?"}% used${mins != null ? `, resets in ${(mins / 60).toFixed(1)}h` : ""}`);
  }
  console.log(`Used:           ${pct(s.usedPct)} of weekly cap  (target ${cfg.targetPct}%)`);
  console.log(`Ideal by now:   ${pct(s.idealPct)}`);
  const under = s.deltaPct < 0;
  console.log(`Pace:           ${pct(Math.abs(s.deltaPct))} ${under ? "UNDER" : "over"} pace`);
  console.log("");
  if (under) {
    const remainingPct = cfg.targetPct - s.usedPct;
    const perDay = s.daysLeft > 0 ? remainingPct / s.daysLeft : remainingPct;
    console.log(`Headroom: about ${pct(remainingPct)} of weekly budget is on track to reset unused.`);
    console.log(`Suggested drain: ~${pct(perDay)} of weekly budget per day to reach target.`);
  } else {
    console.log("On or ahead of pace. No backlog draining needed right now.");
  }
}

function cmdCalibrate(cfg, pctStr) {
  const p = parseFloat(pctStr);
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    console.error("Usage: calibrate <pct>   (your weekly % from `/usage`, e.g. 17)");
    process.exit(1);
  }
  const now = new Date();
  const weekStart = mostRecentReset(now, cfg.resetDayOfWeek, cfg.resetHour);
  const usage = sumWeek(weekStart.getTime(), cfg.weights);
  if (usage.weighted <= 0) {
    console.error("No usage rows for this week yet. Use Claude Code a bit, then calibrate.");
    process.exit(1);
  }
  cfg.capWeightedTokens = Math.round(usage.weighted / (p / 100));
  cfg.calibratedAt = now.toISOString();
  cfg.calibratedAtPct = p;
  saveConfig(cfg);
  console.log(`Calibrated. At ${p}% you have used ${fmt(usage.weighted)} weighted tokens.`);
  console.log(`Estimated weekly cap: ${fmt(cfg.capWeightedTokens)} weighted tokens.`);
}

function cmdPace(cfg) {
  const s = computeState(cfg);
  if (s.usedPct == null) {
    console.log("status=uncalibrated");
    return;
  }
  const action = s.deltaPct < 0 && s.usedPct < cfg.targetPct ? "drain" : "hold";
  console.log(
    `status=ok action=${action} used=${s.usedPct.toFixed(1)} ideal=${s.idealPct.toFixed(1)} ` +
      `delta=${s.deltaPct.toFixed(1)} daysleft=${s.daysLeft.toFixed(2)} idlemin=${s.idleMinutes.toFixed(1)}`
  );
}

function cmdResume(cfg, args) {
  const action = args[0];
  const q = loadQueue();
  if (action === "list") {
    if (!q.length) return console.log("No resume jobs queued.");
    for (const j of q) {
      console.log(`[${j.status}] ${new Date(j.resumeAfter).toLocaleString()}  ${j.dir}`);
      console.log(`        prompt: ${j.prompt}`);
    }
    return;
  }
  if (action === "clear") {
    saveQueue([]);
    return console.log("Resume queue cleared.");
  }
  if (action === "add") {
    const opts = parseFlags(args.slice(1));
    const dir = opts.dir || process.cwd();
    // Default to the official 5-hour reset from the statusLine cache, so you can
    // just run `resume add` with no time after being cut off.
    let after = opts.after ? parseWhen(opts.after) : null;
    if (!after) {
      const official = readOfficialUsage();
      if (official?.fiveHour?.resetsAt) {
        after = official.fiveHour.resetsAt;
        console.log(`Using official 5-hour reset: ${new Date(after).toLocaleString()}`);
      }
    }
    if (!after) {
      console.error('resume add [--dir <path>] [--after "<11:30am | +5h | ISO>"] [--prompt "..."]');
      console.error("No --after given and no official 5h reset cached. Pass --after.");
      process.exit(1);
    }
    const job = {
      id: `r${Date.now()}`,
      dir,
      prompt: opts.prompt || "Continue the task you were working on before the usage limit interrupted you.",
      resumeAfter: new Date(after).toISOString(),
      registeredAt: new Date().toISOString(),
      status: "pending",
    };
    q.push(job);
    saveQueue(q);
    console.log(`Resume queued for ${new Date(after).toLocaleString()} in ${dir}.`);
    console.log("The dispatcher will continue it for free once the window reopens.");
    return;
  }
  console.error("Usage: resume add|list|clear");
  process.exit(1);
}

function parseFlags(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].startsWith("--")) {
      const key = arr[i].slice(2);
      out[key] = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[++i] : true;
    }
  }
  return out;
}

const [, , sub, ...rest] = process.argv;
const cfg = loadConfig();
switch (sub) {
  case "calibrate":
    cmdCalibrate(cfg, rest[0]);
    break;
  case "pace":
    cmdPace(cfg);
    break;
  case "config":
    console.log(JSON.stringify(cfg, null, 2));
    break;
  case "status": {
    const o = readOfficialUsage();
    if (!o) {
      console.log("No official usage cached yet. Set up the statusLine (see README).");
    } else {
      console.log(JSON.stringify(o, null, 2));
    }
    break;
  }
  case "resume":
    cmdResume(cfg, rest);
    break;
  case "report":
  case undefined:
    cmdReport(cfg);
    break;
  default:
    console.error(`Unknown command: ${sub}`);
    console.error("Use: report | calibrate <pct> | pace | config | resume");
    process.exit(1);
}
