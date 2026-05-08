# Step 2: Project skeleton, manifest files, and core types

Lay down the project's directory tree, build/test tooling, plugin manifest files, dogfood configuration, and the foundational TypeScript type definitions. This step adds no behavior: it produces a skeleton that compiles and is ready for the per-module implementation steps that follow.

## 2.1. Directory tree (plan section 1.1)

Create:
- `.claude-plugin/`
- `plugin/.claude-plugin/`
- `plugin/hooks/`
- `plugin/dist/` (created by bundle; gitignored: directory itself does not need to exist yet)
- `src/`
- `src/test/`
- `scripts/`
- `docs/` (already exists from step 1)

## 2.2. `.gitignore` (plan section 1.2)

Create `./.gitignore` with:

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

## 2.3. `package.json` (plan section 1.3)

- `"name": "tools-runner"`, `"version": "0.1.0"`, `"type": "module"`.
- Scripts (verbatim):
  - `bundle`: `bun build src/stop-hook.ts --outfile plugin/dist/stop-hook.js --target bun`
  - `b`: `bun run bundle`
  - `compile`: `tsc --noEmit`
  - `c`: `bun run compile`
  - `test`: `jest`
  - `t`: `bun run test`
  - `smoke`: `bash scripts/smoke-tests.sh`
  - `hook-smoke`: `bash scripts/hook-smoke-tests.sh`
  - `test:all`: `bun run test && bash scripts/hook-smoke-tests.sh && bash scripts/smoke-tests.sh`
  - `ta`: `bun run test:all`
  - `dev`: `claude --plugin-dir ./plugin`
  - `d`: `bun run dev`
- Runtime dependencies: `picomatch ^4.0.2`, `yaml ^2.7.0`.
- Dev dependencies: `jest ^29.7.0`, `@types/jest ^29.5.14`, `ts-jest ^29.3.2`, `@types/picomatch`, `typescript ^5.8.3`.
- No `@types/bun` (this project does not use the bun test runner).

## 2.4. `tsconfig.json` (plan section 1.4)

Use these settings:
- `"types": ["jest", "node"]`
- `"rootDir": "src"`, `"outDir": "dist"`
- `"include": ["src/**/*"]`
- strict mode on
- ESM module setting (so `ts-jest` ESM transform works)

## 2.5. `jest.config.js` (plan section 1.5)

Verbatim:

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

## 2.6. Install dependencies (plan section 1.6)

Run `bun install` from `./` to populate `node_modules` and create `bun.lock`.

## 2.7. Marketplace manifest (plan section 2.1)

Create `./.claude-plugin/marketplace.json`:

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

## 2.8. Plugin manifest (plan section 2.2)

Create `./plugin/.claude-plugin/plugin.json`:

```json
{
    "name": "tools-runner",
    "description": "A smart tool runner: Runs your tests only when files have changed since the last time they were run.",
    "version": "0.1.0",
    "author": { "name": "Ashley Davis" }
}
```

## 2.9. Hooks manifest (plan section 2.3)

Create `./plugin/hooks/hooks.json`:

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

## 2.10. Dev settings (plan section 2.4)

Create `./.claude/settings.json` so the source `.ts` file is invoked directly during development without bundling:

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

## 2.11. Dogfood config (plan section 2.5)

Create `./.claude/tools-runner.yaml`:

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

## 2.12. Core types (plan section 3)

Create `./src/types.ts` exporting every type listed in plan section 3.1, copy-faithfully:

- `interface Config { triggers: Trigger[]; }`
- `interface Trigger { paths?: string[]; group_by?: string; commands: CommandConfig[]; }`: `paths` is optional; an absent or empty `paths` means the trigger never fires. `group_by` is an optional glob that defines a per-trigger grouping prefix; when set, `${{group_dir}}` is available in `run`/`cwd` and resolves to the absolute path of the group's root for each matched file. Per-file template variables available in `run`/`cwd` include `${{file_path}}`, `${{file_name}}`, `${{file_basename}}` (name without extension), `${{file_ext}}` (extension with leading dot, empty string if none), and `${{file_dir}}`.
- `interface CommandConfig { run: string; cooldown?: number; cwd?: string; timeout?: number; }`: `cooldown` and `timeout` are stored in memory as **integer seconds** (post-parse); the YAML *input* form for both is always a duration string parsed by `parseDuration` in step 3. `cooldown` defaults to `60` (i.e. `"1m"`) when missing. `cwd` defaults to `"${{project}}"`; `timeout` defaults to `300` (i.e. `"5m"`) when missing.
- `interface State { fileHashes: Record<string, FileHashEntry>; commandRuns: CommandRunEntry[]; }`
- `interface FileHashEntry { mtimeMs: number; size: number; hash: string; }`: `mtimeMs` is `fs.Stats.mtimeMs` (milliseconds since Unix epoch as a JS number). Cache is keyed by `file.absPath` (absolute path).
- `interface CommandRunEntry { commandKey: string; expandedRun: string; expandedCwd: string; sourceFile: string; sourceLine: number; lastRunAt: string; lastFilesHash: string; matchedFiles: string[]; }`: `commandKey` is `sha256(expandedRun + "\0" + expandedCwd)`; `sourceFile` is the absolute path of the YAML config file that defined the trigger that last produced this entry; `sourceLine` is the 1-based line number of that trigger inside `sourceFile` (both copied from `CompiledCommand.sourceFile` / `CompiledCommand.sourceLine` at upsert time and overwritten on each successful run, so the entry always points at the trigger that was last responsible for it); `lastRunAt` is an ISO 8601 timestamp string (`new Date().toISOString()`); `matchedFiles` is a sorted array of absolute path strings.
- `interface StopHookInput { session_id?: string; transcript_path?: string; stop_hook_active?: boolean; cwd?: string; }`
- `interface ChangedFile { path: string; absPath: string; }`: `path` is relative to the `scopeDir` of the config that triggered collection; `absPath` is the absolute path.
- `interface CompiledCommand { sourceFile: string; sourceLine: number; triggerIndexInFile: number; commandIndex: number; command: CommandConfig; expandedCwd: string; expandedRun: string; commandKey: string; matchedFiles: ChangedFile[]; }`: `sourceLine` is copied from `Trigger.sourceLine` (the 1-based line number of the trigger node in the YAML file, set by `loadConfigFile`).

No tests are added at this step (types contain no executable behavior).

## Verification

- `bun install` succeeds (exit 0); `bun.lock` and `node_modules/` exist.
- `bun run compile` runs without errors (it has no source files to type-check yet beyond `src/types.ts`, which is purely declarative).
- All manifest JSON files parse as valid JSON (run `bun -e "import('node:fs/promises').then(fs => fs.readFile('.claude-plugin/marketplace.json', 'utf8')).then(JSON.parse)"` etc.).
- `./.claude/tools-runner.yaml` parses via the `yaml` package.

Run all tests and confirm they pass before marking this step complete. (No unit tests exist yet at this stage; `bun run test` should report zero tests, exit 0.)

## Summary

_To be completed when this step is implemented._
