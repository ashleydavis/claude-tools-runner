# claude-tools-runner: Config Quick Reference

## File locations

- `~/.claude/claude-tools-runner.yaml` — all projects (home config)
- `<project>/.claude/claude-tools-runner.yaml` — that project only

Both optional; when both exist their triggers run independently.

## Top-level keys

Only two keys are valid — any other key is a parse error:

```yaml
ignore:    # optional — list of picomatch glob strings
triggers:  # required — list of trigger objects (may be empty)
```

### `ignore`

Glob patterns (picomatch) matched against project-relative directory paths. Matching subdirectories are pruned from the config scanner; configs inside them are never loaded. Only the project-root config's `ignore` list applies; nested configs cannot exclude other subtrees.

### `triggers`

A list of trigger objects (may be empty). A trigger fires when at least one file from `git status` (staged, unstaged, or untracked — deletions excluded) matches any of its `paths` patterns, then runs its `commands` subject to cooldown and hash gating.

#### Trigger object

| Field | Required | Default | Description |
|---|---|---|---|
| `paths` | no | (never fires) | picomatch globs relative to config file's directory; absent or empty = trigger never fires |
| `group_by` | no | — | glob that buckets files into groups; enables `${{group_dir}}` |
| `commands` | yes (≥ 1) | — | list of command objects |

`paths`: case-sensitive, supports `!` negations and `{a,b}` brace expansion.

#### Command object

| Field | Required | Default | Description |
|---|---|---|---|
| `run` | yes | — | shell command run via `sh -c`; supports variables |
| `cooldown` | no | `"1m"` | minimum time between runs; `"0s"` disables |
| `timeout` | no | `"5m"` | process is killed after this duration |
| `cwd` | no | `"${{project}}"` | working directory; supports variables |

#### Duration strings

Must be **quoted** — bare YAML numbers are rejected (e.g. `cooldown: 30` fails; use `"30s"`).
Format: `"<N>"` (seconds), `"<N>s"`, `"<N>m"`, `"<N>h"`, `"0"` or `"0s"` (disabled).
Decimals, negatives, `ms`, and `d` are not supported.

## Variables

Use `${{name}}` in `run` and `cwd` only — **not in `paths`**.

| Variable | Expands to | Invocations |
|---|---|---|
| `${{project}}` | Config file's directory (home config: `$CLAUDE_PROJECT_DIR`) | default `cwd` |
| `${{file_path}}` | Absolute path of matched file | one per file |
| `${{file_name}}` | Basename (e.g. `foo.ts`) | one per file |
| `${{file_basename}}` | Basename without extension (e.g. `foo`) | one per file |
| `${{file_ext}}` | Extension with dot (e.g. `.ts`); empty string if none | one per file |
| `${{file_dir}}` | Absolute directory of matched file | one per unique directory |
| `${{group_dir}}` | Absolute directory of matched group (requires `group_by`) | one per group |

All variables except `${{project}}` are shell-quoted when expanded into `run`; none are quoted in `cwd`.

**Invocation count (finest-granularity wins):**
1. `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` in `run`/`cwd` → one per matched file
2. `${{file_dir}}` in `run`/`cwd` → one per unique directory
3. `${{group_dir}}` in `run`/`cwd` (and `group_by` set) → one per group
4. None of the above → single invocation

Each invocation has its own cooldown state, keyed by the resolved `(run, cwd)` pair.

## Run gating

A command runs only when **both** conditions are met:
- The cooldown has elapsed since the last run of that `(run, cwd)` pair
- At least one matched file has changed since the last **successful** run (hash gate)

The hash gate applies even when `cooldown: "0s"`. To force a re-run, delete `.claude/claude-tools-runner/runs/` and `.claude/claude-tools-runner/hashes.yaml` (or the whole `.claude/claude-tools-runner/` directory — the plugin recreates it).

## `group_by`

A glob pattern that groups matched files by shared directory prefix; `${{group_dir}}` expands to that prefix as an absolute path. Common patterns: `packages/*/`, `apps/*/`, `*/`. Trailing `/` is optional. Files with no matching prefix are skipped with a stderr warning. `group_by` without `${{group_dir}}` in `run` or `cwd` has no effect on invocation count.

## Examples

Run tests when TypeScript files change:
```yaml
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
        cooldown: "30s"
        timeout: "5m"
```

Lint each changed Markdown file:
```yaml
triggers:
  - paths:
      - "**/*.md"
    commands:
      - run: markdownlint ${{file_path}}
        cooldown: "10s"
```

Build each changed package in a monorepo:
```yaml
triggers:
  - paths:
      - packages/*/src/**/*.ts
    group_by: packages/*/
    commands:
      - run: bun run build
        cwd: ${{group_dir}}
        cooldown: "30s"
```

Home config formatting + project tests, with build output excluded:
```yaml
# ~/.claude/claude-tools-runner.yaml
triggers:
  - paths:
      - "**/*.{ts,tsx}"
    commands:
      - run: prettier --write ${{file_path}}
        cooldown: "5s"
```
```yaml
# <project>/.claude/claude-tools-runner.yaml
ignore:
  - dist
  - node_modules
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
```
