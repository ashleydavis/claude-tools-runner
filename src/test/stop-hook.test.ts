import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { main, readStdin, runStopHook } from "../stop-hook";

// Sentinel error thrown by the stubbed `process.exit` so a single test invocation can stop the Stop hook
// without terminating the Jest worker. The error carries the requested exit code so the test can assert it.
class ProcessExitError extends Error {
    // The numeric exit code passed to `process.exit`. `undefined` only when `process.exit()` is called with
    // no argument, which the Stop hook never does in routine paths.
    public readonly code: number | undefined;
    constructor(code: number | undefined) {
        super(`process.exit(${code})`);
        this.code = code;
    }
}

// Captures of writes to `process.stdout` and `process.stderr` plus the `exit` code (if any) for one test.
// Tests assert against these by combining captured chunks into a single string and grepping.
interface CapturedIO {
    // Buffered stdout chunks pushed by `process.stdout.write` during the test.
    stdoutChunks: string[];
    // Buffered stderr chunks pushed by `process.stderr.write` during the test.
    stderrChunks: string[];
    // The exit code observed by the stub `process.exit`. `null` when the hook returned without calling exit.
    exitCode: number | null;
}

// Installs the per-test IO stubs on `process` and returns a `CapturedIO` plus a restore function. The
// restore is run from `afterEach`. Tests must `await` the restore to ensure all spies are torn down before
// the next test installs its own.
interface InstalledIO {
    // Captured IO. Mutated as the Stop hook writes to stdout/stderr and calls `process.exit`.
    captured: CapturedIO;
    // Tear-down function. Restores the original `stdout.write`, `stderr.write`, and `exit` implementations.
    restore: () => void;
}

// Replaces `process.stdout.write`, `process.stderr.write`, and `process.exit` with stubs that record into a
// `CapturedIO`. The exit stub throws `ProcessExitError` so the Stop hook's control flow stops at the first
// `process.exit` call: tests `try/catch` around `runStopHook` to swallow the sentinel and inspect the
// captures afterwards.
function installIOStubs(): InstalledIO {
    const captured: CapturedIO = { stdoutChunks: [], stderrChunks: [], exitCode: null };
    const stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        captured.stdoutChunks.push(text);
        return true;
    }) as typeof process.stdout.write);
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        captured.stderrChunks.push(text);
        return true;
    }) as typeof process.stderr.write);
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(((code?: number): never => {
        captured.exitCode = code ?? 0;
        throw new ProcessExitError(code);
    }) as typeof process.exit);
    const restore = (): void => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
    };
    return { captured, restore };
}

// Replaces `process.stdin` for the duration of one test with a Readable stream emitting `inputText`. Returns
// a restore function that puts the original stdin back. The replacement uses `Object.defineProperty` because
// `process.stdin` is a getter and assignment alone does not stick.
function installStdin(inputText: string): () => void {
    const sourceStream = Readable.from([Buffer.from(inputText, "utf8")]);
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => sourceStream,
    });
    return () => {
        if (originalDescriptor !== undefined) {
            Object.defineProperty(process, "stdin", originalDescriptor);
        }
    };
}

// Captures the current values of `CLAUDE_PROJECT_DIR` and `HOME` env vars so a per-test `restoreEnv` can put
// them back exactly as they were (including the case where one was unset before the test).
interface SavedEnv {
    // Original `CLAUDE_PROJECT_DIR` value, or `undefined` if the variable was unset before the test.
    claudeProjectDir: string | undefined;
    // Original `HOME` value, or `undefined` if the variable was unset before the test.
    home: string | undefined;
    // Original cwd of the process at the time of the save.
    cwd: string;
}

// Snapshots env vars relevant to the Stop hook so tests can mutate them freely and restore exact state in
// `afterEach`. Also snapshots the cwd so tests that `process.chdir` to a temp dir do not leak that change.
function saveEnv(): SavedEnv {
    return {
        claudeProjectDir: process.env["CLAUDE_PROJECT_DIR"],
        home: process.env["HOME"],
        cwd: process.cwd(),
    };
}

