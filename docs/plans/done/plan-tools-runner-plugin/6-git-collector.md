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

Implemented `src/git.ts` and `src/test/git.test.ts`. Files changed:

- `src/git.ts` (new): exports `collectChangedFiles(scopeDir)`, `runGitCommand(scopeDir, gitArgs)`, and
  `parsePorcelainV1Z(stdoutText)`. The collector spawns two git invocations: `git -C scopeDir rev-parse --show-toplevel`
  to recover the repo root (needed because `git status --porcelain=v1` always reports paths relative to repo
  root regardless of CWD or `status.relativePaths`), then `git -C scopeDir status --porcelain=v1 -z
  --untracked-files=all`. Paths are resolved via `path.resolve(repoRoot, reportedPath)` and filtered to entries
  whose absolute path starts with `scopeDir + path.sep`. Renames return the destination (the trailing source
  path is consumed and discarded). Worktree-`D` entries are skipped. Results are deduplicated by absolute path.
- `src/test/git.test.ts` (new): direct unit tests for `parsePorcelainV1Z` against canned porcelain byte
  streams, plus integration tests for `collectChangedFiles` that mock `child_process.spawn` per call.
- `__mocks__/child_process.ts` (new): manual Jest mock for `node:child_process` exposing `spawn` as a
  `jest.fn()`. Loaded automatically when a test calls `jest.mock("node:child_process")`.

Decisions and divergences from the original step instructions:

- The plan specified returning the discriminated string literal `"git-missing"` when `git` is absent on
  `$PATH`. Per follow-up feedback, this was changed to throw a plain `Error` with the message
  `"git binary missing on PATH"` (preserving `code === "ENOENT"`), so the Stop hook (step 13) can detect the
  missing-binary case via either the message substring or the error code while other failures propagate
  unchanged. The signature is now `collectChangedFiles(scopeDir): Promise<ChangedFile[]>`.
- The plan's command list was a single `git status` spawn. An additional `git rev-parse --show-toplevel` spawn
  was added because empirical testing showed `git -C sub status --porcelain=v1 -z` reports paths relative to
  the repo root, not relative to `sub`, so we cannot use `path.resolve(scopeDir, ...)` on the porcelain output
  directly without first knowing the repo root.
- Per follow-up feedback, the test suite does not invoke real `git` via `child_process.spawn`. The two probes
  are mocked through the `__mocks__/child_process.ts` manual mock; this also sidesteps a Jest-worker quirk
  where `process.env.PATH` mutations do not propagate to child spawns (which made the planned PATH-override
  test for `git-missing` infeasible to run as written).
- `parsePorcelainV1Z` and `runGitCommand` are exported (not file-private) so each can be unit-tested
  directly: `parsePorcelainV1Z` against canned porcelain byte streams without any mocked spawn, and
  `runGitCommand` through the spawn mock to cover its lifecycle (stdout capture, exit code, ENOENT mapping)
  separately from the higher-level `collectChangedFiles` flow.

Verification: `bun run compile` and `bun run test` both green (216 tests pass, including 10 new parser tests,
9 new collector tests, and 6 new `runGitCommand` tests). Smoke tests are not yet applicable (the `scripts/` directory is empty until step
14, and the `stop-hook.ts` entry point bundle target lands in step 13).
