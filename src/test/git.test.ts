jest.mock("node:child_process");

import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { collectChangedFiles, parsePorcelainV1Z, runGitCommand } from "../git";

// Specification for one mocked `child_process.spawn` invocation. Each call to the mocked spawn looks up the
// matching spec by inspecting the `git` argv (e.g., whether it contains `"rev-parse"` or `"status"`) and
// returns a fake `ChildProcess` that asynchronously emits the configured stdout/stderr and a `close` event.
// When `spawnError` is set the fake emits an `error` event instead and never emits `close`, mirroring how
// Node's spawn surfaces an `ENOENT` for a missing binary.
interface MockSpawnSpec {
    // UTF-8 stdout text emitted on the fake stdout stream before `close`. Empty string by default.
    stdoutText: string;
    // UTF-8 stderr text emitted on the fake stderr stream before `close`. Empty string by default.
    stderrText: string;
    // Exit code surfaced on the `close` event when no `spawnError` is configured. Defaults to `0`.
    exitCode: number;
    // When set, the fake emits this error on the `error` event and never emits `close`. Used to simulate the
    // missing-binary path where Node's spawn surfaces `ENOENT`.
    spawnError: NodeJS.ErrnoException | null;
}

// Returns a `MockSpawnSpec` populated with the no-op defaults (empty stdout/stderr, exit 0, no spawn error).
// Tests override only the fields they care about.
function defaultMockSpec(): MockSpawnSpec {
    return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: null };
}

// Function shape consumed by `setSpawnSelector`. Receives the argv passed to `git` and returns the spec the
// fake child should follow. The selector must be deterministic; tests inspect `argv` to decide whether the
// current call is the `rev-parse` probe or the `status` probe.
type SpawnSelector = (gitArgs: string[]) => MockSpawnSpec;

// Holds the per-spec shape returned from `makeFakeChildProcess`. The fake exposes the stdout/stderr emitters
// as plain `EventEmitter`s so the test asserts on them indirectly via `collectChangedFiles`'s captured output.
interface FakeChildProcess {
    // Top-level child emitter that fires `error` and `close` events.
    child: EventEmitter;
    // Fake stdout stream the production code listens to via `child.stdout!.on("data", ...)`.
    stdout: EventEmitter;
    // Fake stderr stream the production code listens to via `child.stderr!.on("data", ...)`.
    stderr: EventEmitter;
}

