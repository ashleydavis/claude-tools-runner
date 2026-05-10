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

Every Stop event writes a structured audit log per configuration layer to `<scopeDir>/.claude/claude-tools-runner/log/YYYY-MM/DD/HH.{json,log}` (machine-readable JSON Lines plus a human-readable mirror). When debugging "why didn't my command fire?", inspect the most recent files:

```bash
# Tail the most recent hour's text log under the project tree:
ls -t .claude/claude-tools-runner/log/**/*.log | head -1 | xargs tail -f

# Filter the JSON log for one event type (e.g. trigger_match):
jq 'select(.type == "trigger_match")' .claude/claude-tools-runner/log/**/*.json
```

See [AUDIT-LOG.md](AUDIT-LOG.md) for the full entry-type reference and more `jq` recipes.

## Bundling and publishing

`bun run bundle` produces `plugin/dist/stop-hook.js`: a self-contained file with all dependencies inlined. The `dist/` directory is gitignored; bundles are produced on demand.

To publish a new version, bump the `version` in `plugin/.claude-plugin/plugin.json` (and matching `package.json`), run `bun run bundle`, and ship the `plugin/` directory.

## Troubleshooting

**Where is the state file?** Each configuration layer keeps its state in `<scopeDir>/.claude/claude-tools-runner/`: `hashes.yaml` for the hash cache and `runs/<commandKey>.yaml` for one file per known command. The whole `claude-tools-runner/` directory is gitignored. To reset cooldown state for a layer, delete its `runs/` directory and `hashes.yaml` (or the entire `claude-tools-runner/` directory); the next Stop event recreates it from scratch. State for nested configurations is independent: deleting one layer's state leaves the other layers untouched.

**How do I see what the hook is doing?** Routine progress is recorded in the on-disk audit log at `<scopeDir>/.claude/claude-tools-runner/log/<YYYY-MM>/<DD>/<HH>.log` (human-readable text) and `HH.json` (JSON Lines, machine-readable). Stop-hook stdout is intentionally silent (Claude Code parses Stop-hook stdout as JSON and treats anything else as debug-log noise the user never sees), and stderr is used only when the hook is about to exit `2` because at least one command failed or the hook hit a fatal internal error. To watch routine activity, `tail -F` the per-layer audit log; to see failures, look for the `Stop hook feedback:` notice Claude Code surfaces in the chat after a non-zero exit.

**A command keeps re-running on every Stop event.** Either the matched files are genuinely changing (check `git status --porcelain`) or the command is exiting non-zero (failures don't update `lastFilesHash`, so the next Stop sees no recorded hash and runs again). Check the `FAIL` audit-log line for the exit code.

**A command never runs even though my YAML looks right.** Most likely causes, in order: the file isn't actually showing in `git status --porcelain` (untracked files need to exist; deletions don't count); your glob doesn't match the scope-relative POSIX path (relative to the config file's directory); the YAML failed to parse and the hook exited 2 (Claude Code shows the `[tools-runner] failed to load <sourceFile>` stderr line as `Stop hook feedback:` in the chat). Set `cooldown: 0` and delete the layer's `.claude/claude-tools-runner/` directory to rule out gating.
