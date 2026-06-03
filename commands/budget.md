---
description: Show this week's Claude usage pacing (Brimful). Runs a local script, near-zero tokens.
allowed-tools: Bash(node:*)
---

Run the Brimful meter and show its output verbatim. Do not analyze, summarize, or
add commentary unless I ask. The script does all the work; you are just the messenger.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/brimful.mjs" report`
