# Step 6: Changed-files collector

Implement per-scope changed-file collection via the `git` binary. Each call to `collectChangedFiles` operates on one `scopeDir` (the directory a config file governs). A missing `git` binary returns a discriminated string literal rather than throwing.

## Source: `./src/git.ts` (plan section 7.1)

Export:

- `async function collectChangedFiles(scopeDir: string): Promise<ChangedFile[] | "git-missing">`:
  - Spawn `child_process.spawn("git", ["-C", scopeDir, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { stdio: ["ignore", "pipe", "pipe"] })`.
  - Accumulate stdout chunks (Buffers) and concat them once `close` fires; decode as UTF-8.
  - Listen for `error` events. On `error` with `code === "ENOENT"`, return the string literal `"git-missing"` immediately.
  - Parse NUL-delimited records.
  - Includes any file whose index status (col 1) or worktree status (col 2) is non-space (so both staged and unstaged are returned).
  - For renames (`R`) returns the destination path.
  - Skips deleted entries (`D` in worktree).
  - Filters results to files whose absolute path is under `scopeDir` (i.e. `absPath.startsWith(scopeDir + "/")`).
  - Returns `ChangedFile[]` where each entry has `path` (relative to `scopeDir`, POSIX) and `absPath` (absolute path). Deduplicates within the result.

## IO conventions

- All async. Use `child_process.spawn` from `node:child_process` (NOT `child_process.spawnSync`, NOT `Bun.spawn`). Wrap the `close` and `error` events in a Promise.
- No `*Sync` calls anywhere.

## Tests: `./src/test/git.test.ts` (plan section 15.9)

Skip the entire file if `git` is unavailable on the test machine. Cover:

- `collectChangedFiles` returns the expected set for a temp repo with one staged add, one unstaged modify, and one untracked file. Verify deletions are excluded.
- `collectChangedFiles` rename destination (Issue 13): stage a rename (`git mv old.ts new.ts`) in a temp repo and assert the result includes `new.ts` and excludes `old.ts`.
- `collectChangedFiles` returns `"git-missing"` when `PATH` is set to a directory containing no `git` binary (use `process.env` override scoped to the test; restore afterwards).
- `collectChangedFiles` filters results to files under `scopeDir`: when git reports files outside `scopeDir`, they are excluded from the returned array.

Use `await fs.mkdtemp(...)`, `await fs.writeFile(...)`, `await fs.rm(...)` from `node:fs/promises` (no Bun-specific APIs). All git invocations use `child_process.spawn` from `node:child_process` + a Promise wrapper around `close`/`error`.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green (including the git tests when git is available; skipped silently otherwise).

Run all tests and confirm they pass before marking this step complete.

## Summary

_To be completed when this step is implemented._
