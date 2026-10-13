# shawn-mods

The code is benign. It makes no network or process calls and only reads session info.

Two Claude Code mods.

- **usage-bar**: remaining usage % (5-hour and weekly) with reset times and a green-to-red tick bar.
- **goal-meter**: goal/task progress bar with step timers and plan tracking. Commands: `/hide-commands`, `/goal-reset`.

## Install (inside a `claude` session)

```
/plugin marketplace add shawnbotha/claude-mods
/plugin install usage-bar@shawn-mods
/plugin install goal-meter@shawn-mods
```

Then run `/reload-plugins`.

Note: goal-meter has a `SERVER_NAMES` map near the top of `plugins/goal-meter/hooks/register.tsx` that gives MCP connectors friendly names. Edit it for your own connector IDs.
