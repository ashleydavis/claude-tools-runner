# Step 10: Build the prepared command list

Compose one layer's triggers (from step 4), the matched-files filter from step 7, and the template expansion from step 9 into a flat list of `CompiledCommandConfig[]` ready to be gated and executed. The registry never exposes its triggers: this function operates on a single layer's data, and the registry's `compileCommands(changed)` method calls into each layer's `compileCommands(changed)` (which delegates here with the layer's own stored triggers).

## Source: `./src/compile.ts` (plan section 11.1)

Export:

- `function compileCommands(triggers: Trigger[], sourceFile: string, ctx: TemplateContext, scopeDir: string, changed: ChangedFile[]): CompiledCommandConfig[]`:
  - Pure function. Takes one layer's triggers plus the metadata that layer would have stamped onto each entry (`sourceFile`, `ctx`, `scopeDir`). The standalone caller is `FileLayer.compileCommands(changed)` / `StaticLayer.compileCommands(changed)`, which pass their privately-held trigger list. There is no aggregated cross-layer input: the caller invokes this once per layer and the registry concatenates the results.
  - For each trigger, computes `matchedFiles` via `matchFiles(changed, trigger.paths ?? [])`. `trigger.paths` is optional: a missing or empty `paths` field is treated as an empty pattern list, which matches no files, so the trigger is skipped (not an error). Patterns are plain `scopeDir`-relative globs: no variable substitution. `matchFiles` does NOT receive a context. If `matchedFiles` is empty, skip the trigger entirely.
  - **Group-dir computation**. If `trigger.group_by` is set, compute `groupDir = findGroupDir(file.path, trigger.group_by)` for each matched file (step 9). If `groupDir` is `null`, log a stderr warning (`[tools-runner] ${sourceFile}:trigger ${triggerIndex}: file ${file.path} did not match group_by pattern ${trigger.group_by}, skipping`) and drop the file from `matchedFiles` for this trigger. The absolute group dir is `path.join(scopeDir, groupDir)`; that's what `${{group_dir}}` expands to.
  - **Validation**. If any command's `run` or `cwd` contains `${{group_dir}}` but `trigger.group_by` is unset, the trigger is invalid: throw at prepare time.
  - For each command in the trigger, applies the unified grouping rule: emit one `CompiledCommand` per unique `(expandedRun, expandedCwd)` pair, with `matchedFiles` set to the files that produced that pair. Granularity is determined by which variables appear (finest wins):

  | `run` or `cwd` contains | Granularity | Emit count |
  |---|---|---|
  | `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` | per-file | one per matched file |
  | only `${{file_dir}}` (no per-file vars) | per-directory | one per unique `path.dirname(absPath)` |
  | only `${{group_dir}}` (no finer vars) | per-group | one per unique `groupDir` |
  | none of the above | per-trigger | one with all matched files attached |

  - **Per-file**: use `expandPerFile(command.run, ctx, file, groupDir, { forShell: true })` and `expandPerFile(command.cwd, ctx, file, groupDir, { forShell: false })`. Each matched file produces one emit; `matchedFiles` is the single-element array.
  - **Per-directory**: bucket files by `path.dirname(file.absPath)`. Use `expandPerFile` against an arbitrary file in the bucket (any file in the bucket has the same `${{file_dir}}` value).
  - **Per-group**: bucket files by `groupDir`. Use `expandPerFile` against an arbitrary file in the bucket. The absolute group dir is `path.join(scopeDir, groupDir)`.
  - **Per-trigger**: use `expandStatic(command.run, ctx)` and `expandStatic(command.cwd, ctx)`: only `${{project}}` is in scope (which equals `scopeDir` for that layer). All matched files attached.

- Each emitted `CompiledCommand` carries:
  - `sourceFile` (display path of the layer the trigger came from: used in log lines).
  - `sourceLine` (1-based line number of the trigger inside `sourceFile`, copied from `Trigger.sourceLine` set by step 3's loader; surfaces in every audit-log entry that references the trigger).
  - `triggerIndexInFile` (0-based; log lines render `+1` if 1-based display is desired).
  - `commandIndex` (0-based index into `trigger.commands`).
  - `command` (the original `CommandConfig` object, post-defaults; e.g. `cooldown` defaults to `"1m"` if absent).
  - `expandedRun`, `expandedCwd` (post-expansion strings).
  - `commandKey = sha256(expandedRun + "\0" + expandedCwd)` (precomputed once during preparation; lookup key for state).
  - `matchedFiles: ChangedFile[]` (the files that produced this exact `(expandedRun, expandedCwd)` pair).

- The `commandKey`'s content-addressed structure means per-file, per-dir, and per-group emissions automatically have distinct cooldown state without further bookkeeping.

## Tests: `./src/test/compile.test.ts` (plan section 15.7)

Cover:

- A trigger with no per-file/dir/group variables emits one `CompiledCommand` containing all matched files.
- A trigger with `${{file_dir}}` in `cwd` (and no `${{file_path}}` or other per-file vars) emits one `CompiledCommand` per unique directory.
- A trigger with `${{file_path}}` in `run` emits one `CompiledCommand` per file (single-element `matchedFiles`).
- A trigger with `${{file_basename}}` in `run` emits one `CompiledCommand` per file.
- A trigger with `${{file_ext}}` in `run` emits one `CompiledCommand` per file.
- A trigger with `group_by: packages/*` and `${{group_dir}}` in `cwd` (and no per-file vars) emits one `CompiledCommand` per unique group prefix. Two files in different packages produce two emits; two files in the same package produce one emit with both files in `matchedFiles`.
- A trigger with `${{group_dir}}` in `cwd` but no `group_by` field throws at prepare time.
- A matched file whose path doesn't match `group_by` is dropped from `matchedFiles` for that trigger and a warning is logged. If all matched files are dropped, the trigger emits nothing.
- Triggers whose `paths` match no changed files emit nothing (no `CompiledCommand` for the trigger at all).
- A trigger with `paths` missing or empty emits nothing (not an error; treated the same as matching no changed files).
- A trigger with a same `(expandedRun, expandedCwd)` defined in two separate `compileCommands` invocations (e.g., one for the home layer and one for a project layer) produces two `CompiledCommand`s with the SAME `commandKey` (so both share state: last-write-wins). Document this as an intentional consequence of content-addressed keys. Tests model this by calling `compileCommands` twice with different `sourceFile` arguments and the same trigger fixture.
- Each emitted `CompiledCommand` has `sourceFile` set to the value passed to `compileCommands`.
- Each emitted `CompiledCommand` has `sourceLine` copied verbatim from the source trigger (`Trigger.sourceLine`), so all `CompiledCommand`s emitted from the same trigger (one-per-file, one-per-dir, one-per-group, or one-per-trigger fan-out) share the same `sourceLine`.
- `triggerIndexInFile` is the trigger's 0-based position in the `triggers` array passed to this call (the layer's own ordering); it is NOT the trigger's position across any concatenated/aggregated list.
- **`${{project}}` bound to `scopeDir`**: calling `compileCommands` with `ctx: { projectDir: "/abs/myconfig" }` and a command `cwd: "${{project}}"` produces `expandedCwd === "/abs/myconfig"`.
- **Per-group absolute dir**: the absolute group dir is `path.join(scopeDir, groupDir)`.

Tests call `compileCommands` directly with fixture trigger arrays and synthetic `sourceFile`/`ctx`/`scopeDir` values; they do NOT need to construct a `StaticLayer` or `FileLayer` (the layer wrappers are tested separately in step 4 via their `compileCommands(changed)` methods).

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Implemented the prepared-command compilation pipeline in `src/compile.ts`. The exported `compileCommands` function now filters changed files through `matchFiles` (step 7), resolves each file's group directory via `findGroupDir` (step 9, dropping mismatched files with the specified stderr warning), validates that every command using `${{group_dir}}` belongs to a trigger that declares `group_by`, and dispatches to one of four emission paths based on which template variables appear in `run`/`cwd`:

- `emitPerFile` — fires when any per-file variable (`file_path`, `file_name`, `file_basename`, `file_ext`) appears.
- `emitPerDirectory` — fires when only `${{file_dir}}` appears.
- `emitPerGroup` — fires when only `${{group_dir}}` appears.
- `emitPerTrigger` — falls through; uses `expandStatic` so only `${{project}}` is in scope.

Each emission path runs through `buildCompiledCommand`, which centralises the `commandKey = sha256(expandedRun + 0x00 + expandedCwd)` derivation via `computeCommandKey`. The absolute group dir passed to `expandPerFile` is `path.join(scopeDir, relativeGroupDir)` so `${{group_dir}}` substitutes to the absolute path.

Files changed:

- `src/compile.ts` — full rewrite. Adds `IMatchedFileWithGroup` and the helpers `computeCommandKey`, `buildCompiledCommand`, `resolveGroupDirsForFiles`, `validateGroupDirUsage`, `emitPerFile`, `emitPerDirectory`, `emitPerGroup`, `emitPerTrigger`. Each is exported per the per-function-direct-test rule in `CLAUDE.md`.
- `src/template.ts` — adds `FILE_DIR_VARIABLE_REGEX` and exports a new `hasFileDirVariable` helper used by `compileCommands` to detect the per-directory tier.
- `src/test/compile.test.ts` — restructured around the new fan-out semantics. Covers per-file/per-dir/per-group/per-trigger granularity, `group_by` validation, `findGroupDir` dropping with warnings, content-addressed `commandKey` reuse across layers, and direct unit tests for every new helper.
- `src/test/template.test.ts` — adds a `hasFileDirVariable` describe block.

Decisions worth noting:

- All new internal helpers are exported so they can be directly unit tested per the `CLAUDE.md` rule that every function should have its own tests.
- The default `cwd` template (`${{project}}`) is now expanded through `expandStatic` for per-trigger emissions, so `expandedCwd` for an unset `cwd` resolves to `ctx.projectDir` (the layer's `scopeDir`). The pre-step-10 stub stored the raw `${{project}}` literal; existing tests that asserted on the literal were updated to expect the expanded value.
- The `paths`-no-match-no-emit and `paths`-empty-no-emit cases are both routed through `matchFiles`, which already implements the `[]`/`undefined` semantics; no separate branch was needed in `compileCommands`.

Verification: `bun run compile` passes; `bun run test` passes 355 tests across 9 suites. The `bun run smoke` target is not exercised here because the smoke harness (`scripts/smoke-tests.sh`) is scheduled for step 14 and has never existed in git history.

Nothing was deferred.
