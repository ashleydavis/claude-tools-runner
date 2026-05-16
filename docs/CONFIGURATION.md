# Configuration

How to write `claude-tools-runner.yaml` files.

## Configuration files

All locations are optional. If multiple exist, their triggers all run.

- `~/.claude/claude-tools-runner.yaml`: **home config**. Applies to every project you open with Claude Code. Useful for editor-style triggers (formatters, linters) you want everywhere.
- Any `.claude/claude-tools-runner.yaml` found by scanning downward from `$CLAUDE_PROJECT_DIR`: each such file's triggers apply only to files within that file's own directory and below.

Each configuration file gets its own state and output directory, sitting next to it as `.claude/claude-tools-runner/`. Inside it the plugin writes `hashes.yaml`, `runs/<commandKey>.yaml` (one file per command), and `log/YYYY-MM/DD/HH.{json,log}` (audit log) plus `log/YYYY-MM/DD/HH/<MM-SS-…>.log` (per-command stdout/stderr capture). The whole `claude-tools-runner/` directory is gitignored automatically by a `.gitignore` containing `*` that the plugin drops at the directory root. Nested repos with their own configuration each get isolated state so a hook run in the parent never overwrites the nested repo's hashes or run history.

## Schema reference

Each YAML file has two top-level keys: `triggers` (required, may be empty) and `ignore` (optional). Any other top-level key is rejected.

