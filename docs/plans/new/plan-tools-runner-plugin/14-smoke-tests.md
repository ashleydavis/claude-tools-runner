# Step 14: Smoke tests (bundle integrity + end-to-end behavior)

Add the two bash-driven smoke scripts that exercise the bundled `plugin/dist/stop-hook.js` end-to-end. Together with the unit tests from earlier steps, these scripts are responsible for proving every behavioral row of the hook-behavior table without an interactive Claude session.

## 14.1. `./scripts/hook-smoke-tests.sh` (plan section 16.2)

Starts with `chmod +x`. Builds the bundle, then runs:

- `run_test`: malformed JSON exits 1 (pipe `not-json` to the hook; assert exit code 1 and a stderr line matching the catalog literal).
- `run_test`: empty stdin exits 0 (pipe `''` to the hook; assert exit code 0: Stop hooks may receive empty payloads).
- `run_test`: missing `CLAUDE_PROJECT_DIR` exits 1 (unset the env var; assert exit code 1 and stderr matches `[tools-runner] CLAUDE_PROJECT_DIR is not set`).

Reports PASS/FAIL counts. Exits non-zero on any failure.

## 14.2. `./scripts/smoke-tests.sh` (plan section 16.1)

Starts with `chmod +x`. Builds the bundle once, then drives a series of scenarios end-to-end against the bundled hook by piping `'{}'` to `bun "$PROJECT_DIR/plugin/dist/stop-hook.js"` with `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT` exported. Each scenario uses a fresh `mktemp -d` directory, runs `git init`, and writes a `.claude/tools-runner.yaml`. All assertions are scripted (exit codes, file contents, mtimes, stdout greps): no human inspection.

### Scenarios

1. **First-run executes**: trigger with `run: "echo SMOKE_OK > smoke.out"`, glob `src/**/*.ts`, one `src/foo.ts` in working tree. Assert exit 0; stdout contains a trigger-run line; `smoke.out` exists and contains `SMOKE_OK`.

2. **Cooldown skip**: re-run immediately after scenario 1. Assert exit 0; stdout shows the cooldown skip reason; `smoke.out` mtime unchanged.

3. **Cooldown bypass via file change**: modify `src/foo.ts`, set `cooldown: "0s"` in YAML, re-run. Assert command re-executed (`smoke.out` mtime advanced).

4. **Clean-slate after state delete**: `rm .claude/tools-runner-state.yaml`, re-run. Assert command re-executes regardless of cooldown.

5. **Per-file template** (Issue 5: race-free): trigger with `run: "echo ${{file_path}} > per-file-$(basename ${{file_path}}).log"` (note the truncating `>` and per-file output name; `$(basename ${{file_path}})` resolves at shell-time inside the spawned `sh -c`, and the `${{file_path}}` substitution is shell-quoted by `expandPerFile`), `paths: ["**/*.md"]`, two markdown files in different directories (e.g., `a/x.md` and `b/y.md`). After Stop, assert:
   - `per-file-x.md.log` exists and contains exactly one line ending in `a/x.md`.
   - `per-file-y.md.log` exists and contains exactly one line ending in `b/y.md`.
   - No shared output file (`per-file.log` does not exist).
   Each command writes its own output file, so concurrent execution cannot race.

6. **Layered config**: write a home YAML (use `HOME=$(mktemp -d)` so the fake home is isolated) with one trigger and a project YAML with another trigger. Make changes that match both. Assert both commands ran in this Stop AND stdout shows lines tagged with both `~/.claude/tools-runner.yaml` and `.claude/tools-runner.yaml`.

7. **State file shape** (Issue 14): after scenario 1, parse `.claude/tools-runner-state.yaml` (use `bun -e` to round-trip it through the `yaml` package or a small inline `python` snippet) and assert:
   - `commandRuns` array length >= 1.
   - The entry has hex `commandKey`, `expandedRun`, `expandedCwd`, `sourceFile`, `sourceLine`, `lastRunAt`, `lastFilesHash`, `matchedFiles` fields (camelCase).
   - `fileHashes` has at least one entry.

The script reports PASS/FAIL per scenario and exits non-zero on any failure.

## Implementation notes

- Both scripts must be executable (`chmod +x`).
- Both scripts use `set -euo pipefail` for fail-fast behavior.
- Use `mktemp -d` for sandboxes; clean up with `trap 'rm -rf "$tmp"' EXIT` per scenario.
- Export `CLAUDE_PLUGIN_ROOT` to point at the project's `plugin/` directory so the bundled hook can find its sibling files (it doesn't read any, but the env contract from `hooks.json` should match).
- The bundle target path `plugin/dist/stop-hook.js` is created by `bun run bundle` at the top of each script.

## Verification

- `bash scripts/hook-smoke-tests.sh` exits 0 with all `run_test` cases reporting PASS.
- `bash scripts/smoke-tests.sh` exits 0 with all 7 scenarios reporting PASS.
- `bun run test:all` (which runs unit + hook-smoke + smoke as a single gate) exits 0.

Run all tests and confirm they pass before marking this step complete.

## Summary

_To be completed when this step is implemented._
