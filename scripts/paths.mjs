// Brimful path resolution. Separates CODE (the plugin dir, replaceable on update)
// from STATE (user config/backlog/queue/logs, persistent across updates).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();

// Plugin code root (this file lives in <root>/scripts).
export const PLUGIN_DIR = path.resolve(new URL("..", import.meta.url).pathname);

// Persistent user state. Override with BRIMFUL_HOME for tests or custom setups.
export const DATA_DIR = process.env.BRIMFUL_HOME || path.join(HOME, ".brimful");

export function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}
ensureDataDir();

export const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const QUEUE_PATH = path.join(DATA_DIR, "resume-queue.json");
export const BACKLOG_PATH = path.join(DATA_DIR, "backlog.md");
export const USAGE_CACHE_PATH = path.join(DATA_DIR, "usage.json");
export const DONE_LOG_PATH = path.join(DATA_DIR, "done.log");
export const ROUTINES_DIR = path.join(DATA_DIR, "routines");
export const LOG_PATH = path.join(DATA_DIR, "dispatch.log");
export const LOCK_PATH = path.join(DATA_DIR, ".dispatch.lock");
export const PAUSE_PATH = path.join(DATA_DIR, ".brimful-pause");
