// Brimful shared library. Pure code, no model, zero tokens.
// Used by both the meter (brimful.mjs) and the dispatcher (dispatch.mjs).

import fs from "node:fs";
import path from "node:path";
import {
  HOME,
  PLUGIN_DIR,
  DATA_DIR,
  PROJECTS_DIR,
  CONFIG_PATH,
  QUEUE_PATH,
  BACKLOG_PATH,
  USAGE_CACHE_PATH,
  DONE_LOG_PATH,
} from "./paths.mjs";

export { HOME, PLUGIN_DIR, DATA_DIR, PROJECTS_DIR, CONFIG_PATH, QUEUE_PATH, BACKLOG_PATH, USAGE_CACHE_PATH };

const BACKLOG_TEMPLATE = `# Brimful backlog

Deferrable, genuinely useful work to drain into otherwise-wasted weekly budget.
Only real work belongs here. Empty backlog is fine; let the budget reset.

Format: - [priority] description @/optional/repo (S/M/L)

## Tasks
`;

export const DEFAULT_CONFIG = {
  resetDayOfWeek: 4, // 0=Sun .. 6=Sat. Thursday = 4.
  resetHour: 9,
  targetPct: 85,
  capWeightedTokens: null,
  calibratedAt: null,
  calibratedAtPct: null,
  // Dispatcher guardrails.
  idleMinutes: 15, // Skip backlog drain if you used Claude in the last N minutes.
  claudeBin: "claude", // Override if `claude` is not on PATH.
  defaultWorkdir: HOME, // Where a backlog task runs if it names no @dir.
  // How recent the official snapshot must be to use as a live anchor (6h).
  officialAnchorMaxMs: 6 * 3600 * 1000,
  // Resume/drain loop controls.
  maxIterations: 12, // Hard cap on continue-turns per task.
  maxRunMinutes: 180, // Wall-clock cap per task loop.
  noProgressStalls: 2, // Stop after this many identical no-progress turns.
  doneSentinel: "BRIMFUL_TASK_COMPLETE", // Token Claude prints when finished.
  continuePrompt: "Continue the task exactly where you left off.",
  weights: { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 },
};

export function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cfg = { ...cfg, ...raw, weights: { ...DEFAULT_CONFIG.weights, ...(raw.weights || {}) } };
  } catch {
    /* defaults */
  }
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function mostRecentReset(now, dow, hour) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  const diff = (d.getDay() - dow + 7) % 7;
  d.setDate(d.getDate() - diff);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

function listRecentJsonl(sinceMs) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const projDir = path.join(PROJECTS_DIR, ent.name);
    let files = [];
    try {
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(projDir, f);
      try {
        if (fs.statSync(fp).mtimeMs >= sinceMs) out.push(fp);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function extractUsage(obj) {
  return obj?.message?.usage || obj?.usage || null;
}

export function sumWeek(weekStartMs, weights) {
  const files = listRecentJsonl(weekStartMs);
  const seen = new Set();
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let rows = 0;
  let lastActivityMs = 0;

  for (const fp of files) {
    let content;
    try {
      content = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line || line[0] !== "{") continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < weekStartMs) continue;
      const usage = extractUsage(obj);
      if (!usage) continue;
      const key = `${obj.requestId || ""}:${obj?.message?.id || ""}`;
      if (key !== ":" && seen.has(key)) continue;
      if (key !== ":") seen.add(key);
      totals.input += usage.input_tokens || 0;
      totals.output += usage.output_tokens || 0;
      totals.cacheCreation += usage.cache_creation_input_tokens || 0;
      totals.cacheRead += usage.cache_read_input_tokens || 0;
      if (ts > lastActivityMs) lastActivityMs = ts;
      rows++;
    }
  }

  const weighted =
    totals.input * weights.input +
    totals.output * weights.output +
    totals.cacheCreation * weights.cacheCreation +
    totals.cacheRead * weights.cacheRead;
  const raw = totals.input + totals.output + totals.cacheCreation + totals.cacheRead;
  return { totals, weighted, raw, rows, lastActivityMs };
}

