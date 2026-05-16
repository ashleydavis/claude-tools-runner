import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decideGate } from "../gate";
import { aggregateHash } from "../hash";
import { computeCommandKey } from "../compile";
import { emptyState } from "../state";
import { ChangedFile, CommandConfig, CommandRunEntry, CompiledCommand, State } from "../types";

// Holds a temp directory path for the lifetime of one test. Each test gets its own area so file content,
// mtimes, and the resulting hashes never bleed between cases.
interface TempArea {
    // Absolute path to the per-test temp directory.
    rootDir: string;
}

// Creates a fresh temp directory under the OS temp root and returns a `TempArea` referencing it.
async function makeTempArea(): Promise<TempArea> {
    const baseDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-gate-test-"));
    return { rootDir: baseDir };
}

// Removes a temp area created by `makeTempArea`, ignoring missing-directory errors.
async function cleanupTempArea(area: TempArea): Promise<void> {
    await fs.rm(area.rootDir, { recursive: true, force: true });
}

// Writes `content` to a file inside `area.rootDir` and returns a `ChangedFile` for it. The relative `path`
// of the returned `ChangedFile` is `relativePath`; the `absPath` is the joined absolute location.
async function writeChangedFile(area: TempArea, relativePath: string, content: string): Promise<ChangedFile> {
    const absolutePath: string = path.join(area.rootDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return { path: relativePath, absPath: absolutePath };
}

// Builds a `CompiledCommand` fixture for gate tests. Cooldown defaults to 60 seconds (the production
// default applied by `parseCommand`); pass `cooldownSeconds` to override.
function makePrepared(matchedFiles: ChangedFile[], expandedRun: string, expandedCwd: string, cooldownSeconds: number): CompiledCommand {
    const command: CommandConfig = {
        run: expandedRun,
        cooldown: cooldownSeconds,
        timeout: 300,
        cwd: expandedCwd,
        sourceLine: 1,
    };
    return {
        sourceFile: "test-source.yaml",
        sourceLine: 1,
        triggerIndexInFile: 0,
        commandIndex: 0,
        commandSourceLine: 1,
        command,
        expandedCwd,
        expandedRun,
        commandKey: computeCommandKey(expandedRun, expandedCwd),
        matchedFiles,
    };
}

// Builds a `State` containing a single `CommandRunEntry` for `prepared`. `lastRunAt` and `lastFilesHash`
// are caller-supplied so each test pins the values relevant to its branch.
function makeStateWithEntry(prepared: CompiledCommand, lastRunAt: string, lastFilesHash: string): State {
    const entry: CommandRunEntry = {
        commandKey: prepared.commandKey,
        expandedRun: prepared.expandedRun,
        expandedCwd: prepared.expandedCwd,
        sourceFile: prepared.sourceFile,
        sourceLine: prepared.sourceLine,
        lastRunAt,
        lastFilesHash,
        matchedFiles: prepared.matchedFiles.map(matchedFile => matchedFile.absPath).sort(),
    };
    const state: State = emptyState();
    state.commandRuns.push(entry);
    return state;
}

describe("decideGate", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns run with reason 'first run' when there is no prior entry", async () => {
        const matchedFile: ChangedFile = await writeChangedFile(tempArea, "src/foo.ts", "alpha");
        const prepared: CompiledCommand = makePrepared([matchedFile], "echo first", "/work", 60);
        const state: State = emptyState();
        const now: Date = new Date("2026-05-09T12:00:00.000Z");

        const decision = await decideGate(prepared, state, now);

        expect(decision.type).toBe("GATE_RUN");
        expect(decision.filesHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("returns skip with reason 'in cooldown' when elapsed time is below cooldown", async () => {
        const matchedFile: ChangedFile = await writeChangedFile(tempArea, "src/foo.ts", "alpha");
        const prepared: CompiledCommand = makePrepared([matchedFile], "echo cooldown", "/work", 60);
        const lastRunAt: string = "2026-05-09T12:00:00.000Z";
        const state: State = makeStateWithEntry(prepared, lastRunAt, "anyPriorHashValue");
        // Only 30 seconds elapsed; cooldown is 60 seconds.
        const now: Date = new Date("2026-05-09T12:00:30.000Z");

        const decision = await decideGate(prepared, state, now);

        expect(decision.type).toBe("COOLDOWN");
    });

    test("counts a negative elapsed (now before lastRunAt) as in cooldown", async () => {
        const matchedFile: ChangedFile = await writeChangedFile(tempArea, "src/foo.ts", "alpha");
        const prepared: CompiledCommand = makePrepared([matchedFile], "echo skew", "/work", 60);
        const lastRunAt: string = "2026-05-09T12:00:00.000Z";
        const state: State = makeStateWithEntry(prepared, lastRunAt, "anyPriorHashValue");
        // `now` is before `lastRunAt`, simulating clock skew.
        const now: Date = new Date("2026-05-09T11:59:00.000Z");

        const decision = await decideGate(prepared, state, now);

        expect(decision.type).toBe("COOLDOWN");
    });

    test("returns skip with reason 'no file changes since last successful run' when cooldown expired and hash matches", async () => {
        const matchedFile: ChangedFile = await writeChangedFile(tempArea, "src/foo.ts", "alpha");
        const prepared: CompiledCommand = makePrepared([matchedFile], "echo same", "/work", 60);
        const currentFilesHash: string = await aggregateHash(prepared.matchedFiles, {});
        const lastRunAt: string = "2026-05-09T12:00:00.000Z";
        const state: State = makeStateWithEntry(prepared, lastRunAt, currentFilesHash);
        // 120 seconds elapsed; cooldown is 60 seconds.
        const now: Date = new Date("2026-05-09T12:02:00.000Z");

        const decision = await decideGate(prepared, state, now);

        expect(decision.type).toBe("UNCHANGED");
        expect(decision.filesHash).toBe(currentFilesHash);
    });

    test("returns run with reason 'files changed since last run' when cooldown expired and hash differs", async () => {
        const matchedFile: ChangedFile = await writeChangedFile(tempArea, "src/foo.ts", "alpha");
        const prepared: CompiledCommand = makePrepared([matchedFile], "echo diff", "/work", 60);
        const lastRunAt: string = "2026-05-09T12:00:00.000Z";
        const state: State = makeStateWithEntry(prepared, lastRunAt, "differentPriorHashValue");
        // 120 seconds elapsed; cooldown is 60 seconds.
        const now: Date = new Date("2026-05-09T12:02:00.000Z");

        const decision = await decideGate(prepared, state, now);

        expect(decision.type).toBe("GATE_RUN");
        expect(decision.filesHash).not.toBe("differentPriorHashValue");
        expect(decision.filesHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("treats a malformed lastRunAt as first run and writes one stderr line", async () => {
        const matchedFile: ChangedFile = await writeChangedFile(tempArea, "src/foo.ts", "alpha");
        const prepared: CompiledCommand = makePrepared([matchedFile], "echo malformed", "/work", 60);
        const state: State = makeStateWithEntry(prepared, "not-a-date", "priorHashValue");
        const now: Date = new Date("2026-05-09T12:00:00.000Z");

        const writtenChunks: string[] = [];
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk: any): boolean => {
            writtenChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        });

        try {
            const decision = await decideGate(prepared, state, now);

            expect(decision.type).toBe("GATE_RUN");
            expect(writtenChunks.length).toBe(1);
            expect(writtenChunks[0]).toBe(`[tools-runner] ${prepared.sourceFile} cmd ${prepared.commandIndex}: invalid lastRunAt "not-a-date", treating as first run\n`);
        }
        finally {
            stderrSpy.mockRestore();
        }
    });
});
