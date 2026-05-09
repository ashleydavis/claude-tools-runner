# Step 3: Config loader

Implement the YAML config loader that reads ONE file at a time, validates it, and applies the documented defaults. Also delivers the duration-string parser used to normalize `cooldown` and `timeout` from their YAML form into integer seconds. The layered registry that wraps multiple files is built in step 4: this step only delivers the per-file primitive plus path helpers plus the duration helper.

## Source: `./src/duration.ts` (plan section 4.1)

Export:

- `function parseDuration(input: unknown, fieldName: string): number`:
  - Pure compute, no IO.
  - Accepts only strings; rejects any other type with a clear validation error that includes `fieldName`.
  - Format: `<digits>` (interpreted as seconds when no unit suffix is given) or `<digits><unit>` where unit is one of `s`, `m`, `h`. Internal regex: `/^(\d+)(s|m|h)?$/`.
  - Examples accepted: `"30"` → 30, `"30s"` → 30, `"5m"` → 300, `"1h"` → 3600, `"0"` → 0, `"0s"` → 0.
  - Examples rejected (with descriptive error): YAML number `30`; decimals `"1.5s"`; negatives `"-5s"`; unsupported units `"500ms"`, `"7d"`; empty string; whitespace; anything else.
  - Returns: integer seconds.

## Source: `./src/config.ts` (plan section 4.2)

Export:

- `async function loadConfigFile(filePath: string): Promise<Config | null>`:
  - Loads ONE YAML file via `fs.readFile(filePath, "utf8")` from `node:fs/promises`.
  - Catch `ENOENT` and return `null`.
  - Throws on parse or validation errors.
  - Uses the `yaml` package's document parser (`YAML.parseDocument(text, { keepSourceTokens: true })`) so each trigger node retains its source position. The plain-object form needed for validation is obtained via `doc.toJS()`; line lookup is done by walking `doc.contents` and reading each trigger node's `range[0]` byte offset, then converting it to a 1-based line number with a single linear scan over the original text (counting `\n`s up to that offset).
  - Validates: `triggers` is an array; every entry has at least one command; every command has a non-empty `run` string. If a trigger has `group_by`, validates it is a non-empty string. `paths` is optional; absent or empty `paths` is valid (trigger simply never fires). The `group_by` glob itself isn't validated against `paths` here: a misconfigured `group_by` is caught at prepare time.
  - For each command: parses `cooldown` via `parseDuration(rawCooldown, "cooldown")` when present; when absent, fills with the integer `60` (1 minute default, no parse needed). Parses `timeout` via `parseDuration(rawTimeout, "timeout")` when present; when absent, fills with the integer `300`. The resulting `CommandConfig` has `cooldown: number` and `timeout: number` (integer seconds).
  - Defaults: `cwd` → `"${{project}}"` when missing. Template variables available in `run`/`cwd` include `${{project}}`, `${{file_path}}`, `${{file_name}}`, `${{file_basename}}` (name without extension), `${{file_ext}}` (extension with leading dot, empty string if none), `${{file_dir}}`, and `${{group_dir}}`; expansion is handled by step 9 (`template.ts`), not by this module.
  - **Source-line capture**: each `Trigger` returned by the loader carries a `sourceLine: number` field set to the 1-based line number in `filePath` where that trigger's YAML node begins (the line of its first `-` or first key, whichever the document parser reports). When the trigger node has no resolvable position (e.g., a synthetic empty list), `sourceLine` is `1`. This field flows through to `CompiledCommand` and into every audit-log entry that references the trigger so users can jump straight from the audit log to the line in their YAML that produced the entry.
  - Returns `{ triggers: [...] }`. A YAML document with no `triggers` key returns `{ triggers: [] }` (absent is not an error). The schema has only one top-level key (`triggers`); any other top-level key is a validation error.

- `async function scanConfigFiles(projectDir: string): Promise<string[]>`:
  - Scans downward from `projectDir` recursively for all `.claude/tools-runner.yaml` files.
  - Uses `fs.readdir(..., { withFileTypes: true })` from `node:fs/promises`.
  - Skips `node_modules/`, `.git/`, `.cache/`, and any directory starting with `.` other than `.claude`.
  - Returns a sorted array of absolute paths to every found `tools-runner.yaml`.

- `function homeConfigPath(): string | null`: returns `${HOME}/.claude/tools-runner.yaml` or `null` if `process.env["HOME"]` is unset.

### IO conventions (plan "Implementation conventions")

- All IO async. Use `node:fs/promises` (`fs.readFile`, `fs.writeFile`, etc.); no Bun-specific APIs (no `Bun.file`, `Bun.write`). No `*Sync` calls.
- Existence checks via `await fs.stat` + ENOENT catch: never `existsSync`.

### Validation behavior (plan section 4.2)