// ---- Official usage (from the statusLine cache) ----

// Read the cache the statusLine handler writes. `maxAgeMs` guards staleness;
// between sessions the numbers stop updating, so callers decide how fresh is OK.
export function readOfficialUsage(maxAgeMs = 12 * 3600 * 1000) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
  const capturedMs = Date.parse(data.capturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  data.capturedMs = capturedMs;
  data.stale = Date.now() - capturedMs > maxAgeMs;
  return data;
}

// Derive resetDayOfWeek/resetHour from the official weekly reset timestamp, and
// auto-calibrate the cap from the official weekly %. Mutates and persists cfg
// only when something actually changes. Returns what was applied.
export function applyOfficial(cfg) {
  const official = readOfficialUsage();
  if (!official) return { applied: false, reason: "no-official-data" };
  let changed = false;
  const applied = {};

  // Derive the reset schedule, but ONLY from a sane future timestamp (0-8 days
  // ahead). This rejects malformed resets_at values (statusLine bug #52326, or
  // seconds-vs-ms mistakes), which would otherwise corrupt the schedule.
  const aheadMs = official.sevenDay?.resetsAt ? official.sevenDay.resetsAt - Date.now() : null;
  if (aheadMs != null && aheadMs > 0 && aheadMs < 8 * 86400000) {
    const d = new Date(official.sevenDay.resetsAt);
    if (d.getDay() !== cfg.resetDayOfWeek) {
      cfg.resetDayOfWeek = d.getDay();
      changed = true;
    }
    if (d.getHours() !== cfg.resetHour) {
      cfg.resetHour = d.getHours();
      changed = true;
    }
    applied.resetDayOfWeek = cfg.resetDayOfWeek;
    applied.resetHour = cfg.resetHour;
  }

  // Auto-calibrate the cap from the official weekly %. Guard against junk: need a
  // meaningful % (>= 5) and a plausible resulting cap (>= 10M weighted), so a
  // reset-boundary or buggy reading cannot collapse the cap.
  const CAP_FLOOR = 10_000_000;
  if (!official.stale && official.sevenDay?.pct != null && official.sevenDay.pct >= 5) {
    const weekStart = mostRecentReset(new Date(), cfg.resetDayOfWeek, cfg.resetHour);
    const usage = sumWeek(weekStart.getTime(), cfg.weights);
    if (usage.weighted > 0) {
      const cap = Math.round(usage.weighted / (official.sevenDay.pct / 100));
      const prev = cfg.capWeightedTokens || 0;
      if (cap >= CAP_FLOOR && (!prev || Math.abs(cap - prev) / prev > 0.02)) {
        cfg.capWeightedTokens = cap;
        cfg.calibratedAt = new Date().toISOString();
        cfg.calibratedAtPct = official.sevenDay.pct;
        cfg.calibratedFrom = "official";
        changed = true;
      }
      applied.capWeightedTokens = cfg.capWeightedTokens;
    }
  }

  if (changed) saveConfig(cfg);
  return { applied: true, changed, ...applied };
}

