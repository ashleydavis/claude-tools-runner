import { aggregateHash } from "./hash";
import { findCommandRun } from "./state";
import { CommandRunEntry, CompiledCommand, State } from "./types";

// Decision returned by `decideGate` for one prepared command. The `type` discriminator IS the user-facing
// audit-log label: `GATE_RUN` means the command should be executed (JSON-only entry, no text-log line);
// `COOLDOWN`, `UNCHANGED`, and `SKIP` are the three skip variants branched by cause so each cause is
// greppable in the text log. `filesHash` is the freshly computed aggregate hash; it is returned even on
// the skip paths so the runner can persist it on success without recomputing.
export interface GateDecision {
    // User-facing audit-log type. Doubles as both the "should we run?" predicate (only `GATE_RUN` runs)
    // and the text-log label for skip variants.
    type: "GATE_RUN" | "COOLDOWN" | "UNCHANGED" | "SKIP";
    // SHA-256 hex digest of `prepared.matchedFiles` content, computed via `aggregateHash`. Returned even
    // on the skip paths so callers can compare against the stored `lastFilesHash` without recomputing.
    filesHash: string;
}

// Decides whether `prepared` should run on this Stop event. The decision combines two gates:
//   1. Cooldown: at least `command.cooldown` seconds must have elapsed since the last attempt.
//   2. File-change: even after cooldown elapses, the aggregate hash of matched files must differ from the
//      `lastFilesHash` recorded for the previous attempt.
// The state is read but never mutated: `lastRunAt` and `lastFilesHash` are updated by the runner whenever
// the command actually executes (PASS, FAIL, or TIMEOUT). A gate-skipped Stop event leaves state untouched,
// so the cooldown clock keeps ticking from the last attempt and is never extended by skipped events.
// Recording on FAIL/TIMEOUT (not just PASS) is what keeps a persistently failing command from re-burning
// CPU on every Stop event while its matched files stay identical; a dev edit changes the hash and lets the
// next event run again. A malformed `lastRunAt` (i.e. one that does not parse via `Date.parse`) is treated
// as "no prior entry" after writing one diagnostic line to stderr; this matches the recovery behaviour for
// a corrupt state file.
export async function decideGate(prepared: CompiledCommand, state: State, now: Date): Promise<GateDecision> {
    const filesHash: string = await aggregateHash(prepared.matchedFiles, state.fileHashes);
    const entry: CommandRunEntry | undefined = findCommandRun(state, prepared.commandKey);
    if (entry === undefined) {
        return { type: "GATE_RUN", filesHash };
    }

    const lastRunAtMs: number = Date.parse(entry.lastRunAt);
    if (Number.isNaN(lastRunAtMs)) {
        process.stderr.write(`[tools-runner] ${prepared.sourceFile} cmd ${prepared.commandIndex}: invalid lastRunAt "${entry.lastRunAt}", treating as first run\n`);
        return { type: "GATE_RUN", filesHash };
    }

    const elapsedMs: number = now.getTime() - lastRunAtMs;
    const cooldownSeconds: number = prepared.command.cooldown ?? 60;
    const cooldownMs: number = cooldownSeconds * 1000;
    const inCooldown: boolean = elapsedMs < cooldownMs;
    if (inCooldown) {
        return { type: "COOLDOWN", filesHash };
    }

    if (filesHash === entry.lastFilesHash) {
        return { type: "UNCHANGED", filesHash };
    }

    return { type: "GATE_RUN", filesHash };
}
