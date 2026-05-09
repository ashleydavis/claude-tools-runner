# Step 15: Update documentation

Revise the four documentation files written in step 1 to reflect the final state of the code, including anything that changed during implementation. The goal: the docs and the shipped code agree, byte-for-byte where they describe identical artifacts (state YAML shape, log line catalog, config schema, env vars).

## What to revise

### 15.1. `./README.md`

- Re-verify the install steps actually work as written (run them in a clean sandbox if needed).
- Re-verify the single example YAML and its description match what the implemented hook actually does on a single TS file change.
- Confirm every relative link still resolves.

### 15.2. `./docs/CONFIGURATION.md`

- **Schema reference**: every field, type, default, and required-ness must match `src/types.ts` and the validator in `src/config.ts`.
- **Variables**: every variable listed must be implemented in `src/template.ts`. If any variables were added during implementation (e.g., a `{branch}` variable someone introduced), document them and their availability scope. If any were removed, drop them from the doc. Confirm the table accurately distinguishes pre-match (`paths` allowed) vs post-match (`run`/`cwd` only) scope.
- **Worked examples**: re-run each example in a sandbox or by code inspection to verify it does what the doc claims.
- **Layering diagram**: confirm the home/project order in the diagram matches the actual `TriggerRegistry` construction order in `src/stop-hook.ts`.
- **Per-Stop reload diagram**: confirm the docs still describe the no-watcher behaviour (each Stop spawns a fresh process that re-reads every YAML; no in-process file watcher).
- **Troubleshooting**: confirm the documented 30-day state TTL constant matches `src/state.ts`. Document `cooldown: "0s"` as the way to bypass cooldown.

### 15.3. `./docs/HOW_IT_WORKS.md`

- **Architecture diagram**: re-trace the diagram against the actual call graph from `runStopHook` → `discoverRepos` → `FileLayer.create` → `loadState` → `collectChangedFiles` (per discovered repo) → `compileCommands` → `runCommands` → `saveState`. Update if any step was renamed, split, or merged.
- **Cooldown decision table**: ensure the four branches in the doc match the four branches in `src/gate.ts` exactly (the `inCooldown` + `filesHash` truth table). Confirm the doc reflects that `lastRunAt` is only ever updated when a command actually runs, never on skip.
- **Sequence diagram**: confirm the three-Stop sequence is consistent with the actual gate behavior (in particular that skipped Stop events do not bump `lastRunAt`).
- **Literal state-file YAML example**: regenerate from a real run if possible, or re-derive the field names from `src/types.ts`. The keys MUST be the verbatim TypeScript field names (camelCase). If the smoke test in scenario 7 produced a real state file, copy a sanitized version of it into the doc. This is the canonical reference (Issue 22): drift here breaks smoke tests.

### 15.4. `./docs/DEVELOPMENT.md`

- **Scripts**: every command listed (`bun run compile`, `bun run test`, `bun run smoke`, `bun run hook-smoke`, `bun run test:all`) must exist in `package.json` and behave as described.
- **Bundle**: confirm `bun run bundle` produces `plugin/dist/stop-hook.js` and document any flags or outputs that changed.
- (The "Adding a new template token" section was dropped from DEVELOPMENT.md during step 1: no review needed.)
- **Bun-missing note** (Issue 15): confirm the documented behavior matches what actually happens when `bun` is absent.

## Cross-cutting checks

Before marking this step done, run all of these and confirm they hold:

1. The state YAML example in `docs/HOW_IT_WORKS.md` parses via the `yaml` package AND uses the exact field names emitted by `saveState` (open a file written by the smoke script and diff the keys).
2. Every log-line literal cited in `docs/HOW_IT_WORKS.md` or `docs/DEVELOPMENT.md` appears verbatim in `src/stop-hook.ts`, `src/runner.ts`, or `src/gate.ts` (grep the source for each documented literal).
3. The implementation reads zero `TOOLS_RUNNER_*` env vars (all configuration is in YAML or hardcoded). Every YAML field documented in CONFIGURATION.md is read by the implementation; every field the implementation reads is documented.
4. Every relative link in every doc resolves to an existing file.
5. All fenced code blocks are properly closed (no unmatched ` ``` `).
6. Every YAML example in any doc parses successfully via the `yaml` package.

## Verification

- All cross-cutting checks above hold.
- `bun run test:all` still passes after any code changes made during this step (e.g., if a docs-driven fix exposes a real bug, fix the code AND re-verify the docs).
- `bun run compile` passes.

Run all tests and confirm they pass before marking this step complete.

## Summary

Audited the four shipped doc files against the implementation and made small accuracy fixes; uncovered and fixed one latent smoke-test bug introduced by step 15.

**Doc fixes (3-line diff total):**

- `docs/CONFIGURATION.md`: `paths` are matched against scope-relative paths, not "repo-relative" — corrected the schema-reference wording. Example 1's prose claimed "for the next 30 seconds" but the example doesn't override `cooldown`, so the default `1m` applies — corrected to "for the next minute (the default `cooldown`)".
- `docs/DEVELOPMENT.md`: troubleshooting hint "your glob doesn't match the repo-relative POSIX path" updated to "scope-relative POSIX path (relative to the config file's directory)".
- `README.md`, `docs/HOW_IT_WORKS.md`: re-checked end-to-end; no changes needed. The architecture diagram, four-branch gate decision table (matches `src/gate.ts` exactly), three-Stop sequence, and literal state-file YAML example (verbatim camelCase TS field names from `src/types.ts`) are all current.

**Cross-cutting checks (all pass):**

- All 9 fenced YAML examples across the four docs parse via the `yaml` package.
- All 11 documented stdout/stderr literals appear verbatim in `src/`.
- The implementation reads zero `TOOLS_RUNNER_*` env vars (only `HOME`, `CLAUDE_PROJECT_DIR`, `NODE_ENV`).
- All 7 relative `*.md` links resolve.
- Every fenced code block is closed (even delimiter counts in every doc).

**Latent bug fix in `scripts/smoke-tests.sh` (scenario 16):**

- Step 15 added the audit-log files at `<HH>.log` as siblings of the per-command log subdir `<HH>/`. Scenario 16's `find ... -name '*.log' | head -n1` previously matched only per-command logs; post-step-15 the audit log was found first on this filesystem and the `[OUT]/[ERR]` assertion failed against the wrong file.
- Fixed by adding `-mindepth 4` so the find only matches per-command logs (depth 4 from `tools-runner-log/`), not audit logs (depth 3). All 21 smoke scenarios pass after the fix.

**Verification:** `bun run compile` PASS · `bun run test` PASS (464) · `bun run smoke` PASS (21/21) · `bun run hook-smoke` PASS (4/4).

Nothing deferred.
