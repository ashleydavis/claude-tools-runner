import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { IAuditLogEntry, IAuditLogger, NullAuditLogger } from "../audit-log";
import { computeCommandKey } from "../compile";
import { aggregateHash } from "../hash";
import {
    RunCommandsOptions,
    RunResult,
    SpawnedProc,
    Spawner,
    defaultSpawner,
    endWriteStream,
    pipeStreamWithTag,
    resolveCommandLogPath,
    runCommands,
    runOneCommand,
    safeKill,
    toLocalISOString,
} from "../runner";
import { ChangedFile, CommandConfig, CompiledCommand, State } from "../types";

// Recording `IAuditLogger` used by the new audit-emission tests. Captures every entry handed to `log`
// without filtering so the assertions can inspect the full sequence (gate_decision, command_started,
// command_result) and pull fields like `sourceLine` straight off the captured payloads.
class RecordingAuditLogger implements IAuditLogger {
    public readonly entries: IAuditLogEntry[] = [];
    async log(entry: IAuditLogEntry): Promise<void> {
        this.entries.push(entry);
    }
}

// One stub `SpawnedProc` plus the controls a test needs to drive it: resolve/reject the `exited` promise
// from outside, push data onto the stdout/stderr streams, and observe `kill` calls.
interface IStubProc {
    // The fake `SpawnedProc` to hand back from the stub `Spawner`.
    proc: SpawnedProc;
    // Resolves `proc.exited` with the supplied exit code.
    finishWithCode: (code: number) => void;
    // Rejects `proc.exited` with the supplied error (used to simulate ENOENT from spawn).
    failWithError: (err: Error) => void;
    // Pushes a chunk into the stub `stdout` stream. Pass `null` to signal end-of-stream.
    pushStdout: (chunk: string | null) => void;
    // Pushes a chunk into the stub `stderr` stream. Pass `null` to signal end-of-stream.
    pushStderr: (chunk: string | null) => void;
    // Records calls to `proc.kill` so timeout assertions can verify the runner sent SIGTERM.
    killSpy: jest.Mock;
}

// Recorded handle returned by `makeRecordingSpawner`. Tests use `nextSpawn()` to await the next spawn call
// instead of polling, so async work scheduled inside `decideGate` (which reads file content) does not race
// the test's stub manipulation.
interface IRecordingSpawner {
    // The `Spawner` to inject via `RunCommandsOptions.spawn`.
    spawner: Spawner;
    // Resolves with the `IStubProc` produced by the next call to `spawner`. If a spawn already happened
    // and is unclaimed, resolves immediately with that stub.
    nextSpawn: () => Promise<IStubProc>;
}

// Builds a stub `SpawnedProc` and the controls needed to drive it from a test.
function makeStubProc(): IStubProc {
    const stdout = new Readable({ read() {
    } });
    const stderr = new Readable({ read() {
    } });
    let resolveExited!: (code: number) => void;
    let rejectExited!: (err: Error) => void;
    const exited = new Promise<number>((resolve, reject) => {
        resolveExited = resolve;
        rejectExited = reject;
    });
    const killSpy: jest.Mock = jest.fn().mockReturnValue(true);
    const proc: SpawnedProc = {
        exitCode: null,
        exited,
        kill: ((signal?: NodeJS.Signals | number): boolean => killSpy(signal)),
        pid: 12345,
        stdout,
        stderr,
    };
    return {
        proc,
        finishWithCode: (code) => resolveExited(code),
        failWithError: (err) => rejectExited(err),
        pushStdout: (chunk) => {
            stdout.push(chunk);
        },
        pushStderr: (chunk) => {
            stderr.push(chunk);
        },
        killSpy,
    };
}

