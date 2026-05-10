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
                          (find every .claude/claude-tools-runner.yaml
                           under $CLAUDE_PROJECT_DIR)
                                    │
                                    ▼
              ┌─────────────────────┴─────────────────────┐
              │ load layers (triggers stay private)        │
              │   FileLayer ~/.claude/claude-tools-runner.yaml │
              │   FileLayer <dir>/.claude/...yaml × N      │
              │     (one per found config, each scoped     │
              │      to its own directory)                 │
              │   per-layer state under                    │
              │     <scopeDir>/.claude/claude-tools-runner/│
              └─────────────────────┬─────────────────────┘
                                    │
                                    ▼
                      git status --porcelain=v1 -z (per config dir)
                       (staged + unstaged + untracked,
                        skip deletions, take rename dest;
                        results filtered to files under that dir)
                                    │
                                    ▼
                  per-layer compileCommands(changed)
                   ↳ glob match + grouping
                     (each layer keeps its triggers private;
                      each layer's prepared commands run
                      against its own state)
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
                           stdout/stderr captured to per-layer log file)
                                    │
                                    ▼
                          save per-layer state atomically
                          (.claude/claude-tools-runner/runs/
                           and .claude/claude-tools-runner/hashes.yaml)
```

## Layered config loading

The Stop hook builds one `FileLayer` for the home config (`~/.claude/claude-tools-runner.yaml`) plus one per `.claude/claude-tools-runner.yaml` found by scanning downward from `$CLAUDE_PROJECT_DIR`. Triggers are private to each layer: layers never expose or concatenate trigger lists. Each `FileLayer.create(filePath, displayFile, scopeDir, ctx)` awaits an initial `loadConfigFile` and stores the loaded triggers on a private field. The Stop hook is one-shot: each Claude turn spawns a fresh `bun` process that re-reads every YAML from disk before evaluating triggers, so any edit made between turns is picked up automatically without an in-process watcher.

Each layer carries its own `TemplateContext` and a `scopeDir`. The `scopeDir` is layer-specific, not global:

- The **home layer** (`~/.claude/claude-tools-runner.yaml`) uses `scopeDir = $HOME` and `{ projectDir: $HOME }`.
- Each **found config layer** uses `scopeDir = <dir>` and `{ projectDir: <dir> }`, where `<dir>` is the directory containing that particular `.claude/claude-tools-runner.yaml`. So a config at `$CLAUDE_PROJECT_DIR/packages/foo/.claude/claude-tools-runner.yaml` gets `scopeDir = $CLAUDE_PROJECT_DIR/packages/foo`, not `$CLAUDE_PROJECT_DIR`.

A layer's `compileCommands(changed)` only sees files under that layer's `scopeDir`, and `${{project}}` expands to the layer's `projectDir`.

```
Claude turn N ends ──► Stop hook spawns ──► reads every YAML fresh ──► evaluates ──► exits
Claude turn N+1 ends ──► Stop hook spawns ──► reads every YAML fresh (any edits picked up)
```

A YAML that fails to parse or validate aborts the hook: the error is written to stderr (one line, `[tools-runner] failed to load <displayFile>: <message>`) and to the audit log as a `hook_error` entry, and the hook exits 1 without running any commands. Aborting on any malformed layer is intentional: a layer silently treated as empty would mean the user's tests stop running with no obvious cause, which is worse than a noisy failure they can fix. A file that is missing at load time, by contrast, is observationally identical to a file with `triggers: []` (the layer simply contributes no triggers).

## Per-layer state and logs

State and logs are anchored at the layer's `scopeDir`, not at `$CLAUDE_PROJECT_DIR`. Each configuration file gets its own state directory next to it:

```
<scopeDir>/.claude/
  claude-tools-runner.yaml             ← the configuration file
  claude-tools-runner/
    .gitignore                         ← contents: "*\n" (so the whole dir is hidden from git)
    hashes.yaml                        ← per-layer file hash cache
    runs/
      <commandKey>.yaml                ← one file per known command, content-addressed
    log/
      YYYY-MM/DD/HH.json               ← audit log (JSON Lines, machine-readable)
      YYYY-MM/DD/HH.log                ← audit log (plain text, human-readable)
      YYYY-MM/DD/HH/<MM-SS-…>.log      ← per-command stdout/stderr capture
