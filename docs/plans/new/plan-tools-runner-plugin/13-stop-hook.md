# Step 13: Stop hook entry point

Tie all earlier modules together into the actual Stop hook executable. Reads stdin, parses JSON, applies the recursion guard, scans for all config files at or under the project directory, builds the layered registry, collects changed files per config scope, prepares commands, runs them, saves state, and prints a summary.

## Source: `./src/stop-hook.ts` (plan section 14)

There is no global wall-clock cap. Per-command `timeout` (default `"5m"`) bounds each spawned command; the hook awaits all of them and exits naturally. No abort timer, no `activeChildren` set, no force-kill loop.

### 13.1. Stdin reader

`async function readStdin(): Promise<string>`:
- Iterates `for await (const chunk of process.stdin)`, accumulates `Buffer`s, tracks `total += chunk.length` after each chunk.
- On `total > 1024 * 1024` (1 MiB cap, Issue 21): call `process.stdin.destroy()` and reject with `Error("stdin payload exceeded 1 MiB cap")`.
- Returns the concatenated string when stdin closes normally.
- No callbacks, no blocking, no `*Sync`.

### 13.2. `async function runStopHook(): Promise<void>`

1. Read stdin via `readStdin()`. Parse JSON as `StopHookInput` (tolerate empty input → `{}`). On JSON parse error, write `[tools-runner] stdin is not valid JSON: ${err.message}` to stderr and exit 1. On stdin cap exceeded, write `[tools-runner] stdin payload exceeded 1 MiB cap` to stderr and exit 1.

2. **Recursion guard** (Issue 7). If `input.stop_hook_active === true`, log `[tools-runner] stop_hook_active set, skipping to avoid recursion` to stdout and `return` (effective exit 0). This MUST run before any other IO so a recursive Stop event cannot itself spawn git or read YAML.

3. Resolve `projectDir` from `process.env["CLAUDE_PROJECT_DIR"]`. If missing, write `[tools-runner] CLAUDE_PROJECT_DIR is not set` to stderr and exit 1.

4. Scan for config files via `await scanConfigFiles(projectDir)`. This returns all `.claude/tools-runner.yaml` paths found at or under `projectDir`. Each config file's containing `.claude/` directory defines the `scopeDir` for that layer.

5. Build the layered registry. The registry receives a variable number of layers (home + one per found config file):
   ```ts
   const homeLayer = await FileLayer.create(
       homeConfigPath(),
       homeDisplayPath(),
       process.env["HOME"] ?? "",
       { projectDir: process.env["HOME"] ?? "" }
   );
   const configLayers: FileLayer[] = [];
   for (const configPath of configFilePaths) {
       const scopeDir = path.dirname(path.dirname(configPath)); // parent of .claude/
       const layer = await FileLayer.create(
           configPath,
           path.relative(projectDir, configPath),
           scopeDir,
           { projectDir: scopeDir }
       );
       configLayers.push(layer);
   }
   const registry = new TriggerRegistry([homeLayer, ...configLayers]);
   ```
   If `registry.isEmpty()` (every layer holds zero triggers), log `[tools-runner] no triggers configured, skipping` to stdout and exit 0.

6. Load state via `await loadState(statePath(projectDir))`.

7. Collect changed files: for each `scopeDir` (one per config layer found by `scanConfigFiles`), `await collectChangedFiles(scopeDir)`. On the first result that is `"git-missing"`, log `[tools-runner] git binary not found on PATH, skipping` to stdout and exit 0. Concat all `ChangedFile[]` results into a single array. If the union is empty, log `[tools-runner] no changed files, skipping` and exit 0.

8. Build `CompiledCommandConfig[]` via `registry.compileCommands(changed)` (pure-compute, synchronous). The registry iterates its layers in registration order and concatenates each layer's `compileCommands(changed)` output; trigger lists themselves never cross the layer boundary. If the result is empty, log `[tools-runner] no triggers matched, skipping` and exit 0.

9. `await runCommands(prepared, state, new Date());`.

10. Save state via `await saveState(statePath(projectDir), state)`. If `saveState` rejects, the top-level `try/catch` surfaces it as `[tools-runner] cannot write state file: ${err.message}` on stderr and exit 1.

11. Print summary line to stdout: `[tools-runner] summary: ${pass} pass, ${fail} fail, ${skip} skip` and exit 0.

### 13.3. Error handling

Wrap the body in `try/catch`; on any error write `String(err) + "\n"` to stderr and `process.exit(1)`.

### 13.4. Module guard

Guard the auto-invocation with `if (process.env["NODE_ENV"] !== "test") runStopHook();`. This is what makes `stop-hook.test.ts` able to import the module without triggering its main path.

### 13.5. Output streams

Confirm the file uses `process.stdout.write` / `process.stderr.write` exclusively (no audit log, no debug log, plan section 14.2). All log lines match the catalog in plan section "Log line catalog" exactly: substrings of these literals are what the smoke tests grep for.

## Tests: `./src/test/stop-hook.test.ts` (plan section 15.11)

Cover:

- Importing the module under `NODE_ENV=test` does NOT auto-run.
- Calling `runStopHook` with `CLAUDE_PROJECT_DIR` unset writes to stderr and exits with code 1 (use a stubbed `process.exit` thrown sentinel).
- Calling `runStopHook` for a project that has no git repo returns `"git-missing"` from `collectChangedFiles` and logs `[tools-runner] git binary not found on PATH, skipping` and exits 0 when git is unavailable, OR exits with no changed files when a repo exists but has no changes.
- Calling `runStopHook` with multiple config files found by `scanConfigFiles` collects changed files from each `scopeDir` and unions them into the prepared-command pipeline.
- Calling `runStopHook` with both home and project YAML present runs triggers from both layers (use `HOME` and `CLAUDE_PROJECT_DIR` env vars pointing at temp dirs initialized as git repos with changed files).
- **`stop_hook_active` early exit** (Issue 13): stdin JSON `{"stop_hook_active": true}` produces only the skip log line. Spy on `scanConfigFiles` and `loadState` and assert zero calls. Exit 0.
- **Malformed home + valid project** (Issue 13): home YAML contains invalid syntax; project YAML is well-formed. Assert: stderr has one parse-error line tagged with `~/.claude/tools-runner.yaml`; the audit log contains a `hook_error` entry; no commands run (the project trigger does NOT fire because the hook aborts before evaluating triggers); exit 1.
- **Nested config loaded**: project at `<tmpdir>/proj`, a nested config at `<tmpdir>/proj/sub/.claude/tools-runner.yaml` with `scopeDir = <tmpdir>/proj/sub`. The nested trigger fires when a file under `sub/` changes; `${{project}}` in that trigger's `cwd` resolves to `<tmpdir>/proj/sub`, NOT `<tmpdir>/proj`.
- **Scope isolation**: project at `<tmpdir>/proj`, two nested configs at `<tmpdir>/proj/a/.claude/tools-runner.yaml` and `<tmpdir>/proj/b/.claude/tools-runner.yaml`. A change to a file under `a/` triggers ONLY `a`'s commands; `b`'s trigger does not fire.

Tests use `await fs.mkdtemp(...)`, `await fs.writeFile(...)` from `node:fs/promises` (no Bun-specific APIs), and `git init` via `child_process.spawn` from `node:child_process` + a Promise wrapper around `close`/`error` for fixture setup. Stub `process.stdout.write` / `process.stderr.write` to capture output.

## Verification

- `bun run compile` passes.
- `bun run bundle` produces `plugin/dist/stop-hook.js` (file exists, non-zero size).
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

_To be completed when this step is implemented._
