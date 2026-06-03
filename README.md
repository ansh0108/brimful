# Brimful

**Stop wasting your weekly Claude limit. Fill it with your own work, and never lose a task to a limit again.**

Most weeks you do not use your full Claude allowance. It resets and the unused part is gone. Other times a limit cuts off a task mid-way and you have to babysit the restart. Brimful fixes both, running entirely on your own limit with effectively zero overhead.

- **Fill idle budget** - when you are under pace and idle, Brimful drains a backlog of your real, deferrable work into the budget that would otherwise reset unused.
- **Auto-resume** - if a usage limit interrupts a task, Brimful continues it automatically the moment your window reopens. No manual restart.
- **Zero token overhead** - all the watching, measuring, and scheduling runs as plain scripts outside the model. Tokens are spent only on real work.

---

## How it works

Brimful reads the usage numbers Claude Code already exposes (the same ones behind `/usage`) and your local session logs. From those it knows, for free:

- how much of your weekly limit you have used,
- how fast you are pacing toward the reset,
- when your 5-hour and weekly windows reset.

A small scheduler checks this on a timer. When it makes sense, it launches a real Claude task. When it does not, it does nothing. That is the whole idea.

---

## Requirements

- **Claude Code** v2.1.80 or newer
- A **Claude Pro or Max** subscription (official usage numbers are not exposed for API-key auth)
- **Node.js** 18+

---

## Install

```bash
git clone https://github.com/ansh0108/brimful.git
cd brimful
./install.sh --with-cron
```

That command:

1. creates your state dir at `~/.brimful`,
2. wires Brimful's status line (backing up your settings first),
3. schedules the background dispatcher every 30 minutes.

Then **restart Claude Code** so the status line starts capturing your official usage numbers.

> Your data (config, backlog, logs) lives in `~/.brimful`, separate from the code, so updates never wipe it.

---

## Use it

### 1. Check your pacing anytime

```bash
node scripts/brimful.mjs report
```

Shows usage this week, how far under or over pace you are, and how much budget is on track to reset unused.

Prefer a slash command? Drop this into `~/.claude/commands/budget.md`:

```md
---
description: Show this week's Claude usage pacing (Brimful).
allowed-tools: Bash(node:*)
---
Show the output verbatim.

!`node /absolute/path/to/brimful/scripts/brimful.mjs report`
```

Then just type `/budget` in Claude Code.

### 2. Add work to your backlog

Edit `~/.brimful/backlog.md`. One task per line:

```
- [1] Update README and codemaps @/Users/you/projects/my-app (M)
- [2] Add unit tests for the auth module @/Users/you/projects/api (L)
```

- lower priority number runs first
- `@/path` is the repo the task runs in
- only put **real, deferrable** work here; an empty backlog is fine

When you are idle and under pace, the dispatcher picks the top item and works it to completion.

### 3. Auto-resume an interrupted task

If a limit stops you mid-task, register it (it auto-uses your official 5-hour reset time):

```bash
node scripts/brimful.mjs resume add --dir "$(pwd)"
```

The dispatcher continues it when your window reopens. Launching long tasks with `bin/brimful-run.sh -p "..."` registers them automatically.

---

## Commands

| Command | What it does |
| --- | --- |
| `brimful.mjs report` | Usage and pacing for the week |
| `brimful.mjs status` | Raw official numbers from the status line |
| `brimful.mjs calibrate <pct>` | Manual cap calibration (fallback only) |
| `brimful.mjs resume add --dir <path>` | Queue an interrupted task to auto-resume |
| `brimful.mjs resume list` / `clear` | Manage the resume queue |
| `dispatch.mjs tick --dry-run` | See what the scheduler would do, free |
| `dispatch.mjs watch [secs]` | Run the scheduler in the foreground |

---

## Safety

Brimful is conservative by design:

- **Idle check** - never competes with you; it pauses while you are actively working.
- **Hard stop** - stops at 85% of your weekly limit so automation cannot lock you out.
- **Pause switch** - `touch ~/.brimful/.brimful-pause` halts everything (`rm` to resume).
- **Caps** - every task loop has iteration, time, and no-progress limits.

---

## Configuration

Everything is in `~/.brimful/config.json`. Useful keys:

| Key | Meaning | Default |
| --- | --- | --- |
| `targetPct` | How full to aim for (stays below 100) | `85` |
| `idleMinutes` | Minutes of quiet before draining backlog | `15` |
| `maxIterations` | Continue-turns per task | `12` |
| `maxRunMinutes` | Wall-clock cap per task | `180` |

Reset day, hour, and the usage cap are detected automatically from your official numbers.

---

## How it stays free

The meter and scheduler are plain Node, run by cron and the status line, never by the model. They read files and do arithmetic. The only time Brimful spends your limit is when it launches a real task you wanted done. So it can only ever convert waste into work, never the reverse.

---

## Uninstall

```bash
rm -rf ~/.brimful
cp ~/.claude/settings.json.brimful-bak ~/.claude/settings.json   # restore status line
crontab -e   # remove the brimful line
```

---

## License

MIT