```

Nested repos in scenarios like a parent with two child repos each get their own `.claude/claude-tools-runner/` so cooldown and hash state never collide. The home layer's state lives at `~/.claude/claude-tools-runner/`.

## Config discovery

The hook scans downward from `$CLAUDE_PROJECT_DIR` for every file matching the pattern `**/.claude/claude-tools-runner.yaml`. Each found file becomes a layer, scoped to its own directory. The home config (`~/.claude/claude-tools-runner.yaml`) is always loaded as an additional layer regardless of what the scan finds.

Before recursion, the hook reads the project root config's optional `ignore` glob list and uses it to prune subdirectories whose project-relative POSIX path matches any pattern. The scanner never descends into pruned subtrees, so configs inside them are never loaded and changed files inside them are never seen. Only the project root's `ignore` list applies to the scan; nested configs may declare their own `ignore` for their own purposes but cannot influence siblings. The standard hard-coded skips (`node_modules/`, `.git/`, `.cache/`, dot-prefixed directories other than `.claude`) still apply unconditionally and need not be repeated in `ignore`.

If `git` is not on `$PATH`, the spawn returns ENOENT via the `error` event and the hook logs `[tools-runner] git binary not found on PATH, skipping` and exits 0.

## Triggers

A trigger is the unit of declarative configuration the user writes in YAML. Each trigger bundles a few fields:

- `paths`: one or more glob patterns selecting which changed files the trigger cares about.
- `run`: the shell command to execute when the patterns match, with optional template variables (`${{file_path}}`, `${{file_dir}}`, `${{group_dir}}`, `${{project}}`, etc.).
- `cwd`: optional working directory for the spawn (defaults to the layer's `projectDir`); also expandable.
- `cooldown`: optional duration string (e.g. `"30s"`, `"5m"`) parsed at config-load time into integer seconds.
- `timeout`: optional duration string parsed the same way; defaults to `"5m"`.
- `group_by`: optional glob used together with `${{group_dir}}` to partition matched files into per-group invocations.

Each layer holds its own private trigger list (loaded by `FileLayer.create`) and never exposes it across layers. For each Stop event the runner asks every layer "given these changed files, what commands should I prepare?" and the layer answers by running its triggers through `compileCommands`.

A trigger's lifecycle in one Stop event is: load from YAML (with its 1-based source line captured by the `yaml` document parser) → match `paths` against the layer's changed-file slice → expand template variables in `run` and `cwd` → emit one or more `CompiledCommand`s (granularity determined by which variables appear, see [CompiledCommand grouping](#compiledcommand-grouping)) → gate each emitted command by cooldown and hash → spawn the survivors in parallel. The full YAML schema and template variable reference lives in [CONFIGURATION.md](CONFIGURATION.md).

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

`compileCommands` is a pure function that operates on one layer's triggers at a time. Each `FileLayer` calls it with its own privately-held trigger list. For each trigger whose `paths` patterns match at least one changed file, the function emits one `CompiledCommand` per unique `(expandedRun, expandedCwd)` pair, with `matchedFiles` set to the files that produced that pair. Each layer's invocation only sees files under that layer's `scopeDir`, and `${{project}}` expands to the layer's `projectDir`. Granularity is determined by which variables appear in `run` / `cwd` (finest wins):

| Variables present in `run` / `cwd` | Granularity |
|---|---|
| `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` | one emit per matched file |
| only `${{file_dir}}` | one emit per unique file-directory |
| only `${{group_dir}}` (with `group_by`) | one emit per unique group |
| none of the above | one emit, all matched files attached |

Each emitted `CompiledCommand` carries `sourceFile`, `sourceLine` (1-based line number of the originating trigger inside its YAML file, captured at config-load time via the `yaml` package's document parser), `triggerIndexInFile`, `commandIndex`, the expanded strings, and a precomputed `commandKey = sha256(expandedRun + "\0" + expandedCwd)`. The content-addressed key means per-file, per-dir, and per-group invocations all get distinct cooldown state automatically. `sourceFile` and `sourceLine` flow through into every audit-log entry that references the command, so users can navigate from a log line directly to the trigger in their `claude-tools-runner.yaml`.

## Command-run state

Each layer stores its run history in `<scopeDir>/.claude/claude-tools-runner/runs/<commandKey>.yaml` (one file per known command) plus a sibling `<scopeDir>/.claude/claude-tools-runner/hashes.yaml` for the file hash cache. The `runs/` directory and `hashes.yaml` are created automatically on the first run and are gitignored by the plugin's own `.gitignore`. To force every trigger to fire on the next Stop event, delete the layer's `runs/` directory and `hashes.yaml` (or the entire `claude-tools-runner/` directory).

Old entries are pruned automatically: `commandRuns` whose `lastRunAt` is older than 30 days are dropped during each save, and any `fileHashes` entries no longer referenced by a surviving `commandRun` are dropped with them.

`state.commandRuns` is an in-memory array of entries, one per known `commandKey` for the current layer:

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

A single per-command run file on disk looks like:

```yaml
commandKey: "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"
expandedRun: "bun run test"
expandedCwd: "/path/to/project"
sourceFile: "/path/to/project/.claude/claude-tools-runner.yaml"
sourceLine: 12
lastRunAt: "2026-05-08T12:34:56.789Z"
lastFilesHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
matchedFiles:
  - "/path/to/project/src/foo.ts"
  - "/path/to/project/src/bar.ts"
