# Step 4: Trigger registry (FileLayer + TriggerRegistry)

Wrap the per-file config loader from step 3 in a layered registry. The registry accepts a variable number of layers (home + one per found config file). Each layer encapsulates its own triggers (they are never exposed or concatenated). Each layer carries a `scopeDir` (the directory the config file governs) and a `TemplateContext`. Each layer is loaded once at construction time; there is no in-process file watcher (the Stop hook is one-shot, so per-Stop process re-spawn is the reload path).

## Source: `./src/trigger-registry.ts` (plan section 5)

Export:

- `interface ITriggerLayer`: triggers stored inside a layer are NEVER exposed or concatenated. The interface only exposes per-layer metadata and the operations the registry needs:
  - `sourceFile: string`: display path used in log lines. Each trigger's per-trigger `sourceLine` is stamped onto the trigger by `loadConfigFile` in step 3 and travels with the trigger inside `_triggers`; the layer itself does not need a separate field for it.
  - `scopeDir: string`: directory the config governs; `${{project}}` expands to `scopeDir` for that layer's triggers.
  - `ctx: TemplateContext`: the layer's expansion context (`{ projectDir: scopeDir }`).
  - `isEmpty(): boolean`: true when the layer holds zero triggers.
  - `compileCommands(changed: ChangedFile[]): CompiledCommandConfig[]`: produces this layer's `CompiledCommandConfig[]` for the given changed-file set. Internally calls the pure `compileCommands(triggers, sourceFile, ctx, scopeDir, changed)` function from `compile.ts` (step 10), passing its own stored trigger list. The trigger list itself never crosses the layer boundary.

- `class StaticLayer implements ITriggerLayer`:
  - Wraps a fixed `Trigger[]` stored on a private field (used by tests).
  - Constructor: `constructor(triggers: Trigger[], sourceFile: string, scopeDir: string, ctx: TemplateContext)`.
  - `isEmpty()` returns `this._triggers.length === 0`.
  - `compileCommands(changed)` delegates to the pure `compileCommands` function with the stored triggers.
  - Tests pass synthetic values so log output unambiguously identifies the layer.
  - `StaticLayer` is test-only; production always uses `FileLayer`.

- `class FileLayer implements ITriggerLayer`:
  - Private constructor stores already-loaded fields including `_triggers`, `scopeDir`, and `ctx`. The `_triggers` field is private; nothing outside the class reads it. The loaded triggers never change for the lifetime of the layer.
  - `static async create(filePath: string | null, displayFile: string, scopeDir: string, ctx: TemplateContext): Promise<FileLayer>` awaits `loadConfigFile(filePath)` (or yields empty triggers if `filePath` is `null` or the file is missing) before instantiating. Parse and validation errors thrown by `loadConfigFile` are NOT caught inside `create`: the rejection propagates out so the stop-hook's top-level `try/catch` can write `[tools-runner] failed to load ${displayFile}: ${err.message}` to stderr, emit a `hook_error` audit-log entry, and exit 1.
  - `isEmpty()` returns `this._triggers.length === 0`.
  - `compileCommands(changed)` delegates to the pure `compileCommands` function from `compile.ts` with `this._triggers`, `this.sourceFile`, `this.ctx`, `this.scopeDir`, and `changed`.
  - Exposes `sourceFile`, `scopeDir`, and `ctx` so the registry's `CompiledCommandConfig[]` output and any log lines that reference the layer can identify it.

- `class TriggerRegistry`:
  - Constructor: `constructor(layers: ITriggerLayer[])`: accepts a variable number of layers (home + N layers, one per found config file; N may be zero).
  - `isEmpty(): boolean`: returns `true` when every layer's `isEmpty()` returns `true`. The Stop hook uses this to decide whether to log `no triggers configured, skipping`.
  - `compileCommands(changed: ChangedFile[]): CompiledCommandConfig[]`: iterates layers in registration order and concatenates the result of `layer.compileCommands(changed)` for each. Layer boundaries are preserved through each `CompiledCommand`'s `sourceFile`. The registry NEVER inspects, exposes, or aggregates trigger lists: it only composes per-layer outputs.

## Implementation conventions (plan)

- Construction-time loads use `await loadConfigFile(...)` from step 3.
- Every IO path is async via `node:fs/promises` (no Bun-specific APIs, no callback-style `node:fs`).

## Tests: `./src/test/trigger-registry.test.ts` (plan section 15.2)

Trigger lists are NOT exposed by the layer or registry, so all behavioural tests verify state through `isEmpty()` and `compileCommands(changed)` rather than reading raw triggers.

Cover:

