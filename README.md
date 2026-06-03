# Brimful

Fill idle weekly Claude usage with your own backlog work, so nothing resets unused.

Most usage tools only *tell* you that you wasted budget. Brimful is built to *spend*
that idle budget on a backlog of real work you wanted done anyway. It runs fully
local, on your own Claude limit, with no external API and no hosted backend.

## Zero-overhead by design

The meter is plain Node, run outside the model, so it costs **zero tokens**. The
model is only ever invoked to do actual backlog work, never to watch the gauge.

## Install

### One command

```bash
./install.sh            # or: ./install.sh --with-cron
```

This creates the state dir `~/.brimful`, seeds your config and backlog, wires the
statusLine (backing up your settings first), and prints how to schedule the
dispatcher. Re-runnable and safe.

State (config, backlog, queue, logs) lives in `~/.brimful`, separate from the plugin
code, so plugin updates never wipe your data. Override the location with
`BRIMFUL_HOME`.

### As a Claude Code plugin (for the `/budget` command)

```
/plugin marketplace add <your-repo-url>
/plugin install brimful
```

Then run `./install.sh` once to wire the statusLine and state dir.

## Official numbers (recommended, automatic)

Claude Code (>= 2.1.80, Pro/Max) feeds the statusLine command an official
`rate_limits` object with `five_hour` and `seven_day` percentages and reset times.
Brimful captures these for free and uses them as the source of truth.

Wire it once in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/brimful/scripts/statusline.mjs",
    "padding": 0
  }
}
```

After that, Brimful auto-derives your reset day/hour and auto-calibrates the cap from
the official weekly %. No manual steps. It also gets the exact 5-hour reset time, so
`resume add` needs no `--after`. Check it with `node scripts/brimful.mjs status`.

Notes: the data appears only after the first response in a session and only for
subscriber auth (not API keys). Between sessions the cache goes stale and Brimful
falls back to its calibrated estimate.

## Manual calibration (fallback)

If you cannot use the statusLine, calibrate once from `/usage`:

1. Run `/usage`, read the weekly % for "All models".
2. `node scripts/brimful.mjs calibrate <pct>`   (e.g. `calibrate 17`)

Brimful divides your week-to-date weighted tokens by that percentage to estimate the
cap. Re-run any week it drifts; it self-corrects.

## Commands

| Command | What it does | Tokens |
| --- | --- | --- |
| `report` | Week-to-date usage, pace vs target, wasted-budget headroom | 0 |
| `calibrate <pct>` | Pin the weekly cap from your `/usage` % | 0 |
| `pace` | One-line machine-readable signal for schedulers | 0 |
| `config` | Print resolved config | 0 |

## Config (`config.json`)

| Key | Meaning |
| --- | --- |
| `resetDayOfWeek` | 0=Sun .. 6=Sat. Your weekly reset day (read from `/usage`). |
| `resetHour` | Local hour of reset. |
| `targetPct` | How full to aim for. Stays below 100 for safety. |
| `capWeightedTokens` | Set by `calibrate`. |
| `weights` | Cost-style weights so the token measure tracks Anthropic metering. |

## Backlog

`backlog.md` holds deferrable, genuinely useful tasks. Only real work belongs there.
Empty backlog means let the budget reset. That is fine.

Format: `- [priority] description @/optional/repo (size)`. Lower priority number runs
first. The `@/path` tells the dispatcher which repo to run the task in.

## Resume interrupted tasks

If the limit cuts off a task mid-way, Brimful can finish it the instant the window
reopens, with no manual restart.

- Auto path: launch long tasks with `bin/brimful-run.sh -p "..."`. If a limit stops
  it, the wrapper parses the reset time and queues a resume job by itself.
- Manual path: when you get cut off, run
  `node scripts/brimful.mjs resume add --dir "$(pwd)" --after "11:30am"`.

Either way the dispatcher continues it with `claude -c` once the window is open.
Waiting is plain code, so it costs nothing until the work actually resumes.

## Dispatcher

The dispatcher decides, for free, what to do each cycle:

1. Resume any interrupted task whose window has reopened.
2. Otherwise drain the top backlog item, but only if calibrated, under pace, below
   target, and idle (no Claude use in the last `idleMinutes`).
3. Otherwise hold.

Both resume and drain run as a **loop**: Brimful keeps issuing continue-turns until
the task prints the done sentinel, hits the limit again (it re-queues itself for the
next window), or trips a safety cap (`maxIterations`, `maxRunMinutes`, a no-progress
stall, or the `targetPct` budget stop). A task can therefore span several reset
windows and still finish. Completed backlog items are recorded so they never rerun.

```bash
node scripts/dispatch.mjs tick --dry-run   # decide and print, never launches claude
node scripts/dispatch.mjs tick             # one real cycle (cron-friendly)
node scripts/dispatch.mjs watch 900        # loop every 15 min (launchd/tmux)
```

Guardrails: a lockfile prevents overlap, a `.brimful-pause` file halts everything,
and it hard-stops at `targetPct` so automation never locks you out.

### Schedule it (cron)

Cron runs the free check on its own; tokens are spent only when real work launches.

```cron
# every 30 minutes
*/30 * * * * /usr/local/bin/node /Users/you/Desktop/brimful/scripts/dispatch.mjs tick >> /Users/you/Desktop/brimful/dispatch.log 2>&1
```

## Roadmap

- [x] Step 1: zero-token meter + calibration (`report`, `calibrate`, `pace`)
- [x] Step 2: dispatcher with resume + backlog drain, guardrails, dry-run, wrapper
- [x] Step 3: official statusLine numbers, auto-calibration, auto reset schedule, 5h-aware resume
- [x] Step 4: public packaging (marketplace manifest, installer, `~/.brimful` state dir)
- [x] Step 5: multi-turn task loop (continue to done, re-queue across windows, safety caps)
- [ ] Live resume test (when a real limit interrupts a task)