```

Because the key is content-addressed, adding, removing, or reordering triggers in either YAML layer never orphans existing state: only changing the resolved command text or working directory does. State is partitioned by layer, so a project-layer trigger and a nested-layer trigger that resolved to the same `(run, cwd)` would still use separate state files (each in its own `runs/` directory).

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

`runCommands` spawns every gate-passing command in parallel via `Promise.all`. Each spawn is `child_process.spawn("sh", ["-c", expandedRun], { cwd: expandedCwd, stdio: ["ignore", "pipe", "pipe"] })` from `node:child_process`. The runner writes both streams into a single per-command log file at `<scopeDir>/.claude/claude-tools-runner/log/YYYY-MM/DD/HH/MM-SS-<ms>-<commandKey-first8>.log`, tagging each line with its source: stdout lines are prefixed with `[OUT] ` and stderr lines with `[ERR] `. Lines from the two streams are emitted in the order their terminating newline arrives, so a reader still sees the natural interleaving but can distinguish which stream produced any given line. The runner maintains a small per-stream line buffer: incoming chunks are split on `\n`, complete lines are written immediately with the appropriate prefix, and any partial trailing line is flushed with its prefix (followed by a synthetic `\n`) when the stream ends. The audit-log entries (`command_started` and `command_result`) carry the same `logFile` path so a user inspecting the audit log can jump straight to the command's full output. A per-command `timeout` (default 300s) races the `exited` promise against `setTimeout`; on expiry `proc.kill("SIGTERM")` is called (then `SIGKILL` 2s later for stragglers) and the run is recorded as `FAIL timeout`.

The hook has no global wall-clock cap: every individual command has its own `timeout` (default `"5m"`), so a hung command is bounded by its own kill timer. The hook process exits naturally once every spawned command resolves (success, fail, or per-command timeout). Layer-level parallelism stacks on top of within-layer parallelism via an outer `Promise.all` over each layer's `runCommands` call.

## State persistence: locking and atomic writes

`saveState` is reached at the end of every gate-passing hook invocation, and multiple hooks (or multiple parallel layers within one hook) can be writing to the same `<scopeDir>/.claude/claude-tools-runner/` directory at once. Two cooperating mechanisms keep the state files from corrupting each other: a per-file write lock and an atomic tmp-file rename.

**Per-file write locks** (`src/lock.ts`): each per-command run file (`runs/<commandKey>.yaml`) has its own sibling lock token at `runs/<commandKey>.yaml.lock`, and the hash cache (`hashes.yaml`) has its own at `hashes.yaml.lock`. `withFileLock` uses `fs.mkdir` as the lock primitive: `mkdir` either succeeds (the caller now holds the lock) or fails with `EEXIST` (someone else does). On `EEXIST` the acquirer stats the lock directory; if its `mtime` is older than 30 seconds the lock is treated as stale (the previous holder probably crashed or was SIGKILLed) and stolen via `rmdir` then retry. Otherwise the acquirer sleeps with exponential backoff (5ms, doubling, capped at 200ms) and retries the `mkdir`. The lock is always released in a `finally` block so an exception inside the critical section never strands it. `mkdir`-as-lock is atomic across processes on every POSIX filesystem, which is the property the runner needs: two parallel hooks never both believe they hold the same lock. Lock granularity is per file, not per directory: writers updating different per-command files run in parallel and only writers contending on the same file serialise.

**Atomic writes via tmp + rename** (`src/state.ts`): inside the lock, `atomicWriteYaml` never writes to the destination file directly. It serialises the payload via `YAML.stringify`, writes the bytes to a sibling tmp file named `<dest>.<pid>.<8-random-hex>.tmp`, then calls `fs.rename(tmp, dest)`. `rename` is atomic on the same filesystem, so a concurrent reader either sees the old file or the new file, never a partial write. The unique tmp suffix (pid plus 8 random bytes) means two writers cannot collide on the same intermediate file even if they bypass the lock (defense in depth), and a crashed write leaves an identifiable orphan rather than silently pre-empting the next writer's tmp slot.

**Why both**: the lock alone is not enough, because a process killed mid-`writeFile` would still leave a torn file. The rename alone is not enough, because two writers could each prepare a tmp file and the second `rename` would clobber the first writer's record without the lock observing that each writer's intent was a read-modify-write cycle. Together the lock serialises read-modify-write per file and the rename guarantees readers always see a complete file. The common case during a single hook's `saveState` (writing several different per-command files plus the hash cache) proceeds in parallel because each file has its own lock.

**Reader behavior**: `loadHashesFile` and `loadCommandRunFile` treat `ENOENT` as "no prior state" and corrupt YAML as "drop and re-derive on the next run" (one diagnostic line is written to stderr in the corrupt case). Because writes are atomic, the corrupt branch is reachable only through external tampering or filesystem-level damage, never through writer interleaving.

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

## Audit log

Each layer writes its own audit log under `<scopeDir>/.claude/claude-tools-runner/log/YYYY-MM/DD/HH.{json,log}` (paired JSON Lines + plain text). Files rotate hourly; older month directories are pruned each invocation (the current month and the previous two are retained, anything older is purged). All writes go through `fs.appendFile` from `node:fs/promises`, so concurrent hook invocations interleave at line boundaries safely.

Per-command stdout/stderr captures sit in a sibling `HH/` subdirectory inside the same hour, and the `command_started` / `command_result` entries carry a `logFile` field pointing at the relevant capture so a reader can jump from the audit log straight to the command's full output.

Layer-specific entries (`config_load`, `trigger_match`, `gate_decision`, `command_started`, `command_result`, `state_saved`) are routed only to the originating layer's log via `MultiLayerLogger`, so reading one layer's log shows you exactly what that configuration did. Global entries (`hook_started`, `changed_files`, `hook_completed`, `hook_error`) fan out to every layer's log so each file is self-contained.

The canonical entry types (smoke and unit tests assert on these literals):

- `hook_started`: first entry per invocation; records `cwd`, `projectDir`, `sessionId`, `stopHookActive`.
- `config_load`: one per `FileLayer` that loaded successfully; records `filePath`, `triggerCount`, plus the layer's `hashesPath`, `runsDir`, and `logBaseDir` so the audit log shows up-front where the layer's output goes.
- `changed_files`: aggregate list of files surfaced by `collectChangedFiles` across every layer.
- `trigger_match`: one per evaluated trigger (regardless of outcome); records `sourceFile`, `sourceLine`, `patterns`, `matchedFiles`, `unmatchedFiles`.
- `gate_decision`: one per `CompiledCommand` after `decideGate`; records the four-branch decision plus `filesHash`, `cooldownSeconds`, `elapsedSeconds`, and the human reason.
- `command_started`: one per command actually spawned; records `pid`, `timeoutSeconds`, and the `logFile` path.
- `command_result`: paired with `command_started`; records `exitCode`, `durationMs`, `outcome` (`pass` / `fail` / `timeout`), and the same `logFile`.
- `state_saved`: post-`saveState`; records `sourceFile` (the layer this save belongs to), `hashesPath`, `runsDir`, `commandRunsCount`, `fileHashesCount`, and the prune counts.
- `hook_completed`: last entry per invocation; records `pass` / `fail` / `skip` totals, `durationMs`, `exitCode`, and an optional `skipReason` for early-exit paths (`stop_hook_active`, `git_missing`, `env_unset`, `no_triggers`, `no_changed_files`, `no_match`).
- `hook_error`: written when the top-level `try/catch` catches an unhandled exception. May be followed by `hook_completed` with `exitCode: 1`, or `process.exit(1)` may fire first; the absence of a paired `hook_completed` is itself a signal.

Every entry that references a trigger (`trigger_match`, `gate_decision`, `command_started`, `command_result`) carries `sourceFile` and `sourceLine`, and the human-readable log lines are prefixed with `path/to/claude-tools-runner.yaml:42` so most terminals recognise the shape as a clickable jump target.

For full schemas, the human-readable rendering, retention semantics, and `jq` recipes, see [AUDIT-LOG.md](AUDIT-LOG.md).
