# Step 9: Template expansion

Implement variable expansion (`${{project}}`, `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, `${{group_dir}}`) for the `run` and `cwd` fields of a command. Variables are not supported in `paths` (see step 7). Per-file variables are post-match and only valid when there is a current `ChangedFile` in scope. Shell-quoting is applied to per-file substitutions destined for `sh -c`.

**Syntax**: variables are written as `${{name}}` (GitHub-Actions style: `$` followed by two opening braces, the name, then two closing braces). The internal recogniser is the regex `/\$\{\{(project|file_path|file_name|file_basename|file_ext|file_dir|group_dir)\}\}/g`. A literal `${` followed by a single `{` that isn't one of the recognised names passes through unchanged. The shell never sees `${{name}}`: substitution happens inside `expandStatic` / `expandPerFile` BEFORE the result is handed to `sh -c` for `run` or to `child_process.spawn`'s `cwd` option.

## Source: `./src/template.ts` (plan section 10.1)

Export:

- `interface TemplateContext { projectDir: string; }`: the only project-wide value. `projectDir` is `scopeDir` for the config that owns the trigger.

- `function shellQuote(s: string): string`:
  - Wraps `s` in single quotes and escapes embedded single quotes via the standard `'\''` sequence (e.g., `it's` → `'it'\''s'`).
  - Always produces a quoted result, even for empty strings (`''`).
  - Used only by `expandPerFile` when `forShell === true`.

- `function expandStatic(input: string, ctx: TemplateContext): string`:
  - Replaces `${{project}}` with `ctx.projectDir`.
  - Throws if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, or `${{group_dir}}` appears (this helper is for project-wide static expansion only: every other variable depends on a matched file).
  - No shell quoting is applied: these are configuration values, not user-controlled file paths.

- `function expandPerFile(input: string, ctx: TemplateContext, file: ChangedFile, groupDir: string | null, opts: { forShell: boolean }): string`:
  - Replaces:
    - `${{project}}` with `ctx.projectDir`.
    - `${{file_path}}` with `file.absPath`.
    - `${{file_name}}` with `path.basename(file.absPath)`.
    - `${{file_basename}}` with `path.basename(file.absPath, path.extname(file.absPath))` (basename without extension).
    - `${{file_ext}}` with `path.extname(file.absPath)` (extension including dot, empty string if none).
    - `${{file_dir}}` with `path.dirname(file.absPath)`.
    - `${{group_dir}}` with `groupDir` (throws if `${{group_dir}}` appears in the input but `groupDir === null`).
  - When `opts.forShell === true` (i.e., the result is going into a `sh -c` command line), `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, and `${{group_dir}}` substitutions are passed through `shellQuote` so a value containing shell metacharacters (`;`, `$()`, backticks, spaces, quotes, etc.) cannot inject (Issue 4).
  - When `opts.forShell === false` (i.e., the result is the `cwd` argument passed directly to `child_process.spawn`, which does not invoke a shell), no quoting is applied: the spawn's `cwd` option is a literal path, not a shell expression.
  - `${{project}}` is NEVER auto-quoted in either mode (it is a configuration value, not a user-controlled file path, and pre-quoting would break commands that build paths via concatenation).
  - Caller obligation (enforced in step 10's `compile.ts`): always call `expandPerFile(command.run, ctx, file, groupDir, { forShell: true })` for `run` templates and `expandPerFile(command.cwd, ctx, file, groupDir, { forShell: false })` for `cwd` templates.

- `function findGroupDir(filePath: string, groupBy: string): string | null`:
  - Used by `compileCommands` (step 10) to compute the group prefix for a matched file.
  - Strips a single trailing `/` from `groupBy` before matching, so users can write either `packages/*` or `packages/*/` (the trailing-slash form is conventional shorthand for "directory": both are accepted, both behave identically).
  - Splits `filePath` on `/`, builds successively-longer segment-prefixes (1 segment, 2 segments, ..., length-1), and tests each prefix against `picomatch(strippedGroupBy, { dot: true })`. Returns the first prefix that matches, or `null` if none does.
  - Example: `findGroupDir("packages/foo/src/lib/util.ts", "packages/*")` → `"packages/foo"`.
  - Example: `findGroupDir("packages/foo/src/lib/util.ts", "packages/*/")` → `"packages/foo"` (same: trailing slash stripped).
  - Example: `findGroupDir("scripts/test.sh", "packages/*")` → `null` (no prefix matches).

- `function hasPerFileVariable(input: string): boolean`:
  - True if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` is present, false otherwise.

- `function hasGroupDirVariable(input: string): boolean`:
  - True if `${{group_dir}}` is present, false otherwise. Used by `compileCommands` to validate that a trigger using `${{group_dir}}` also has `group_by` set, and to choose the per-group grouping tier.

## Tests: `./src/test/template.test.ts` (plan section 15.6)

Cover:

- `expandStatic` replaces `${{project}}`.
- `expandStatic` throws if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, or `${{group_dir}}` appears (every variable other than `${{project}}` requires a file context).
- `expandPerFile` replaces all seven variables.
- `${{file_basename}}` resolves to the filename without extension (e.g. `foo.ts` → `foo`; `archive.tar.gz` → `archive.tar`).
- `${{file_ext}}` resolves to the extension with dot (e.g. `foo.ts` → `.ts`; `Makefile` → `""`).
- `expandPerFile` with `forShell: true` shell-quotes `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, and `${{group_dir}}` (e.g., a file path `it's; rm -rf /` substitutes as `'it'\''s; rm -rf /'`, NOT as the unquoted form).
- `expandPerFile` with `forShell: false` substitutes those six verbatim with no quoting (cwd path mode).
- `expandPerFile` does NOT shell-quote `${{project}}` even with `forShell: true`.
- `expandPerFile` throws if `${{group_dir}}` appears but `groupDir === null`.
- `shellQuote("")` returns `''`; `shellQuote("plain")` returns `'plain'`; `shellQuote("a'b")` returns `'a'\''b'`.
- `findGroupDir("packages/foo/src/lib/util.ts", "packages/*")` returns `"packages/foo"`.
- `findGroupDir("packages/foo/src/util.ts", "packages/*")` returns `"packages/foo"` (same group as a deeper file in the same package).
- `findGroupDir("packages/foo/src/util.ts", "packages/*/")` returns `"packages/foo"` (trailing slash stripped: both forms accepted).
- `findGroupDir("scripts/test.sh", "packages/*")` returns `null`.
- `findGroupDir` with a multi-segment glob (e.g. `packages/*/src`) returns the first matching prefix (`packages/foo/src`).
- `hasPerFileVariable` is true for `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, `${{file_ext}}`; false for `${{project}}`, `${{file_dir}}`, `${{group_dir}}`, and plain text.
- `hasGroupDirVariable` is true only for `${{group_dir}}`; false for the other variables.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Implemented variable expansion in `src/template.ts`:

- Added `shellQuote(value)` — wraps in single quotes and escapes embedded single quotes via the `'\''` sequence; produces `''` for the empty string.
- Added `expandStatic(input, ctx)` — replaces `${{project}}` with `ctx.projectDir`; throws if any per-file or `${{group_dir}}` variable appears.
- Added `expandPerFile(input, ctx, file, groupDir, opts)` — replaces all seven supported variables; under `forShell: true` shell-quotes every per-file substitution including `${{group_dir}}` but not `${{project}}`; throws when `${{group_dir}}` appears with `groupDir === null`.
- Added `findGroupDir(filePath, groupBy)` — strips a single trailing `/` from the pattern, then tests successively-longer segment prefixes (1..length-1) of `filePath` against `picomatch(strippedGroupBy, { dot: true })` and returns the first match or `null`.
- Added `hasPerFileVariable(input)` — true when `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` appears (intentionally excludes `${{file_dir}}`, `${{group_dir}}`, `${{project}}`).
- Added `hasGroupDirVariable(input)` — true when `${{group_dir}}` appears.
- Added `ExpandPerFileOptions` named interface (the project style ban on inline anonymous object types means the `opts` argument needed a named type).

Internal recogniser: a single `/g`-flagged regex `\$\{\{(project|file_path|file_name|file_basename|file_ext|file_dir|group_dir)\}\}/g` drives both `expandStatic` and `expandPerFile` via `String.prototype.replace`. Two non-`/g` regexes back the `hasPerFileVariable` and `hasGroupDirVariable` helpers.

`TemplateContext` (already existed) was kept as-is; it carries only `projectDir`.

Tests added in `src/test/template.test.ts` covering every bullet from the step file: shell-quoting of empty/plain/quoted/metacharacter strings; static replacement and throw-on-per-file-variable for `expandStatic`; verbatim and shell-quoted per-file substitutions; the `archive.tar.gz` and `Makefile` edge cases; the `${{group_dir}}` null-throw under both `forShell` modes; the four `findGroupDir` cases plus a multi-segment-glob case and a one-segment-file case; and the predicate matrix for `hasPerFileVariable` / `hasGroupDirVariable`.

`bun run compile` and `bun run test` pass (301 tests across 9 suites). `bun run smoke` fails because `scripts/smoke-tests.sh` does not exist yet — that script is delivered by step 14, which is still unchecked.
