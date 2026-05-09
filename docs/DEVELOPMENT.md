# Development

How to build, test, and contribute to `claude-tools-runner`.

## Prerequisites

- [Bun](https://bun.sh/): runtime, bundler, package manager, and test runner host.

## Clone and bootstrap

```bash
git clone git@github.com:ashleydavis/claude-tools-runner.git
cd claude-tools-runner
bun install
bun run bundle
```

## Running it during development

From inside the repo:

```bash
claude --plugin-dir ./plugin
```

Or from any other project directory:

```bash
claude --plugin-dir ~/claude-tools-runner/plugin
```

Note: `--plugin-dir` is a CLI flag and does not apply to Claude Code running inside IDE extensions (VS Code, JetBrains). Use the global hook approach below if you need the plugin active in those environments.

### Enabling for all Claude instances (including IDE extensions)

Add the hook directly to `~/.claude/settings.json`. This is equivalent to what the plugin system does internally and applies to every Claude Code instance on the machine, including the VS Code extension:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/claude-tools-runner/src/stop-hook.ts"
          }
        ]
      }
    ]
  }
}
```

## Testing and type-checking

The four commands you'll run while editing:

| Command | What it does |
|---|---|
| `bun run compile` (alias `bun run c`) | Type-checks via `tsc --noEmit`. Fast, run frequently. |
| `bun run test` (alias `bun run t`) | Runs the Jest unit tests under `src/test/`. |
| `bun run hook-smoke` | Runs `scripts/hook-smoke-tests.sh`: bundle-integrity checks (malformed JSON, empty stdin, missing `CLAUDE_PROJECT_DIR`, expected exit codes). |
| `bun run smoke` | Runs `scripts/smoke-tests.sh`: end-to-end behavioral scenarios in a temp git repo (first-run executes, second-run skips on cooldown, file change re-fires, state file deletion resets, per-file template invokes once per file). |

To run everything as a single gate:

```bash
bun run test:all   # unit + hook-smoke + smoke
# alias: bun run ta
```

### Inspecting the audit log

Every Stop event writes a structured audit log to `<project>/.claude/tools-runner-log/YYYY-MM/DD/HH.{json,log}` (machine-readable JSON Lines plus a human-readable mirror). When debugging "why didn't my command fire?", inspect the most recent files:

```bash
# Tail the most recent hour's text log (any project under cwd):
ls -t .claude/tools-runner-log/**/*.log | head -1 | xargs tail -f

# Filter the JSON log for one event type (e.g. trigger_match):
jq 'select(.type == "trigger_match")' .claude/tools-runner-log/**/*.json
```

See [AUDIT-LOG.md](AUDIT-LOG.md) for the full entry-type reference and more `jq` recipes.

## Bundling and publishing

`bun run bundle` produces `plugin/dist/stop-hook.js`: a self-contained file with all dependencies inlined. The `dist/` directory is gitignored; bundles are produced on demand.

To publish a new version, bump the `version` in `plugin/.claude-plugin/plugin.json` (and matching `package.json`), run `bun run bundle`, and ship the `plugin/` directory.

## Troubleshooting

**Where is the state file?** `<project>/.claude/tools-runner-state.yaml`. It's gitignored. To reset all cooldown state for a project, delete it; the next Stop event recreates it from scratch.

**How do I see what the hook is doing?** Routine progress goes to stdout, errors to stderr. Both streams appear in Claude Code's hook output panel. Every prepared command logs a `PASS`, `FAIL`, or `SKIP` line, followed by a final summary.

**A command keeps re-running on every Stop event.** Either the matched files are genuinely changing (check `git status --porcelain`) or the command is exiting non-zero (failures don't update `lastFilesHash`, so the next Stop sees no recorded hash and runs again). Check the `FAIL` log line for the exit code.

**A command never runs even though my YAML looks right.** Most likely causes, in order: the file isn't actually showing in `git status --porcelain` (untracked files need to exist; deletions don't count); your glob doesn't match the repo-relative POSIX path; the YAML failed to parse and the layer was treated as empty (look for `[tools-runner] failed to load <sourceFile>` on stderr). Set `cooldown: 0` and delete `.claude/tools-runner-state.yaml` to rule out gating.