// Builds a `Spawner` that records each spawn into a queue. Tests await `nextSpawn()` to receive the
// `IStubProc` for the n-th spawn, even when the spawn happens long after a microtask boundary (e.g. after
// `decideGate`'s file read).
function makeRecordingSpawner(): IRecordingSpawner {
    const ready: IStubProc[] = [];
    const waiters: ((stub: IStubProc) => void)[] = [];
    const spawner: Spawner = () => {
        const stub = makeStubProc();
        const waiter = waiters.shift();
        if (waiter !== undefined) {
            waiter(stub);
        }
        else {
            ready.push(stub);
        }
        return stub.proc;
    };
    const nextSpawn = (): Promise<IStubProc> => {
        return new Promise<IStubProc>((resolve) => {
            const next = ready.shift();
            if (next !== undefined) {
                resolve(next);
                return;
            }
            waiters.push(resolve);
        });
    };
    return { spawner, nextSpawn };
}

// Fixture builder: writes `content` to `relativePath` under `rootDir` and returns a `ChangedFile`. The
// gate's `aggregateHash` reads the file off disk, so each test that exercises gate behaviour must place
// the matched file under a temp directory.
async function writeChangedFile(rootDir: string, relativePath: string, content: string): Promise<ChangedFile> {
    const absolutePath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return { path: relativePath, absPath: absolutePath };
}

// Fixture builder: assembles a `CompiledCommand` from the supplied parts. Cooldown defaults to 0 so the
// gate decides "first run" / "files changed since last run" on its own; tests that need a real cooldown
// pass an explicit value.
function makeCompiled(matchedFiles: ChangedFile[], expandedRun: string, expandedCwd: string, cooldownSeconds: number, timeoutSeconds: number): CompiledCommand {
    const command: CommandConfig = {
        run: expandedRun,
        cooldown: cooldownSeconds,
        timeout: timeoutSeconds,
        cwd: expandedCwd,
    };
    return {
        sourceFile: "test.yaml",
        sourceLine: 7,
        triggerIndexInFile: 0,
        commandIndex: 0,
        command,
        expandedRun,
        expandedCwd,
        commandKey: computeCommandKey(expandedRun, expandedCwd),
        matchedFiles,
    };
}

// Suppresses `process.stdout.write` during the test so the runner's PASS/FAIL/SKIP lines do not pollute
// Jest output. Returned spy must be restored in `afterEach`.
function silenceStdout(): jest.SpyInstance {
    return jest.spyOn(process.stdout, "write").mockImplementation((): boolean => true);
}