export function computeState(cfg) {
  // Pull in official numbers first so the schedule and cap are current.
  applyOfficial(cfg);
  const official = readOfficialUsage();

  const now = new Date();
  const weekStart = mostRecentReset(now, cfg.resetDayOfWeek, cfg.resetHour);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const elapsed = now.getTime() - weekStart.getTime();
  const span = weekEnd.getTime() - weekStart.getTime();
  const fracElapsed = Math.min(1, Math.max(0, elapsed / span));
  const daysLeft = Math.max(0, (weekEnd.getTime() - now.getTime()) / 86400000);
  const usage = sumWeek(weekStart.getTime(), cfg.weights);

  // Freshest possible weekly %: take the official snapshot as an anchor, then add
  // the weighted tokens logged SINCE that snapshot (live from disk). This stays
  // current even when the statusLine cache is a few minutes old.
  const cap = cfg.capWeightedTokens;
  const estimatePct = cap ? (usage.weighted / cap) * 100 : null;
  let usedPct = null;
  let source = "none";
  let officialAgeMs = null;

  if (official?.sevenDay?.pct != null && cap) {
    officialAgeMs = Date.now() - official.capturedMs;
    if (officialAgeMs <= (cfg.officialAnchorMaxMs ?? 6 * 3600 * 1000)) {
      const deltaWeighted = sumWeek(official.capturedMs, cfg.weights).weighted;
      usedPct = official.sevenDay.pct + (deltaWeighted / cap) * 100;
      source = officialAgeMs <= 60000 ? "official" : "official+live";
    }
  }
  if (usedPct == null && estimatePct != null) {
    usedPct = estimatePct;
    source = "estimate";
  }
  if (usedPct == null && official?.sevenDay?.pct != null) {
    usedPct = official.sevenDay.pct;
    source = "official(stale)";
  }

  let idealPct = null;
  let deltaPct = null;
  if (usedPct != null) {
    idealPct = fracElapsed * cfg.targetPct;
    deltaPct = usedPct - idealPct;
  }
  const idleMinutes = usage.lastActivityMs ? (now.getTime() - usage.lastActivityMs) / 60000 : Infinity;
  return {
    now,
    weekStart,
    weekEnd,
    fracElapsed,
    daysLeft,
    usage,
    usedPct,
    idealPct,
    deltaPct,
    idleMinutes,
    source,
    officialAgeMs,
    official,
  };
}

// ---- Resume queue ----

export function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  } catch {
    return [];
  }
}

export function saveQueue(q) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + "\n");
}

// Parse a "when" string into an epoch ms. Supports ISO, "+Nh", "+Nm",
// and clock times like "11:30am" (next occurrence).
export function parseWhen(s, now = new Date()) {
  if (!s) return null;
  const str = String(s).trim();
  const rel = str.match(/^\+(\d+)\s*([hm])$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const mult = rel[2].toLowerCase() === "h" ? 3600000 : 60000;
    return now.getTime() + n * mult;
  }
  // Clock time: minutes optional ("9pm", "11:30am", "9:00"). Require minutes or
  // am/pm so a bare integer is not misread as a time.
  const clock = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let hh = parseInt(clock[1], 10);
    const mm = clock[2] ? parseInt(clock[2], 10) : 0;
    const ap = clock[3]?.toLowerCase();
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const iso = Date.parse(str);
  return Number.isFinite(iso) ? iso : null;
}

// ---- Completion tracking ----

function doneKey(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isDone(text) {
  try {
    const set = new Set(
      fs.readFileSync(DONE_LOG_PATH, "utf8").split("\n").map((l) => l.replace(/^\d+\t/, "").trim())
    );
    return set.has(doneKey(text));
  } catch {
    return false;
  }
}

export function markDone(text) {
  try {
    fs.appendFileSync(DONE_LOG_PATH, `${Date.now()}\t${doneKey(text)}\n`);
  } catch {
    /* ignore */
  }
}

// ---- Backlog ----

// Lines like: `- [1] Do the thing @/path/to/repo (M)`
export function readBacklog() {
  let text;
  try {
    text = fs.readFileSync(BACKLOG_PATH, "utf8");
  } catch {
    try {
      fs.writeFileSync(BACKLOG_PATH, BACKLOG_TEMPLATE); // seed on first use
    } catch {
      /* ignore */
    }
    return [];
  }
  const items = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s*\[(\d+)\]\s*(.+)$/);
    if (!m) continue;
    let body = m[2].trim();
    if (/\(example\)/i.test(body)) continue; // skip template placeholders
    let dir = null;
    const dm = body.match(/@(\S+)/);
    if (dm) {
      dir = dm[1].replace(/^~(?=\/|$)/, HOME);
      body = body.replace(/@\S+/, "").trim();
    }
    if (isDone(body)) continue; // already completed in a prior run
    items.push({ priority: parseInt(m[1], 10), text: body, dir });
  }
  items.sort((a, b) => a.priority - b.priority);
  return items;
}

export const fmt = (n) => Math.round(n).toLocaleString("en-US");
export const pct = (n) => `${Number(n).toFixed(1)}%`;