- `StaticLayer` reports `isEmpty(): false` for a non-empty trigger fixture and `isEmpty(): true` for `[]`. Exposes the constructed `sourceFile`, `scopeDir`, and `ctx`. `compileCommands` against a fixture changed-file set returns the expected `CompiledCommandConfig[]`.
- `FileLayer` constructed with a non-existent path: `isEmpty()` is `true`, `compileCommands` returns `[]`, no thrown error.
- `FileLayer` constructed with a valid YAML file: `isEmpty()` is `false`, exposes the constructed `sourceFile`, `scopeDir`, and `ctx`, and `compileCommands` against a matching changed-file set produces the expected output.
- `FileLayer.create` against a YAML file that fails to parse or validate rejects with the underlying parse/validation error. The `create` method does not write to stderr and does not return a partially-constructed layer: error reporting (stderr line, `hook_error` audit entry, exit 1) is handled by the stop-hook's top-level `try/catch` in step 13.
- `TriggerRegistry.isEmpty()` returns `true` when every layer's `isEmpty()` is `true`, and `false` if any layer holds triggers.
- `TriggerRegistry.compileCommands(changed)` iterates layers in registration order: a registry built from `[homeLayer, configLayerA, configLayerB]` returns home's `CompiledCommandConfig[]` followed by A's followed by B's.
- A registry containing zero config layers (just home) produces the expected output.
- A registry containing two config layers (with different `scopeDir` values) produces `CompiledCommand`s tagged with their own layer's `sourceFile`: outputs from layer A never carry layer B's `sourceFile` or expand `${{project}}` to layer B's `scopeDir`.

## Why there is no watcher

The Stop hook spawns a fresh `bun` process for every Claude turn, which reads each YAML from disk during construction. That gives the same effect as a watcher for any edit made between turns. An in-process watcher would only ever fire while a command was already running, by which point the triggers had already been evaluated for this invocation, so a reload could not change which commands ran. The complexity of `fs.watchFile`, `dispose()`, and reload-error retention is therefore not worth carrying.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests (this file + step 3's) green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Wrapped step 3's loader in the layered registry described in the plan:

- `src/template.ts`: minimal new module exporting only `interface TemplateContext { projectDir: string; }`. Step 9 (template expansion) will fill in `expandStatic`, `expandPerFile`, `findGroupDir`, `shellQuote`, `hasPerFileVariable`, and `hasGroupDirVariable` here. The interface is owned by `template.ts` so the layer/registry types do not need to import from `compile.ts`.
- `src/compile.ts`: new module exporting `compileCommands(triggers, sourceFile, ctx, scopeDir, changed): CompiledCommand[]`. The current implementation handles only the per-trigger granularity case: `[]` when `changed` is empty, otherwise one `CompiledCommand` per `(trigger, command)` pair for every trigger whose `paths` is non-empty. Glob filtering of `changed` against `paths`, template variable expansion, group-by handling, and per-file/per-dir/per-group fan-out land in steps 7, 9, and 10 (which will extend this module's body and the existing `compile.test.ts`). `commandKey` is computed via `node:crypto` `sha256(expandedRun + "\0" + expandedCwd)` exactly as the plan specifies; `expandedCwd` defaults to `"${{project}}"` when `command.cwd` is undefined to mirror `parseCommand`'s YAML-side default.
- `src/test/compile.test.ts`: covers the current `compileCommands` behavior — empty inputs, undefined/empty `paths` skip, one emission per `(trigger, command)`, `sourceFile` / `sourceLine` / `triggerIndexInFile` / `commandIndex` stamping, `matchedFiles` is the supplied `changed` array, `expandedCwd` defaulting and verbatim preservation, and `commandKey` algorithm including same-pair sharing and different-pair distinguishability. Step 10 will extend this file when it lands the granularity fan-out and template expansion.
- `src/trigger-registry.ts`: exports `interface ITriggerLayer`, `class StaticLayer` (test-only), `class FileLayer` (production, async `static create(...)`), and `class TriggerRegistry`. Each layer holds its `Trigger[]` on a private `_triggers` field and never exposes it: only `isEmpty()` and `compileCommands(changed)` cross the layer boundary. Both layer types delegate `compileCommands(changed)` to the pure `compileCommands` from `compile.ts` with their own stored trigger list, layer metadata, and the supplied `changed` set. `FileLayer.create` calls `loadConfigFile`; a `null` path or a `loadConfigFile` `null` return (file missing) yields a layer with zero triggers, while parse/validation errors propagate uncaught so the eventual stop-hook `try/catch` (step 13) can format the stderr line and audit-log entry. `TriggerRegistry.compileCommands(changed)` iterates layers in registration order and concatenates their per-layer outputs; `isEmpty()` is true only when every layer's `isEmpty()` is true.
- `src/test/trigger-registry.test.ts`: covers each test in the plan list — `StaticLayer` `isEmpty()` true/false plus `sourceFile`/`scopeDir`/`ctx` exposure plus `compileCommands` output shape, `FileLayer` with non-existent path / null path / valid YAML / unparseable YAML / validation-failing YAML, `TriggerRegistry` `isEmpty()` composition over multiple layers and zero layers, `compileCommands` ordering across `[home, configA, configB]`, registry with only the home layer, and two-config-layer cross-contamination guard (output `sourceFile` always matches the producing layer). One extra sanity test exercises a custom `ITriggerLayer` implementation through the registry to confirm the interface is a sufficient contract.

The "expand `${{project}}` to layer B's `scopeDir`" portion of the cross-contamination test is deferred to `compile.test.ts` (step 10): the current `compileCommands` does not perform template expansion, so the present test only verifies that each `CompiledCommand`'s `sourceFile` matches its producing layer.

Verification: `bun run compile` clean; `bun run test` runs 111 tests across 3 suites green (the two pre-existing suites plus the new `trigger-registry.test.ts`). `bun run smoke` is not yet wired up (the smoke-test script lands in step 14); step 4's verification block only calls for compile + test, both green.
