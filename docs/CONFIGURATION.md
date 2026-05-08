# Configuration

How to write `tools-runner.yaml` files.

## Configuration files

All locations are optional. If multiple exist, their triggers all run.

- `~/.claude/tools-runner.yaml`: **home config**. Applies to every project you open with Claude Code. Useful for editor-style triggers (formatters, linters) you want everywhere.
- Any `.claude/tools-runner.yaml` found by scanning downward from `$CLAUDE_PROJECT_DIR`: each such file's triggers apply only to files within that file's own directory and below.

## Schema reference

Each YAML file has one top-level key: `triggers`.

- **`triggers`**: list, required (may be empty). An empty list is valid (the file is in place but quiet).
  - **`paths`**: list of strings, optional (may be missing or empty). [picomatch](https://github.com/micromatch/picomatch) glob patterns applied to repo-relative POSIX paths. A trigger fires if any changed file matches any pattern. An empty or absent `paths` list is not an error: the trigger simply never fires. Negations (`!`) exclude. Brace expansion (`*.{ts,tsx}`) is supported. Case-sensitive.
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

In your `tools-runner.yaml` config file, you can write `${{name}}`-style variables into certain fields and they'll be replaced with real values when a trigger fires. For example:

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
# <project>/.claude/tools-runner.yaml
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
```

Whenever any `.ts` file under `src/` shows up in `git status`, `bun run test` runs once. For the next 30 seconds, subsequent Stop events skip with `in cooldown`. After that, if the matched files are unchanged the run is skipped with `no file changes since last successful run`; if they've changed it runs again.

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

### 4. Home + project, layered

`~/.claude/tools-runner.yaml`:

```yaml
triggers:
  - paths:
      - "**/*.{ts,tsx}"
    commands:
      - run: prettier --check ${{file_path}}
```

`<project>/.claude/tools-runner.yaml`:

```yaml
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
```

Inside this project both triggers run: a generic per-file `prettier --check` (from your home config) plus the project-specific test runner. Open a different project and only the home trigger is active.

## Troubleshooting

**Audit log: the canonical record of every Stop event.** Every invocation writes a sequence of structured entries to `<project>/.claude/tools-runner-log/YYYY-MM/DD/HH.log` (plain text, human-readable) and `HH.json` (JSON Lines, machine-readable). Entry types include `hook_started`, `config_load`, `changed_files`, `trigger_match` (per trigger, with both **matched** and **unmatched** file lists), `gate_decision` (per command, with the cooldown/hash reasoning), `command_started`, `command_result`, `state_saved`, and `hook_completed`. **If a trigger isn't firing, this is where to look first**: the `trigger_match` entry for it shows exactly which files matched its `paths` patterns and which didn't. Every trigger-scoped entry is prefixed with `<sourceFile>:<sourceLine>` (the YAML file path and the line where that trigger begins), so you can jump straight from a log line to the line in your `tools-runner.yaml` that produced it.

**Per-command output log.** Every spawned command's stdout and stderr are captured to a per-command file at `<project>/.claude/tools-runner-log/YYYY-MM/DD/HH/<MM-SS-…>.log`, sitting next to the audit log. Inside the file, every output line is prefixed with `[OUT] ` if it came from stdout or `[ERR] ` if it came from stderr, so you can tell the streams apart while still seeing them in the order they were produced. Each `command_started` and `command_result` audit entry carries a `logFile` field pointing at the file, so you can jump from "this command failed at 14:30" in the audit log to its full output without searching. When a command fails, that file is where the actual error message lives.

**Stdout summary.** Alongside the audit log, the hook also writes a one-line summary per command to stdout (visible in Claude Code's hook output panel): `PASS`, `SKIP <reason>`, or `FAIL <reason>`: and a final `[tools-runner] summary: <p> pass, <f> fail, <s> skip`. Quick-glance signals; the audit log is the deep-dive reference.

**Verifying a trigger matches.** Run `git status --porcelain` in the project. Anything listed there is a candidate. The hook collects both staged and unstaged changes (and untracked files), skips deletions, and follows renames to the destination path. Cross-reference with the `changed_files` and `trigger_match` audit entries for the most recent Stop.

**Resetting state.** To force every trigger to fire on the next Stop event, delete `<project>/.claude/tools-runner-state.yaml`. (See [HOW_IT_WORKS.md](HOW_IT_WORKS.md) for what the state file stores.)

**Bypassing cooldown for testing.** Set `cooldown: 0s` on the command. The hash gate still applies, so the command will only re-run when the matched files actually change. Combine with the state-file delete above to force every Stop event to re-run.

**`bun` not on `$PATH`.** If `bun` is not installed, the Stop hook silently fails to start (the shell can't `exec` it). Either install Bun or remove the hook line from `~/.claude/settings.json` / `plugin/hooks/hooks.json`. For *user-configured* commands that use `bun` (e.g. `bun run test`), a missing `bun` causes `sh -c` to exit 127, which the hook treats identically to any other non-zero exit (`FAIL exit 127`).

