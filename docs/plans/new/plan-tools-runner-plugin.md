# Tools Runner Claude Plugin

## Implementation Steps

- [x] 1. Write documentation: `plan-tools-runner-plugin/1-write-documentation.md`
- [x] 2. Project skeleton, manifest files, and core types: `plan-tools-runner-plugin/2-project-skeleton.md`
- [x] 3. Config loader (layered: home + project + per-repo): `plan-tools-runner-plugin/3-config-loader.md`
- [ ] 4. Trigger registry (FileLayer + TriggerRegistry): `plan-tools-runner-plugin/4-trigger-registry.md`
- [ ] 5. State file: `plan-tools-runner-plugin/5-state-file.md`
- [ ] 6. Git changed-files collector: `plan-tools-runner-plugin/6-git-collector.md`
- [ ] 7. Glob matcher: `plan-tools-runner-plugin/7-glob-matcher.md`
- [ ] 8. File hashing with cache: `plan-tools-runner-plugin/8-file-hashing.md`
- [ ] 9. Template expansion: `plan-tools-runner-plugin/9-template-expansion.md`
- [ ] 10. Build the prepared command list: `plan-tools-runner-plugin/10-compile-commands.md`
- [ ] 11. Cooldown and hash gating: `plan-tools-runner-plugin/11-cooldown-gate.md`
- [ ] 12. Command runner: `plan-tools-runner-plugin/12-command-runner.md`
- [ ] 13. Stop hook entry point: `plan-tools-runner-plugin/13-stop-hook.md`
- [ ] 14. Smoke tests (bundle integrity + end-to-end behavior): `plan-tools-runner-plugin/14-smoke-tests.md`
- [ ] 15. Audit log: `plan-tools-runner-plugin/15-audit-log.md`
- [ ] 16. Update documentation: `plan-tools-runner-plugin/16-update-documentation.md`
- [ ] 19. GitHub Workflows (CI + publish): `plan-tools-runner-plugin/19-github-workflows.md`

## Overview
Build a new Claude Code plugin here called `tools-runner` that hooks the `Stop` event. When Claude finishes a turn, the hook inspects the current git repository for changed files (unstaged working-tree changes plus staged changes), matches those files against user-defined glob triggers in YAML, and runs the configured commands. Each command has its own cooldown window during which it will not be re-triggered, and the hook records a hash of the matched files so a command is re-run only when those files have actually changed since the last successful run. The plugin is built with Bun + TypeScript, prints debug info to stdout and errors to stderr (no audit log, no debug log), and dogfoods itself by running `bun run test` whenever its own TypeScript files change.

Configuration is layered: the hook reads `~/.claude/tools-runner.yaml` (home) and every `.claude/tools-runner.yaml` found by scanning downward from `$CLAUDE_PROJECT_DIR`. Each YAML file is wrapped in a `FileLayer` that loads on construction. Triggers are private to their layer: layers and the registry never expose or concatenate trigger lists. Instead, each layer exposes `compileCommands(changed)` and the registry's `compileCommands(changed)` calls each layer in registration order (home first, then found configs in discovery order) and concatenates their per-layer `CompiledCommandConfig[]` outputs. Each found config file's scope is its own containing directory (`scopeDir`), and `${{project}}` resolves to `scopeDir` within that config. The Stop hook is one-shot: every time Claude finishes a turn, it spawns a fresh `bun` process which constructs the registry from scratch, so any YAML edit made between turns is picked up before triggers are evaluated. There is no in-process file watcher: a YAML edit made while a command is mid-flight does not affect the current invocation (it will be picked up on the next Stop event).

## Hook behavior

The table below is the contract: every situation the Stop hook can encounter, what it logs, and what exit code it returns. These are the routine, expected outcomes: most invocations land on one of these rows on every Claude turn. The default policy is graceful skip (log + exit 0) so that nothing about the user's environment can block their Claude session; only situations where the hook genuinely cannot interpret its inputs return exit 1. Every row here is a code path the implementation must include and the smoke or unit tests must cover.

| Situation | Behavior | Exit |
|---|---|---|
| Stdin JSON has `stop_hook_active: true` | Log `[tools-runner] stop_hook_active set, skipping to avoid recursion` to stdout; exit before any git/YAML/state IO | 0 |
| `git` binary not on `$PATH` | Log `[tools-runner] git binary not found on PATH, skipping` to stdout | 0 |
| `CLAUDE_PROJECT_DIR` env unset | Log error to stderr | 1 |
| Stdin empty | Treat as `{}` and proceed | 0 |
| Stdin is not valid JSON | Log error to stderr | 1 |
| Stdin payload exceeds 1 MiB cap | Log `[tools-runner] stdin payload exceeded 1 MiB cap` to stderr; destroy stdin; treat as malformed-JSON | 1 |
| Every layer empty (no home, project, or per-repo YAML provided any triggers) | Log `[tools-runner] no triggers configured, skipping` to stdout | 0 |
| Any one YAML has a parse or validation error | Log error to stderr and to the audit log as a `hook_error` entry; abort the hook without running any commands | 1 |
| State file missing | Treat as empty state and proceed (this is the first-run path) | 0 |
| State file corrupt | Log error to stderr, treat as empty state, proceed | 0 |
| No changed files in working tree | Log `[tools-runner] no changed files, skipping` to stdout | 0 |
| Changed files exist but no glob matches any trigger | Log `[tools-runner] no triggers matched, skipping` to stdout | 0 |
| Command exits non-zero (including exit 127 = command-not-found from `sh -c`) | Log `FAIL` line for that command; do NOT update its `lastFilesHash` (so it re-runs next Stop); other commands continue | 0 |
| Command exceeds per-command `timeout` | Kill the process, log `FAIL timeout` line, do NOT update state for that command | 0 |
| Cannot write state file (permission denied, disk full) | Log error to stderr | 1 |
| Any other unhandled exception in the hook | Top-level `try/catch` writes `String(err) + "\n"` to stderr | 1 |

## Log line catalog

These are the canonical stdout/stderr strings for each routine outcome. They are the literal arguments to `process.stdout.write` / `process.stderr.write` (with a trailing `\n` appended by the writer). Smoke tests grep for these exact substrings. Variable parts are written in `${...}` form so the catalog is unambiguous about what is hard-coded versus interpolated.

| Stream | Literal | Emitted when |
|---|---|---|
| stdout | `[tools-runner] stop_hook_active set, skipping to avoid recursion` | Recursion guard fires (Issue 7). |
| stdout | `[tools-runner] git binary not found on PATH, skipping` | `collectChangedFiles` returns `"git-missing"`. |
| stdout | `[tools-runner] no triggers configured, skipping` | Every layer (home + per found config) absent or empty. |
| stdout | `[tools-runner] no changed files, skipping` | `collectChangedFiles` returned `[]`. |
| stdout | `[tools-runner] no triggers matched, skipping` | `compileCommands` returned `[]`. |
| stdout | `[tools-runner] ${sourceFile}:trigger ${triggerIndexInFile} cmd ${commandIndex} cwd=${expandedCwd} run=${expandedRun}: PASS ${reason}` | Command exited 0. |
| stdout | `[tools-runner] ${sourceFile}:trigger ${triggerIndexInFile} cmd ${commandIndex} cwd=${expandedCwd} run=${expandedRun}: FAIL ${reason}` | Command exited non-zero. `${reason}` is `"exit ${code}"` or `"timeout"`. |
| stdout | `[tools-runner] ${sourceFile}:trigger ${triggerIndexInFile} cmd ${commandIndex} cwd=${expandedCwd} run=${expandedRun}: SKIP ${reason}` | Gate decided not to run. `${reason}` is one of the `GateDecision.reason` strings (e.g., `"in cooldown"`). |
| stdout | `[tools-runner] summary: ${pass} pass, ${fail} fail, ${skip} skip` | End of `runStopHook` happy path. |
| stderr | `[tools-runner] CLAUDE_PROJECT_DIR is not set` | Env var unset. |
| stderr | `[tools-runner] stdin is not valid JSON: ${err.message}` | JSON parse failed. |
| stderr | `[tools-runner] stdin payload exceeded 1 MiB cap` | Stdin size cap hit (Issue 21). |
| stderr | `[tools-runner] failed to load ${sourceFile}: ${err.message}` | A YAML layer failed to parse or validate; the hook aborts (exit 1) and emits a `hook_error` audit-log entry. |
| stderr | `[tools-runner] state file is corrupt, treating as empty: ${err.message}` | `loadState` could not parse. |
| stderr | `[tools-runner] ${sourceFile} cmd ${commandIndex}: invalid lastRunAt "${entry.lastRunAt}", treating as first run` | Gate saw an unparseable `lastRunAt` (Issue 11). |
| stderr | `[tools-runner] cannot write state file: ${err.message}` | `saveState` rename failed. |
| stderr | `${String(err)}` (with trailing `\n`) | Top-level `try/catch` caught an unhandled exception. |

The smoke-test scripts grep for substrings of these literals; the implementation MUST emit the exact literal text (modulo interpolated values) and MUST NOT add additional log lines outside this catalog without updating the table.

## Implementation conventions

- **All IO is async. Sync stdlib functions are banned. Bun-specific APIs are also banned.** Use `node:fs/promises` (`fs.readFile`, `fs.writeFile`, `fs.stat`, `fs.rename`, `fs.mkdtemp`, `fs.utimes`, etc.) and Node's `child_process.spawn` from `node:child_process` wrapped in a Promise around the `close`/`error` events. Do not call any Bun-specific function (no `Bun.file(...)`, `Bun.write(...)`, `Bun.spawn`, `Bun.spawnSync`, etc.) and do not call any `*Sync` (`readFileSync`, `writeFileSync`, `existsSync`, `statSync`, `renameSync`, `mkdtempSync`, `utimesSync`, `child_process.spawnSync`, or any other `*Sync` from `node:fs` / `node:os` / `node:child_process`). This applies to production code AND tests. The Bun-API ban is deliberate: the plugin runs on Bun but uses only Node-compatible stdlib so the source stays portable, every spawn is a Node `ChildProcess` (so we can pipe its stdio streams into per-command log files: see step 12), and there's a single, Node-native shape used consistently. Only `node:fs/promises` is used; the callback-style `node:fs` surface is not used either.
- Existence checks are done by attempting the async operation (e.g., `await fs.stat(path)` and catching `ENOENT`), not by `existsSync`-then-read.
- Any class that needs to load state at construction must expose a `static async create(...)` factory; the constructor itself stays synchronous and just stores already-loaded fields.

## Steps

### 1. Initialize the project skeleton

1.1. Create the following directory tree under `./`:
- `.claude-plugin/`
- `plugin/.claude-plugin/`
- `plugin/hooks/`
- `plugin/dist/` (created by bundle; gitignored)
- `src/`
- `src/test/`
- `scripts/`
- `docs/`

