#!/usr/bin/env node
// Idempotently wire Brimful's statusLine into ~/.claude/settings.json.
// Backs up once, skips if already pointing at Brimful. Zero tokens.

import fs from "node:fs";
import path from "node:path";
import { HOME, PLUGIN_DIR } from "./paths.mjs";

const SETTINGS = path.join(HOME, ".claude", "settings.json");
const BACKUP = SETTINGS + ".brimful-bak";
const cmd = `node ${path.join(PLUGIN_DIR, "scripts", "statusline.mjs")}`;

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
} catch {
  /* will create */
}

const current = settings.statusLine?.command || "";
if (current.includes("brimful") && current.includes("statusline")) {
  console.log("statusLine already wired to Brimful. Nothing to do.");
  process.exit(0);
}

if (settings.statusLine && !fs.existsSync(BACKUP)) {
  console.log(`Existing statusLine found. Backing up to ${BACKUP}.`);
}
if (!fs.existsSync(BACKUP)) {
  try {
    fs.copyFileSync(SETTINGS, BACKUP);
  } catch {
    /* no existing settings to back up */
  }
}

settings.statusLine = { type: "command", command: cmd, padding: 0 };
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(`Wired statusLine: ${cmd}`);
console.log("Restart Claude Code (or wait for the next status paint) to start capturing.");