// Builds a fake `ChildProcess`-shaped object whose stdio streams are bare `EventEmitter`s. After construction
// the helper schedules a `process.nextTick` that drives the lifecycle: emit stdout/stderr (when present) then
// `close`, OR emit a single `error` event when `spec.spawnError` is configured.
function makeFakeChildProcess(spec: MockSpawnSpec): FakeChildProcess {
    const fake: FakeChildProcess = {
        child: new EventEmitter(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    };
    process.nextTick(() => {
        if (spec.spawnError !== null) {
            fake.child.emit("error", spec.spawnError);
            return;
        }
        if (spec.stdoutText.length > 0) {
            fake.stdout.emit("data", Buffer.from(spec.stdoutText, "utf8"));
        }
        if (spec.stderrText.length > 0) {
            fake.stderr.emit("data", Buffer.from(spec.stderrText, "utf8"));
        }
        fake.child.emit("close", spec.exitCode);
    });
    return fake;
}

// Convenience handle for the manually-mocked `spawn` symbol. `jest.mock("node:child_process")` at the top of
// the file routes the import through `__mocks__/child_process.ts`, so `spawn` is the `jest.fn()` defined
// there and tests can install per-test behaviour via `mockImplementation`.
const mockSpawn = childProcess.spawn as unknown as jest.Mock;

// Configures the mocked `spawn` so each subsequent call routes through `selector`. Centralised so tests do
// not duplicate the boilerplate of building a fake `ChildProcess` for every call.
function setSpawnSelector(selector: SpawnSelector): void {
    mockSpawn.mockImplementation((command: any, args?: any) => {
        const argv = (args as string[]) ?? [];
        const spec = selector(argv);
        const fake = makeFakeChildProcess(spec);
        const fakeChild: any = fake.child;
        fakeChild.stdout = fake.stdout;
        fakeChild.stderr = fake.stderr;
        return fakeChild;
    });
}

// Returns a selector that distinguishes the two real-world git invocations made by `collectChangedFiles`:
// the `rev-parse --show-toplevel` probe (used to recover the repo root for absolute-path resolution) and the
// `status --porcelain=v1 -z` call (used to enumerate changed files). The two stdout strings are passed in
// directly so each test can supply its own canned porcelain output.
function selectByCommand(repoRoot: string, statusStdout: string): SpawnSelector {
    return (gitArgs: string[]): MockSpawnSpec => {
        if (gitArgs.includes("rev-parse")) {
            return { stdoutText: repoRoot + "\n", stderrText: "", exitCode: 0, spawnError: null };
        }
        if (gitArgs.includes("status")) {
            return { stdoutText: statusStdout, stderrText: "", exitCode: 0, spawnError: null };
        }
        return defaultMockSpec();
    };
}

beforeEach(() => {
    mockSpawn.mockReset();
});

describe("parsePorcelainV1Z", () => {
    test("returns an empty array for an empty input", () => {
        expect(parsePorcelainV1Z("")).toEqual([]);
    });

    test("returns the single path for a staged addition", () => {
        expect(parsePorcelainV1Z("A  staged-new.ts\0")).toEqual(["staged-new.ts"]);
    });

    test("returns the single path for an unstaged modification", () => {
        expect(parsePorcelainV1Z(" M tracked.ts\0")).toEqual(["tracked.ts"]);
    });

    test("returns the single path for an untracked file", () => {
        expect(parsePorcelainV1Z("?? untracked.ts\0")).toEqual(["untracked.ts"]);
    });

    test("excludes a worktree-deleted file", () => {
        expect(parsePorcelainV1Z(" D removed.ts\0")).toEqual([]);
    });

    test("excludes a staged-modify-then-worktree-deleted file (worktree column wins)", () => {
        expect(parsePorcelainV1Z("MD half-deleted.ts\0")).toEqual([]);
    });

    test("returns the destination path for a rename and skips the source path", () => {
        expect(parsePorcelainV1Z("R  new.ts\0old.ts\0")).toEqual(["new.ts"]);
    });

    test("returns the destination path for a copy and skips the source path", () => {
        expect(parsePorcelainV1Z("C  copy.ts\0orig.ts\0")).toEqual(["copy.ts"]);
    });

    test("handles multiple mixed records and preserves order", () => {
        const input: string = "A  staged-new.ts\0 M tracked.ts\0?? untracked.ts\0 D removed.ts\0R  new.ts\0old.ts\0";
        expect(parsePorcelainV1Z(input)).toEqual([
            "staged-new.ts",
            "tracked.ts",
            "untracked.ts",
            "new.ts",
        ]);
    });

    test("ignores stray short records produced by a trailing NUL", () => {
        expect(parsePorcelainV1Z("A  foo.ts\0")).toEqual(["foo.ts"]);
    });
});

describe("collectChangedFiles", () => {
    test("rejects with 'git binary missing on PATH' when spawn fails with ENOENT", async () => {
        const enoent: NodeJS.ErrnoException = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        setSpawnSelector(() => {
            return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: enoent };
        });

        await expect(collectChangedFiles("/repo")).rejects.toThrow("git binary missing on PATH");
    });

    test("rejects with 'git binary missing on PATH' when only the rev-parse probe fails with ENOENT", async () => {
        const enoent: NodeJS.ErrnoException = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        setSpawnSelector((gitArgs: string[]) => {
            if (gitArgs.includes("rev-parse")) {
                return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: enoent };
            }
            return defaultMockSpec();
        });

        await expect(collectChangedFiles("/repo")).rejects.toThrow("git binary missing on PATH");
    });

    test("propagates non-ENOENT spawn errors verbatim", async () => {
        const eaccess: NodeJS.ErrnoException = new Error("spawn git EACCES") as NodeJS.ErrnoException;
        eaccess.code = "EACCES";
        setSpawnSelector(() => {
            return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: eaccess };
        });

        await expect(collectChangedFiles("/repo")).rejects.toThrow(/EACCES/);
    });

    test("rejects when git exits non-zero (e.g. not a repo)", async () => {
        setSpawnSelector(() => {
            return {
                stdoutText: "",
                stderrText: "fatal: not a git repository\n",
                exitCode: 128,
                spawnError: null,
            };
        });

        await expect(collectChangedFiles("/repo")).rejects.toThrow(/not a git repository/);
    });

    test("returns staged adds, unstaged modifies, and untracked files; excludes worktree deletions", async () => {
        const repoRoot = "/repo";
        const statusStdout = "A  staged-new.ts\0 M tracked.ts\0?? untracked.ts\0 D removed.ts\0";
        setSpawnSelector(selectByCommand(repoRoot, statusStdout));

        const result = await collectChangedFiles(repoRoot);
        const reportedPaths = result.map(file => file.path).sort();
        expect(reportedPaths).toEqual(["staged-new.ts", "tracked.ts", "untracked.ts"]);
        for (const file of result) {
            expect(file.absPath).toBe(path.join(repoRoot, file.path));
        }
    });

    test("returns the rename destination, not the source", async () => {
        const repoRoot = "/repo";
        const statusStdout = "R  new.ts\0old.ts\0";
        setSpawnSelector(selectByCommand(repoRoot, statusStdout));

        const result = await collectChangedFiles(repoRoot);
        expect(result.map(file => file.path)).toEqual(["new.ts"]);
        expect(result[0].absPath).toBe(path.join(repoRoot, "new.ts"));
    });

    test("filters out files outside scopeDir even when git reports them", async () => {
        const repoRoot = "/repo";
        const scopeDir = path.join(repoRoot, "sub");
        const statusStdout = " M outside.ts\0 M sub/inside.ts\0";
        setSpawnSelector(selectByCommand(repoRoot, statusStdout));

        const result = await collectChangedFiles(scopeDir);
        expect(result.map(file => file.path)).toEqual(["inside.ts"]);
        expect(result[0].absPath).toBe(path.join(scopeDir, "inside.ts"));
    });

    test("deduplicates entries that resolve to the same absolute path", async () => {
        const repoRoot = "/repo";
        const statusStdout = " M dup.ts\0 M dup.ts\0";
        setSpawnSelector(selectByCommand(repoRoot, statusStdout));

        const result = await collectChangedFiles(repoRoot);
        expect(result.map(file => file.path)).toEqual(["dup.ts"]);
    });

    test("returns relative paths in POSIX form rooted at scopeDir", async () => {
        const repoRoot = "/repo";
        const statusStdout = " M nested/dir/file.ts\0";
        setSpawnSelector(selectByCommand(repoRoot, statusStdout));

        const result = await collectChangedFiles(repoRoot);
        expect(result[0].path).toBe("nested/dir/file.ts");
        expect(result[0].absPath).toBe(path.join(repoRoot, "nested", "dir", "file.ts"));
    });
});