1.2. Create `./.gitignore` with:
```
node_modules/
plugin/dist/
*.log
.DS_Store
.env*
.claude/tools-runner-state.yaml
.claude/tools-runner-log/
tmp/
```

1.3. Create `./package.json`:
- `"name": "tools-runner"`, `"version": "0.1.0"`, `"type": "module"`.
- Scripts:
  - `bundle`: `bun build src/stop-hook.ts --outfile plugin/dist/stop-hook.js --target bun`
  - `b`: `bun run bundle`
  - `compile`: `tsc --noEmit`
  - `c`: `bun run compile`
  - `test`: `jest` (Jest is the test runner, not `bun test`. `bun run test` resolves `node_modules/.bin/jest` and runs it under Bun directly: no Node binary needed; Bun ignores the `#!/usr/bin/env node` shebang and runs the script itself.)
  - `t`: `bun run test`
  - `smoke`: `bash scripts/smoke-tests.sh`
  - `hook-smoke`: `bash scripts/hook-smoke-tests.sh`
  - `test:all`: `bun run test && bash scripts/hook-smoke-tests.sh && bash scripts/smoke-tests.sh`
  - `ta`: `bun run test:all`
  - `dev`: `claude --plugin-dir ./plugin`
  - `d`: `bun run dev`
- Runtime dependencies: `picomatch ^4.0.2`, `yaml ^2.7.0`.
- Dev dependencies: `jest ^29.7.0`, `@types/jest ^29.5.14`, `ts-jest ^29.3.2`, `@types/picomatch`, `typescript ^5.8.3`. (No `@types/bun`: this project does not use the bun test runner.)

1.4. Create `./tsconfig.json` with: `"types": ["jest", "node"]`, `"rootDir": "src"`, `"outDir": "dist"`, `"include": ["src/**/*"]`, strict mode on, ESM module setting (so `ts-jest` ESM transform works).

1.5. Create `./jest.config.js`:
```js
/** @type {import("jest").Config} */
export default {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["**/*.test.ts"],
    extensionsToTreatAsEsm: [".ts"],
    transform: {
        "^.+\\.ts$": ["ts-jest", { useESM: true }],
    },
};
```

1.6. Run `bun install` from `./` to populate `node_modules` and create `bun.lock`.

### 2. Create the plugin manifest files

2.1. Create `./.claude-plugin/marketplace.json`:
```json
{
    "name": "tools-runner",
    "description": "Marketplace for the tools-runner plugin",
    "owner": { "name": "Ashley Davis", "email": "ashley@codecapers.com.au" },
    "plugins": [
        {
            "name": "tools-runner",
            "description": "A smart tool runner: Runs your tests only when files have changed since the last time they were run.",
            "source": "./plugin",
            "author": { "name": "Ashley Davis", "email": "ashley@codecapers.com.au" }
        }
    ]
}
```

2.2. Create `./plugin/.claude-plugin/plugin.json`:
```json
{
    "name": "tools-runner",
    "description": "A smart tool runner: Runs your tests only when files have changed since the last time they were run.",
    "version": "0.1.0",
    "author": { "name": "Ashley Davis" }
}
```

2.3. Create `./plugin/hooks/hooks.json`:
```json
{
    "hooks": {
        "Stop": [
            {
                "matcher": "",
                "hooks": [{ "type": "command", "command": "bun ${CLAUDE_PLUGIN_ROOT}/dist/stop-hook.js" }]
            }
        ]
    }
}
```

2.4. Create `./.claude/settings.json` (used during dev so the source `.ts` file is invoked directly without bundling):
```json
{
    "hooks": {
        "Stop": [
            {
                "matcher": "",
                "hooks": [
                    { "type": "command", "command": "bun ${CLAUDE_PROJECT_DIR}/src/stop-hook.ts" }
                ]
            }
        ]
    }
}
```

2.5. Create the dogfood config `./.claude/tools-runner.yaml`:
```yaml
triggers:
  - paths:
      - "src/**/*.ts"
      - "scripts/**/*.ts"
    commands:
      - run: "bun run test"
        cooldown: 30s
        cwd: "${{project}}"
```

### 3. Define core types

3.1. Create `./src/types.ts` exporting:
- `interface Config { triggers: Trigger[]; }`
- `interface Trigger { paths?: string[]; group_by?: string; commands: CommandConfig[]; sourceLine: number; }`: `paths` is optional; a missing or empty `paths` array means the trigger never fires (valid config, not an error). `group_by` is an optional glob that defines a per-trigger grouping prefix; when set, `${{group_dir}}` is available in `run` and `cwd` and resolves to the absolute path of the group's root for each matched file (see step 11). `sourceLine` is the 1-based line number in the YAML file where this trigger node begins; it is set by `loadConfigFile` (step 4 / `loadConfigFile` uses `YAML.parseDocument` with `keepSourceTokens: true` and reads each trigger node's `range[0]` byte offset to derive the line). It is propagated through `CompiledCommand` and into every audit-log entry that references the trigger so users can navigate from a log entry straight to the line in their `tools-runner.yaml` that produced it.
- `interface CommandConfig { run: string; cooldown?: number; cwd?: string; timeout?: number; }`: `cooldown` and `timeout` are stored in memory as **integer seconds** (post-parse); the YAML *input* form is always a duration string (see step 4 / `parseDuration`). `cooldown` defaults to `60` (i.e., `"1m"`) when missing; `cwd` defaults to `"${{project}}"`; `timeout` defaults to `300` (i.e., `"5m"`) when missing.
- `interface State { fileHashes: Record<string, FileHashEntry>; commandRuns: CommandRunEntry[]; }`
- `interface FileHashEntry { mtimeMs: number; size: number; hash: string; }`: `mtimeMs` is `fs.Stats.mtimeMs` (milliseconds since Unix epoch as a JS number; safe through year 285,000+ given `Number.MAX_SAFE_INTEGER`). Cache entries are keyed by absolute path (`file.absPath`).
- `interface CommandRunEntry { commandKey: string; expandedRun: string; expandedCwd: string; sourceFile: string; sourceLine: number; lastRunAt: string; lastFilesHash: string; matchedFiles: string[]; }`: `commandKey` is `sha256(expandedRun + "\0" + expandedCwd)` so state survives trigger reordering or insertion in either layer; `expandedRun` and `expandedCwd` are stored alongside for human inspection of the state YAML. `sourceFile` is the absolute path of the YAML config file that defined the trigger that last produced this entry, and `sourceLine` is the 1-based line number of that trigger inside `sourceFile`; both are copied from `CompiledCommand.sourceFile` / `CompiledCommand.sourceLine` on every successful upsert. When a home-layer trigger and a project-layer trigger resolve to the same `commandKey`, the entry's `sourceFile`/`sourceLine` are overwritten by whichever ran most recently (same "last run wins" rule that applies to `lastRunAt`), so the state file always points at the trigger that was last responsible for the entry. `lastRunAt` is an ISO 8601 timestamp string (the result of `new Date().toISOString()`); the runner converts `Date → string` on write and the gate converts `string → ms-since-epoch` (via `Date.parse(...)`) on read. The `Date` type is never persisted; it lives only inside in-memory locals. `matchedFiles` is the sorted `string[]` of absolute paths this command was last triggered against; it is the authoritative back-reference used by `saveState` to prune unreferenced `fileHashes` entries.
- `interface StopHookInput { session_id?: string; transcript_path?: string; stop_hook_active?: boolean; cwd?: string; }`
- `interface ChangedFile { path: string; absPath: string; }`: `path` is relative to the `scopeDir` of the config that discovered this file (POSIX); `absPath` is the absolute path. The plugin unions changed files from all found configs' `scopeDir`s into a single list.
- `interface CompiledCommand { sourceFile: string; sourceLine: number; triggerIndexInFile: number; commandIndex: number; command: CommandConfig; expandedCwd: string; expandedRun: string; commandKey: string; matchedFiles: ChangedFile[]; }`: `sourceFile` is the display path of the YAML layer the trigger came from (`"~/.claude/tools-runner.yaml"` or `".claude/tools-runner.yaml"`), used for log lines only; `sourceLine` is copied from `Trigger.sourceLine` so audit-log entries for this command can render `<sourceFile>:<sourceLine>` editor-jump prefixes; `commandKey` is precomputed once during preparation.

### 4. Config loader (layered: home + project + per-repo)

4.1. Create `./src/duration.ts` exporting:
- `function parseDuration(input: unknown, fieldName: string): number`: converts a YAML duration string into integer seconds. Accepts only strings; rejects any other type with a clear validation error. Format: `<digits>` (interpreted as seconds when no unit is given) or `<digits><unit>` where unit is one of `s`, `m`, `h` (seconds, minutes, hours). Examples accepted: `"30"`, `"30s"`, `"5m"`, `"1h"`, `"0"`, `"0s"`. Rejects: bare YAML numbers (`30`), decimals (`"1.5s"`), negatives (`"-5s"`), other units (`"500ms"`, `"7d"`), empty strings, and anything else not matching `/^(\d+)(s|m|h)?$/`. Error messages include `fieldName` so users see e.g. `cooldown: expected duration string like "30" or "30s" or "5m", got number 30`. Pure compute, no IO.

4.2. Create `./src/config.ts` exporting:
- `async function loadConfigFile(filePath: string): Promise<Config | null>`: loads ONE YAML file via `fs.readFile(filePath, "utf8")` from `node:fs/promises` (catch `ENOENT` and return `null`). Throws on parse or validation errors. Uses the `yaml` package's document parser (`YAML.parseDocument(text, { keepSourceTokens: true })`) so each trigger node retains its source position. Validates that `triggers` is an array and every entry has at least one command with a non-empty `run` string. A missing or empty `paths` field on a trigger is valid (the trigger simply never fires). If a trigger has `group_by`, validates it is a non-empty string (the glob itself is not validated against `paths` at load time: `compileCommands` catches mismatches per-file at runtime with a stderr warning). For each command, parses `cooldown` (optional, defaulting to the integer `60` when missing) and `timeout` (optional, defaulting to the integer `300` when missing) via `parseDuration` from `./duration.ts`: the resulting `CommandConfig` object stores integer seconds. Defaults `cwd` to `"${{project}}"` when missing. Each returned `Trigger` carries `sourceLine: number` (1-based line of the trigger node in `filePath`, derived from the parse-tree node's `range[0]` byte offset by counting `\n`s in the original text up to that offset; `1` if no position is available). Returns `{ triggers: [] }` for a YAML document with no `triggers` key (treats absent triggers as empty, not as an error). The schema has only one top-level key (`triggers`); any other top-level key is a validation error.
- `function homeConfigPath(): string | null`: returns `${HOME}/.claude/tools-runner.yaml` or `null` if `process.env["HOME"]` is unset.
- `function homeDisplayPath(): string`: returns the static string `"~/.claude/tools-runner.yaml"` (used in log output).
- `async function scanConfigFiles(projectDir: string): Promise<string[]>`: scans downward from `projectDir` for all files matching `**/.claude/tools-runner.yaml`. Returns a sorted list of absolute paths. Used by the stop hook to discover all per-directory config files.

