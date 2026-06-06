#!/usr/bin/env node
// Brimful routine runner. Runs a named, GUARANTEED task via cron at a set time,
// headless, whether or not Claude Code is open. Unlike backlog drain, a routine
// is not gated on pace/idle/quiet-hours - if you scheduled it, it runs.
//
//   node routine.mjs <name> [--dry-run]
//
// Reads ~/.brimful/routines/<name>.json  ->  { "prompt": "...", "dir": "..." }

import fs from "node:fs";
import path from "node:path";
import { ROUTINES_DIR } from "./paths.mjs";
import { loadConfig } from "./lib.mjs";
import { runTaskLoop, log } from "./runner.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const name = args.find((a) => !a.startsWith("--"));

if (!name) {
  console.error("Usage: routine.mjs <name> [--dry-run]");
  process.exit(1);
}

const file = path.join(ROUTINES_DIR, `${name}.json`);
let routine;
try {
  routine = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error(`No routine at ${file}`);
  process.exit(1);
}

const cfg = loadConfig();
const cwd = routine.dir || cfg.defaultWorkdir;
if (!fs.existsSync(cwd)) {
  log(`routine:${name} skipped, dir missing: ${cwd}`);
  process.exit(1);
}

log(`routine:${name} starting in ${cwd}`);
const res = runTaskLoop(cfg, { cwd, prompt: routine.prompt, label: `routine:${name}`, firstUsesContinue: false }, dryRun);
log(`routine:${name} -> ${res.status} after ${res.iterations ?? 0} turn(s)`);
