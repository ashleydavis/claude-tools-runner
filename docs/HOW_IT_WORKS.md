# How it works

Internals of the `claude-tools-runner` plugin: what runs when, what state is kept, and how a Stop event becomes a command spawn. For YAML syntax see [CONFIGURATION.md](CONFIGURATION.md).

## High-level architecture

```
                   ┌────────────────────────────────────────┐
   Claude Code ──► │ Stop hook (bun src/stop-hook.ts)       │
                   └────────────────────────────────────────┘
                                    │
                                    ▼
                          scan downward for configs
                          (find every .claude/tools-runner.yaml
                           under $CLAUDE_PROJECT_DIR)
                                    │
                                    ▼
              ┌─────────────────────┴─────────────────────┐
              │ load layers (triggers stay private)        │
              │   FileLayer ~/.claude/tools-runner.yaml    │
              │   FileLayer <dir>/.claude/...yaml × N      │
              │     (one per found config, each scoped     │
              │      to its own directory)                 │
              │   → TriggerRegistry                        │
              │     (no allTriggers; per-layer compile)    │
              └─────────────────────┬─────────────────────┘
                                    │
                                    ▼
                      git status --porcelain=v1 -z (per config dir)
                       (staged + unstaged + untracked,
                        skip deletions, take rename dest;
                        results filtered to files under that dir)
                                    │
                                    ▼
                  registry.compileCommands(changed)
                   ↳ per-layer glob match + grouping
                     (each layer keeps its triggers private;
                      registry concatenates per-layer
                      CompiledCommandConfig[] in registration order)
                                    │
                                    ▼
                          aggregate file hash
                          (SHA-256 over sorted entries,
                           per-file mtime+size cache)
                                    │
                                    ▼
                          cooldown / hash gate
                          (decides run vs skip; see below)
                                    │
                                    ▼
                          spawn `sh -c <run>` in parallel
                          (child_process.spawn, per-command timeout,
                           stdout/stderr captured to per-command log file)
                                    │
                                    ▼
                          save state YAML atomically
                          (.claude/tools-runner-state.yaml)
```

## Layered config loading

