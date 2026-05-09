# Step 7: Glob matcher

Implement the glob match utility used by `compileCommands` to filter changed files against a trigger's `paths` patterns. Pure compute, no IO. `paths` patterns are plain `scopeDir`-relative globs: variables (`${{project}}`, `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, `${{group_dir}}`) are NOT supported in `paths`. The post-match variables would be circular; `${{project}}` is project-wide and does not anchor globs.

## Source: `./src/matcher.ts` (plan section 8.1)

Export:

- `function matchFiles(files: ChangedFile[], paths: string[] | undefined): ChangedFile[]`:
  - **Library**: `picomatch` with `{ dot: true }`. No regex, no custom matcher, no fallback.
  - **Input path**: each file's `scopeDir`-relative POSIX path (`ChangedFile.path`, always `/`-separated, never absolute).
  - **No variable expansion**: patterns are matched literally against `scopeDir`-relative paths. The matcher does not call any template helper.
  - **OR semantics across `paths[]`**: a file matches the trigger if its path matches *any* positive pattern (and is not excluded by a negation: see below). An empty `paths` array matches no files (trigger never fires; this is valid config and should not error). A missing `paths` field (absent from the YAML) is treated identically to an empty array: no files match and no error is raised.
  - **Brace expansion**: supported via picomatch's defaults: `*.{ts,tsx}` works.
  - **Negation**: a pattern beginning with `!` is treated as an exclude. A file is "matched" only if at least one positive pattern matches AND no negation pattern matches. Example: `["src/**/*.ts", "!src/generated/**"]` includes everything under `src/` except the generated subtree. Negation alone (no positive pattern) matches nothing.
  - **Path normalization on the pattern**: a single leading `./` or `/` is stripped (so users can write `/src/**/*.ts` or `./src/**/*.ts` and mean "anchored at scope root"). The input file path itself is never absolute, so a literal `/` in a pattern would otherwise never match.
  - **Case sensitivity**: case-sensitive (picomatch default). Linux-only convention is acceptable since the plugin only runs alongside `git`.
  - **Symlinks / out-of-scope paths**: not a concern; `git status --porcelain` only reports files inside the working tree, and `collectChangedFiles` already filters to files under `scopeDir`.

## Tests: `./src/test/matcher.test.ts` (plan section 15.4)

Cover:

- A single glob `src/**/*.ts` matches `src/foo.ts` and `src/dir/bar.ts` but not `scripts/foo.sh`.
- Multiple patterns OR together (e.g., `["src/**/*.ts", "scripts/**/*.sh"]` matches files under either).
- Empty `paths` array matches no files (and does not throw).
- Missing `paths` field (passing `undefined` or omitting it) matches no files (and does not throw); treated identically to an empty array.
- Dotfiles match when included by glob (e.g., `**/.env` matches `.env` and `config/.env`).
- Brace expansion: `src/**/*.{ts,tsx}` matches both `.ts` and `.tsx` files.
- Negation: `["src/**/*.ts", "!src/generated/**"]` matches `src/foo.ts` but excludes `src/generated/foo.ts`.
- Negation alone (no positive glob) matches nothing.
- Leading-slash stripping: `/src/**/*.ts` and `./src/**/*.ts` behave identically to `src/**/*.ts`.
- Case sensitivity: `src/**/*.ts` does not match `src/Foo.TS`.
- Two `ChangedFile` entries with identical `path` values (but different `absPath`) are both kept; the matcher treats them independently.

All inputs are constructed in-memory; no filesystem IO needed.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Implemented `matchFiles` in `src/matcher.ts` using `picomatch` with `{ dot: true }` and case-sensitive defaults:

- Treats `undefined` and empty `paths` arrays identically (returns `[]`, never throws).
- Splits `paths` into positive and negative compiled matchers in one pass; a leading `!` on a pattern flags it as a negation. If no positive patterns remain after the split (negation-only config), returns `[]`.
- Strips a single leading `./` or `/` from each pattern body via `stripLeadingAnchor` before compiling, so users can write `/src/**/*.ts` or `./src/**/*.ts` and have them anchor to the scope root.
- For each `ChangedFile`, requires at least one positive matcher hit and zero negation hits before keeping it. Iteration preserves input order and never deduplicates: two `ChangedFile`s with the same `path` but different `absPath` are both kept.
- Brace expansion (`src/**/*.{ts,tsx}`) and dotfile matching (`**/.env`) work via picomatch defaults plus `dot: true`.

Tests in `src/test/matcher.test.ts` cover all 11 cases listed in this step (single glob, OR across patterns, empty `paths`, undefined `paths`, dotfiles, brace expansion, negation excluding a subtree, negation-only matching nothing, leading-`/` strip, leading-`./` strip, case sensitivity, duplicate-path retention). `stripLeadingAnchor` is also exported and has its own direct unit tests (single `/`, single `./`, no anchor, `//` doubled prefix, `.//` doubled prefix, leading dot without slash, empty string) so every function in the module is directly tested per the project's testing rule.

`bun run compile` passes; `bun run test` passes (235 tests across 7 suites, 19 new). `bun run smoke` and `bun run hook-smoke` are not runnable yet (script files arrive in step 14).