describe("runCommands", () => {
    let tempDir: string;
    let logBaseDir: string;
    let stdoutSpy: jest.SpyInstance;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-runner-test-"));
        logBaseDir = path.join(tempDir, "log");
        stdoutSpy = silenceStdout();
    });

    afterEach(async () => {
        stdoutSpy.mockRestore();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("runs gated commands in parallel", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const fileTwo = await writeChangedFile(tempDir, "src/b.ts", "bravo");
        const compiledOne = makeCompiled([fileOne], "echo one", path.join(tempDir, "work"), 0, 30);
        const compiledTwo = makeCompiled([fileTwo], "echo two", path.join(tempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiledOne, compiledTwo], state, fixedNow, opts);

        // Both spawns must happen before either `exited` resolves: this is the parallelism assertion.
        const stubOne = await recorder.nextSpawn();
        const stubTwo = await recorder.nextSpawn();
        stubOne.pushStdout(null);
        stubOne.pushStderr(null);
        stubTwo.pushStdout(null);
        stubTwo.pushStderr(null);
        stubOne.finishWithCode(0);
        stubTwo.finishWithCode(0);

        const results = await resultsPromise;
        expect(results).toHaveLength(2);
        expect(results[0].exitCode).toBe(0);
        expect(results[1].exitCode).toBe(0);
    });

    test("on success writes a CommandRunEntry with sorted matchedFiles and copied source location", async () => {
        const fileTwo = await writeChangedFile(tempDir, "src/zeta.ts", "zeta");
        const fileOne = await writeChangedFile(tempDir, "src/alpha.ts", "alpha");
        const compiled = makeCompiled([fileTwo, fileOne], "echo ok", path.join(tempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        stub.pushStdout(null);
        stub.pushStderr(null);
        stub.finishWithCode(0);
        const results = await resultsPromise;

        expect(state.commandRuns).toHaveLength(1);
        const entry = state.commandRuns[0];
        expect(entry.commandKey).toBe(compiled.commandKey);
        expect(entry.sourceFile).toBe("test.yaml");
        expect(entry.sourceLine).toBe(7);
        expect(entry.lastRunAt).toBe(fixedNow.toISOString());
        const expectedHash = await aggregateHash(compiled.matchedFiles, {});
        expect(entry.lastFilesHash).toBe(expectedHash);
        expect(entry.matchedFiles).toEqual([fileOne.absPath, fileTwo.absPath].sort());
        expect(results[0].filesHash).toBe(expectedHash);
    });

    test("writes a per-command log file with header, [OUT]/[ERR] tagged body, and footer", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "echo body", path.join(tempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        // Yield between pushes so each chunk's `data` event fires before the next push lands. Without
        // these yields Node may emit all stdout chunks before any stderr chunks, scrambling the log
        // body's interleaving.
        stub.pushStdout("hello\n");
        await new Promise(resolve => setTimeout(resolve, 5));
        stub.pushStderr("oops\n");
        await new Promise(resolve => setTimeout(resolve, 5));
        stub.pushStdout("done\n");
        await new Promise(resolve => setTimeout(resolve, 5));
        stub.pushStdout(null);
        stub.pushStderr(null);
        stub.finishWithCode(0);
        const results = await resultsPromise;

        const logFile = results[0].logFile;
        expect(logFile.startsWith(logBaseDir)).toBe(true);
        const logText = await fs.readFile(logFile, "utf8");
        expect(logText).toContain("> echo body\n");
        expect(logText).toContain(`> cwd: ${path.join(tempDir, "work")}\n`);
        expect(logText).toContain("> started: ");
        expect(logText).toContain("---\n[OUT] hello\n[ERR] oops\n[OUT] done\n---\n");
        expect(logText).toContain("> exit: 0\n");
        expect(logText).toContain("> duration: ");
    });

    test("flushes residue without trailing newline as a [OUT] line before the footer", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "echo residue", path.join(tempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        stub.pushStdout("abc");
        await new Promise(resolve => setTimeout(resolve, 10));
        stub.pushStdout(null);
        stub.pushStderr(null);
        stub.finishWithCode(0);
        const results = await resultsPromise;

        const logText = await fs.readFile(results[0].logFile, "utf8");
        expect(logText).toContain("---\n[OUT] abc\n---\n");
    });

    test("on non-zero exit does not update lastFilesHash and the log footer records the exit code", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "exit 2", path.join(tempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        stub.pushStdout(null);
        stub.pushStderr(null);
        stub.finishWithCode(2);
        const results = await resultsPromise;

        expect(results[0].exitCode).toBe(2);
        expect(state.commandRuns).toHaveLength(0);
        const logText = await fs.readFile(results[0].logFile, "utf8");
        expect(logText).toContain("> exit: 2\n");
    });

    test("a skipped (gated-off) command leaves existing state untouched and creates no log file", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "echo skipped", path.join(tempDir, "work"), 600, 30);
        const priorHash = await aggregateHash(compiled.matchedFiles, {});
        const priorMatchedFiles = [fileOne.absPath];
        const priorLastRunAt = "2026-05-09T14:30:00.000Z";
        const state: State = {
            fileHashes: {},
            commandRuns: [{
                commandKey: compiled.commandKey,
                expandedRun: compiled.expandedRun,
                expandedCwd: compiled.expandedCwd,
                sourceFile: "prior.yaml",
                sourceLine: 99,
                lastRunAt: priorLastRunAt,
                lastFilesHash: priorHash,
                matchedFiles: priorMatchedFiles,
            }],
        };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        let spawnCalls = 0;
        const opts: RunCommandsOptions = {
            spawn: (() => {
                spawnCalls++;
                return makeStubProc().proc;
            }),
            now: () => fixedNow,
            logBaseDir,
        };

        const results = await runCommands([compiled], state, fixedNow, opts);

        expect(spawnCalls).toBe(0);
        expect(results[0].logFile).toBe("");
        expect(state.commandRuns).toHaveLength(1);
        const entry = state.commandRuns[0];
        expect(entry.lastRunAt).toBe(priorLastRunAt);
        expect(entry.lastFilesHash).toBe(priorHash);
        expect(entry.matchedFiles).toEqual(priorMatchedFiles);
        const logRoot = await fs.readdir(logBaseDir).catch(() => [] as string[]);
        expect(logRoot).toEqual([]);
    });

    test("per-command timeout kills the process and records '> killed: timeout' in the log footer", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "sleep forever", path.join(tempDir, "work"), 0, 0.05);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        stub.pushStdout(null);
        stub.pushStderr(null);

        const start = Date.now();
        const results = await resultsPromise;
        const elapsedMs = Date.now() - start;

        expect(elapsedMs).toBeLessThan(500);
        expect(results[0].error).toBe("timeout");
        expect(results[0].exitCode).toBe(-1);
        expect(stub.killSpy).toHaveBeenCalledWith("SIGTERM");
        expect(state.commandRuns).toHaveLength(0);
        const logText = await fs.readFile(results[0].logFile, "utf8");
        expect(logText).toContain("> killed: timeout\n");
    });

    test("ENOENT from spawn (rejected exited promise) surfaces error message and does not update state", async () => {
        const fileOne = await writeChangedFile(tempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "missing-binary", path.join(tempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawn sh ENOENT"), { code: "ENOENT" });
        stub.pushStdout(null);
        stub.pushStderr(null);
        stub.failWithError(enoent);
        const results: RunResult[] = await resultsPromise;

        expect(results[0].exitCode).toBe(-1);
        expect(results[0].error).toBe("spawn sh ENOENT");
        expect(state.commandRuns).toHaveLength(0);
    });
});

