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

_To be completed when this step is implemented._