// Restores env vars and cwd from a `SavedEnv` snapshot. Sets each variable back to its original value, or
// deletes it when it was originally unset. Always invokes `process.chdir` last so a chdir-to-removed-tempdir
// failure does not block env restoration.
function restoreEnv(saved: SavedEnv): void {
    if (saved.claudeProjectDir === undefined) {
        delete process.env["CLAUDE_PROJECT_DIR"];
    }
    else {
        process.env["CLAUDE_PROJECT_DIR"] = saved.claudeProjectDir;
    }
    if (saved.home === undefined) {
        delete process.env["HOME"];
    }
    else {
        process.env["HOME"] = saved.home;
    }
    process.chdir(saved.cwd);
}

// Spawns `git <args>` in `cwd` and waits for `close`. Resolves on exit code 0, rejects otherwise. Used to
// build real git fixtures (init, add, commit) so tests exercise the production `collectChangedFiles` path
// against an actual repository instead of mocking git output.
function runGit(cwd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn("git", args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        });
        const stderrChunks: Buffer[] = [];
        child.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });
        child.on("error", reject);
        child.on("close", (exitCode) => {
            if (exitCode === 0) {
                resolve();
                return;
            }
            const stderrText = Buffer.concat(stderrChunks).toString("utf8");
            reject(new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderrText}`));
        });
    });
}

// Initialises a fresh git repository at `dir` with deterministic identity and an initial commit so the
// porcelain output reflects only the changes the test makes after this call. Identity overrides come via
// env so the test does not depend on the user's `~/.gitconfig`.
async function initGitRepo(dir: string): Promise<void> {
    await runGit(dir, ["init", "-q", "-b", "main"]);
    await runGit(dir, ["config", "user.email", "test@example.invalid"]);
    await runGit(dir, ["config", "user.name", "Test"]);
    await runGit(dir, ["commit", "--allow-empty", "-m", "init"]);
}

// Returns the concatenation of every captured stdout chunk, useful for substring assertions. Combines the
// chunks once instead of forcing each test to spell out the join.
function joinedStdout(captured: CapturedIO): string {
    return captured.stdoutChunks.join("");
}

// Returns the concatenation of every captured stderr chunk, useful for substring assertions.
function joinedStderr(captured: CapturedIO): string {
    return captured.stderrChunks.join("");
}

// Runs `runStopHook` and swallows the `ProcessExitError` thrown by the stubbed `process.exit`. Any other
// rejection propagates so the test fails with the original error. Returns nothing: the test inspects the
// `CapturedIO` populated by the stubs.
async function runHookAllowingExit(): Promise<void> {
    try {
        await runStopHook();
    }
    catch (caughtErr) {
        if (caughtErr instanceof ProcessExitError) {
            return;
        }
        throw caughtErr;
    }
}

describe("stop-hook module guard", () => {
    test("importing the module under NODE_ENV=test does not auto-run", () => {
        // The mere fact that `import { runStopHook } from "../stop-hook"` at the top of this file did not
        // print to the live stdout/stderr or invoke `process.exit` proves the guard. We additionally
        // assert NODE_ENV is "test" so the guard's branch is the actually-evaluated one.
        expect(process.env["NODE_ENV"]).toBe("test");
        expect(typeof runStopHook).toBe("function");
        expect(typeof main).toBe("function");
        expect(typeof readStdin).toBe("function");
    });
});

describe("readStdin", () => {
    let restoreStdin: () => void;

    afterEach(() => {
        restoreStdin();
    });

    test("returns the empty string when stdin is empty", async () => {
        restoreStdin = installStdin("");
        const result = await readStdin();
        expect(result).toBe("");
    });

    test("returns the concatenated UTF-8 bytes of stdin when within the cap", async () => {
        const payload = JSON.stringify({ stop_hook_active: true, cwd: "/tmp" });
        restoreStdin = installStdin(payload);
        const result = await readStdin();
        expect(result).toBe(payload);
    });

    test("rejects with the canonical cap-exceeded message when stdin exceeds 1 MiB", async () => {
        const oversized = "x".repeat(1024 * 1024 + 1);
        restoreStdin = installStdin(oversized);
        await expect(readStdin()).rejects.toThrow("stdin payload exceeded 1 MiB cap");
    });
});

describe("main", () => {
    let installedIO: InstalledIO;
    let savedEnv: SavedEnv;
    let restoreStdin: () => void;
    let tempDir: string;

    beforeEach(async () => {
        savedEnv = saveEnv();
        installedIO = installIOStubs();
        restoreStdin = installStdin("");
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-stop-hook-main-test-"));
        process.chdir(tempDir);
    });

    afterEach(async () => {
        restoreStdin();
        installedIO.restore();
        restoreEnv(savedEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("returns without calling exit when runStopHook completes its happy path", async () => {
        // No YAML files anywhere → registry is empty → runStopHook hits the "no triggers configured"
        // skip path and returns without calling `process.exit`. `main` should observe a clean return.
        process.env["CLAUDE_PROJECT_DIR"] = tempDir;
        process.env["HOME"] = tempDir;
        restoreStdin();
        restoreStdin = installStdin("{}");

        await main();

        expect(installedIO.captured.exitCode).toBe(null);
        expect(joinedStdout(installedIO.captured)).toContain("[tools-runner] no triggers configured, skipping");
        expect(joinedStderr(installedIO.captured)).toBe("");
    });

    test("routes runStopHook's process.exit(1) through its catch and surfaces the same exit code", async () => {
        // CLAUDE_PROJECT_DIR unset → runStopHook calls `process.exit(1)`, which the stubbed exit re-throws
        // as `ProcessExitError`. `main`'s top-level catch then writes `String(err)` to stderr and itself
        // calls `process.exit(1)`. Either way the captured exit code lands on 1.
        delete process.env["CLAUDE_PROJECT_DIR"];
        restoreStdin();
        restoreStdin = installStdin("{}");

        try {
            await main();
        }
        catch (caughtErr) {
            if (!(caughtErr instanceof ProcessExitError)) {
                throw caughtErr;
            }
        }

        expect(installedIO.captured.exitCode).toBe(1);
        expect(joinedStderr(installedIO.captured)).toContain("[tools-runner] CLAUDE_PROJECT_DIR is not set");
    });

    test("writes String(err) to stderr and exits 1 on an unhandled exception escaping runStopHook", async () => {
        // Replace `process.stdin` with a stream whose `for await` throws a synthetic Error. `readStdin`
        // does not catch this (only the cap branch is special-cased), so the error propagates out of
        // `runStopHook`, hits `main`'s top-level catch, and gets written as `String(err) + "\n"`.
        process.env["CLAUDE_PROJECT_DIR"] = tempDir;
        process.env["HOME"] = tempDir;
        const errorStream = new Readable({
            read(): void {
                this.destroy(new Error("synthetic stdin failure"));
            },
        });
        restoreStdin();
        const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
        Object.defineProperty(process, "stdin", {
            configurable: true,
            get: () => errorStream,
        });
        restoreStdin = (): void => {
            if (originalDescriptor !== undefined) {
                Object.defineProperty(process, "stdin", originalDescriptor);
            }
        };

        try {
            await main();
        }
        catch (caughtErr) {
            if (!(caughtErr instanceof ProcessExitError)) {
                throw caughtErr;
            }
        }

        expect(installedIO.captured.exitCode).toBe(1);
        expect(joinedStderr(installedIO.captured)).toContain("synthetic stdin failure");
    });
});

describe("runStopHook", () => {
    let installedIO: InstalledIO;
    let savedEnv: SavedEnv;
    let restoreStdin: () => void;
    let tempDir: string;
    let homeDir: string;
    let projectDir: string;

    beforeEach(async () => {
        savedEnv = saveEnv();
        installedIO = installIOStubs();
        restoreStdin = installStdin("");
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-stop-hook-test-"));
        homeDir = path.join(tempDir, "home");
        projectDir = path.join(tempDir, "project");
        await fs.mkdir(homeDir, { recursive: true });
        await fs.mkdir(projectDir, { recursive: true });
        process.chdir(tempDir);
    });

    afterEach(async () => {
        restoreStdin();
        installedIO.restore();
        restoreEnv(savedEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("CLAUDE_PROJECT_DIR unset writes the canonical stderr line and exits 1", async () => {
        delete process.env["CLAUDE_PROJECT_DIR"];
        process.env["HOME"] = homeDir;
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(1);
        expect(joinedStderr(installedIO.captured)).toContain("[tools-runner] CLAUDE_PROJECT_DIR is not set");
    });

    test("stop_hook_active=true short-circuits before scanning configs or env checks", async () => {
        // Deliberately leave CLAUDE_PROJECT_DIR unset: if the recursion guard did NOT short-circuit before
        // the env check, the hook would emit the "CLAUDE_PROJECT_DIR is not set" stderr line and exit 1.
        delete process.env["CLAUDE_PROJECT_DIR"];
        delete process.env["HOME"];
        restoreStdin();
        restoreStdin = installStdin(JSON.stringify({ stop_hook_active: true }));

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        expect(joinedStdout(installedIO.captured)).toBe("[tools-runner] stop_hook_active set, skipping to avoid recursion\n");
        expect(joinedStderr(installedIO.captured)).toBe("");
    });

    test("no triggers configured (no YAML files anywhere) prints the canonical skip line and exits 0", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        expect(joinedStdout(installedIO.captured)).toContain("[tools-runner] no triggers configured, skipping");
    });

    test("triggers configured but no changed files prints the canonical skip line and exits 0", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        await initGitRepo(projectDir);
        await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
        await fs.writeFile(path.join(projectDir, ".claude", "tools-runner.yaml"), "triggers:\n  - paths:\n      - 'src/**/*.ts'\n    commands:\n      - run: 'true'\n");
        // Commit the YAML so it does not show up as untracked in `git status` and the test exercises the
        // genuine "no changed files" path rather than "no triggers matched".
        await runGit(projectDir, ["add", "-A"]);
        await runGit(projectDir, ["commit", "-q", "-m", "config"]);
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        expect(joinedStdout(installedIO.captured)).toContain("[tools-runner] no changed files, skipping");
    });

    test("malformed YAML in any layer aborts with a parse-error stderr line and exits 1", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        await initGitRepo(projectDir);
        await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
        await fs.writeFile(path.join(homeDir, ".claude", "tools-runner.yaml"), "triggers: [\nbroken yaml here");
        await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
        await fs.writeFile(path.join(projectDir, ".claude", "tools-runner.yaml"), "triggers:\n  - paths:\n      - 'src/**/*.ts'\n    commands:\n      - run: 'true'\n");
        await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
        await fs.writeFile(path.join(projectDir, "src", "a.ts"), "alpha");
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(1);
        const stderrText = joinedStderr(installedIO.captured);
        expect(stderrText).toContain("failed to parse YAML");
        // Project-layer trigger must NOT have run: the runner only emits PASS/FAIL/SKIP lines, none of
        // which should appear because the hook aborted before `runCommands`.
        const stdoutText = joinedStdout(installedIO.captured);
        expect(stdoutText).not.toContain("PASS");
        expect(stdoutText).not.toContain("FAIL");
        expect(stdoutText).not.toContain("SKIP");
    });

    test("nested config governs ${{project}} expansion to its own scopeDir", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        await initGitRepo(projectDir);
        const subDir = path.join(projectDir, "sub");
        await fs.mkdir(path.join(subDir, ".claude"), { recursive: true });
        const expectedProjectFile = path.join(subDir, "project-marker.txt");
        const yamlBody =
            "triggers:\n" +
            "  - paths:\n" +
            "      - '**/*.ts'\n" +
            "    commands:\n" +
            "      - run: \"printf '%s' '${{project}}' > '${{project}}/project-marker.txt'\"\n" +
            "        cooldown: '0s'\n" +
            "        timeout: '30s'\n";
        await fs.writeFile(path.join(subDir, ".claude", "tools-runner.yaml"), yamlBody);
        await fs.writeFile(path.join(subDir, "trigger.ts"), "alpha");
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        const stdoutText = joinedStdout(installedIO.captured);
        expect(stdoutText).toContain("summary:");
        expect(stdoutText).toContain("1 pass");
        const markerText = await fs.readFile(expectedProjectFile, "utf8");
        expect(markerText).toBe(subDir);
    });

    test("scope isolation: changes under sub a fire only sub a's commands", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        await initGitRepo(projectDir);
        const aDir = path.join(projectDir, "a");
        const bDir = path.join(projectDir, "b");
        await fs.mkdir(path.join(aDir, ".claude"), { recursive: true });
        await fs.mkdir(path.join(bDir, ".claude"), { recursive: true });
        await fs.writeFile(
            path.join(aDir, ".claude", "tools-runner.yaml"),
            "triggers:\n  - paths:\n      - '**/*.ts'\n    commands:\n      - run: \"printf a > '${{project}}/a-fired.txt'\"\n        cooldown: '0s'\n        timeout: '30s'\n",
        );
        await fs.writeFile(
            path.join(bDir, ".claude", "tools-runner.yaml"),
            "triggers:\n  - paths:\n      - '**/*.ts'\n    commands:\n      - run: \"printf b > '${{project}}/b-fired.txt'\"\n        cooldown: '0s'\n        timeout: '30s'\n",
        );
        // Only `a/` has a changed file, so `b`'s trigger must not fire even though its glob would match.
        await fs.writeFile(path.join(aDir, "x.ts"), "alpha");
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        const aFiredExists = await fileExists(path.join(aDir, "a-fired.txt"));
        const bFiredExists = await fileExists(path.join(bDir, "b-fired.txt"));
        expect(aFiredExists).toBe(true);
        expect(bFiredExists).toBe(false);
    });

    test("home + project layers both contribute prepared commands", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        await initGitRepo(projectDir);
        await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
        await fs.writeFile(
            path.join(homeDir, ".claude", "tools-runner.yaml"),
            "triggers:\n  - paths:\n      - '**/*.ts'\n    commands:\n      - run: \"printf home > '" + projectDir.replace(/'/g, "'\\''") + "/home-fired.txt'\"\n        cooldown: '0s'\n        timeout: '30s'\n",
        );
        await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
        await fs.writeFile(
            path.join(projectDir, ".claude", "tools-runner.yaml"),
            "triggers:\n  - paths:\n      - '**/*.ts'\n    commands:\n      - run: \"printf project > '${{project}}/project-fired.txt'\"\n        cooldown: '0s'\n        timeout: '30s'\n",
        );
        await fs.writeFile(path.join(projectDir, "x.ts"), "alpha");
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        const stdoutText = joinedStdout(installedIO.captured);
        expect(stdoutText).toContain("2 pass");
        const homeFiredExists = await fileExists(path.join(projectDir, "home-fired.txt"));
        const projectFiredExists = await fileExists(path.join(projectDir, "project-fired.txt"));
        expect(homeFiredExists).toBe(true);
        expect(projectFiredExists).toBe(true);
    });

    test("per-command log file lands under projectDir even when cwd is elsewhere", async () => {
        // Regression: an earlier implementation resolved `runner.logBaseDir` from `process.cwd()`. In a
        // session where Claude Code does not chdir into the project (or anything else mutates cwd), that
        // produced log files outside the project tree. The fix routes `projectDir` into `runCommands` via
        // `RunCommandsOptions.logBaseDir`, so this test pins the directory to projectDir and asserts that
        // cwd plays no role in the resulting log path.
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        await initGitRepo(projectDir);
        await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
        await fs.writeFile(
            path.join(projectDir, ".claude", "tools-runner.yaml"),
            "triggers:\n  - paths:\n      - '**/*.ts'\n    commands:\n      - run: 'echo hi'\n        cooldown: '0s'\n        timeout: '30s'\n",
        );
        await fs.writeFile(path.join(projectDir, "x.ts"), "alpha");
        // Stay chdir'd at `tempDir` (the parent of projectDir) so cwd is intentionally distinct.
        expect(process.cwd()).toBe(tempDir);
        restoreStdin();
        restoreStdin = installStdin("{}");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(null);
        const projectLogRoot = path.join(projectDir, ".claude", "tools-runner-log");
        const cwdLogRoot = path.join(tempDir, ".claude", "tools-runner-log");
        const projectLogRootExists = await fileExists(projectLogRoot);
        const cwdLogRootExists = await fileExists(cwdLogRoot);
        expect(projectLogRootExists).toBe(true);
        expect(cwdLogRootExists).toBe(false);
    });

    test("invalid JSON on stdin writes the canonical stderr line and exits 1", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        restoreStdin();
        restoreStdin = installStdin("{not json");

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(1);
        expect(joinedStderr(installedIO.captured)).toContain("[tools-runner] stdin is not valid JSON:");
    });

    test("stdin payload exceeding 1 MiB cap writes the canonical stderr line and exits 1", async () => {
        process.env["CLAUDE_PROJECT_DIR"] = projectDir;
        process.env["HOME"] = homeDir;
        const oversized = "x".repeat(1024 * 1024 + 1);
        restoreStdin();
        restoreStdin = installStdin(oversized);

        await runHookAllowingExit();

        expect(installedIO.captured.exitCode).toBe(1);
        expect(joinedStderr(installedIO.captured)).toContain("[tools-runner] stdin payload exceeded 1 MiB cap");
    });
});

// Returns true when `filePath` exists, false on `ENOENT`. Used by the scope-isolation and home-vs-project
// tests to assert that the right side-effect file was (or was not) created without `try/catch` boilerplate
// at every call site.
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.stat(filePath);
        return true;
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return false;
        }
        throw caughtErr;
    }
}
