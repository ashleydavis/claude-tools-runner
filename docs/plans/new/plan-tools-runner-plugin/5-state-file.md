# Step 5: State file

Implement loading, saving, and pruning of the per-project state YAML at `<project>/.claude/tools-runner-state.yaml`. State is keyed by `commandKey = sha256(expandedRun + "\0" + expandedCwd)` so trigger reordering or insertion never orphans existing entries.

## Field-name convention (plan section 6 + Issue 14)

All state YAML keys are the TypeScript field names verbatim (camelCase). `state.commandRuns[0].commandKey` serialises as literal `commandRuns: - commandKey: ...`. The implementation does no key transformation: the `yaml` package writes whatever keys the in-memory object has.

## Source: `./src/state.ts` (plan section 6.1)

Export:

- `function statePath(projectDir: string): string`: pure path join, no IO. Returns `${projectDir}/.claude/tools-runner-state.yaml`.

- `async function loadState(filePath: string): Promise<State>`:
  - Reads via `fs.readFile(filePath, "utf8")` from `node:fs/promises`.
  - Returns an empty state (`{ fileHashes: {}, commandRuns: [] }`) on `ENOENT`.
  - Otherwise parses YAML and validates shape.
  - On corrupt YAML: write `[tools-runner] state file is corrupt, treating as empty: ${err.message}` to stderr and return empty state (do NOT throw: corrupt-state should not block the hook).

- `async function saveState(filePath: string, state: State, opts?: { now?: Date; ttlDays?: number }): Promise<void>`:
  - Mutates `state` in place using a single TTL (Issues 3 + 18) BEFORE serialising:
    1. **`commandRuns` TTL prune.** `now = opts?.now ?? new Date()`; `ttlDays = opts?.ttlDays ?? 30` (the 30-day TTL is a hardcoded constant; `opts.ttlDays` exists only so unit tests can pass a deterministic value). Drop any `commandRuns` entry where `Date.parse(entry.lastRunAt)` is `NaN` OR `now.getTime() - Date.parse(entry.lastRunAt) > ttlDays * 86_400_000`.
    2. **Cascading `fileHashes` prune.** After step 1, build `keepKeys = new Set<string>()` from the union of every *surviving* `state.commandRuns[i].matchedFiles[j]` directly (they are absolute path strings). Drop any `fileHashes[key]` whose key is not in `keepKeys`.
  - Writes YAML atomically: `await fs.writeFile(filePath + ".tmp", yamlText)` then `await fs.rename(filePath + ".tmp", filePath)` (both using `node:fs/promises`).
  - Rename failure (e.g., target dir missing, EROFS) propagates as a thrown error: caught by the top-level `try/catch` in `stop-hook.ts` (step 13) and surfaced as the "cannot write state file" hook-behavior row (exit 1).

- `function commandKeyFor(expandedRun: string, expandedCwd: string): string`: pure compute (SHA-256 hex via `node:crypto`); no IO so stays synchronous. Returns the lowercase hex digest.

- `function findCommandRun(state: State, commandKey: string): CommandRunEntry | undefined`: pure in-memory lookup.

- `function upsertCommandRun(state: State, entry: CommandRunEntry): void`: pure in-memory mutation; replaces by `commandKey` (no duplication). Content-addressed, so editing or reordering triggers in either YAML layer does not orphan or duplicate existing state.

## IO conventions

- All async (`fs.readFile`, `fs.writeFile`, and the rest of `node:fs/promises`). No Bun-specific APIs (no `Bun.file`, `Bun.write`, etc.).
- No `*Sync` calls in production or tests.
- `fs.rename` is the atomic-publish primitive: write to `.tmp`, then rename. No partial state ever lands at the canonical path.

## Tests: `./src/test/state.test.ts` (plan section 15.3)

Cover:

- `loadState` returns an empty state when missing (file does not exist).
- `loadState` treats a corrupt YAML file as empty state and writes one error line to stderr (no throw).
- `saveState` writes a parseable YAML file (round-trip via `yaml.parse`).
- `saveState` prunes orphaned `fileHashes`: state has three `fileHashes` entries (keys `/tmp/myrepo/a.ts`, `/tmp/myrepo/b.ts`, `/tmp/myrepo/c.ts`) and one `commandRuns` entry whose `matchedFiles` is `["/tmp/myrepo/a.ts"]`. After `saveState`, the on-disk YAML's `fileHashes` contains only `/tmp/myrepo/a.ts`.
- `saveState` rename failure: stub `fs.rename` to throw `EROFS`; assert `saveState` rejects with that error.
- `commandKeyFor` is deterministic; differs when either `expandedRun` or `expandedCwd` differs.
- `findCommandRun` returns `undefined` when no match, returns the entry otherwise.
- `upsertCommandRun` replaces by `commandKey` without duplicating. Editing a trigger's `paths` (which doesn't change the resolved `run`/`cwd`) does NOT invalidate the state entry.
- TTL prune: `commandRuns` entries older than `ttlDays` (passed via `opts.ttlDays` for determinism) are dropped, AND `fileHashes` cascades to drop any entries not referenced by the surviving `matchedFiles`.

Use `await fs.mkdtemp(...)` for temp dirs. No `*Sync`.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests (this file + earlier steps) green.

Run all tests and confirm they pass before marking this step complete.

## Summary

_To be completed when this step is implemented._