4.3. Validation must reject only structural problems; an empty `triggers: []` list is valid (lets a user keep an empty home config in place), and a trigger with a missing or empty `paths` field is also valid (it simply never fires). All layers (home, project, per-repo) are validated at load time. A parse or validation error in any layer aborts the hook: the error is written to stderr (one line, `[tools-runner] failed to load ${displayFile}: ${err.message}`) and emitted to the audit log as a `hook_error` entry, and the hook exits 1 without running any commands. A bad `cooldown`/`timeout` duration counts as a validation error and aborts the hook, exactly like a missing `run`.

### 5. Trigger registry (FileLayer + TriggerRegistry)

5.1. Create `./src/trigger-registry.ts`. Triggers are encapsulated inside each layer: the layer and registry never expose or concatenate trigger lists. The only operations crossing the layer boundary are `isEmpty(): boolean` and `compileCommands(changed): CompiledCommandConfig[]`.
- `interface ITriggerLayer { sourceFile: string; scopeDir: string; ctx: TemplateContext; isEmpty(): boolean; compileCommands(changed: ChangedFile[]): CompiledCommandConfig[]; }`: `ctx` is the layer's `TemplateContext` used for variable expansion in this layer's triggers. `scopeDir` is the directory containing this config file (for per-directory configs) or the home directory for the home layer. `${{project}}` resolves to `scopeDir` within each layer's context. `isEmpty()` answers whether the layer currently holds zero triggers (used by `TriggerRegistry.isEmpty`). `compileCommands(changed)` is the only way callers obtain a layer's `CompiledCommandConfig[]`; the layer's stored triggers are never exposed.
- `class StaticLayer implements ITriggerLayer`: wraps a fixed `Trigger[]` on a private field (used by tests). Constructor: `constructor(triggers: Trigger[], sourceFile: string, scopeDir: string, ctx: TemplateContext)`. `isEmpty()` returns `this._triggers.length === 0`. `compileCommands(changed)` delegates to the pure `compileCommands(triggers, sourceFile, ctx, scopeDir, changed)` function in `compile.ts` (step 11). Tests pass synthetic values so log output unambiguously identifies the layer. `StaticLayer` is test-only; production always uses `FileLayer`.
- `class FileLayer implements ITriggerLayer`:
  - Private constructor stores already-loaded fields including a private `_triggers` field, plus `scopeDir` and `ctx`. Nothing outside the class reads `_triggers`.
  - Construction is via `static async create(filePath: string | null, displayFile: string, scopeDir: string, ctx: TemplateContext): Promise<FileLayer>`, which `await`s `loadConfigFile(filePath)` (or yields empty triggers if `filePath` is `null` or the file is missing) before instantiating. Parse and validation errors thrown by `loadConfigFile` are NOT caught inside `create`: they propagate out of the `create` promise so the stop-hook's top-level `try/catch` can write `[tools-runner] failed to load ${displayFile}: ${err.message}` to stderr, emit a `hook_error` audit-log entry, and exit 1. The loaded triggers (on the success path) are stored on `this._triggers` and never change for the lifetime of the layer.
  - `isEmpty()` returns `this._triggers.length === 0` (in-memory accessor).
  - `compileCommands(changed: ChangedFile[]): CompiledCommandConfig[]` calls the pure `compileCommands` function from `compile.ts` with `this._triggers, this.sourceFile, this.ctx, this.scopeDir, changed`.
  - Exposes `sourceFile`, `scopeDir`, and `ctx` so the registry's output and log lines can identify the layer. Does NOT expose the trigger list.
- `class TriggerRegistry`:
  - Constructor: `constructor(layers: ITriggerLayer[])`: accepts a variable number of layers (home + one per found config file).
  - `isEmpty(): boolean`: returns `true` if every layer's `isEmpty()` returns `true`. The Stop hook uses this to decide whether to log `no triggers configured, skipping`.
  - `compileCommands(changed: ChangedFile[]): CompiledCommandConfig[]`: iterates layers in registration order and concatenates each layer's `compileCommands(changed)` output. The registry never inspects, exposes, or aggregates trigger lists: it only composes per-layer outputs. Layer ordering is preserved through each `CompiledCommand`'s `sourceFile` field.

5.2. The Stop hook is one-shot: it spawns a fresh `bun` process for every Claude turn, which constructs every `FileLayer` from scratch. There is no in-process file watcher, no reload, and no `dispose()` cleanup: a YAML edit between turns is picked up by the next invocation's construction-time read, and an edit during an in-flight invocation is ignored until the next Stop event.

### 6. State file

**Field-name convention.** All state YAML keys are the TypeScript field names verbatim (camelCase). `state.commandRuns[0].commandKey` serialises as literal `commandRuns: - commandKey: ...`. The implementation does no key transformation: the `yaml` package writes whatever keys the in-memory object has. See `docs/HOW_IT_WORKS.md` for a literal example.

6.1. Create `./src/state.ts` exporting:
- `function statePath(projectDir: string): string`: pure path join, no IO.
- `async function loadState(filePath: string): Promise<State>`: reads via `fs.readFile(filePath, "utf8")` from `node:fs/promises`; returns an empty state (`{ fileHashes: {}, commandRuns: [] }`) on `ENOENT`. Otherwise parses YAML and validates shape.
- `async function saveState(filePath: string, state: State, opts?: { now?: Date; ttlDays?: number }): Promise<void>`: writes YAML atomically: `await fs.writeFile(filePath + ".tmp", yamlText)` then `await fs.rename(filePath + ".tmp", filePath)` (both from `node:fs/promises`). Before serialising, mutate `state` in place (Issues 3 + 18):
  1. **`commandRuns` TTL prune.** `now = opts?.now ?? new Date()`; `ttlDays = opts?.ttlDays ?? 30` (the 30-day TTL is a hardcoded constant; `opts.ttlDays` exists only so unit tests can pass a deterministic value). Drop any `commandRuns` entry where `Date.parse(entry.lastRunAt)` is `NaN` OR `now.getTime() - Date.parse(entry.lastRunAt) > ttlDays * 86_400_000`.
  2. **Cascading `fileHashes` prune.** After step 1, build `keepKeys = new Set<string>()` from the union of every *surviving* `state.commandRuns[i].matchedFiles[j]` (which are already absolute path strings). Drop any `fileHashes[key]` whose key is not in `keepKeys`. The `fileHashes` record is keyed by absolute path (`file.absPath`), matching the keys stored in `matchedFiles`.
  One timestamp source (`lastRunAt`), one rule. Rename failure (e.g., target dir missing, EROFS) propagates as a thrown error: caught by the top-level `try/catch` in `stop-hook.ts` and surfaced as the "cannot write state file" hook-behavior row (exit 1).
- `function commandKeyFor(expandedRun: string, expandedCwd: string): string`: pure compute (SHA-256 hex via `node:crypto`); no IO so stays synchronous.
- `function findCommandRun(state: State, commandKey: string): CommandRunEntry | undefined`: pure in-memory lookup.
- `function upsertCommandRun(state: State, entry: CommandRunEntry): void`: pure in-memory mutation; replaces by `commandKey`. Content-addressed, so editing or reordering triggers in either YAML layer does not orphan or duplicate existing state.

### 7. Git changed-files collector

