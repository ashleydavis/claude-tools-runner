# Step 8: File hashing with cache

Hash the contents of every matched file to compute the per-command `lastFilesHash`. The hash cache lives in the state YAML (keyed by `file.absPath`) and short-circuits unchanged files via `(mtimeMs, size)`.

## Source: `./src/hash.ts` (plan section 9.1)

Export:

- `async function hashFileWithCache(file: ChangedFile, cache: Record<string, FileHashEntry>): Promise<string>`:
  - Cache key is `file.absPath` directly.
  - Uses `fs.stat(file.absPath)` from `node:fs/promises` to read `mtimeMs` and `size`.
  - On `ENOENT` returns the literal string `"<missing>"` (sentinel; do NOT update cache). Handles the race between `git status` reporting a file and `fs.stat` looking it up.
  - Cache hit requires ALL THREE: `cache[file.absPath]` exists AND `cache[file.absPath].mtimeMs === stat.mtimeMs` AND `cache[file.absPath].size === stat.size`.
  - On miss: read file bytes via `fs.readFile(file.absPath)` from `node:fs/promises`, compute SHA-256 hex via `node:crypto`, set `cache[file.absPath] = { mtimeMs, size, hash }`, and return the hash. No file-size cap: the plugin targets source-tree files which don't approach the danger zone.

- `async function aggregateHash(files: ChangedFile[], cache: Record<string, FileHashEntry>): Promise<string>`:
  - Sorts by `file.absPath`.
  - Awaits `hashFileWithCache` for each via `Promise.all`. The cache writes are idempotent: each key writes the same `(mtimeMs, size, hash)` tuple computed deterministically from the file on disk, so a last-writer-wins overwrite is identical to the value being overwritten (Issue 19). No explicit lock needed.
  - Then SHA-256s the concatenated `file.absPath + "\0" + hash + "\n"` lines and returns the hex digest.
  - Empty file list returns the SHA-256 of the empty string.

## IO conventions

- `fs.stat`, `fs.readFile` from `node:fs/promises` only (no Bun-specific APIs). No `*Sync`.
- `node:crypto` (`createHash`) is synchronous-API but does not perform IO; use it directly.

## Tests: `./src/test/hash.test.ts` (plan section 15.5)

Cover:

- `hashFileWithCache` returns a stable hex SHA-256 for fixed contents.
- Cache hit returns the cached value when `mtimeMs` and `size` both match.
- Cache miss recomputes when `mtimeMs` differs (use `await fs.utimes(...)` to bump the mtime).
- `aggregateHash` returns the same hex for the same logical input regardless of input order.
- `aggregateHash` differs when one file's contents change.
- Missing file is reported as `"<missing>"` in the per-file hash; cache is NOT updated.
- Empty file list: `aggregateHash([], {})` returns the hex SHA-256 of the empty string.

Use `await fs.mkdtemp(...)`, `await fs.writeFile(...)` from `node:fs/promises` (no Bun-specific APIs). No `*Sync`.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Implemented file hashing with caching as specified.

**Files added**:
- `src/hash.ts` — exports `hashFileWithCache` and `aggregateHash`. Uses `node:fs/promises` (`fs.stat`, `fs.readFile`) and `node:crypto` (`createHash("sha256")`). Cache key is `file.absPath`; hit requires both `mtimeMs` and `size` to match. ENOENT on stat returns the literal `"<missing>"` sentinel and leaves the cache untouched. `aggregateHash` sorts by `absPath`, hashes per-file in parallel via `Promise.all`, then concatenates `${absPath}\0${perFileHash}\n` lines through a single SHA-256 stream and returns the hex digest. Empty file list returns the SHA-256 of the empty string (verified by test against an independently computed reference).
- `src/test/hash.test.ts` — 8 tests covering: stable hex digest for fixed contents, hex format check, cache hit when (mtimeMs, size) match, cache miss when mtimeMs differs (via `fs.utimes`), missing-file sentinel + cache untouched, empty-list aggregate, order-independence, and aggregate-changes-when-content-changes.

**Key decisions**:
- The `MISSING_FILE_SENTINEL` is held as a module-level `const` rather than inlining the literal so future references stay in sync with the documented contract.
- Sort uses an explicit comparator (not `.sort()` default) so behavior is locale-independent and matches the `<` / `>` byte-wise ordering implied by the spec.
- Cache writes inside `aggregateHash` happen via `Promise.all` parallel `hashFileWithCache` calls; per the step doc this is safe because each key writes a deterministic value derived from the file on disk.

**Verification**: `bun run compile` passes; `bun run test` passes (242/242, including 8 new tests). Smoke tests are deferred (step 14 — `scripts/smoke-tests.sh` not yet authored).

**Deferred / skipped**: Nothing — full step scope landed.
