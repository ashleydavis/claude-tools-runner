import { aggregateHash } from "./hash";
import { findCommandRun } from "./state";
import { CommandRunEntry, CompiledCommand, State } from "./types";

// Decision returned by `decideGate` for one prepared command. Carries both the boolean run/skip decision
// and the diagnostic `reason` string that the runner prints in PASS/FAIL/SKIP log lines, plus the freshly
// computed `filesHash` so the runner can persist it on success without recomputing.
export interface GateDecision {
    // Whether the command should be executed on this Stop event.
    run: boolean;
    // Human-readable rationale for the decision. One of: "first run", "in cooldown",
    // "no file changes since last successful run", or "files changed since last run".
    reason: string;
    // SHA-256 hex digest of `prepared.matchedFiles` content, computed via `aggregateHash`. Returned even when
    // `run` is false so callers can compare against the stored `lastFilesHash` without recomputing.
    filesHash: string;
}

// Decides whether `prepared` should run on this Stop event. The decision combines two gates:
//   1. Cooldown: at least `command.cooldown` seconds must have elapsed since the last successful run.
//   2. File-change: even after cooldown elapses, the aggregate hash of matched files must differ from the
//      `lastFilesHash` recorded for the previous successful run.
// The state is read but never mutated: `lastRunAt` and `lastFilesHash` are only ever updated by the runner
// when the command actually executes successfully. A skipped Stop event leaves state untouched, so the
// cooldown clock keeps ticking from the last *successful* run and is never extended by skipped events.
// A malformed `lastRunAt` (i.e. one that does not parse via `Date.parse`) is treated as "no prior entry"
// after writing one diagnostic line to stderr; this matches the recovery behaviour for a corrupt state file.
export async function decideGate(prepared: CompiledCommand, state: State, now: Date): Promise<GateDecision> {
    const filesHash: string = await aggregateHash(prepared.matchedFiles, state.fileHashes);
    const entry: CommandRunEntry | undefined = findCommandRun(state, prepared.commandKey);
    if (entry === undefined) {
        return { run: true, reason: "first run", filesHash };
    }

    const lastRunAtMs: number = Date.parse(entry.lastRunAt);
    if (Number.isNaN(lastRunAtMs)) {
        process.stderr.write(`[tools-runner] ${prepared.sourceFile} cmd ${prepared.commandIndex}: invalid lastRunAt "${entry.lastRunAt}", treating as first run\n`);
        return { run: true, reason: "first run", filesHash };
    }

    const elapsedMs: number = now.getTime() - lastRunAtMs;
    const cooldownSeconds: number = prepared.command.cooldown ?? 60;
    const cooldownMs: number = cooldownSeconds * 1000;
    const inCooldown: boolean = elapsedMs < cooldownMs;
    if (inCooldown) {
        return { run: false, reason: "in cooldown", filesHash };
    }

    if (filesHash === entry.lastFilesHash) {
        return { run: false, reason: "no file changes since last successful run", filesHash };
    }

    return { run: true, reason: "files changed since last run", filesHash };
}
