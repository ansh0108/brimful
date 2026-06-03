#!/usr/bin/env node
// Brimful statusLine handler. Claude Code pipes a JSON payload to this on stdin
// after each response. We capture the OFFICIAL rate-limit numbers to a cache file
// and print a compact status line. This runs as a command, not the model, so it
// costs ZERO tokens.
//
// Source: rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}
// (Claude Code >= 2.1.80, Pro/Max only, appears after the first response.)

import fs from "node:fs";
import { USAGE_CACHE_PATH as CACHE_PATH } from "./paths.mjs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Reject the known bug where used_percentage arrives as an epoch timestamp.
function validPct(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

function window(obj) {
  if (!obj) return null;
  const pct = validPct(obj.used_percentage);
  const resetsAt = Number.isFinite(obj.resets_at) ? obj.resets_at * 1000 : null;
  if (pct == null && resetsAt == null) return null;
  return { pct, resetsAt };
}

function writeCache(data) {
  try {
    const tmp = CACHE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CACHE_PATH);
  } catch {
    /* best effort */
  }
}

function countdown(ms) {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const h = diff / 3600000;
  if (h >= 24) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(diff / 60000)}m`;
}

const raw = readStdin();
let input = {};
try {
  input = JSON.parse(raw);
} catch {
  /* may be empty on first paint */
}

const rl = input.rate_limits || {};
const fiveHour = window(rl.five_hour);
const sevenDay = window(rl.seven_day);
const ctx = validPct(input?.context_window?.used_percentage);
const model = input?.model?.display_name || input?.model?.id || "claude";

// Persist official numbers if we got any this paint.
if (fiveHour || sevenDay) {
  writeCache({
    capturedAt: new Date().toISOString(),
    fiveHour,
    sevenDay,
    contextPct: ctx,
    costUsd: input?.cost?.total_cost_usd ?? null,
  });
}

// Compose a compact status line.
const parts = [];
if (sevenDay) parts.push(`wk ${sevenDay.pct ?? "?"}%${sevenDay.resetsAt ? ` ↺${countdown(sevenDay.resetsAt)}` : ""}`);
if (fiveHour) parts.push(`5h ${fiveHour.pct ?? "?"}%${fiveHour.resetsAt ? ` ↺${countdown(fiveHour.resetsAt)}` : ""}`);
if (ctx != null) parts.push(`ctx ${ctx}%`);
parts.push(model);
process.stdout.write("◫ " + parts.join(" · "));
