# Step 11: Cooldown and hash gating

Decide whether each `CompiledCommand` should run or skip. The decision depends on cooldown elapsed since `lastRunAt` and whether the aggregate file hash has changed since the last successful run. `lastRunAt` is only ever updated when the command actually runs; skipped commands never touch state.

## Source: `./src/gate.ts` (plan section 12.1)

Export:

- `interface GateDecision { run: boolean; reason: string; filesHash: string; }`

- `async function decideGate(prepared: CompiledCommand, state: State, now: Date): Promise<GateDecision>`:
  - Look up the `CommandRunEntry` keyed by `prepared.commandKey` (i.e., `sha256(expandedRun + "\0" + expandedCwd)`).
  - Compute `filesHash` via `await aggregateHash(prepared.matchedFiles, state.fileHashes)`.
  - **No prior entry**: `{ run: true, reason: "first run", filesHash }`.
  - **Time conversion** (used by every subsequent branch: Issue 11):
    - `const lastRunAtMs = Date.parse(entry.lastRunAt);`
    - If `Number.isNaN(lastRunAtMs)`, log one line to stderr: `[tools-runner] {sourceFile} cmd {commandIndex}: invalid lastRunAt "{entry.lastRunAt}", treating as first run`. Then treat as no prior entry (return the first-run branch above).
    - Otherwise: `const elapsedMs = now.getTime() - lastRunAtMs;` and `const cooldownMs = (prepared.command.cooldown ?? 60) * 1000;` (default 60 s, i.e. "1m", when the field is absent).
    - `inCooldown = elapsedMs < cooldownMs`.
    - A negative `elapsedMs` (clock skew or test-injected past `now`) counts as in-cooldown.
  - **`inCooldown`** (regardless of hash): `{ run: false, reason: "in cooldown", filesHash }`. Cooldown is measured from the last successful run only and is never extended by skipped Stop events.
  - **Cooldown expired (`!inCooldown`) AND `filesHash === lastFilesHash`**: `{ run: false, reason: "no file changes since last successful run", filesHash }`.
  - **Cooldown expired (`!inCooldown`) AND `filesHash !== lastFilesHash`**: `{ run: true, reason: "files changed since last run", filesHash }`.

All time arithmetic is in milliseconds; `command.cooldown` is the only seconds-domain value and is converted at exactly one place.

## Tests: `./src/test/gate.test.ts` (plan section 15.8)

Cover all four branches enumerated above, using fake `now` values:

1. No prior entry → run, `reason: "first run"`.
2. In cooldown (any hash) → skip, `reason: "in cooldown"`.
3. Cooldown expired + same hash → skip, `reason: "no file changes since last successful run"`.
4. Cooldown expired + different hash → run, `reason: "files changed since last run"`.

Plus: malformed `lastRunAt` (e.g., string `"not-a-date"`) is treated as first-run, AND one stderr line is written.

Construct `state` and `prepared` in-memory; use temp files only for the underlying `aggregateHash` calls (the matched files must exist on disk so `hashFileWithCache` can stat them). Use `await fs.mkdtemp(...)` and `await fs.writeFile(...)` from `node:fs/promises` (no Bun-specific APIs).

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

Implemented `./src/gate.ts` with the `GateDecision` interface and the `decideGate` async function exactly as specified:

- Looks up the prior `CommandRunEntry` via `findCommandRun(state, prepared.commandKey)` (reusing the existing helper rather than re-deriving the lookup).
- Computes `filesHash` via `aggregateHash(prepared.matchedFiles, state.fileHashes)`.
- Branches: no prior entry returns `{ run: true, reason: "first run" }`; malformed `lastRunAt` writes one stderr diagnostic and falls through to the same first-run branch; cooldown not elapsed returns `{ run: false, reason: "in cooldown" }` regardless of hash (negative elapsed counts as in-cooldown); cooldown elapsed with matching hash returns `{ run: false, reason: "no file changes since last successful run" }`; cooldown elapsed with differing hash returns `{ run: true, reason: "files changed since last run" }`.
- `cooldownSeconds` defaults to `60` (`prepared.command.cooldown ?? 60`) per the spec; in production the config loader already fills the default, so the `??` is defensive.

Added `./src/test/gate.test.ts` covering all four branches plus the malformed `lastRunAt` stderr emission and a clock-skew (negative elapsed) sub-case. Tests construct `state` and `prepared` in memory and use `fs.mkdtemp` + `fs.writeFile` for the on-disk files needed by `aggregateHash`. The malformed-`lastRunAt` test installs a `jest.spyOn(process.stderr, "write")` to capture the single diagnostic line and asserts the literal string against the catalog entry from the main plan.

Verification:
- `bun run compile` passes.
- `bun run test` passes (361 tests across 10 suites, including the 6 new `decideGate` cases).
- `bun run smoke` not run for this step: the smoke script is a deliverable of step 14 and `scripts/smoke-tests.sh` does not yet exist. Step 11's verification block only requires compile + unit tests.

Nothing diverged from the original step instructions; nothing was deferred.