`TriggerRegistry` is constructed with a variable number of `FileLayer` instances: the home config (`~/.claude/tools-runner.yaml`) plus one per `.claude/tools-runner.yaml` found by scanning downward from `$CLAUDE_PROJECT_DIR`. Triggers are private to each layer: layers and the registry never expose or concatenate trigger lists. The registry exposes only two operations crossing the layer boundary: `isEmpty()` (true when every layer holds zero triggers) and `compileCommands(changed)` (iterates layers in registration order — home first, then found configs in discovery order — and concatenates each layer's `CompiledCommandConfig[]` output). Each `FileLayer.create(filePath, displayFile, scopeDir, ctx)` awaits an initial `loadConfigFile` and stores the loaded triggers on a private field. The Stop hook is one-shot: each Claude turn spawns a fresh `bun` process that re-reads every YAML from disk before evaluating triggers, so any edit made between turns is picked up automatically without an in-process watcher.

Each layer carries its own `TemplateContext` and a `scopeDir`. The `scopeDir` is layer-specific, not global:

- The **home layer** (`~/.claude/tools-runner.yaml`) uses `scopeDir = $CLAUDE_PROJECT_DIR` and `{ projectDir: $CLAUDE_PROJECT_DIR }`.
- Each **found config layer** uses `scopeDir = <dir>` and `{ projectDir: <dir> }`, where `<dir>` is the directory containing that particular `.claude/tools-runner.yaml`. So a config at `$CLAUDE_PROJECT_DIR/packages/foo/.claude/tools-runner.yaml` gets `scopeDir = $CLAUDE_PROJECT_DIR/packages/foo`, not `$CLAUDE_PROJECT_DIR`.

A layer's `compileCommands(changed)` only sees files under that layer's `scopeDir`, and `${{project}}` expands to the layer's `projectDir`.

```
Claude turn N ends ──► Stop hook spawns ──► reads every YAML fresh ──► evaluates ──► exits
Claude turn N+1 ends ──► Stop hook spawns ──► reads every YAML fresh (any edits picked up)
```

A YAML that fails to parse or validate aborts the hook: the error is written to stderr (one line, `[tools-runner] failed to load <displayFile>: <message>`) and to the audit log as a `hook_error` entry, and the hook exits 1 without running any commands. Aborting on any malformed layer is intentional: a layer silently treated as empty would mean the user's tests stop running with no obvious cause, which is worse than a noisy failure they can fix. A file that is missing at load time, by contrast, is observationally identical to a file with `triggers: []` (the layer simply contributes no triggers).

## Config discovery

The hook scans downward from `$CLAUDE_PROJECT_DIR` for every file matching the pattern `**/.claude/tools-runner.yaml`. Each found file becomes a layer in the registry, scoped to its own directory. The home config (`~/.claude/tools-runner.yaml`) is always loaded as an additional layer regardless of what the scan finds.

If `git` is not on `$PATH`, the spawn returns ENOENT via the `error` event and the hook logs `[tools-runner] git binary not found on PATH, skipping` and exits 0.

## Changed-file collection

For each config layer, `collectChangedFiles(scopeDir)` runs `git status --porcelain=v1 -z --untracked-files=all` from `scopeDir`. Git walks upward to find the enclosing repo and returns results as repo-relative paths; the plugin filters those to files whose absolute path falls under `scopeDir`. A file is included if either the index status or the worktree status is non-space, so both staged and unstaged changes are returned. For renames (`R`) the destination path is taken. Deletions (`D` in worktree) are excluded: there is nothing on disk to hash.

Each `ChangedFile` is `{ path, absPath }` where `path` is relative to `scopeDir`.

## Glob matching

`paths` patterns are matched against each `ChangedFile`'s POSIX `path` relative to the config file's `scopeDir`. A pattern `src/**/*.ts` matches a file at `<scopeDir>/src/foo.ts`. **Variables aren't supported in `paths`**: they appear only in `run` and `cwd`.

Leading `./` or `/` is stripped from each pattern (so `/src/**/*.ts` and `./src/**/*.ts` and `src/**/*.ts` all mean the same thing).

`matchFiles(files, paths)` uses [picomatch](https://github.com/micromatch/picomatch) with `{ dot: true }`. A file matches if at least one positive pattern matches and no negation pattern (prefix `!`) matches. Brace expansion (`*.{ts,tsx}`) works via picomatch defaults. Matching is case-sensitive.

## Hash computation

Each matched file's hash is computed via `hashFileWithCache`:

1. `fs.stat(absPath)` reads `mtimeMs` and `size`.
2. If a cache entry exists with the same `(mtimeMs, size)`, return its `hash` without reading the file.
3. Read the bytes via `fs.readFile(absPath)` from `node:fs/promises`, compute SHA-256 hex via `node:crypto`, store `(mtimeMs, size, hash)`, and return.
4. On `ENOENT`, return the sentinel `"<missing>"` (cache is not updated). This handles the race between `git status` reporting a file and `fs.stat` looking it up.

`aggregateHash(files, cache)` sorts the matched files by path, awaits per-file hashes via `Promise.all`, then returns `sha256("<path>\0<hash>\n<path>\0<hash>\n...")` over the concatenation. Empty input hashes to the SHA-256 of the empty string. Concurrent writes to the same cache key are safe: every writer computes the same `(mtimeMs, size, hash)` deterministically from the file on disk, so last-writer-wins overwrites the same value.

The cache is `state.fileHashes`, keyed by the file's absolute path. Entries are pruned during `saveState` once nothing in `state.commandRuns.matchedFiles` references them.

## CompiledCommand grouping

`compileCommands` is a pure function that operates on one layer's triggers at a time. Each `FileLayer` calls it with its own privately-held trigger list; the registry's `compileCommands(changed)` invokes each layer in registration order and concatenates the per-layer outputs. For each trigger whose `paths` patterns match at least one changed file, the function emits one `CompiledCommand` per unique `(expandedRun, expandedCwd)` pair, with `matchedFiles` set to the files that produced that pair. Each layer's invocation only sees files under that layer's `scopeDir`, and `${{project}}` expands to the layer's `projectDir`. Granularity is determined by which variables appear in `run` / `cwd` (finest wins):

| Variables present in `run` / `cwd` | Granularity |
|---|---|
| `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` | one emit per matched file |
| only `${{file_dir}}` | one emit per unique file-directory |
| only `${{group_dir}}` (with `group_by`) | one emit per unique group |
| none of the above | one emit, all matched files attached |

Each emitted `CompiledCommand` carries `sourceFile`, `sourceLine` (1-based line number of the originating trigger inside its YAML file, captured at config-load time via the `yaml` package's document parser), `triggerIndexInFile`, `commandIndex`, the expanded strings, and a precomputed `commandKey = sha256(expandedRun + "\0" + expandedCwd)`. The content-addressed key means per-file, per-dir, and per-group invocations all get distinct cooldown state automatically. `sourceFile` and `sourceLine` flow through into every audit-log entry that references the command, so users can navigate from a log line directly to the trigger in their `tools-runner.yaml`.

## Command-run state

The hook stores its run history in `<project>/.claude/tools-runner-state.yaml`. The file is created automatically on the first run and is gitignored by the plugin's own `.gitignore`. To force every trigger to fire on the next Stop event, delete it.

Old entries are pruned automatically: `commandRuns` whose `lastRunAt` is older than 30 days are dropped during each save, and any `fileHashes` entries no longer referenced by a surviving `commandRun` are dropped with them.

`state.commandRuns` is an array of entries keyed (logically) by `commandKey`:

```ts
interface CommandRunEntry {
    commandKey: string;        // sha256(expandedRun + "\0" + expandedCwd)
    expandedRun: string;       // stored alongside the key for human inspection
    expandedCwd: string;       // stored alongside the key for human inspection
    sourceFile: string;        // absolute path to the YAML config file that defined the trigger
    sourceLine: number;        // 1-based line number of the trigger inside sourceFile
    lastRunAt: string;         // ISO 8601, e.g. "2026-05-08T12:34:56.789Z"
    lastFilesHash: string;     // aggregate SHA-256 of matched files at the time of last successful run
    matchedFiles: string[];    // absolute paths; back-reference for fileHashes pruning
}
```

A single entry on disk looks like:

```yaml
- commandKey: "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"
  expandedRun: "bun run test"
  expandedCwd: "/path/to/project"
  sourceFile: "/path/to/project/.claude/tools-runner.yaml"
  sourceLine: 12
  lastRunAt: "2026-05-08T12:34:56.789Z"
  lastFilesHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  matchedFiles:
    - "/path/to/project/src/foo.ts"
    - "/path/to/project/src/bar.ts"
```

Because the key is content-addressed, adding, removing, or reordering triggers in either YAML layer never orphans existing state: only changing the resolved command text or working directory does. A consequence: a home-layer trigger and a project-layer trigger that resolve to the same `(run, cwd)` share state (last run wins) — `sourceFile` and `sourceLine` are overwritten with the most recently run trigger's location, so the state file always points at the trigger that was last responsible for the entry.

## Cooldown / hash gate

`decideGate` is the four-branch decision the runner makes for each `CompiledCommand`. `filesHash = aggregateHash(prepared.matchedFiles, state.fileHashes)`. `lastRunAtMs = Date.parse(entry.lastRunAt)`; `elapsedMs = now.getTime() - lastRunAtMs`; `cooldownMs = command.cooldown * 1000`; `inCooldown = elapsedMs < cooldownMs`. `command.cooldown` here is an integer-seconds number: the YAML `cooldown` (and `timeout`) string was parsed and normalized at config-load time by `parseDuration` (see [CONFIGURATION.md](CONFIGURATION.md) for the YAML format).

| Prior entry | Cooldown? | Hash match? | Decision | `lastRunAt` updated? |
|---|---|---|---|---|
| none | n/a | n/a | **run**, reason `first run` | yes (after success) |
| present | in cooldown | any | **skip**, reason `in cooldown` | no |
| present | expired | same hash | **skip**, reason `no file changes since last successful run` | no |
| present | expired | different hash | **run**, reason `files changed since last run` | yes (after success) |

`lastRunAt` only ever moves forward when the command actually runs, so its meaning stays plain: the wall-clock time of the most recent successful spawn. Cooldown is measured from that anchor and is never extended by Stop events that skip.

A negative `elapsedMs` (clock went backwards or a test injected an earlier `now`) counts as in-cooldown. An unparseable `lastRunAt` is treated as if no prior entry existed, and one warning is logged to stderr.

## Parallel execution

`runCommands` spawns every gate-passing command in parallel via `Promise.all`. Each spawn is `child_process.spawn("sh", ["-c", expandedRun], { cwd: expandedCwd, stdio: ["ignore", "pipe", "pipe"] })` from `node:child_process`. The runner writes both streams into a single per-command log file at `<projectDir>/.claude/tools-runner-log/YYYY-MM/DD/HH/MM-SS-<ms>-<commandKey-first8>.log`, tagging each line with its source: stdout lines are prefixed with `[OUT] ` and stderr lines with `[ERR] `. Lines from the two streams are emitted in the order their terminating newline arrives, so a reader still sees the natural interleaving but can distinguish which stream produced any given line. The runner maintains a small per-stream line buffer: incoming chunks are split on `\n`, complete lines are written immediately with the appropriate prefix, and any partial trailing line is flushed with its prefix (followed by a synthetic `\n`) when the stream ends. The audit-log entries (`command_started` and `command_result`) carry the same `logFile` path so a user inspecting the audit log can jump straight to the command's full output. A per-command `timeout` (default 300s) races the `exited` promise against `setTimeout`; on expiry `proc.kill("SIGTERM")` is called (then `SIGKILL` 2s later for stragglers) and the run is recorded as `FAIL timeout`. A per-command `timeout` (default 300s) races the `exited` promise against `setTimeout`; on expiry `proc.kill("SIGTERM")` is called (then `SIGKILL` 2s later for stragglers) and the run is recorded as `FAIL timeout`.

The hook has no global wall-clock cap: every individual command has its own `timeout` (default `"5m"`), so a hung command is bounded by its own kill timer. The hook process exits naturally once every spawned command resolves (success, fail, or per-command timeout).

## Three-Stop-event sequence

```
Stop event 1 (t=0s)
  changed: src/foo.ts
  no prior entry → run, exit 0
  state: { commandRuns[0]: { lastRunAt=t=0s, lastFilesHash=H1, matchedFiles=[src/foo.ts] } }

Stop event 2 (t=10s, src/foo.ts unchanged on disk)
  changed: src/foo.ts (still showing in git status)
  filesHash=H1, inCooldown (10 < 30)
  → SKIP "in cooldown", lastRunAt unchanged (still t=0s)

Stop event 3 (t=50s, src/foo.ts still unchanged)
  changed: src/foo.ts
  filesHash=H1, inCooldown? elapsed=50, cooldown=30 → expired
  hash matches H1
  → SKIP "no file changes since last successful run", lastRunAt unchanged
```

## State file shape (literal example)

This is the canonical reference for `saveState` and any code that round-trips state through the `yaml` package. Keys are camelCase identical to the TypeScript field names: there is no key transformation.

```yaml
fileHashes:
  /path/to/project/src/foo.ts:
    mtimeMs: 1746700000000
    size: 1234
    hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  /path/to/project/src/bar.ts:
    mtimeMs: 1746700001500
    size: 567
    hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
commandRuns:
  - commandKey: "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"
    expandedRun: "bun run test"
    expandedCwd: "/path/to/project"
    sourceFile: "/path/to/project/.claude/tools-runner.yaml"
    sourceLine: 12
    lastRunAt: "2026-05-08T12:34:56.789Z"
    lastFilesHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    matchedFiles:
      - "/path/to/project/src/bar.ts"
      - "/path/to/project/src/foo.ts"
```

`saveState` writes atomically: serialise to YAML, write to `filePath + ".tmp"`, then `fs.rename(...tmp, ...)`. Before serialising it prunes `commandRuns` whose `lastRunAt` is older than 30 days (hardcoded constant) or unparseable, then prunes any `fileHashes` entry whose key is not referenced by a surviving `commandRun.matchedFiles`. A rename failure surfaces as the `cannot write state file` row of the hook-behavior table and the hook exits 1.

## Audit log

Every Stop event is recorded to a paired `.json` (JSON Lines) and `.log` (plain text) file at `<projectDir>/.claude/tools-runner-log/YYYY-MM/DD/HH.{json,log}`. Files rotate hourly; older month directories are pruned each invocation (current month only is retained). All writes go through `fs.appendFile` from `node:fs/promises`, so concurrent hook invocations interleave at line boundaries safely.

Per-command stdout/stderr captures sit in a sibling `HH/` subdirectory inside the same hour, and the `command_started` / `command_result` entries carry a `logFile` field pointing at the relevant capture so a reader can jump from the audit log straight to the command's full output.

The canonical entry types (smoke and unit tests assert on these literals):

- `hook_started`: first entry per invocation; records `cwd`, `projectDir`, `sessionId`, `stopHookActive`.
- `config_load`: one per `FileLayer` that loaded successfully; records `filePath` and `triggerCount`.
- `changed_files`: aggregate list of files surfaced by `collectChangedFiles` across every layer.
- `trigger_match`: one per evaluated trigger (regardless of outcome); records `sourceFile`, `sourceLine`, `patterns`, `matchedFiles`, `unmatchedFiles`.
- `gate_decision`: one per `CompiledCommand` after `decideGate`; records the four-branch decision plus `filesHash`, `cooldownSeconds`, `elapsedSeconds`, and the human reason.
- `command_started`: one per command actually spawned; records `pid`, `timeoutSeconds`, and the `logFile` path.
- `command_result`: paired with `command_started`; records `exitCode`, `durationMs`, `outcome` (`pass` / `fail` / `timeout`), and the same `logFile`.
- `state_saved`: post-`saveState`; records `commandRunsCount`, `fileHashesCount`, and the prune counts.
- `hook_completed`: last entry per invocation; records `pass` / `fail` / `skip` totals, `durationMs`, `exitCode`, and an optional `skipReason` for early-exit paths (`stop_hook_active`, `git_missing`, `env_unset`, `no_triggers`, `no_changed_files`, `no_match`).
- `hook_error`: written when the top-level `try/catch` catches an unhandled exception. May be followed by `hook_completed` with `exitCode: 1`, or `process.exit(1)` may fire first; the absence of a paired `hook_completed` is itself a signal.

Every entry that references a trigger (`trigger_match`, `gate_decision`, `command_started`, `command_result`) carries `sourceFile` and `sourceLine`, and the human-readable log lines are prefixed with `path/to/tools-runner.yaml:42` so most terminals recognise the shape as a clickable jump target.

For full schemas, the human-readable rendering, retention semantics, and `jq` recipes, see [AUDIT-LOG.md](AUDIT-LOG.md).