7.1. Create `./src/git.ts` exporting:
- `async function collectChangedFiles(scopeDir: string): Promise<ChangedFile[] | "git-missing">`: spawns `git -C <scopeDir> status --porcelain=v1 -z --untracked-files=all` via `child_process.spawn` from `node:child_process` with `stdio: ["ignore", "pipe", "pipe"]`. Listens for the `error` event: on `code: "ENOENT"`, resolves `"git-missing"` (Node emits `error` asynchronously for missing binaries). On `close`, accumulates stdout chunks (Buffers) decoded as UTF-8 and parses NUL-delimited records. Includes any file whose index status (col 1) or worktree status (col 2) is non-space (so both staged and unstaged are returned). For renames (`R`) returns the destination path. Skips deleted entries (`D` in worktree). Filters results to files under `scopeDir` (git finds the enclosing repo itself; the filter ensures only files within the config's scope directory are returned). Returns `ChangedFile[]` where each entry has `path` (relative to `scopeDir`, POSIX) and `absPath` (absolute). Deduplicates results.
- The Stop hook calls `collectChangedFiles(scopeDir)` for each found config's `scopeDir`, unions the results into a single `ChangedFile[]`. On the first `"git-missing"` result, logs `[tools-runner] git binary not found on PATH, skipping` and exits 0.

### 8. Glob matching

8.1. Create `./src/matcher.ts` exporting:
- `function matchFiles(files: ChangedFile[], paths: string[]): ChangedFile[]`: pure compute, no IO. Specification:
  - **Library**: `picomatch` with `{ dot: true }`. No regex, no custom matcher, no fallback to other glob libraries.
  - **Input path**: each file's repo-relative POSIX path (the `path` field of `ChangedFile`, always `/`-separated, never absolute).
  - **No variable expansion**: `paths` patterns are plain repo-relative globs. Variables (`${{repo}}`, `${{project}}`, `${{file_path}}`, `${{file_name}}`, `${{file_dir}}`, `${{group_dir}}`) are NOT supported in `paths`. The pre-match variables (`${{repo}}`, `${{project}}`) cannot be anchored across multiple repos (each `ChangedFile` has its own `repoRoot`); the post-match variables are circular by definition. Document this in `docs/CONFIGURATION.md`.
  - **OR semantics across `paths[]`**: a file matches the trigger if its path matches *any* positive pattern (and is not excluded by a negation: see below). An empty `paths` array matches no files (trigger never fires; this is valid config and should not error).
  - **Brace expansion**: supported via picomatch's defaults: `*.{ts,tsx}` works.
  - **Negation**: a pattern beginning with `!` is treated as an exclude. A file is "matched" only if at least one positive pattern matches AND no negation pattern matches. Example: `["src/**/*.ts", "!src/generated/**"]` includes everything under `src/` except the generated subtree.
  - **Path normalization on the pattern**: a single leading `./` or `/` is stripped (so users can write `/src/**/*.ts` or `./src/**/*.ts` and mean "anchored at repo root"). Document that the input file path itself is never absolute, so a literal `/` in a pattern would otherwise never match.
  - **Case sensitivity**: case-sensitive (picomatch default). Document this: a Linux-only convention is acceptable since the plugin only runs alongside `git`.
  - **Symlinks / out-of-repo paths**: not a concern; `git status --porcelain` only reports files inside the working tree, and the matcher trusts `ChangedFile.path` is repo-relative.

### 9. File hashing with cache

9.1. Create `./src/hash.ts` exporting:
- `async function hashFileWithCache(file: ChangedFile, cache: Record<string, FileHashEntry>): Promise<string>`: uses `file.absPath` as the cache key. Uses `fs.stat(file.absPath)` from `node:fs/promises` to read `mtimeMs` and `size`; on `ENOENT` returns the literal string `"<missing>"` and does NOT update the cache. Cache hit requires `cache[file.absPath]` exists AND `cache[file.absPath].mtimeMs === stat.mtimeMs` AND `cache[file.absPath].size === stat.size`. On miss, reads file bytes via `fs.readFile(file.absPath)` from `node:fs/promises`, computes SHA-256 hex via `node:crypto`, sets `cache[file.absPath] = { mtimeMs, size, hash }`, and returns the hash. No file-size cap is enforced: the plugin is targeted at source-tree files, which never approach the danger zone for whole-file reads.
- `async function aggregateHash(files: ChangedFile[], cache: Record<string, FileHashEntry>): Promise<string>`: sorts by `file.absPath`, awaits `hashFileWithCache` for each (`Promise.all` is fine since the cache writes are idempotent: each key writes the same `(mtimeMs, size, hash)` tuple computed deterministically from the file on disk, so a last-writer-wins overwrite is identical to the value being overwritten), then SHA-256s the concatenated `absPath + "\0" + hash + "\n"` lines and returns the hex digest. Empty file list returns the SHA-256 of the empty string.

### 10. Template expansion

10.1. Create `./src/template.ts` exporting:
- `interface TemplateContext { projectDir: string; }`: `projectDir` is the `scopeDir` of the config file this layer came from (for the home layer it is the home config's directory; for per-directory configs it is the directory containing the config file). `${{project}}` resolves to `ctx.projectDir`.
- `function shellQuote(s: string): string`: wraps `s` in single quotes and escapes embedded single quotes via the standard `'\''` sequence (e.g., `it's` → `'it'\''s'`). Always produces a quoted result, even for empty strings (`''`). Used only by `expandPerFile` when `forShell === true`.
- `function expandStatic(input: string, ctx: TemplateContext): string`: replaces `${{project}}` only; throws if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, or `${{group_dir}}` appear (this helper is for static expansion only). No shell quoting is applied.
- `function expandPerFile(input: string, ctx: TemplateContext, file: ChangedFile, groupDir: string | null, opts: { forShell: boolean }): string`: replaces `${{project}}` with `ctx.projectDir`, `${{file_path}}` with `file.absPath`, `${{file_name}}` with `path.basename(file.absPath)`, `${{file_basename}}` with the filename without its extension (e.g., `foo` for `foo.ts`; computed as `path.basename(file.absPath, path.extname(file.absPath))`), `${{file_ext}}` with the extension including the leading dot (e.g., `.ts`; empty string when the file has no extension; computed via `path.extname(file.absPath)`), `${{file_dir}}` with `path.dirname(file.absPath)`, and `${{group_dir}}` with `groupDir` (throws if `${{group_dir}}` is referenced and `groupDir` is `null`). When `opts.forShell === true` (i.e., the result is going into a `sh -c` command line), `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, and `${{group_dir}}` substitutions are passed through `shellQuote` so a value containing shell metacharacters (`;`, `$()`, backticks, spaces, quotes, etc.) cannot inject. When `opts.forShell === false` (i.e., the result is the `cwd` argument passed directly to the spawn function, which does not invoke a shell), no quoting is applied: the spawn's `cwd` is a literal path, not a shell expression. `${{project}}` is never auto-quoted in either mode: it is a configuration value, not a user-controlled file path, and pre-quoting would break commands that build paths via concatenation. Caller obligation: `compile.ts` always calls `expandPerFile(command.run, ctx, file, groupDir, { forShell: true })` for `run` templates and `expandPerFile(command.cwd, ctx, file, groupDir, { forShell: false })` for `cwd` templates.
- `function hasPerFileVariable(input: string): boolean`: true if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, or `${{file_dir}}` is present.
- `function hasGroupDirVariable(input: string): boolean`: true if `${{group_dir}}` is present.
- `function findGroupDir(repoRelativePath: string, groupByPattern: string): string | null`: used by `compile.ts` for `group_by`. Strips a single trailing `/` from `groupByPattern` (so users can write `packages/*/` for clarity but matching is the same as `packages/*`), splits the repo-relative path into segments, and returns the longest path prefix whose segment count matches the pattern's segment count and which itself matches `groupByPattern` via picomatch. Returns `null` if no prefix matches. Used to compute `${{group_dir}}` and to bucket files by group in `compileCommands`. The returned value is the prefix as a relative POSIX path (e.g., `"packages/foo"`), not absolute.

### 11. Build the prepared command list

11.1. Create `./src/compile.ts` exporting:
- `function compileCommands(triggers: Trigger[], sourceFile: string, ctx: TemplateContext, scopeDir: string, changed: ChangedFile[]): CompiledCommandConfig[]`: pure function operating on a single layer's data. Called by `FileLayer.compileCommands(changed)` and `StaticLayer.compileCommands(changed)` with the layer's privately-held trigger list. The registry never invokes this directly: it calls `layer.compileCommands(changed)` per layer and concatenates results. There is no aggregated cross-layer input. For each trigger, compute `matchedFiles` via `matchFiles(changed, trigger.paths ?? [])` (no variable expansion in paths). If empty, skip the trigger. If `trigger.group_by` is set, compute `groupDir` per matched file via `findGroupDir(file.path, trigger.group_by)` (step 10); files whose `groupDir` is `null` are dropped from `matchedFiles` for this trigger and a stderr warning is logged. If a command's `run` or `cwd` contains `${{group_dir}}` but `trigger.group_by` is unset, throw a validation error. For each command in the trigger, apply the grouping rule (finest-granularity wins):
  - If `run` or `cwd` contains `${{file_path}}` or `${{file_name}}`: one emit per matched file. Use `expandPerFile(command.run, ctx, file, groupDir, { forShell: true })` and `expandPerFile(command.cwd, ctx, file, groupDir, { forShell: false })`.
  - Else if `run` or `cwd` contains `${{file_dir}}`: one emit per unique `path.dirname(absPath)`; `matchedFiles` is the subset sharing that dir. Use `expandPerFile` against the first file in the group (any file in the group produces the same `${{file_dir}}` value).
  - Else if `run` or `cwd` contains `${{group_dir}}`: one emit per unique `groupDir`; `matchedFiles` is the subset sharing that group. Use `expandPerFile` against the first file in the group.
  - Else: one emit, all matched files attached. Use `expandStatic(command.run, ctx)` and `expandStatic(command.cwd, ctx)` (static expansion only: no file context needed since none of the per-file/per-group variables are referenced).
- Each emitted `CompiledCommand` carries `sourceFile`, `triggerIndexInFile`, `commandIndex` (used in log lines) and a precomputed `commandKey = sha256(expandedRun + "\0" + expandedCwd)` (used as the state lookup key). The `commandKey`'s content-addressed structure means per-file, per-dir, and per-group emissions automatically have distinct cooldown state without further bookkeeping.

### 12. Cooldown and hash gating

12.1. Create `./src/gate.ts` exporting:
- `interface GateDecision { run: boolean; reason: string; filesHash: string; }`
- `async function decideGate(prepared: CompiledCommand, state: State, now: Date): Promise<GateDecision>`: looks up the `CommandRunEntry` keyed by `prepared.commandKey` (i.e., `sha256(expandedRun + "\0" + expandedCwd)`).
  - Compute `filesHash` via `await aggregateHash(prepared.matchedFiles, state.fileHashes)`.
  - If no prior entry: `{ run: true, reason: "first run", filesHash }`.
  - **Time conversion** (used by every subsequent branch): `const lastRunAtMs = Date.parse(entry.lastRunAt);`. If `Number.isNaN(lastRunAtMs)`, log a one-line warning to stderr (`[tools-runner] {sourceFile} cmd {commandIndex}: invalid lastRunAt "{entry.lastRunAt}", treating as first run`) and treat as no prior entry. Otherwise `const elapsedMs = now.getTime() - lastRunAtMs;` and `const cooldownMs = prepared.command.cooldown * 1000;`. The boolean `inCooldown = elapsedMs < cooldownMs` (a negative `elapsedMs` from clock skew or injected fake clocks counts as in-cooldown).
  - If `inCooldown` (regardless of hash): `{ run: false, reason: "in cooldown", filesHash }`. Cooldown is measured from the last successful run only and is never extended by skipped Stop events; `lastRunAt` is not touched on skip.
  - If cooldown expired (`!inCooldown`) AND `filesHash === lastFilesHash`: `{ run: false, reason: "no file changes since last successful run", filesHash }`.
  - If cooldown expired (`!inCooldown`) AND `filesHash !== lastFilesHash`: `{ run: true, reason: "files changed since last run", filesHash }`.

### 13. Command runner

13.1. Create `./src/runner.ts` exporting:
- `interface RunResult { prepared: CompiledCommand; exitCode: number; durationMs: number; error?: string; filesHash: string; }`
- `interface SpawnedProc { exitCode: number | null; exited: Promise<number>; kill(signal?: number): void; pid: number; }`
- `type Spawner = (cmd: string[], opts: { cwd: string; stdout: "inherit"; stderr: "inherit" }) => SpawnedProc;`
- `const defaultSpawner: Spawner`: wraps `child_process.spawn` from `node:child_process` and returns a `SpawnedProc` whose `exited` Promise resolves on `close` (with the exit code, or `-1` for null) and rejects on `error` (e.g. ENOENT). Stdio is `["ignore", "pipe", "pipe"]`; the runner pipes the streams into a per-command log file. Exported so tests can compose around it; `runCommands`'s default `spawn` is `defaultSpawner`.
- `interface RunCommandsOptions { spawn?: Spawner; }`: DI seam (Issue 9). Tests pass a stubbed `Spawner` that returns a controlled `exited` promise.
- `async function runCommands(prepared: CompiledCommandConfig[], state: State, now: Date, opts?: RunCommandsOptions): Promise<RunResult[]>`: for each prepared command, awaits `decideGate`. If `gate.run` is true, spawns `(opts?.spawn ?? defaultSpawner)(["sh", "-c", prepared.expandedRun], { cwd: prepared.expandedCwd, stdout: "inherit", stderr: "inherit" })` and awaits `proc.exited`, all spawns running in parallel via `Promise.all`. Applies the per-command timeout via `Promise.race` against a `setTimeout`-backed promise that calls `proc.kill()` on expiry (no `setTimeoutSync`, no blocking sleep: uses `setTimeout` from `node:timers/promises` or the global with a `clearTimeout` cleanup). On `exitCode === 0` calls `upsertCommandRun(state, { commandKey: prepared.commandKey, expandedRun: prepared.expandedRun, expandedCwd: prepared.expandedCwd, sourceFile: prepared.sourceFile, sourceLine: prepared.sourceLine, lastRunAt: now.toISOString(), lastFilesHash: gate.filesHash, matchedFiles: prepared.matchedFiles.map(file => file.absPath).sort() })`. If `gate.run` is false, the existing state entry is left untouched (no `lastRunAt` bump). The `now: Date` argument is converted to an ISO 8601 string at this boundary; the on-disk YAML never contains a `Date` object. Prints a one-line summary per command to stdout (`[tools-runner] {sourceFile}:trigger {triggerIndexInFile} cmd {commandIndex} cwd=... run=...: PASS|FAIL|SKIP reason`) so the user can see which YAML layer fired.

### 14. Stop hook entry point

14.1. Create `./src/stop-hook.ts`:
- The hook has no global wall-clock cap. Per-command `timeout` (default `"5m"`) bounds each spawned command; the hook awaits all of them and exits naturally. There is no abort timer, no `activeChildren` set, no force-kill loop.
- `async function readStdin(): Promise<string>` (caps the accumulated bytes at 1 MiB. Implementation iterates `for await (const chunk of process.stdin)`, accumulates `Buffer`s, tracks `total += chunk.length` after each chunk, and on `total > 1024 * 1024` calls `process.stdin.destroy()` and rejects with `Error("stdin payload exceeded 1 MiB cap")`. Returns the concatenated string when stdin closes normally).
- `async function runStopHook(): Promise<void>`:
  1. Parse stdin JSON as `StopHookInput` (tolerate empty input).
  2. **Recursion guard.** If `input.stop_hook_active === true`, log `"[tools-runner] stop_hook_active set, skipping to avoid recursion"` to stdout and `return` (effective exit 0). This MUST run before any other IO so a recursive Stop event cannot itself spawn git or read YAML.
  3. Resolve `projectDir` from `process.env["CLAUDE_PROJECT_DIR"]`; throw if missing.
  4. Scan for config files via `await scanConfigFiles(projectDir)` to get all `.claude/tools-runner.yaml` files found by scanning downward from `projectDir`.
  5. Build the layered registry. The registry receives a variable number of layers:
     - `await FileLayer.create(homeConfigPath(), homeDisplayPath(), { projectDir: homeDir })`: home layer (using the home directory as `scopeDir`).
     - For each found config file path (from `scanConfigFiles`): `await FileLayer.create(configFilePath, configFilePath, { projectDir: scopeDir })` where `scopeDir` is the directory containing the config file (the `.claude/` directory's parent). Each layer's `scopeDir` defines the scope for `${{project}}` expansion.
     - Construct `const registry = new TriggerRegistry([homeLayer, ...configLayers]);`.
     - If `registry.isEmpty()` (every layer holds zero triggers), log `"[tools-runner] no triggers configured, skipping"` and exit 0.
  6. Load state via `await loadState(statePath(projectDir))`.
  7. Collect changed files: for each found config's `scopeDir`, call `await collectChangedFiles(scopeDir)`. On the first result of `"git-missing"`, log `"[tools-runner] git binary not found on PATH, skipping"` and exit 0. Union all `ChangedFile[]` results into a single list. If the union is empty, log `"[tools-runner] no changed files, skipping"` and exit 0.
  8. Build `CompiledCommandConfig[]` via `registry.compileCommands(changed)` (pure-compute, synchronous). The registry iterates layers in registration order and concatenates each layer's `compileCommands(changed)` output: trigger lists never cross the layer boundary.
  9. `await runCommands(prepared, state, new Date());`.
  10. Save state via `await saveState(statePath(projectDir), state)`.
  11. Print summary line to stdout (counts of PASS/FAIL/SKIP, including which layer each came from) and exit 0.
- Wrap the body in `try/catch`; on any error write `String(err) + "\n"` to stderr and `process.exit(1)`.
- Guard the auto-invocation with `if (process.env["NODE_ENV"] !== "test") runStopHook();`.

14.2. Confirm the file uses `process.stdout.write` / `process.stderr.write` (no audit log, no debug log).

### 15. Unit tests (Jest, run via `bun run test`)

Tests use the Jest API (`describe`, `test`/`it`, `expect`, `beforeEach`, etc.): not the bun test runner. Imports come from `@jest/globals` if explicit imports are needed; otherwise rely on Jest's globals after configuring `@types/jest`.

15.1. Create `./src/test/config.test.ts` covering:
- `loadConfigFile` returns `null` for missing file.
- Valid yaml round-trips into the expected shape with defaults filled.
- Throws on unparseable yaml.
- Throws when `triggers` is not an array, or when a command has empty `run` or a bad `cooldown` duration. A trigger with missing or empty `paths` is accepted (trigger just never fires). An empty document or a document with `triggers: []` is accepted. `cooldown` missing on a command defaults to `60` (1 minute).
- `homeConfigPath` returns `null` when `HOME` is unset; returns the expected path otherwise.

15.2. Create `./src/test/trigger-registry.test.ts` covering (trigger lists are never exposed; behaviour is verified through `isEmpty()` and `compileCommands(changed)` outputs):
- `StaticLayer` reports `isEmpty()` correctly (true for `[]`, false for non-empty fixture) and `compileCommands(changed)` against a matching fixture returns the expected `CompiledCommandConfig[]`.
- `FileLayer` constructed with a non-existent path: `isEmpty()` is `true`, `compileCommands(changed)` returns `[]`, no thrown error.
- `FileLayer` constructed with a valid YAML file: `isEmpty()` is `false` and `compileCommands(changed)` against a matching changed-file set returns the expected output.
- `FileLayer.create` rejects when the YAML file fails to parse or validate (the error propagates so the stop-hook's top-level `try/catch` can log it to stderr, emit a `hook_error` audit-log entry, and exit 1).
- `TriggerRegistry.isEmpty()` is `true` when every layer is empty, `false` if any layer has triggers.
- `TriggerRegistry.compileCommands(changed)` iterates layers in registration order: outputs from earlier layers (e.g., home) appear before outputs from later layers (e.g., project), and per-layer `sourceFile` tagging is preserved.

15.3. Create `./src/test/state.test.ts` covering:
- `loadState` returns an empty state when missing.
- `loadState` treats a corrupt YAML file as empty state and writes one error line to stderr (no throw).
- `saveState` writes a parseable yaml file.
- `saveState` prunes orphaned `fileHashes`: state has three `fileHashes` entries (keys `/tmp/myrepo/a.ts`, `/tmp/myrepo/b.ts`, `/tmp/myrepo/c.ts`) and one `commandRuns` entry whose `matchedFiles` is `["/tmp/myrepo/a.ts"]` (absolute path strings). After `saveState`, the on-disk YAML's `fileHashes` contains only `/tmp/myrepo/a.ts`.
- `saveState` rename failure: stub `fs.rename` to throw `EROFS`; assert `saveState` rejects with that error (so the top-level `try/catch` in `stop-hook.ts` can surface it as exit 1).
- `commandKeyFor` is deterministic and differs when either `expandedRun` or `expandedCwd` differs.
- `findCommandRun` returns `undefined` when no match, returns the entry otherwise.
- `upsertCommandRun` replaces by `commandKey` without duplicating. Editing a trigger's `paths` (which doesn't change the resolved `run`/`cwd`) does NOT invalidate the state entry.
- TTL prune: `commandRuns` entries older than `ttlDays` (passed via `opts.ttlDays` for determinism) are dropped, and `fileHashes` cascades to drop any entries not referenced by the surviving `matchedFiles`: see Issue 18.

15.4. Create `./src/test/matcher.test.ts` covering:
- A single glob `src/**/*.ts` matches `src/foo.ts` and `src/dir/bar.ts` but not `scripts/foo.sh`.
- Multiple patterns OR together (e.g. `["src/**/*.ts", "scripts/**/*.sh"]` matches files under either).
- Empty `paths` array matches no files (and does not throw).
- Dotfiles match when included by glob (e.g. `**/.env` matches `.env` and `config/.env`).
- Brace expansion: `src/**/*.{ts,tsx}` matches both `.ts` and `.tsx` files.
- Negation: `["src/**/*.ts", "!src/generated/**"]` matches `src/foo.ts` but excludes `src/generated/foo.ts`.
- Negation alone (no positive glob) matches nothing.
- Leading-slash stripping: `/src/**/*.ts` and `./src/**/*.ts` behave identically to `src/**/*.ts`.
- Case sensitivity: `src/**/*.ts` does not match `src/Foo.TS`.
- `ChangedFile` entries with the same `path` but different `absPath` are matched independently (matcher does not deduplicate).

15.5. Create `./src/test/hash.test.ts` covering:
- `hashFileWithCache` returns a stable hex SHA-256 for fixed contents.
- Cache hit returns the cached value when `mtimeMs` and `size` match.
- Cache miss recomputes when `mtimeMs` differs.
- `aggregateHash` returns the same hex for the same logical input regardless of input order.
- `aggregateHash` differs when one file's contents change.
- Missing file is reported as `"<missing>"` in the per-file hash.

15.6. Create `./src/test/template.test.ts` covering:
- `expandStatic` replaces `${{project}}`.
- `expandStatic` throws if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, or `${{group_dir}}` appear.
- `expandPerFile` replaces all seven variables (`${{project}}`, `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, `${{group_dir}}`).
- `expandPerFile` `${{file_basename}}` returns the filename without extension (e.g. `foo` for `foo.ts`, `bar` for `bar.test.ts`). `${{file_ext}}` returns the extension with leading dot (e.g. `.ts`) or empty string for a file with no extension.
- `expandPerFile` with `forShell: true` shell-quotes `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, and `${{group_dir}}` (e.g., a file path `it's; rm -rf /` substitutes as `'it'\''s; rm -rf /'`, NOT as the unquoted form).
- `expandPerFile` with `forShell: false` substitutes those six verbatim with no quoting (cwd path mode).
- `expandPerFile` does NOT shell-quote `${{project}}` even with `forShell: true`.
- `expandPerFile` throws if `${{group_dir}}` appears but `groupDir === null`.
- `shellQuote("")` returns `''`; `shellQuote("plain")` returns `'plain'`; `shellQuote("a'b")` returns `'a'\''b'`.
- `hasPerFileVariable` is true for `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`; false for the others.
- `hasGroupDirVariable` is true only for `${{group_dir}}`.
- `findGroupDir` returns the longest segment-prefix matching a `group_by` glob; returns `null` when no prefix matches; trailing-slash form (`packages/*/`) is equivalent to non-slash form.

15.7. Create `./src/test/compile.test.ts` covering (calls the pure `compileCommands(triggers, sourceFile, ctx, scopeDir, changed)` directly with fixture inputs; does not construct `StaticLayer`/`FileLayer`):
- A trigger with no per-file variables emits one `CompiledCommand` containing all matched files.
- A trigger with `${{file_dir}}` in cwd emits one `CompiledCommand` per unique directory.
- A trigger with `${{file_path}}` in run emits one `CompiledCommand` per file.
- Triggers whose `paths` match no changed files emit nothing.
- Two `compileCommands` calls with the same trigger fixture but different `sourceFile` arguments (modelling a home/project layer pair) each produce a `CompiledCommand` with the SAME `commandKey` (so they share state: last-write-wins). Document this as an intentional consequence of content-addressed keys.
- Each emitted `CompiledCommand` has `sourceFile` set to the value passed to `compileCommands`.
- Each emitted `CompiledCommand` has `sourceLine` copied from the source `Trigger.sourceLine`. All `CompiledCommand`s emitted from the same trigger (e.g., per-file fan-out) share the same `sourceLine`.

15.8. Create `./src/test/gate.test.ts` covering all four branches enumerated in step 12.1, using fake `now` values.

15.9. Create `./src/test/git.test.ts` (skip if `git` unavailable) covering:
- `collectChangedFiles` returns the expected set for a temp repo with one staged add, one unstaged modify, and one untracked file (using `scopeDir = repoRoot`). Verify deletions are excluded. Each returned `ChangedFile` has `path` (relative to `scopeDir`) and `absPath` (absolute).
- `collectChangedFiles` filters results to files under `scopeDir`: when `scopeDir` is a subdirectory of the repo, files outside that subdirectory do not appear in the result.
- `collectChangedFiles` rename destination: stage a rename (`git mv old.ts new.ts`) in a temp repo and assert the result includes `new.ts` and excludes `old.ts`.
- `collectChangedFiles` returns `"git-missing"` when `PATH` is set to a directory containing no `git` binary (use `process.env` override scoped to the test).

15.10. Create `./src/test/runner.test.ts` covering (with mocked `Spawner` via dependency injection: see Issue 9):
- `runCommands` runs all gated commands in parallel (assert by tracking spawn timestamps and seeing overlap, or by gating two stubbed procs on a shared barrier).
- A successful command writes a `CommandRunEntry` keyed by `commandKey` with the expected hash, the sorted `matchedFiles` list, and `sourceFile`/`sourceLine` copied verbatim from the input `CompiledCommand`.
- A failing command does NOT update `lastFilesHash`.
- A skipped (`run: false`) command leaves the existing `CommandRunEntry` untouched: `lastRunAt`, `lastFilesHash`, and `matchedFiles` all stay at their prior values.
- Per-command timeout: a stubbed `Spawner` returns a never-resolving `exited` promise. With `command.timeout: 0.05` (50 ms), `runCommands` resolves within ~100 ms with `RunResult.error === "timeout"` and `RunResult.exitCode === -1` (or the convention chosen: pin one and document it). Assert `proc.kill` was called.

15.11. Create `./src/test/stop-hook.test.ts` covering:
- Importing the module under `NODE_ENV=test` does not auto-run.
- Calling `runStopHook` with `CLAUDE_PROJECT_DIR` unset writes to stderr and exits with code 1 (use a stubbed `process.exit` thrown sentinel).
- Calling `runStopHook` for a project that is not a git repo prints the skip message and exits 0.
- Calling `runStopHook` with both home and project YAML present runs triggers from both layers (use `HOME` and `CLAUDE_PROJECT_DIR` env vars pointing at temp dirs).
- `stop_hook_active` early exit: stdin JSON `{"stop_hook_active": true}` produces only the skip log line; assert no git, YAML, or state IO is performed (e.g., spy on `discoverRepos`/`loadState` and assert zero calls). Exit 0.
- Malformed home + valid project: home YAML contains invalid syntax; project YAML is well-formed. Assert: stderr has one parse-error line tagged with `~/.claude/tools-runner.yaml`; the audit log contains a `hook_error` entry; no commands run (the project trigger does NOT fire); exit 1.

### 16. Smoke tests

16.1. Create `./scripts/smoke-tests.sh` (chmod +x). It builds the bundle once, then drives a series of scenarios end-to-end against the bundled hook by piping `'{}'` to `bun "$PROJECT_DIR/plugin/dist/stop-hook.js"` with `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT` exported. Each scenario uses a fresh `mkdtemp` dir, runs `git init`, and writes a `.claude/tools-runner.yaml`. All assertions are scripted (exit codes, file contents, mtimes, stdout greps): no human inspection.

Scenarios the script must cover:
1. **First-run executes**: trigger with `echo SMOKE_OK > smoke.out`, glob `src/**/*.ts`, one `src/foo.ts` in working tree. Assert exit 0; stdout contains a trigger-run line; `smoke.out` exists and contains `SMOKE_OK`.
2. **Cooldown skip**: re-run immediately. Assert exit 0; stdout shows the cooldown skip reason; `smoke.out` mtime unchanged.
3. **Cooldown bypass via file change**: modify `src/foo.ts`, set `cooldown: "0s"` in YAML, re-run. Assert command re-executed (`smoke.out` mtime advanced).
4. **Clean-slate after state delete**: `rm .claude/tools-runner-state.yaml`, re-run. Assert command re-executes regardless of cooldown.
5. **Per-file template**: trigger with `run: "echo ${{file_path}} > per-file-$(basename ${{file_path}}).log"` (note the truncating `>` and per-file output name; `$(basename ${{file_path}})` resolves at shell-time inside the spawned `sh -c` and the `${{file_path}}` substitution is shell-quoted by `expandPerFile`), `paths: ["**/*.md"]`, two markdown files in different directories (e.g., `a/x.md` and `b/y.md`). After Stop, assert: (a) `per-file-x.md.log` exists and contains exactly one line ending in `a/x.md`; (b) `per-file-y.md.log` exists and contains exactly one line ending in `b/y.md`. Each command writes its own output file, so concurrent execution cannot race. Also assert there is no shared output file (`per-file.log` does not exist).
6. **Layered config**: write a home YAML (use `HOME=$(mktemp -d)` so the fake home is isolated) with one trigger and a project YAML with another trigger. Make changes that match both. Assert both commands ran in this Stop and stdout shows lines tagged with both `~/.claude/tools-runner.yaml` and `.claude/tools-runner.yaml`.
7. **State file shape**: after scenario 1, parse `.claude/tools-runner-state.yaml` (use `bun -e` to round-trip it through the `yaml` package or a small inline `python` snippet) and assert: `commandRuns` array length >= 1; the entry has hex `commandKey`, `expandedRun`, `expandedCwd`, `sourceFile`, `sourceLine`, `lastRunAt`, `lastFilesHash` fields; `fileHashes` has at least one entry.

The script reports PASS/FAIL per scenario and exits non-zero on any failure.

16.2. Create `./scripts/hook-smoke-tests.sh` (chmod +x):
- Builds the bundle.
- `run_test`: malformed JSON exits 1.
- `run_test`: empty stdin exits 0 (Stop hooks may receive empty payloads).
- `run_test`: missing `CLAUDE_PROJECT_DIR` exits 1.
- Reports PASS/FAIL counts.

### 17. Audit log

17.1. Create `./src/audit-log.ts`. All IO is async: use `appendFile` / `mkdir` / `rm` / `readdir` from `fs/promises`, and `IAuditLogger.log` returns `Promise<void>` (callers `await` each entry). The directory name is `.claude/tools-runner-log/`.

Entry-type discriminators (canonical: smoke and unit tests assert on these literals):
`hook_started`, `config_load`, `changed_files`, `trigger_match`, `gate_decision`, `command_started`, `command_result`, `state_saved`, `hook_completed`, `hook_error`. Step 15 details every variant's fields, the dual-format (`HH.json` JSON Lines + `HH.log` plain text) output, hourly path scheme `<projectDir>/.claude/tools-runner-log/YYYY-MM/DD/HH.{json,log}`, and the monthly-cleanup rule (keep current + 2 preceding months).

The four trigger-scoped entry types (`trigger_match`, `gate_decision`, `command_started`, `command_result`) each carry both `sourceFile` (the YAML layer's display path) and `sourceLine` (the 1-based line in that file where the trigger node begins, set by `loadConfigFile` and copied through `Trigger` → `CompiledCommand`). The text format renders them together as `<sourceFile>:<sourceLine>`, so users can navigate from a log entry directly to the triggering line in their `tools-runner.yaml`.

17.2. Retrofit:
- `src/stop-hook.ts` (step 13) emits most events. Order: `hook_started` (after stdin parsed) → per-layer `config_load` → `changed_files` → per-trigger `trigger_match` (with both matched and unmatched lists for debug-ability) → per-`CompiledCommand` `gate_decision` → `command_started` / `command_result` (from runner) → `state_saved` → `hook_completed`. Early-exit paths (recursion guard, git missing, etc.) emit `hook_started` + `hook_completed` with `skipReason` set.
- `src/runner.ts` (step 12) gains `logger?: IAuditLogger` in `RunCommandsOptions` (default `NullAuditLogger`). Emits `command_started` after spawn and `command_result` after `exited`.
- `src/trigger-registry.ts` (step 4) `FileLayer.create` lets parse and validation errors propagate to the stop-hook's top-level `try/catch`, which writes the error to stderr and emits a `hook_error` audit-log entry before exiting 1. No `loadError` field is needed on `FileLayer`. Logger is NOT threaded into `FileLayer`.
- `src/state.ts` (step 5) `saveState` returns `{ prunedCommandRuns, prunedFileHashes }` (was `void`) so the stop-hook can populate `state_saved`.

17.3. Configuration:
- The audit log is always on. There is no env var, no YAML toggle. If `CLAUDE_PROJECT_DIR` is unset, the hook exits 1 anyway; otherwise the log writes unconditionally.
- The log directory is gitignored: `.gitignore` and `package.json`'s skeleton (plan section 1.2) gain `.claude/tools-runner-log/`.

17.4. Documentation: step 15 also adds the user-facing audit-log content to `docs/CONFIGURATION.md` (new "Audit log" section), `docs/HOW_IT_WORKS.md` (brief subsection listing entry types), and `docs/DEVELOPMENT.md` (one-liner inspection commands). The final-pass review in step 16 just verifies these.

### 18. Documentation

17.1. Create `./README.md` (kept tight: pitch, install, ONE example, links out):
- Heading and 1-2 sentence pitch.
- Installation: clone, `bun install`, `bun run bundle`, then either `claude --plugin-dir ./plugin` for a single project or register the `Stop` hook in `~/.claude/settings.json`.
- A single minimal yaml example with one trigger running `bun run test` on TS changes, dropped at `<project>/.claude/tools-runner.yaml`. Two-line description of what will happen.
- "Learn more" section linking to `docs/CONFIGURATION.md` (how to write configs), `docs/HOW_IT_WORKS.md` (architecture), and `docs/DEVELOPMENT.md` (contributing).
- No exhaustive field reference, no template-token table, no layering explanation here: those live in `docs/CONFIGURATION.md`.

17.2. Create `./docs/CONFIGURATION.md`: the user-facing reference for writing trigger configs:
- **Where configs live**: three locations, all optional:
  - `~/.claude/tools-runner.yaml`: applies to every project the user opens with Claude Code.
  - `<project>/.claude/tools-runner.yaml`: applies to the whole project (including any nested repos).
  - `<repo>/.claude/tools-runner.yaml`: one per discovered repo other than the project itself; applies only to files in that repo, with `${{project}}` and `${{repo}}` both rebound to the repo's root.
- **Layering**: triggers from the home file are listed first, project second, then per-repo layers in repo-discovery order; all contribute. There is no key-based override (the YAML has no `name` field on triggers); the same trigger present in two files runs as two independent triggers: though if their resolved `(run, cwd)` matches, they'll share a `commandKey` and therefore share cooldown state (last run wins).
- **Layering diagram** (ASCII or mermaid):
  ```
  ┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌─────────────────────────────┐
  │ ~/.claude/tools-runner.yaml │  │ <project>/.claude/...yaml   │  │ <repo>/.claude/...yaml × N  │
  │   FileLayer (private)       │  │   FileLayer (private)       │  │   FileLayer (private)       │
  │   triggers stay inside      │  │   triggers stay inside      │  │   triggers stay inside      │
  └─────────────┬───────────────┘  └─────────────┬───────────────┘  └─────────────┬───────────────┘
                │ layer.compileCommands(changed) │                                │
                └────────────────────────────────┴────────────────────────────────┘
                                                  ▼
                                TriggerRegistry.compileCommands(changed)
                                  concatenates per-layer CompiledCommandConfig[]
                                  (home output, then project, then per-repo)
  ```
- **Per-Stop reload diagram** (sequence):
  ```
  Claude turn N ends ──► Stop hook spawns ──► reads all YAMLs fresh ──► evaluates ──► exits
  Claude turn N+1 ends ──► Stop hook spawns ──► reads all YAMLs fresh (any edits picked up)
  ```
  Note: there is no in-process file watcher. YAML edits between turns are picked up automatically because each Stop event spawns a fresh process; edits during an in-flight invocation are deferred until the next Stop event.
- **Schema reference**: table or bullet list of every YAML field:
  - `triggers[]`: list of triggers (top-level).
  - `triggers[].paths[]`: optional. List of picomatch glob patterns applied to repo-relative POSIX paths. A trigger fires if any changed file matches any pattern. A missing or empty `paths` field is valid; the trigger simply never fires (useful as a placeholder).
  - `triggers[].commands[]`: list of commands to run when the trigger fires.
  - `triggers[].commands[].run`: required. Shell command (run via `sh -c`).
  - `triggers[].commands[].cooldown`: optional. Duration string (`"30"`, `"30s"`, `"5m"`, `"1h"`). Bare strings of digits are interpreted as seconds. Defaults to `"1m"` (60 seconds). Use `"0"` or `"0s"` to disable.
  - `triggers[].commands[].cwd`: optional. Working directory. Defaults to `"${{project}}"`.
  - `triggers[].commands[].timeout`: optional. Duration string (same format). Defaults to `"5m"` (300 seconds).
- **Duration format subsection**: pin the format with examples and supported units (`s`, `m`, `h`); call out that bare YAML numbers are rejected, and that decimals, negatives, and other units (`ms`, `d`) are rejected.
- **Variables**: `${{project}}` (project-wide in home/project configs; rebound to the layer's repo root in per-repo configs), `${{repo}}` (per-file in home/project configs; same as `${{project}}` in per-repo configs), `${{file_path}}`, `${{file_name}}`, `${{file_basename}}` (filename without extension), `${{file_ext}}` (extension with leading dot, empty for files with no extension), `${{file_dir}}` (per-file post-match), `${{group_dir}}` (per-group, requires the trigger's `group_by` field). `${{file_basename}}` and `${{file_ext}}` have the same per-file granularity as `${{file_path}}` and `${{file_name}}`: each occurrence causes one invocation per matched file. Variables are NOT supported in `paths`: patterns are plain repo-relative globs and apply across all discovered repos. Per-file / per-group / per-repo variables cause one invocation per unique expansion. Document the per-repo override of `${{project}}`/`${{repo}}` and link to the "Per-repo configs" subsection.
- **Per-repo configs**: separate subsection. Explain that any discovered repo other than `${{project}}` itself can have its own `<repo>/.claude/tools-runner.yaml`. Triggers in this file see only files from that repo (implicit filter). Inside the file, `${{project}}` and `${{repo}}` both resolve to the layer's repo root, and the default `cwd` (`${{project}}`) means commands run from the repo by default. Walk through a monorepo example with two per-repo configs (`packages/foo` and `packages/bar`), each with its own triggers, demonstrating that they don't interact and don't need to know about each other. Per-repo layers are loaded fresh on every Stop event, identically to home/project layers. Mention the skip rule: when `${{project}}` itself is a repo, its own config is the project layer: there's no separate per-repo layer for it.
- **Grouping (`group_by`)**: separate subsection explaining the trigger-level `group_by` field as a generic per-directory grouping mechanism (per-package, per-app, per-area, per-test-suite, etc.). Defines a glob that maps each matched file to a "group directory"; `${{group_dir}}` expands to that directory's absolute path. Show the per-package worked example (paths `packages/*/src/**/*.ts`, `group_by: packages/*/`, `cwd: ${{group_dir}}`) and call out that the section title should NOT lead with "package": many projects don't have a packages/ structure.
- **Worked examples** (3-4):
  1. *Project-level: run tests when TS changes*: basic `paths: ["src/**/*.ts"]`, `run: "bun run test"`, `cooldown: 30s`. The README example.
  2. *Per-file linter using `${{file_path}}`*: `paths: ["**/*.md"]`, `run: "markdownlint ${{file_path}}"`, `cooldown: 5s`. Demonstrates one-invocation-per-file.
  3. *Per-package build using `${{file_dir}}`*: `paths: ["packages/*/src/**/*.ts"]`, `run: "bun run build"`, `cwd: "${{file_dir}}"`, `cooldown: 10s`. Demonstrates one-invocation-per-directory.
  4. *Home-level shared linter, project-level project tests*: show one trigger in `~/.claude/tools-runner.yaml` (e.g. a generic `prettier --check` on any `*.{ts,tsx,md}`) and one trigger in `<project>/.claude/tools-runner.yaml` (the project's own test runner). Demonstrates layering benefit.
- **State file**: brief note that `.claude/tools-runner-state.yaml` is created automatically (gitignored), and how to reset (delete it).
- **Troubleshooting subsection**: what stdout / stderr look like, how to verify a trigger is matching (run `git status --porcelain` to see what the hook sees), how to bypass cooldown for testing (`cooldown: "0s"`).

17.3. Create `./docs/HOW_IT_WORKS.md`: the *internals* reference (architecture, not config syntax):
- High-level architecture diagram (mermaid or ascii) showing: Claude Code → Stop hook → discover repos → load layers (home + project + per-repo YAMLs) → git status (per repo) → glob match → hash → cooldown gate → spawn commands → state file.
- Section per concern: layered config loading (home + project + per-repo layers, each loaded fresh per Stop event with no in-process watcher; per-repo layers carry a `repoFilter` and a layer-local `TemplateContext` where `projectDir = repoRoot`), repo discovery (walk-up + walk-down), changed-file collection (note: staged + unstaged, deletions skipped, renames take destination; each `ChangedFile` carries its `repoRoot`), glob matching against repo-relative paths, hash computation (SHA-256 over sorted `path\0hash\n` lines, with per-file mtime+size cache), command-run state keyed by `sha256(expandedRun + "\0" + expandedCwd)`, cooldown semantics (the four-branch decision table from step 12.1), parallel execution, state file shape.
- A sequence diagram of three consecutive Stop events: first run executes; second run inside cooldown skips and resets cooldown when no change; third run after cooldown with same hash skips without resetting.
- **Literal state-file YAML example** (Issue 22). Include a fenced YAML block showing the on-disk shape: every field of `State`, `CommandRunEntry`, and `FileHashEntry` in canonical camelCase. Use realistic values so the example doubles as a smoke-test reference. Example:
  ```yaml
  fileHashes:
    tools-runner:src/foo.ts:
      mtimeMs: 1746700000000
      size: 1234
      hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      repoRoot: "/path/to/project"
    tools-runner:src/bar.ts:
      mtimeMs: 1746700001500
      size: 567
      hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
      repoRoot: "/path/to/project"
  commandRuns:
    - commandKey: "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"
      expandedRun: "bun run test"
      expandedCwd: "/path/to/project"
      sourceFile: "/path/to/project/.claude/tools-runner.yaml"
      sourceLine: 12
      lastRunAt: "2026-05-08T12:34:56.789Z"
      lastFilesHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      matchedFiles:
        - repoRoot: "/path/to/project"
          path: "src/bar.ts"
        - repoRoot: "/path/to/project"
          path: "src/foo.ts"
  ```
  This block is the canonical reference for smoke test 16.1 scenario 7, the implementation of `saveState`, and any future code that round-trips state through `yaml`.
- For YAML syntax, link out to `docs/CONFIGURATION.md` rather than duplicating.

17.4. Create `./docs/DEVELOPMENT.md`:
- Prerequisites: Bun.
- Clone and bootstrap: `git clone`, `cd claude-tools-runner`, `bun install`, `bun run bundle`.
- Running it during development (`claude --plugin-dir ./plugin` or the global hook approach via `~/.claude/settings.json`).
- Running tests and type-check: `bun run compile` (TypeScript type-check via `tsc --noEmit`: fast, run frequently while editing), `bun run test` (Jest unit tests), `bun run smoke` (end-to-end behavioral scenarios), `bun run hook-smoke` (bundle-integrity checks: malformed JSON, empty stdin, missing env). `bun run test:all` runs unit + hook-smoke + smoke as a single gate.
- (Section dropped from DEVELOPMENT.md by user request: the term "template token" tested as too jargony, and the recipe is short enough that contributors can derive it from `src/template.ts`. The `docs/CONFIGURATION.md` user-facing section is now titled "Variables".)
- Bundling and publishing: `bun run bundle`, what files end up in `plugin/dist/`.
- Troubleshooting: where the state file lives, how to reset (delete `.claude/tools-runner-state.yaml`), how to debug (observe stdout/stderr; the hook prints debug info to stdout, and the audit log captures the full event timeline).

## Unit Tests
- `src/test/duration.test.ts`: `parseDuration` happy paths (`"30"`, `"30s"`, `"5m"`, `"1h"`, `"0"`, `"0s"`); rejects bare numbers (`30`), decimals (`"1.5s"`), negatives (`"-5s"`), unsupported units (`"500ms"`, `"7d"`), empty strings, non-string types; error message includes the field name.
- `src/test/config.test.ts`: `loadConfigFile` happy path, missing file, malformed yaml, validation failures (including a YAML number for `cooldown` and a bad duration string), `cooldown` and `timeout` parsed via `parseDuration` produce the expected integer-seconds, `cooldown` defaults to `60` when missing, `timeout` defaults to `300` when missing, missing/empty `paths` accepted as a valid trigger, empty-triggers acceptance, `homeConfigPath` env handling, each returned `Trigger` carries the correct 1-based `sourceLine` derived from the YAML document parser.
- `src/test/trigger-registry.test.ts`: `StaticLayer` `isEmpty` and `compileCommands` outputs, `FileLayer` initial load (valid file, missing file, parse-error rejects the `create` promise), `TriggerRegistry.isEmpty()` (all-empty vs any-non-empty), `TriggerRegistry.compileCommands(changed)` concatenation order (home output, then project output).
- `src/test/state.test.ts`: `loadState` empty default, `saveState` round-trip, `commandKeyFor` determinism and sensitivity, `findCommandRun`/`upsertCommandRun` replace-by-`commandKey`, `paths`-edit doesn't invalidate state.
- `src/test/matcher.test.ts`: `matchFiles` single glob, multi-glob OR, dotfile behavior.
- `src/test/hash.test.ts`: `hashFileWithCache` deterministic output, cache hit, cache miss on `mtimeMs` change, `aggregateHash` order independence and content sensitivity, missing-file sentinel.
- `src/test/template.test.ts`: `expandStatic`, `expandPerFile` (including `${{file_basename}}` and `${{file_ext}}`), `findGroupDir`, `hasPerFileVariable`, `hasRepoVariable`, `hasGroupDirVariable`.
- `src/test/compile.test.ts`: flat command, `${{file_dir}}` expansion, `${{file_path}}` expansion, no-match suppression, shared-`commandKey` between home/project layers, `sourceFile` propagation, `sourceLine` propagation from `Trigger.sourceLine` into every emitted `CompiledCommand`.
- `src/test/gate.test.ts`: all four branches of `decideGate`.
- `src/test/git.test.ts`: `discoverRepos` (no-repo, walk-up, walk-down, both, dedupe, git-missing, node_modules skip), `collectChangedFiles` with staged + unstaged + untracked + deleted + renamed entries.
- `src/test/runner.test.ts`: parallel execution via injected spawner, success updates state by `commandKey`, failure does not, skip-with-reset bumps `lastRunAt` only.
- `src/test/stop-hook.test.ts`: module guard, missing `CLAUDE_PROJECT_DIR` exits 1, no-repos project exits 0 with `no git repos found, skipping`, multiple discovered repos contribute changed files into the same prepared-command pipeline, both YAML layers contribute when both files exist.

## Smoke Tests
- `scripts/hook-smoke-tests.sh`: bundle builds; the bundled `plugin/dist/stop-hook.js` exits 1 on malformed JSON, exits 0 on empty stdin, exits 1 when `CLAUDE_PROJECT_DIR` is unset.
- `scripts/smoke-tests.sh`: initializes a temp git repo, drops a config that runs `echo SMOKE_OK > smoke.out` for `*.ts`, runs the bundled hook, asserts the side effect and exit code; second invocation skips due to cooldown; modifying the file plus a zero-cooldown override (`cooldown: "0s"`) triggers re-execution.

## Verify

All verification is automated and self-contained: every step below is something the implementing agent runs and asserts on directly. There is no separate human-verification phase; if any of these checks fail, the plan is not done.

1. `cd /path/to/project && bun install` succeeds (exit 0, `bun.lock` and `node_modules/` exist).
2. `bun run compile` produces no TypeScript errors.
3. `bun run bundle` produces `plugin/dist/stop-hook.js` (file exists, non-zero size). Bundle integrity is verified end-to-end by `bun run hook-smoke` (step 5) actually executing the bundled file; a Node-side syntax check is intentionally NOT used because `--target bun` emits constructs Node cannot parse (e.g., `import.meta.main`).
4. `bun run test` passes every unit test listed above (every `src/test/*.test.ts` reports green).
5. `bun run hook-smoke` passes.
6. `bun run smoke` passes. The smoke script (step 16.1) is responsible for covering: without an interactive Claude session: every behavioral scenario the plan promises:
   - First Stop: trigger fires, command runs, side-effect file is written.
   - Immediate second Stop: skipped with the cooldown reason; side-effect file is NOT rewritten (assert via mtime).
   - File modified + cooldown overridden to 0: command re-runs.
   - State file deleted between runs: next Stop re-executes from a clean slate.
   - Per-file template (`run: "echo ${{file_path}}"`, `paths: ["**/*.md"]`) with two markdown files in different directories: command invoked exactly twice, once per file, with the right paths in stdout.
7. `bun run test:all` passes end-to-end.
8. Inspect `.claude/tools-runner-state.yaml` after the smoke test (parse it as YAML) and assert: it contains a `commandRuns` entry keyed by a hex `commandKey`, with `expandedRun`, `expandedCwd`, `sourceFile`, and `sourceLine` stored alongside, for the dogfood trigger; and at least one entry under `fileHashes`.
9. Doc-integrity checks (no GitHub rendering needed):
   - `README.md`, `docs/CONFIGURATION.md`, `docs/HOW_IT_WORKS.md`, and `docs/DEVELOPMENT.md` all exist.
   - Every relative link in `README.md` resolves to an existing file (parse the markdown for `[...](...)` and `stat` each target).
   - All fenced code blocks in every doc are properly closed (no unmatched ` ``` `).
   - Every YAML example in any doc parses successfully via the `yaml` package.

## Notes
- **Execution model**: commands run in parallel inside the Stop hook (per the user's choice). The hook waits for them to finish before returning, so very long-running commands will delay the next prompt. Per-command `timeout` (default 300s = `"5m"`) bounds each spawned command. There is no global wall-clock cap: the hook awaits all commands and exits naturally. The state TTL (30 days) is a hardcoded constant.
- **Layered config**: triggers come from a variable number of YAML files: `~/.claude/tools-runner.yaml` (home), `<project>/.claude/tools-runner.yaml` (project), and `<repo>/.claude/tools-runner.yaml` (one per discovered repo other than the project itself). All contribute; home triggers are listed first, project second, then per-repo layers in repo-discovery order. Per-repo layers carry an implicit `repoFilter` that restricts their triggers to files from that repo, and a layer-local `TemplateContext` where `projectDir = repoRoot` (so `${{project}}` and `${{repo}}` are interchangeable inside per-repo configs).
- **Per-Stop reload**: there is no in-process file watcher. The Stop hook is one-shot: each Claude turn spawns a fresh process that reads every YAML from disk before evaluating triggers. YAML edits made between turns are picked up automatically; edits during an in-flight invocation are ignored until the next Stop event. (An earlier draft used `fs.watchFile` on each layer; it was dropped because the watcher only ever fired during long-running commands, by which point the trigger evaluation was already complete.)
- **State location**: state is stored in `<project>/.claude/tools-runner-state.yaml` (per-project YAML, gitignored by the generated `.gitignore`). Even when triggers are defined in the home YAML, their per-project run history lives in the project's state file.
- **Command run key**: `commandRuns` are keyed by `sha256(expandedRun + "\0" + expandedCwd)` rather than by trigger index. This means adding, removing, or reordering triggers in either YAML layer never orphans or shifts existing state: only changing the resolved command text or working directory invalidates a run record. A consequence: a home-layer trigger and a project-layer trigger that resolve to the same `(run, cwd)` share state (last run wins), which is intentional. The entry's `sourceFile` and `sourceLine` follow the same "last run wins" rule and are overwritten on every successful upsert, so the state file always points at the trigger that was last responsible for the entry.
- **Changed file scope**: both staged and unstaged are included via `git status --porcelain=v1 -z --untracked-files=all`. Deletions are excluded from the matched set; renames use the destination path. Files outside the repo root are never matched.
- **Variable scope**: `${{project}}` resolves to `$CLAUDE_PROJECT_DIR` for triggers from the home and project layers; in a per-repo layer it is rebound to that layer's repo root. `${{repo}}` is per-file in home/project layers: it resolves to the absolute path of the repo containing each matched file (which can be a parent of `${{project}}`, a child of it, or `${{project}}` itself; see section 7.1's `discoverRepos`); in a per-repo layer it equals `${{project}}` (the layer's repo root) for every matched file. `${{file_path}}`, `${{file_name}}`, `${{file_basename}}` (filename without extension), `${{file_ext}}` (extension with leading dot, empty when none), `${{file_dir}}` are per-file post-match. `${{group_dir}}` is per-group post-match and requires the trigger's `group_by` field. None of the variables are supported in `paths`: patterns are plain repo-relative globs and apply across all discovered repos that the layer can see (home/project: all discovered repos; per-repo: only the layer's own repo). The default for `cwd` is `${{project}}` (and is therefore the repo root inside per-repo configs). Per-file / per-group / per-repo variables cause one invocation per unique expansion; the matched file set used for hashing is restricted to the files that produced that expansion, so cooldowns are independent per `commandKey` (i.e., per resolved `(run, cwd)` pair).
- **Hash cache invalidation**: keyed by absolute path with `(mtimeMs, size)` as the cache key. The cache lives in the same state YAML; entries not referenced by any current `commandRuns` matched-files set are pruned during `saveState` (see Issue 3 resolution).
- **No audit log, no debug log**: all human output goes to stdout (trigger outcomes, summary) and stderr (errors). This is enforced by simply not adding any logger module: `process.stdout.write` and `process.stderr.write` are the only sinks.
- **Test runner is Jest**: tests are run via `bun run test` (unit tests only) or `bun run test:all` (unit + hook smoke + smoke). The `bun run test` script invokes Jest (via `node --experimental-vm-modules node_modules/jest/bin/jest.js`); `bun` is only used as a runtime, not as a test runner. Test files use the Jest API (`describe`, `test`, `expect`). `runner.ts` exposes its spawner for injection so unit tests do not actually fork processes.
- **Awaiting commands is the chosen behavior**: the Stop hook awaits all spawned commands before returning. This keeps success/failure recording for the hash deterministic and matches what the dogfood loop needs. Long-running commands are bounded by per-command `timeout` (default 300s = `"5m"`).

### 19. GitHub Workflows

19.1. Create `.github/workflows/ci.yml`:
- Triggers on `push` and `pull_request` (all branches).
- Single job `ci` on `ubuntu-latest`.
- Steps: `actions/checkout@v4`, `oven-sh/setup-bun@v2` (latest), `bun install`, `bun run compile`, `bun run test`, `bun run bundle`, `bash scripts/smoke-tests.sh`, `bash scripts/hook-smoke-tests.sh`.

19.2. Create `.github/workflows/publish.yml`:
- Triggers on `push` of tags matching `v*.*.*`.
- Single job `publish` on `ubuntu-latest`.
- Steps: same as CI (`actions/checkout@v4`, `oven-sh/setup-bun@v2`, `bun install`, `bun run compile`, `bun run test`, `bun run bundle`, `bash scripts/smoke-tests.sh`, `bash scripts/hook-smoke-tests.sh`), followed by a `Publish` step with a `TODO: publish to Claude marketplace here` placeholder that exits 1 until real publish logic is added.