Reject only structural problems. An empty `triggers: []` list is valid (lets a user keep an empty home or per-project config in place). A parse or validation error in any layer aborts the hook: the error is written to stderr (one line, `[tools-runner] failed to load ${displayFile}: ${err.message}`) and emitted to the audit log as a `hook_error` entry, and the hook exits 1 without running any commands. The abort behaviour is implemented by the caller (the stop-hook's top-level `try/catch` in step 13); `loadConfigFile` itself just throws, and `FileLayer.create` (step 4) lets the error propagate.

## Tests: `./src/test/duration.test.ts`

- Happy paths: `"30"` → 30, `"30s"` → 30, `"5m"` → 300, `"1h"` → 3600, `"0"` → 0, `"0s"` → 0.
- Rejects bare numbers (`30`) with a message that includes the field name.
- Rejects decimals (`"1.5s"`), negatives (`"-5s"`), unsupported units (`"500ms"`, `"7d"`), the empty string, leading/trailing whitespace, and non-string types (object, null, undefined, array).
- The error message contains the supplied `fieldName` so two failures from different fields are distinguishable.

## Tests: `./src/test/config.test.ts` (plan section 15.1)

- `loadConfigFile` returns `null` for missing file.
- Valid yaml round-trips into the expected shape with defaults filled (`cwd === "${{project}}"`, `timeout === 300` when `timeout` is omitted, `cooldown === 60` when `cooldown` is omitted).
- `cooldown` and `timeout` values like `"30s"`, `"5m"`, `"1h"` parse to 30, 300, 3600 respectively (integer seconds).
- Throws on unparseable yaml.
- Throws when `triggers` is not an array, when a command has empty `run`, when `cooldown` is a YAML number (e.g. `cooldown: 30`), when `cooldown` is a malformed duration string (e.g. `"1.5s"`, `"500ms"`).
- An empty document is accepted (returns `{ triggers: [] }`); a document with `triggers: []` is accepted.
- A trigger with no `paths` key is accepted; it simply never fires.
- A trigger with `paths: []` is accepted; it never fires.
- A document with any unknown top-level key (e.g. `settings: ...`, `foo: 1`) throws a validation error.
- A trigger with `group_by: packages/*` parses; the `Trigger` object has `group_by: "packages/*"`.
- A trigger with `group_by: ""` (empty string) throws a validation error.
- A trigger with `group_by` set to a non-string value (number, list, etc.) throws.
- **Source-line capture**: a YAML file with three triggers whose first lines start at lines 3, 9, and 15 of the document yields `Trigger` objects with `sourceLine === 3`, `9`, and `15` respectively. Lines counted are 1-based and refer to the line of the trigger's first child (the `-` marker or the first key of the trigger map).
- **Source-line capture across leading blank lines and comments**: `sourceLine` is the line of the trigger node itself, not the line of `triggers:`. A document beginning with comment lines and a `triggers:` key on line 5, with the first trigger entry starting on line 6, yields `sourceLine === 6` for that trigger.
- `homeConfigPath` returns `null` when `HOME` is unset; returns the expected path otherwise.
- `scanConfigFiles` returns paths to all `.claude/tools-runner.yaml` files found under a temp dir tree.
- `scanConfigFiles` skips `node_modules/` directories.

Use Jest API (`describe`, `test`, `expect`, etc.). Imports from `@jest/globals` if explicit imports are needed. No `*Sync` calls in tests. Use `await fs.writeFile(...)` / `await fs.mkdtemp(...)` from `node:fs/promises` for fixture setup (no Bun-specific APIs).

## Verification

- `bun run compile` passes.
- `bun run test` runs the new file's tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Delivered the per-file YAML config primitive plus the duration-string parser used to normalize cooldown/timeout values.

**Files added:**
- `src/duration.ts` — `parseDuration(input, fieldName)` accepting the regex-validated forms `"<digits>"`, `"<digits>s|m|h"` and rejecting non-strings, decimals, negatives, unsupported units, empty/whitespace strings. Includes the field name in every error message so cooldown vs timeout failures are distinguishable.
- `src/config.ts` — `loadConfigFile(filePath)`, `scanConfigFiles(projectDir)`, `homeConfigPath()`. Loader uses `YAML.parseDocument(text, { keepSourceTokens: true })`, validates the schema (only `triggers` allowed at top-level, every trigger needs at least one command, every command needs a non-empty `run`, `group_by` must be a non-empty string when present), fills defaults (`cwd: "${{project}}"`, `cooldown: 60`, `timeout: 300`), and captures each trigger's 1-based source line by walking `doc.contents.items` to find the `triggers` seq and reading `range[0]` on each item, then converting that byte offset to a line number with a single linear scan over the source text. Empty docs and `triggers: []` round-trip to `{ triggers: [] }`.
- `src/test/duration.test.ts` — 19 tests covering happy paths, all rejection categories, and field-name distinguishability.
- `src/test/config.test.ts` — 24 tests covering null-on-missing-file, default fill-in, duration parsing for cooldown/timeout, all validation errors, empty/empty-list documents, optional/empty `paths`, unknown top-level keys, `group_by` happy/empty/non-string paths, source-line capture across explicit positions and across leading comments, `homeConfigPath` with HOME set/unset, and `scanConfigFiles` against a temp tree (sorted output, node_modules skip, dot-prefix skip, empty tree).

**Key decisions / divergences:**
- `parseDuration` is typed as `(input: any, fieldName: string)` rather than `(input: unknown, ...)` because CLAUDE.md bans the `unknown` type. Using `any` at this validation boundary preserves the spec's intent (accept anything, validate at runtime).
- `YAML.parseDocument` `range[0]` was empirically verified to point at the first key character of a block-sequence trigger (e.g. `p` of `paths:`). The line counter handles missing/non-numeric ranges by defaulting to line `1`, satisfying the "synthetic empty list" clause.
- `scanConfigFiles` propagates `readdir` errors but explicitly catches `ENOENT` from the `fs.stat` existence check (per the project's "fs.stat + ENOENT catch" convention) so a `.claude/` directory without a `tools-runner.yaml` doesn't crash the scan.

**Deferred / not done in this step:**
- The `FileLayer` wrapper and `TriggerRegistry` that turn one or more loaded `Config` objects into compiled commands (step 4).
- Smoke-test coverage of `loadConfigFile` and `scanConfigFiles` is deferred to step 14, per the plan ordering (no `scripts/smoke-tests.sh` exists yet).

**Verification:**
- `bun run compile` clean.
- `bun run test` 44/44 passing (19 duration + 25 config tests).
- `bun run smoke` is expected to fail at this point because the smoke-test scripts are introduced in step 14.