describe("resolveCommandLogPath", () => {
    test("produces the documented YYYY-MM/DD/HH/MM-SS-ms-keyShort.log layout", () => {
        const startedAt = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = resolveCommandLogPath("/base", startedAt, "abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaa");
        expect(result).toBe(path.join("/base", "2026-05", "09", "14", "30-15-123-abcdef01.log"));
    });

    test("zero-pads single-digit year/month/day/hour/minute/second/millisecond fields", () => {
        const startedAt = new Date(2007, 0, 1, 1, 1, 1, 1);
        const result = resolveCommandLogPath("/base", startedAt, "0123456789abcdef0123456789abcdef");
        expect(result).toBe(path.join("/base", "2007-01", "01", "01", "01-01-001-01234567.log"));
    });

    test("truncates commandKey to its first 8 characters", () => {
        const startedAt = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = resolveCommandLogPath("/base", startedAt, "0123456789abcdef0123456789abcdef0123456789abcdef");
        expect(result.endsWith("01234567.log")).toBe(true);
    });
});

describe("toLocalISOString", () => {
    test("produces a string matching YYYY-MM-DDTHH:mm:ss.SSS±HH:mm shape", () => {
        const value = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = toLocalISOString(value);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    test("zero-pads three-digit milliseconds for small values", () => {
        const value = new Date(2026, 4, 9, 14, 30, 15, 5);
        const result = toLocalISOString(value);
        expect(result).toContain(".005");
    });

    test("zero-pads single-digit month, day, hour, minute, second components", () => {
        const value = new Date(2026, 0, 1, 2, 3, 4, 56);
        const result = toLocalISOString(value);
        expect(result.startsWith("2026-01-01T02:03:04.056")).toBe(true);
    });

    test("renders the timezone offset suffix with a sign and HH:mm", () => {
        const value = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = toLocalISOString(value);
        const offsetSlice = result.slice(-6);
        expect(offsetSlice).toMatch(/^[+-]\d{2}:\d{2}$/);
    });
});

describe("safeKill", () => {
    test("forwards the signal to proc.kill", () => {
        const killSpy: jest.Mock = jest.fn().mockReturnValue(true);
        const proc: SpawnedProc = {
            exitCode: null,
            exited: Promise.resolve(0),
            kill: killSpy as (signal?: NodeJS.Signals | number) => boolean,
            pid: 123,
            stdout: null,
            stderr: null,
        };
        safeKill(proc, "SIGTERM");
        expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    });

    test("swallows errors thrown by proc.kill", () => {
        const proc: SpawnedProc = {
            exitCode: null,
            exited: Promise.resolve(0),
            kill: () => {
                throw new Error("ESRCH-style boom");
            },
            pid: 123,
            stdout: null,
            stderr: null,
        };
        expect(() => safeKill(proc, "SIGKILL")).not.toThrow();
    });
});

describe("pipeStreamWithTag", () => {
    let pipeTempDir: string;

    beforeEach(async () => {
        pipeTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-pipe-test-"));
    });

    afterEach(async () => {
        await fs.rm(pipeTempDir, { recursive: true, force: true });
    });

    test("returns a no-op flush when source is null", () => {
        const writeStream = nodeFs.createWriteStream(path.join(pipeTempDir, "null-source.log"));
        const flush = pipeStreamWithTag(null, writeStream, "[OUT] ");
        expect(() => flush()).not.toThrow();
        writeStream.end();
    });

    test("emits one tagged line per newline-terminated chunk", async () => {
        const source = new Readable({ read() {
        } });
        const logFile = path.join(pipeTempDir, "lines.log");
        const writeStream = nodeFs.createWriteStream(logFile);
        const flush = pipeStreamWithTag(source, writeStream, "[OUT] ");
        source.push("hello\nworld\n");
        source.push(null);
        await new Promise(resolve => setTimeout(resolve, 10));
        flush();
        await endWriteStream(writeStream);
        const text = await fs.readFile(logFile, "utf8");
        expect(text).toBe("[OUT] hello\n[OUT] world\n");
    });

    test("buffers a partial line and emits it when the newline arrives", async () => {
        const source = new Readable({ read() {
        } });
        const logFile = path.join(pipeTempDir, "partial.log");
        const writeStream = nodeFs.createWriteStream(logFile);
        const flush = pipeStreamWithTag(source, writeStream, "[ERR] ");
        source.push("par");
        await new Promise(resolve => setTimeout(resolve, 10));
        source.push("tial\n");
        source.push(null);
        await new Promise(resolve => setTimeout(resolve, 10));
        flush();
        await endWriteStream(writeStream);
        const text = await fs.readFile(logFile, "utf8");
        expect(text).toBe("[ERR] partial\n");
    });

    test("flush() emits residue with a synthetic trailing newline when the stream ends mid-line", async () => {
        const source = new Readable({ read() {
        } });
        const logFile = path.join(pipeTempDir, "residue.log");
        const writeStream = nodeFs.createWriteStream(logFile);
        const flush = pipeStreamWithTag(source, writeStream, "[OUT] ");
        source.push("abc");
        source.push(null);
        await new Promise(resolve => setTimeout(resolve, 10));
        flush();
        await endWriteStream(writeStream);
        const text = await fs.readFile(logFile, "utf8");
        expect(text).toBe("[OUT] abc\n");
    });

    test("flush() does not double-emit residue when called twice", async () => {
        const source = new Readable({ read() {
        } });
        const logFile = path.join(pipeTempDir, "double-flush.log");
        const writeStream = nodeFs.createWriteStream(logFile);
        const flush = pipeStreamWithTag(source, writeStream, "[OUT] ");
        source.push("xyz");
        source.push(null);
        await new Promise(resolve => setTimeout(resolve, 10));
        flush();
        flush();
        await endWriteStream(writeStream);
        const text = await fs.readFile(logFile, "utf8");
        expect(text).toBe("[OUT] xyz\n");
    });
});

describe("endWriteStream", () => {
    let endTempDir: string;

    beforeEach(async () => {
        endTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-end-test-"));
    });

    afterEach(async () => {
        await fs.rm(endTempDir, { recursive: true, force: true });
    });

    test("resolves once the WriteStream finishes flushing", async () => {
        const logFile = path.join(endTempDir, "done.log");
        const writeStream = nodeFs.createWriteStream(logFile);
        writeStream.write("durable\n");
        await endWriteStream(writeStream);
        const text = await fs.readFile(logFile, "utf8");
        expect(text).toBe("durable\n");
    });

    test("rejects when end()'s callback receives an error", async () => {
        const fakeError = new Error("end failed");
        const writtenChunks: string[] = [];
        const fakeStream: any = {
            write: (chunk: string) => {
                writtenChunks.push(chunk);
                return true;
            },
            end: (callback: (err: Error | null | undefined) => void) => {
                setImmediate(() => callback(fakeError));
            },
        };
        await expect(endWriteStream(fakeStream)).rejects.toBe(fakeError);
    });
});

describe("defaultSpawner", () => {
    test("spawns a real process and resolves exited with exit code 0", async () => {
        const proc = defaultSpawner(["sh", "-c", "exit 0"], { cwd: process.cwd() });
        const code = await proc.exited;
        expect(code).toBe(0);
    });

    test("resolves exited with the actual non-zero exit code", async () => {
        const proc = defaultSpawner(["sh", "-c", "exit 7"], { cwd: process.cwd() });
        const code = await proc.exited;
        expect(code).toBe(7);
    });

    test("rejects exited on ENOENT for a missing binary", async () => {
        const proc = defaultSpawner(["this-binary-does-not-exist-anywhere-xyz"], { cwd: process.cwd() });
        await expect(proc.exited).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("returns piped stdout and stderr streams readable by the caller", async () => {
        const proc = defaultSpawner(["sh", "-c", "printf 'hi\\n'; printf 'err\\n' >&2"], { cwd: process.cwd() });
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        proc.stdout!.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
        proc.stderr!.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
        const code = await proc.exited;
        expect(code).toBe(0);
        expect(stdoutChunks.join("")).toBe("hi\n");
        expect(stderrChunks.join("")).toBe("err\n");
    });
});

describe("runCommands audit-log emissions", () => {
    let auditTempDir: string;
    let auditLogBaseDir: string;
    let stdoutSpy: jest.SpyInstance;

    beforeEach(async () => {
        auditTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-runner-audit-test-"));
        auditLogBaseDir = path.join(auditTempDir, "log");
        stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((): boolean => true);
    });

    afterEach(async () => {
        stdoutSpy.mockRestore();
        await fs.rm(auditTempDir, { recursive: true, force: true });
    });

    test("emits gate_decision, command_started, and command_result for each spawned command, all carrying the prepared command's sourceLine", async () => {
        const fileOne = await writeChangedFile(auditTempDir, "src/a.ts", "alpha");
        const compiledOne = makeCompiled([fileOne], "echo one", path.join(auditTempDir, "work"), 0, 30);
        const fileTwo = await writeChangedFile(auditTempDir, "src/b.ts", "bravo");
        const compiledTwo = makeCompiled([fileTwo], "echo two", path.join(auditTempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const auditLogger = new RecordingAuditLogger();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logger: auditLogger,
            logBaseDir: auditLogBaseDir,
        };

        const resultsPromise = runCommands([compiledOne, compiledTwo], state, fixedNow, opts);
        const stubOne = await recorder.nextSpawn();
        const stubTwo = await recorder.nextSpawn();
        stubOne.pushStdout(null);
        stubOne.pushStderr(null);
        stubTwo.pushStdout(null);
        stubTwo.pushStderr(null);
        stubOne.finishWithCode(0);
        stubTwo.finishWithCode(0);
        await resultsPromise;

        const gateEntries = auditLogger.entries.filter(entry => entry.type === "gate_decision");
        const startEntries = auditLogger.entries.filter(entry => entry.type === "command_started");
        const resultEntries = auditLogger.entries.filter(entry => entry.type === "command_result");
        expect(gateEntries).toHaveLength(2);
        expect(startEntries).toHaveLength(2);
        expect(resultEntries).toHaveLength(2);
        for (const entry of gateEntries) {
            expect((entry as { sourceLine: number }).sourceLine).toBe(7);
        }
        for (const entry of startEntries) {
            expect((entry as { sourceLine: number }).sourceLine).toBe(7);
        }
        for (const entry of resultEntries) {
            expect((entry as { sourceLine: number }).sourceLine).toBe(7);
            expect((entry as { outcome: string }).outcome).toBe("pass");
        }
    });

    test("a timed-out command emits command_result with outcome 'timeout' and exitCode -1", async () => {
        const fileOne = await writeChangedFile(auditTempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "sleep forever", path.join(auditTempDir, "work"), 0, 0.05);
        const recorder = makeRecordingSpawner();
        const auditLogger = new RecordingAuditLogger();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logger: auditLogger,
            logBaseDir: auditLogBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        stub.pushStdout(null);
        stub.pushStderr(null);
        await resultsPromise;

        const resultEntries = auditLogger.entries.filter(entry => entry.type === "command_result");
        expect(resultEntries).toHaveLength(1);
        const resultEntry = resultEntries[0] as { outcome: string; exitCode: number };
        expect(resultEntry.outcome).toBe("timeout");
        expect(resultEntry.exitCode).toBe(-1);
    });

    test("omitting the logger option uses NullAuditLogger so the recording stub sees no calls", async () => {
        const fileOne = await writeChangedFile(auditTempDir, "src/a.ts", "alpha");
        const compiled = makeCompiled([fileOne], "echo no-logger", path.join(auditTempDir, "work"), 0, 30);
        const recorder = makeRecordingSpawner();
        const auditLogger = new RecordingAuditLogger();
        const state: State = { fileHashes: {}, commandRuns: [] };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");
        const opts: RunCommandsOptions = {
            spawn: recorder.spawner,
            now: () => fixedNow,
            logBaseDir: auditLogBaseDir,
        };

        const resultsPromise = runCommands([compiled], state, fixedNow, opts);
        const stub = await recorder.nextSpawn();
        stub.pushStdout(null);
        stub.pushStderr(null);
        stub.finishWithCode(0);
        await resultsPromise;

        expect(auditLogger.entries).toHaveLength(0);
    });
});

describe("NullAuditLogger", () => {
    test("log resolves to undefined and does not throw", async () => {
        const logger: IAuditLogger = new NullAuditLogger();
        const result = await logger.log({
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp",
            projectDir: "/tmp",
            stopHookActive: false,
        });
        expect(result).toBeUndefined();
    });
});

describe("runOneCommand", () => {
    let oneTempDir: string;
    let oneLogBaseDir: string;
    let stdoutSpy: jest.SpyInstance;

    beforeEach(async () => {
        oneTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-one-test-"));
        oneLogBaseDir = path.join(oneTempDir, "log");
        stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((): boolean => true);
    });

    afterEach(async () => {
        stdoutSpy.mockRestore();
        await fs.rm(oneTempDir, { recursive: true, force: true });
    });

    test("invoked directly: produces a RunResult and updates state on success", async () => {
        const absPath = path.join(oneTempDir, "src/a.ts");
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, "alpha", "utf8");
        const matchedFile: ChangedFile = { path: "src/a.ts", absPath };
        const command: CommandConfig = { run: "echo direct", cooldown: 0, timeout: 30, cwd: path.join(oneTempDir, "work") };
        const compiled: CompiledCommand = {
            sourceFile: "test.yaml",
            sourceLine: 11,
            triggerIndexInFile: 0,
            commandIndex: 0,
            command,
            expandedRun: "echo direct",
            expandedCwd: path.join(oneTempDir, "work"),
            commandKey: computeCommandKey("echo direct", path.join(oneTempDir, "work")),
            matchedFiles: [matchedFile],
        };
        const fixedNow = new Date("2026-05-09T14:30:15.123Z");

        const stubStdout = new Readable({ read() {
        } });
        const stubStderr = new Readable({ read() {
        } });
        stubStdout.push(null);
        stubStderr.push(null);
        const stubProc: SpawnedProc = {
            exitCode: null,
            exited: Promise.resolve(0),
            kill: () => true,
            pid: 7777,
            stdout: stubStdout,
            stderr: stubStderr,
        };
        const stubSpawner: Spawner = () => stubProc;
        const state: State = { fileHashes: {}, commandRuns: [] };

        const result = await runOneCommand(
            compiled,
            state,
            fixedNow,
            stubSpawner,
            () => fixedNow,
            new NullAuditLogger(),
            oneLogBaseDir,
            oneTempDir,
        );

        expect(result.exitCode).toBe(0);
        expect(result.logFile.startsWith(oneLogBaseDir)).toBe(true);
        expect(state.commandRuns).toHaveLength(1);
        expect(state.commandRuns[0].lastRunAt).toBe(fixedNow.toISOString());
    });
});
