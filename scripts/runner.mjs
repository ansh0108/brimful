// Brimful task loop. Keeps continuing a Claude task across turns until it reports
// done, hits the limit again, or trips a safety cap. The deciding/looping is free;
// tokens are spent only inside each `claude` turn (the real work).

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { computeState, parseWhen } from "./lib.mjs";
import { LOG_PATH } from "./paths.mjs";

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* ignore */
  }
}

// Find a usage-limit reset time in Claude's output, e.g. "resets 11:30am".
export function parseLimitReset(text, now = new Date()) {
  if (!text) return null;
  const m = text.match(/resets?(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (!m) return null;
  return parseWhen(m[1], now);
}

function runOnce(cfg, cwd, args, dryRun) {
  const display = `${cfg.claudeBin} ${args
    .map((a) => (a.includes(" ") ? `"${a.slice(0, 60)}..."` : a))
    .join(" ")}  (cwd: ${cwd})`;
  if (dryRun) {
    log(`DRY-RUN would launch: ${display}`);
    return { dryRun: true, stdout: "", stderr: "" };
  }
  log(`launching: ${display}`);
  const res = spawnSync(cfg.claudeBin, args, {
    cwd,
    encoding: "utf8",
    timeout: (cfg.maxRunMinutes || 180) * 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) log(`launch error: ${res.error.message}`);
  if (res.stdout) {
    try {
      fs.appendFileSync(LOG_PATH, res.stdout + "\n");
    } catch {
      /* ignore */
    }
  }
  return res;
}

// opts: { cwd, prompt, label, firstUsesContinue }
// Returns { status, iterations, resetAt? }
//   done | limited | budget-stop | time-cap | stalled | max-iter | dry-run
export function runTaskLoop(cfg, opts, dryRun) {
  const sentinel = cfg.doneSentinel || "BRIMFUL_TASK_COMPLETE";
  const instr =
    `\n\nWork autonomously and do not ask me questions. Make as much progress as you ` +
    `can. When the task is fully complete and nothing remains, print exactly ` +
    `"${sentinel}" on its own line as your final output.`;
  const continueText = cfg.continuePrompt || "Continue the task exactly where you left off.";
  const maxIter = cfg.maxIterations || 12;
  const deadline = Date.now() + (cfg.maxRunMinutes || 180) * 60000;

  let lastSig = "";
  let stalls = 0;

  for (let i = 0; i < maxIter; i++) {
    const first = i === 0;
    const promptText = (first ? opts.prompt : continueText) + instr;
    // Resume continues the interrupted conversation from turn 1; drain starts fresh
    // then continues its own conversation on later turns.
    const args = first && !opts.firstUsesContinue ? ["-p", promptText] : ["-c", "-p", promptText];

    log(`[${opts.label}] turn ${i + 1}/${maxIter}`);
    const res = runOnce(cfg, opts.cwd, args, dryRun);
    if (dryRun) return { status: "dry-run", iterations: 0 };

    const out = `${res.stdout || ""}\n${res.stderr || ""}`;

    if (out.includes(sentinel)) return { status: "done", iterations: i + 1 };

    const resetAt = parseLimitReset(out);
    if (resetAt) return { status: "limited", resetAt, iterations: i + 1 };

    // Stop before overrunning the weekly budget.
    const s = computeState(cfg);
    if (s.usedPct != null && s.usedPct >= cfg.targetPct) {
      return { status: "budget-stop", iterations: i + 1 };
    }
    if (Date.now() > deadline) return { status: "time-cap", iterations: i + 1 };

    // No-progress guard: identical tail output twice means we are spinning.
    const sig = out.trim().slice(-400);
    if (sig && sig === lastSig) {
      if (++stalls >= (cfg.noProgressStalls || 2)) return { status: "stalled", iterations: i + 1 };
    } else {
      stalls = 0;
    }
    lastSig = sig;
  }
  return { status: "max-iter", iterations: maxIter };
}