describe("runGitCommand", () => {
    test("resolves to the captured stdout text when git exits 0", async () => {
        setSpawnSelector(() => {
            return { stdoutText: "hello world\n", stderrText: "", exitCode: 0, spawnError: null };
        });

        const result = await runGitCommand("/repo", ["status"]);
        expect(result).toBe("hello world\n");
    });

    test("invokes spawn with 'git', '-C scopeDir', and the supplied args", async () => {
        setSpawnSelector(() => {
            return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: null };
        });

        await runGitCommand("/repo", ["status", "--porcelain"]);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const callArgs = mockSpawn.mock.calls[0];
        expect(callArgs[0]).toBe("git");
        expect(callArgs[1]).toEqual(["-C", "/repo", "status", "--porcelain"]);
    });

    test("rejects with 'git binary missing on PATH' (and ENOENT code) when spawn errors with ENOENT", async () => {
        const enoent: NodeJS.ErrnoException = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        setSpawnSelector(() => {
            return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: enoent };
        });

        await expect(runGitCommand("/repo", ["status"])).rejects.toMatchObject({
            message: "git binary missing on PATH",
            code: "ENOENT",
        });
    });

    test("propagates non-ENOENT spawn errors unchanged", async () => {
        const eaccess: NodeJS.ErrnoException = new Error("spawn git EACCES") as NodeJS.ErrnoException;
        eaccess.code = "EACCES";
        setSpawnSelector(() => {
            return { stdoutText: "", stderrText: "", exitCode: 0, spawnError: eaccess };
        });

        await expect(runGitCommand("/repo", ["status"])).rejects.toMatchObject({
            message: "spawn git EACCES",
            code: "EACCES",
        });
    });

    test("rejects with stderr-bearing message when git exits non-zero", async () => {
        setSpawnSelector(() => {
            return {
                stdoutText: "",
                stderrText: "fatal: bad command\n",
                exitCode: 1,
                spawnError: null,
            };
        });

        await expect(runGitCommand("/repo", ["weirdcmd"])).rejects.toThrow(
            /weirdcmd exited with code 1.*fatal: bad command/s,
        );
    });

    test("decodes multi-chunk stdout as a single UTF-8 string", async () => {
        const expectedText = "first chunk + second chunk";
        mockSpawn.mockImplementation(() => {
            const fakeChild: any = new EventEmitter();
            const fakeStdout = new EventEmitter();
            const fakeStderr = new EventEmitter();
            fakeChild.stdout = fakeStdout;
            fakeChild.stderr = fakeStderr;
            process.nextTick(() => {
                fakeStdout.emit("data", Buffer.from("first chunk + ", "utf8"));
                fakeStdout.emit("data", Buffer.from("second chunk", "utf8"));
                fakeChild.emit("close", 0);
            });
            return fakeChild;
        });

        const result = await runGitCommand("/repo", ["status"]);
        expect(result).toBe(expectedText);
    });
});