- **`ignore`**: list of strings, optional. Glob patterns matched against project-relative POSIX directory paths during the recursive config scan. Subdirectories matching any pattern are pruned wholesale (the scanner never descends into them, so configs they contain are never loaded). Only the project root config's `ignore` list is consulted; nested configs cannot exclude others' subtrees. Patterns use the same picomatch syntax as `paths` (a leading `./` or `/` is stripped). Typical use: `e2e/**/tmp` to skip smoke-test fixtures, `dist`, `build`, etc.
- **`triggers`**: list, required (may be empty). An empty list is valid (the file is in place but quiet).
  - **`paths`**: list of strings, optional (may be missing or empty). [picomatch](https://github.com/micromatch/picomatch) glob patterns applied to POSIX paths relative to the config file's directory (`scopeDir`). A trigger fires if any changed file matches any pattern. An empty or absent `paths` list is not an error: the trigger simply never fires. Negations (`!`) exclude. Brace expansion (`*.{ts,tsx}`) is supported. Case-sensitive.
  - **`group_by`**: string, optional. A glob pattern that defines a "group" directory per matched file. When set, files whose paths share the same `group_by` match are treated as one group, and the `${{group_dir}}` variable becomes available in `run` and `cwd`. See "Grouping" below. Example: `packages/*/` (per-package), `apps/*/` (per-app), `*/` (per-top-level-directory). The trailing `/` is conventional shorthand for "directory" and optional: `packages/*` works identically.
  - **`commands`**: list, required (≥ 1). One or more commands to run when the trigger fires.
    - **`run`**: string, required. Shell command line, executed via `sh -c`. Supports variables (see below).
    - **`cooldown`**: duration string, optional. Default `"1m"`. Time between consecutive runs of this command (see "Duration format" below). Use `"0"` or `"0s"` to disable.
    - **`cwd`**: string, optional. Default `"${{project}}"`. Working directory for the spawned process. Supports variables.
    - **`timeout`**: duration string, optional. Default `"5m"`. Per-command wall-clock timeout. The process is killed (`SIGTERM` then `SIGKILL`) on expiry and the run is recorded as `FAIL timeout`.

### Duration format

`cooldown` and `timeout` are always strings. The format is `<integer>` (interpreted as seconds when no unit suffix is given) or `<integer><unit>` where unit is one of:

| Suffix | Unit |
|---|---|
| `s` | seconds |
| `m` | minutes |
| `h` | hours |

Examples: `"30"` (30 seconds), `"30s"` (same), `"5m"` (300 seconds), `"1h"` (3600 seconds), `"0"` or `"0s"` (disabled). Bare YAML numbers (`cooldown: 30`) are rejected: quote the value or add a unit suffix. Decimal values, negative values, and other unit suffixes (e.g. `"500ms"`, `"7d"`) are also rejected.

A trigger needs at least one path pattern and one command, and every command needs a non-empty `run` and a valid `cooldown` duration string (see "Duration format" above): anything else is a parse error and that file is treated as empty for the current invocation (the other layer still loads).

## Variables

In your `claude-tools-runner.yaml` config file, you can write `${{name}}`-style variables into certain fields and they'll be replaced with real values when a trigger fires. For example:

```yaml
triggers:
  - paths:
      - "**/*.md"
    commands:
      - run: markdownlint ${{file_path}}
        cooldown: 5s
```

This runs `markdownlint` **once for every changed `.md` file**: `${{file_path}}` is *per-file*, so each invocation gets a different file's absolute path. The command runs from `${{project}}` (the default `cwd`).

The full set:

| Name | Replaced with | Available in |
|---|---|---|
| `${{project}}` | The directory containing this config file. For the home config, `$CLAUDE_PROJECT_DIR`. **The default `cwd` for every command.** | `run`, `cwd` only |
| `${{file_path}}` | The absolute path of one matched file. | `run`, `cwd` only |
| `${{file_name}}` | The basename of one matched file (e.g. `foo.ts` for `/abs/repo/src/foo.ts`). | `run`, `cwd` only |
| `${{file_basename}}` | The basename without extension (e.g. `foo` for `/abs/repo/src/foo.ts`). | `run`, `cwd` only |
| `${{file_ext}}` | The file extension including the leading dot (e.g. `.ts` for `/abs/repo/src/foo.ts`). Empty string for files with no extension. | `run`, `cwd` only |
| `${{file_dir}}` | The absolute directory of one matched file (`path.dirname(${{file_path}})`). | `run`, `cwd` only |
| `${{group_dir}}` | The absolute directory of the matched file's *group*, as defined by the trigger's `group_by` pattern. Only available when `group_by` is set on the trigger. | `run`, `cwd` only |

**Variables aren't supported in `paths`.** Write `paths` as plain globs matched against paths relative to the config file's directory: `src/**/*.ts`, `**/*.md`, etc.

### Grouping (`group_by`)

`group_by` is a trigger-level field that lets you run a command **once per group of files** rather than once per file or once per file-directory. A "group" is whatever directory you want to bucket matched files into. Common uses:

- Each package in a monorepo (`group_by: packages/*/`)
- Each app in a multi-app repo (`group_by: apps/*/`)
- Each top-level area (`group_by: */`)
- Each test suite (`group_by: tests/*/`)

The value is a glob pattern that matches a directory prefix of each file's path; the directory that matches becomes that file's "group", and `${{group_dir}}` expands to it as an absolute path.

A trailing `/` on the glob is conventional shorthand for "directory" and is recommended for readability: `packages/*/` reads more clearly than `packages/*`. Both forms are accepted and behave identically.

For `paths: packages/*/src/**/*.ts` and `group_by: packages/*/`:

| Matched file | Matched group directory | `${{group_dir}}` |
|---|---|---|
| `packages/foo/src/util.ts` | `packages/foo/` | `/abs/repo/packages/foo` |
| `packages/foo/src/lib/util.ts` | `packages/foo/` (same) | `/abs/repo/packages/foo` |
| `packages/bar/src/util.ts` | `packages/bar/` | `/abs/repo/packages/bar` |

Files with the same group directory collapse to one invocation when the command uses `${{group_dir}}`. If a matched file's path has no prefix that matches `group_by` (unusual: implies a misconfiguration), that file is skipped for this trigger and a warning is logged to stderr.

`group_by` is matched as an anchored glob against successive path prefixes (one segment, two segments, …) until the first match is found. So `packages/*/` matches the two-segment prefix `packages/foo`, not `packages/foo/src`. Brace expansion and `**` are supported, but in practice a flat `<dir>/*/` is what most users want.

How variables decide the number of invocations of a command (finest-granularity wins):

- If `run` or `cwd` contains `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}`: one invocation per matched file.
- Else if `run` or `cwd` contains `${{file_dir}}`: one invocation per unique directory.
- Else if `run` or `cwd` contains `${{group_dir}}` (and the trigger sets `group_by`): one invocation per unique group directory.
- Else: a single invocation with all matched files attached for hashing.

`${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, and `${{group_dir}}` are **shell-quoted automatically** when expanded into `run` (POSIX single-quote with `'\''` escaping), so a value containing spaces, semicolons, dollar signs, or quotes cannot inject. `cwd` is passed directly as the spawned process's working directory (no shell involved), so no quoting is applied or needed there. `${{project}}` is never auto-quoted in either field: it's a configuration value, not a user-controlled file path.

## Examples

### 1. Project-level: run tests when TS files change

```yaml
# <project>/.claude/claude-tools-runner.yaml
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
```

Whenever any `.ts` file under `src/` shows up in `git status`, `bun run test` runs once. For the next minute (the default `cooldown`), subsequent Stop events skip with `in cooldown`. After that, if the matched files are unchanged the run is skipped with `no file changes since last run`; if they've changed it runs again. The hash gate applies to *any* prior attempt (pass, fail, or timeout), so a failing command does not re-burn CPU on every Stop event while its matched files stay identical — edit any matched file to force a retry.

### 2. Per-file linter using `${{file_path}}`

```yaml
triggers:
  - paths:
      - "**/*.md"
    commands:
      - run: markdownlint ${{file_path}}
```

Because `run` references `${{file_path}}`, the runner emits one invocation per matched markdown file. `${{file_path}}` is shell-quoted, so a path like `docs/README (draft).md` is safe.

### 3. Per-group invocation using `group_by` (per-package build)

```yaml
triggers:
  - paths:
      - packages/*/src/**/*.ts
    group_by: packages/*/
    commands:
      - run: bun run build
        cwd: ${{group_dir}}
```

`group_by: packages/*/` tells the runner to group matched files by their `packages/<name>/` directory, and `${{group_dir}}` expands to that directory's absolute path. So a change to `packages/foo/src/lib/util.ts` runs `bun run build` in `packages/foo/`. If files in two different packages change in the same Stop event, both packages get rebuilt: one invocation each. Each invocation has its own cooldown state, keyed by the resolved `(run, cwd)` pair.

### 4. Pruning subtrees with `ignore`

```yaml
# <project>/.claude/claude-tools-runner.yaml
ignore:
  - "e2e/**/tmp"
  - dist
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
```

The recursive scanner walks the project tree looking for `.claude/claude-tools-runner.yaml` files. With `ignore` set, any subdirectory whose project-relative path matches one of the listed globs is pruned before descent: configs (and changed files) inside it are never seen by the hook. Useful when smoke-test fixtures, build outputs, or vendored worktrees contain their own `.claude/` directories you don't want loaded. Only the project root config's `ignore` list applies; nested configs declare their own subtrees but cannot exclude others'.

### 5. Home + project, layered

`~/.claude/claude-tools-runner.yaml`:

```yaml
triggers:
  - paths:
      - "**/*.{ts,tsx}"
    commands:
      - run: prettier --check ${{file_path}}
```

`<project>/.claude/claude-tools-runner.yaml`:

```yaml
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
```

Inside this project both triggers run: a generic per-file `prettier --check` (from your home config) plus the project-specific test runner. Open a different project and only the home trigger is active.

## Troubleshooting

**Audit log: the canonical record of every Stop event.** Each configuration layer writes its own audit log under that layer's `.claude/claude-tools-runner/log/YYYY-MM/DD/HH.log` (plain text, human-readable) and `HH.json` (JSON Lines, machine-readable). The text log shows just the user-facing chain — `CONFIG` (which configs loaded), `CHANGE` (which files changed this Stop), `MATCH` (per-trigger result with the patterns and matched-file list), `CMD` (a command spawned), `PASS` / `FAIL` / `TIMEOUT` (the command finished, with `exit=N` on `FAIL` and the duration always). The JSON log additionally carries `hook_started`, `gate_decision` (cooldown/hash reasoning per command), `state_saved`, and `hook_completed` for programmatic queries. **If a trigger isn't firing, the `MATCH` line is where to look first**: it shows exactly which files matched its `paths` patterns and which didn't. Every command-scoped line is prefixed with `<sourceFile>:<commandLine>`, so you can jump straight from a log line to the command's `run:` key in your `claude-tools-runner.yaml`. Layer-specific entries route to the originating layer's log only; global entries (`hook_started`, `changed_files`, `hook_completed`, `hook_error`) fan out to every layer's log so each file is self-contained.

**Per-command output log.** Every spawned command's stdout and stderr are captured to a per-command file at `<scopeDir>/.claude/claude-tools-runner/log/YYYY-MM/DD/HH/<MM-SS-…>.log` (where `<scopeDir>` is the directory of the configuration file that produced the command), sitting next to that layer's audit log. Inside the file, every output line is prefixed with `[OUT] ` if it came from stdout or `[ERR] ` if it came from stderr, so you can tell the streams apart while still seeing them in the order they were produced. Each `command_started` and `command_result` audit entry carries a `logFile` field pointing at the file, so you can jump from "this command failed at 14:30" in the audit log to its full output without searching. When a command fails, that file is where the actual error message lives.

**Stdout/stderr contract with Claude Code.** Stop-hook stdout is reserved by Claude Code for structured JSON output the model can consume; non-JSON stdout for Stop hooks goes to the debug log only and is not shown to the user or the model. The runner therefore writes nothing to stdout: every routine event (config loads, gate decisions, per-command outcomes, the run summary) lands in the on-disk audit log under `.claude/claude-tools-runner/log/<YYYY-MM>/<DD>/<HH>.{json,log}`. Stderr is used only on the failure path (see below).

**Failure visibility (exit 2).** When at least one command fails, the hook emits one `[tools-runner] FAIL <sourceFile>:<line> "<expandedRun>" exit=N log=<logFile>` line per failed command followed by `[tools-runner] summary: <p> pass, <f> fail, <s> skip` on **stderr**, then exits with status `2`. Exit 2 is the documented Claude Code Stop-hook signal that means "blocking error": Claude Code feeds the hook's stderr back to the model on the next turn, so a failed command (a broken test, a lint regression, a missing file) is surfaced into the conversation rather than only into the on-disk audit log. The same exit-2 path is taken for the hook's own internal errors (malformed YAML, unset `CLAUDE_PROJECT_DIR`, oversized stdin, etc.). When every command passes the hook exits `0` with both streams empty and Claude Code stays silent.

**Verifying a trigger matches.** Run `git status --porcelain` in the project. Anything listed there is a candidate. The hook collects both staged and unstaged changes (and untracked files), skips deletions, and follows renames to the destination path. Cross-reference with the `changed_files` and `trigger_match` audit entries for the most recent Stop.

**Resetting state.** To force every trigger to fire on the next Stop event, delete the layer's `.claude/claude-tools-runner/runs/` directory and `.claude/claude-tools-runner/hashes.yaml` file (or the entire `.claude/claude-tools-runner/` directory; the plugin recreates it on the next run). Each configuration file has its own state directory next to it, so you can reset one nested repo's state without touching the parent. See [HOW_IT_WORKS.md](HOW_IT_WORKS.md) for what those files store.

**Bypassing cooldown for testing.** Set `cooldown: 0s` on the command. The hash gate still applies, so the command will only re-run when the matched files actually change. Combine with the state delete above to force every Stop event to re-run.

**`bun` not on `$PATH`.** If `bun` is not installed, the Stop hook silently fails to start (the shell can't `exec` it). Either install Bun or remove the hook line from `~/.claude/settings.json` / `plugin/hooks/hooks.json`. For *user-configured* commands that use `bun` (e.g. `bun run test`), a missing `bun` causes `sh -c` to exit 127, which the hook treats identically to any other non-zero exit (`FAIL exit 127`).

