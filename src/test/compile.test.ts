import * as crypto from "node:crypto";
import * as path from "node:path";
import { ChangedFile, CommandConfig, CompiledCommand, Trigger } from "../types";
import { TemplateContext } from "../template";
import {
    IMatchedFileWithGroup,
    buildCompiledCommand,
    compileCommands,
    computeCommandKey,
    emitPerDirectory,
    emitPerFile,
    emitPerGroup,
    emitPerTrigger,
    resolveGroupDirsForFiles,
    validateGroupDirUsage,
} from "../compile";

// Builds a `Trigger` for tests. Mirrors the post-parse defaults `parseCommand` applies in `config.ts` so the
// fixtures look indistinguishable from triggers loaded by `loadConfigFile`.
function makeTrigger(paths: string[] | undefined, runCommands: string[], sourceLine: number, cwd?: string, groupBy?: string): Trigger {
    const commands: CommandConfig[] = runCommands.map(runValue => {
        const command: CommandConfig = {
            run: runValue,
            cooldown: 60,
            timeout: 300,
            sourceLine,
        };
        if (cwd !== undefined) {
            command.cwd = cwd;
        }
        return command;
    });
    const trigger: Trigger = {
        commands,
        sourceLine,
    };
    if (paths !== undefined) {
        trigger.paths = paths;
    }
    if (groupBy !== undefined) {
        trigger.group_by = groupBy;
    }
    return trigger;
}

// Builds a `ChangedFile`. The relative path is rooted at `scopeDir`; the absolute path joins them.
function makeChangedFile(scopeDir: string, relativePath: string): ChangedFile {
    return {
        path: relativePath,
        absPath: `${scopeDir}/${relativePath}`,
    };
}

// Computes the expected `commandKey` so tests can assert against it without re-deriving the algorithm in
// each case.
function expectedCommandKey(expandedRun: string, expandedCwd: string): string {
    return crypto.createHash("sha256").update(`${expandedRun}\0${expandedCwd}`).digest("hex");
}

describe("compileCommands", () => {
    test("returns [] when changed is empty", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", []);
        expect(result).toEqual([]);
    });

    test("returns [] when triggers is empty", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands([], "source", ctx, "/abs/scope", changed);
        expect(result).toEqual([]);
    });

    test("skips triggers whose paths field is undefined", () => {
        const triggers: Trigger[] = [makeTrigger(undefined, ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result).toEqual([]);
    });

    test("skips triggers whose paths field is empty", () => {
        const triggers: Trigger[] = [makeTrigger([], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result).toEqual([]);
    });

    test("skips triggers whose paths match no changed files", () => {
        const triggers: Trigger[] = [makeTrigger(["scripts/**/*.sh"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result).toEqual([]);
    });

    test("emits one CompiledCommand per (trigger, command) pair when no fan-out vars are used", () => {
        const triggers: Trigger[] = [
            makeTrigger(["src/**/*.ts"], ["echo a", "echo b"], 5),
            makeTrigger(["**/*"], ["echo c"], 9),
        ];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(3);
        expect(result[0].triggerIndexInFile).toBe(0);
        expect(result[0].commandIndex).toBe(0);
        expect(result[0].expandedRun).toBe("echo a");
        expect(result[1].triggerIndexInFile).toBe(0);
        expect(result[1].commandIndex).toBe(1);
        expect(result[1].expandedRun).toBe("echo b");
        expect(result[2].triggerIndexInFile).toBe(1);
        expect(result[2].commandIndex).toBe(0);
        expect(result[2].expandedRun).toBe("echo c");
    });

    test("stamps sourceFile from the parameter onto every emission", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "my-source.yaml", ctx, "/abs/scope", changed);
        expect(result.length).toBe(1);
        expect(result[0].sourceFile).toBe("my-source.yaml");
    });

    test("copies sourceLine verbatim from the source trigger", () => {
        const triggers: Trigger[] = [
            makeTrigger(["**/*"], ["echo a", "echo b"], 42),
        ];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].sourceLine).toBe(42);
        expect(result[1].sourceLine).toBe(42);
    });

    test("attaches the matched files as matchedFiles on a per-trigger emission", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [
            makeChangedFile("/abs/scope", "src/a.ts"),
            makeChangedFile("/abs/scope", "src/b.ts"),
        ];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(1);
        expect(result[0].matchedFiles).toEqual(changed);
    });

    test("expandedCwd defaults to ctx.projectDir when CommandConfig.cwd is undefined (per-trigger)", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].expandedCwd).toBe("/abs/scope");
    });

    test("expandedCwd preserves the supplied CommandConfig.cwd verbatim when it has no template variables", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1, "/some/explicit/path")];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].expandedCwd).toBe("/some/explicit/path");
    });

    test("commandKey is sha256(expandedRun + 0x00 + expandedCwd)", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1, "/cwd")];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].commandKey).toBe(expectedCommandKey("echo a", "/cwd"));
    });

    test("two triggers with the same expandedRun and expandedCwd share commandKey", () => {
        const triggers: Trigger[] = [
            makeTrigger(["**/*"], ["echo a"], 1, "/same/cwd"),
            makeTrigger(["**/*"], ["echo a"], 2, "/same/cwd"),
        ];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(2);
        expect(result[0].commandKey).toBe(result[1].commandKey);
    });

    test("the same trigger fixture compiled with two different sourceFile arguments yields the same commandKey", () => {
        const triggerFixture: Trigger = makeTrigger(["**/*"], ["echo a"], 1, "/same/cwd");
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const fromHome = compileCommands([triggerFixture], "home.yaml", ctx, "/abs/scope", changed);
        const fromProject = compileCommands([triggerFixture], "project.yaml", ctx, "/abs/scope", changed);
        expect(fromHome.length).toBe(1);
        expect(fromProject.length).toBe(1);
        expect(fromHome[0].commandKey).toBe(fromProject[0].commandKey);
        expect(fromHome[0].sourceFile).toBe("home.yaml");
        expect(fromProject[0].sourceFile).toBe("project.yaml");
    });

    test("two commands with different expandedRun produce different commandKeys", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a", "echo b"], 1, "/cwd")];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].commandKey).not.toBe(result[1].commandKey);
    });

    test("emission's command field references the original CommandConfig object", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result: CompiledCommand[] = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].command).toBe(triggers[0].commands[0]);
    });

    test("triggerIndexInFile is the trigger's 0-based position in the supplied triggers array", () => {
        const triggers: Trigger[] = [
            makeTrigger(["**/*"], ["echo a"], 1),
            makeTrigger(["**/*"], ["echo b"], 5),
            makeTrigger(["**/*"], ["echo c"], 9),
        ];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].triggerIndexInFile).toBe(0);
        expect(result[1].triggerIndexInFile).toBe(1);
        expect(result[2].triggerIndexInFile).toBe(2);
    });

    test("matchFiles filters changed files: only files matching trigger.paths reach matchedFiles", () => {
        const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const matchingFile = makeChangedFile("/abs/scope", "src/foo.ts");
        const nonMatchingFile = makeChangedFile("/abs/scope", "scripts/build.sh");
        const changed: ChangedFile[] = [matchingFile, nonMatchingFile];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(1);
        expect(result[0].matchedFiles).toEqual([matchingFile]);
    });

    test("`${{project}}` in run/cwd expands to ctx.projectDir for per-trigger emission", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["cd ${{project}} && pwd"], 1, "${{project}}/sub")];
        const ctx: TemplateContext = { projectDir: "/abs/myconfig" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/myconfig", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/myconfig", changed);
        expect(result.length).toBe(1);
        expect(result[0].expandedRun).toBe("cd /abs/myconfig && pwd");
        expect(result[0].expandedCwd).toBe("/abs/myconfig/sub");
    });

    test("`${{project}}` bound to scopeDir for cwd: ${{project}}", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1, "${{project}}")];
        const ctx: TemplateContext = { projectDir: "/abs/myconfig" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/myconfig", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/myconfig", changed);
        expect(result[0].expandedCwd).toBe("/abs/myconfig");
    });

    describe("per-file granularity", () => {
        test("trigger with `${{file_path}}` in run emits one CompiledCommand per file", () => {
            const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["lint ${{file_path}}"], 1)];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "src/a.ts");
            const fileB = makeChangedFile("/abs/scope", "src/b.ts");
            const changed: ChangedFile[] = [fileA, fileB];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(2);
            expect(result[0].matchedFiles).toEqual([fileA]);
            expect(result[1].matchedFiles).toEqual([fileB]);
            expect(result[0].expandedRun).toBe("lint '/abs/scope/src/a.ts'");
            expect(result[1].expandedRun).toBe("lint '/abs/scope/src/b.ts'");
        });

        test("trigger with `${{file_basename}}` in run emits one CompiledCommand per file", () => {
            const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo ${{file_basename}}"], 1)];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "src/a.ts");
            const fileB = makeChangedFile("/abs/scope", "src/b.ts");
            const changed: ChangedFile[] = [fileA, fileB];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(2);
            expect(result[0].expandedRun).toBe("echo 'a'");
            expect(result[1].expandedRun).toBe("echo 'b'");
        });

        test("trigger with `${{file_ext}}` in run emits one CompiledCommand per file", () => {
            const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo ${{file_ext}}"], 1)];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "src/a.ts");
            const fileB = makeChangedFile("/abs/scope", "src/b.ts");
            const changed: ChangedFile[] = [fileA, fileB];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(2);
            expect(result[0].expandedRun).toBe("echo '.ts'");
            expect(result[1].expandedRun).toBe("echo '.ts'");
        });

        test("trigger with `${{file_name}}` in run emits one CompiledCommand per file", () => {
            const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo ${{file_name}}"], 1)];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "src/a.ts");
            const fileB = makeChangedFile("/abs/scope", "src/b.ts");
            const changed: ChangedFile[] = [fileA, fileB];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(2);
            expect(result[0].expandedRun).toBe("echo 'a.ts'");
            expect(result[1].expandedRun).toBe("echo 'b.ts'");
        });
    });

    describe("per-directory granularity", () => {
        test("trigger with `${{file_dir}}` in cwd (no per-file vars) emits one CompiledCommand per unique directory", () => {
            const triggers: Trigger[] = [makeTrigger(["**/*.ts"], ["npm test"], 1, "${{file_dir}}")];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "src/a.ts");
            const fileB = makeChangedFile("/abs/scope", "src/b.ts");
            const fileC = makeChangedFile("/abs/scope", "lib/c.ts");
            const changed: ChangedFile[] = [fileA, fileB, fileC];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(2);
            const cwdValues = result.map(entry => entry.expandedCwd).sort();
            expect(cwdValues).toEqual(["/abs/scope/lib", "/abs/scope/src"]);
            const srcEmission = result.find(entry => entry.expandedCwd === "/abs/scope/src");
            const libEmission = result.find(entry => entry.expandedCwd === "/abs/scope/lib");
            expect(srcEmission).toBeDefined();
            expect(libEmission).toBeDefined();
            if (srcEmission !== undefined) {
                expect(srcEmission.matchedFiles).toEqual([fileA, fileB]);
            }
            if (libEmission !== undefined) {
                expect(libEmission.matchedFiles).toEqual([fileC]);
            }
        });
    });

    describe("per-group granularity", () => {
        test("trigger with `group_by: packages/*` and `${{group_dir}}` in cwd emits one CompiledCommand per unique group", () => {
            const triggers: Trigger[] = [
                makeTrigger(["packages/**/*.ts"], ["npm test"], 1, "${{group_dir}}", "packages/*"),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fooA = makeChangedFile("/abs/scope", "packages/foo/src/a.ts");
            const fooB = makeChangedFile("/abs/scope", "packages/foo/src/b.ts");
            const barA = makeChangedFile("/abs/scope", "packages/bar/src/a.ts");
            const changed: ChangedFile[] = [fooA, fooB, barA];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(2);
            const cwdValues = result.map(entry => entry.expandedCwd).sort();
            expect(cwdValues).toEqual(["/abs/scope/packages/bar", "/abs/scope/packages/foo"]);
            const fooEmission = result.find(entry => entry.expandedCwd === "/abs/scope/packages/foo");
            const barEmission = result.find(entry => entry.expandedCwd === "/abs/scope/packages/bar");
            expect(fooEmission).toBeDefined();
            expect(barEmission).toBeDefined();
            if (fooEmission !== undefined) {
                expect(fooEmission.matchedFiles).toEqual([fooA, fooB]);
            }
            if (barEmission !== undefined) {
                expect(barEmission.matchedFiles).toEqual([barA]);
            }
        });

        test("two files in the same package produce one emit with both files in matchedFiles", () => {
            const triggers: Trigger[] = [
                makeTrigger(["packages/**/*.ts"], ["echo build"], 1, "${{group_dir}}", "packages/*"),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "packages/foo/src/a.ts");
            const fileB = makeChangedFile("/abs/scope", "packages/foo/src/b.ts");
            const changed: ChangedFile[] = [fileA, fileB];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(1);
            expect(result[0].matchedFiles).toEqual([fileA, fileB]);
            expect(result[0].expandedCwd).toBe("/abs/scope/packages/foo");
        });

        test("absolute group dir is path.join(scopeDir, groupDir)", () => {
            const triggers: Trigger[] = [
                makeTrigger(["packages/**/*.ts"], ["echo ${{group_dir}}"], 1, undefined, "packages/*"),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const fileA = makeChangedFile("/abs/scope", "packages/foo/src/a.ts");
            const changed: ChangedFile[] = [fileA];
            const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
            expect(result.length).toBe(1);
            expect(result[0].expandedRun).toBe("echo '/abs/scope/packages/foo'");
        });
    });

    describe("group_by validation", () => {
        test("`${{group_dir}}` in cwd but no group_by throws at prepare time", () => {
            const triggers: Trigger[] = [
                makeTrigger(["**/*"], ["npm test"], 1, "${{group_dir}}"),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
            expect(() => compileCommands(triggers, "source", ctx, "/abs/scope", changed)).toThrow(/group_dir/);
        });

        test("`${{group_dir}}` in run but no group_by throws at prepare time", () => {
            const triggers: Trigger[] = [
                makeTrigger(["**/*"], ["echo ${{group_dir}}"], 1),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
            expect(() => compileCommands(triggers, "source", ctx, "/abs/scope", changed)).toThrow(/group_dir/);
        });

        test("matched file whose path doesn't match group_by is dropped with a warning, file is not emitted", () => {
            const triggers: Trigger[] = [
                makeTrigger(["**/*.ts"], ["echo ${{group_dir}}"], 1, undefined, "packages/*"),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const insideGroup = makeChangedFile("/abs/scope", "packages/foo/src/a.ts");
            const outsideGroup = makeChangedFile("/abs/scope", "src/b.ts");
            const changed: ChangedFile[] = [insideGroup, outsideGroup];
            const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
            try {
                const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
                expect(result.length).toBe(1);
                expect(result[0].matchedFiles).toEqual([insideGroup]);
                const warningCalls = stderrSpy.mock.calls.filter(call => String(call[0]).includes("did not match group_by"));
                expect(warningCalls.length).toBe(1);
                expect(String(warningCalls[0][0])).toContain("src/b.ts");
                expect(String(warningCalls[0][0])).toContain("packages/*");
            }
            finally {
                stderrSpy.mockRestore();
            }
        });

        test("if all matched files are dropped by group_by, the trigger emits nothing", () => {
            const triggers: Trigger[] = [
                makeTrigger(["**/*.ts"], ["echo ${{group_dir}}"], 1, undefined, "packages/*"),
            ];
            const ctx: TemplateContext = { projectDir: "/abs/scope" };
            const outsideGroup = makeChangedFile("/abs/scope", "src/b.ts");
            const changed: ChangedFile[] = [outsideGroup];
            const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
            try {
                const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
                expect(result).toEqual([]);
            }
            finally {
                stderrSpy.mockRestore();
            }
        });
    });

    test("absolute group dir uses path.join (handles trailing slashes consistently)", () => {
        const triggers: Trigger[] = [
            makeTrigger(["packages/**/*.ts"], ["echo ${{group_dir}}"], 1, undefined, "packages/*"),
        ];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const file = makeChangedFile("/abs/scope", "packages/foo/src/a.ts");
        const changed: ChangedFile[] = [file];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(1);
        const expectedAbsGroupDir = path.join("/abs/scope", "packages/foo");
        expect(result[0].expandedRun).toBe(`echo '${expectedAbsGroupDir}'`);
    });
});

describe("computeCommandKey", () => {
    test("returns a 64-character hex string (sha256)", () => {
        const result = computeCommandKey("echo a", "/cwd");
        expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    test("matches sha256(expandedRun + 0x00 + expandedCwd)", () => {
        const expectedDigest = crypto.createHash("sha256").update("echo a\0/cwd").digest("hex");
        expect(computeCommandKey("echo a", "/cwd")).toBe(expectedDigest);
    });

    test("differs when run changes", () => {
        const keyOne = computeCommandKey("echo a", "/cwd");
        const keyTwo = computeCommandKey("echo b", "/cwd");
        expect(keyOne).not.toBe(keyTwo);
    });

    test("differs when cwd changes", () => {
        const keyOne = computeCommandKey("echo a", "/cwd-one");
        const keyTwo = computeCommandKey("echo a", "/cwd-two");
        expect(keyOne).not.toBe(keyTwo);
    });

    test("is deterministic for identical inputs", () => {
        expect(computeCommandKey("echo a", "/cwd")).toBe(computeCommandKey("echo a", "/cwd"));
    });
});

describe("buildCompiledCommand", () => {
    const command: CommandConfig = {
        run: "echo ${{project}}",
        cooldown: 60,
        timeout: 300,
        cwd: "${{project}}",
        sourceLine: 5,
    };

    test("populates every field on the returned CompiledCommand", () => {
        const matchedFiles: ChangedFile[] = [makeChangedFile("/abs", "src/a.ts")];
        const result = buildCompiledCommand("src.yaml", 7, 0, 1, command, "echo /abs", "/abs", matchedFiles);
        expect(result.sourceFile).toBe("src.yaml");
        expect(result.sourceLine).toBe(7);
        expect(result.triggerIndexInFile).toBe(0);
        expect(result.commandIndex).toBe(1);
        expect(result.command).toBe(command);
        expect(result.expandedRun).toBe("echo /abs");
        expect(result.expandedCwd).toBe("/abs");
        expect(result.matchedFiles).toBe(matchedFiles);
    });

    test("derives commandKey via computeCommandKey", () => {
        const matchedFiles: ChangedFile[] = [];
        const result = buildCompiledCommand("src.yaml", 1, 0, 0, command, "echo a", "/cwd", matchedFiles);
        expect(result.commandKey).toBe(computeCommandKey("echo a", "/cwd"));
    });
});

describe("resolveGroupDirsForFiles", () => {
    test("when trigger.group_by is undefined, returns one entry per file with absGroupDir null", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1);
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const fileB = makeChangedFile("/abs", "src/b.ts");
        const result = resolveGroupDirsForFiles([fileA, fileB], trigger, "src.yaml", 0, "/abs");
        expect(result.length).toBe(2);
        expect(result[0]).toEqual({ file: fileA, absGroupDir: null });
        expect(result[1]).toEqual({ file: fileB, absGroupDir: null });
    });

    test("when trigger.group_by is set, returns absolute group dirs for matching files", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1, undefined, "packages/*");
        const fileA = makeChangedFile("/abs", "packages/foo/a.ts");
        const fileB = makeChangedFile("/abs", "packages/bar/b.ts");
        const result = resolveGroupDirsForFiles([fileA, fileB], trigger, "src.yaml", 0, "/abs");
        expect(result.length).toBe(2);
        expect(result[0]).toEqual({ file: fileA, absGroupDir: "/abs/packages/foo" });
        expect(result[1]).toEqual({ file: fileB, absGroupDir: "/abs/packages/bar" });
    });

    test("drops files that don't match group_by and writes a warning to stderr", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1, undefined, "packages/*");
        const fileInside = makeChangedFile("/abs", "packages/foo/a.ts");
        const fileOutside = makeChangedFile("/abs", "src/b.ts");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result = resolveGroupDirsForFiles([fileInside, fileOutside], trigger, "src.yaml", 3, "/abs");
            expect(result.length).toBe(1);
            expect(result[0].file).toBe(fileInside);
            const warningCalls = stderrSpy.mock.calls.filter(call => String(call[0]).includes("did not match group_by"));
            expect(warningCalls.length).toBe(1);
            const warningText = String(warningCalls[0][0]);
            expect(warningText).toContain("src.yaml");
            expect(warningText).toContain("trigger 3");
            expect(warningText).toContain("src/b.ts");
            expect(warningText).toContain("packages/*");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("returns [] when every file is dropped", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1, undefined, "packages/*");
        const fileOutside = makeChangedFile("/abs", "src/b.ts");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result = resolveGroupDirsForFiles([fileOutside], trigger, "src.yaml", 0, "/abs");
            expect(result).toEqual([]);
        }
        finally {
            stderrSpy.mockRestore();
        }
    });
});

describe("validateGroupDirUsage", () => {
    test("does not throw when trigger has group_by even if templates use ${{group_dir}}", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1, undefined, "packages/*");
        expect(() => validateGroupDirUsage("echo ${{group_dir}}", "${{group_dir}}", trigger, "src.yaml", 0, 0)).not.toThrow();
    });

    test("does not throw when neither template uses ${{group_dir}} and trigger has no group_by", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1);
        expect(() => validateGroupDirUsage("echo a", "${{project}}", trigger, "src.yaml", 0, 0)).not.toThrow();
    });

    test("throws when run uses ${{group_dir}} but trigger has no group_by", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{group_dir}}"], 1);
        expect(() => validateGroupDirUsage("echo ${{group_dir}}", "${{project}}", trigger, "src.yaml", 5, 2)).toThrow(/group_dir/);
    });

    test("throws when cwd uses ${{group_dir}} but trigger has no group_by", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo a"], 1);
        expect(() => validateGroupDirUsage("echo a", "${{group_dir}}", trigger, "src.yaml", 5, 2)).toThrow(/group_dir/);
    });

    test("error message includes the source file, trigger index, and command index", () => {
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{group_dir}}"], 1);
        try {
            validateGroupDirUsage("echo ${{group_dir}}", "${{project}}", trigger, "my-source.yaml", 7, 3);
            throw new Error("expected to throw");
        }
        catch (caughtError: any) {
            expect(caughtError.message).toContain("my-source.yaml");
            expect(caughtError.message).toContain("trigger 7");
            expect(caughtError.message).toContain("command 3");
        }
    });
});

describe("emitPerFile", () => {
    test("emits one CompiledCommand per file with single-element matchedFiles", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{file_path}}"], 5);
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const fileB = makeChangedFile("/abs", "src/b.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fileA, absGroupDir: null },
            { file: fileB, absGroupDir: null },
        ];
        const output: CompiledCommand[] = [];
        emitPerFile(filesWithGroup, "src.yaml", trigger, 0, 0, command, "echo ${{file_path}}", "${{project}}", ctx, output);
        expect(output.length).toBe(2);
        expect(output[0].matchedFiles).toEqual([fileA]);
        expect(output[1].matchedFiles).toEqual([fileB]);
        expect(output[0].expandedRun).toBe("echo '/abs/src/a.ts'");
        expect(output[1].expandedRun).toBe("echo '/abs/src/b.ts'");
        expect(output[0].sourceLine).toBe(5);
        expect(output[1].sourceLine).toBe(5);
    });

    test("expands ${{group_dir}} when absGroupDir is provided", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{file_path}}"], 1, undefined, "packages/*");
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "packages/foo/a.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fileA, absGroupDir: "/abs/packages/foo" },
        ];
        const output: CompiledCommand[] = [];
        emitPerFile(filesWithGroup, "src.yaml", trigger, 0, 0, command, "${{file_path}}", "${{group_dir}}", ctx, output);
        expect(output.length).toBe(1);
        expect(output[0].expandedCwd).toBe("/abs/packages/foo");
    });

    test("appends to the supplied output array (does not overwrite)", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{file_path}}"], 1);
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [{ file: fileA, absGroupDir: null }];
        const seedEmission: CompiledCommand = buildCompiledCommand("seed", 0, 0, 0, command, "seed-run", "/seed", []);
        const output: CompiledCommand[] = [seedEmission];
        emitPerFile(filesWithGroup, "src.yaml", trigger, 0, 0, command, "echo ${{file_path}}", "${{project}}", ctx, output);
        expect(output.length).toBe(2);
        expect(output[0]).toBe(seedEmission);
    });
});

describe("emitPerDirectory", () => {
    test("emits one CompiledCommand per unique dirname(absPath)", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm test"], 1, "${{file_dir}}");
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const fileB = makeChangedFile("/abs", "src/b.ts");
        const fileC = makeChangedFile("/abs", "lib/c.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fileA, absGroupDir: null },
            { file: fileB, absGroupDir: null },
            { file: fileC, absGroupDir: null },
        ];
        const output: CompiledCommand[] = [];
        emitPerDirectory(filesWithGroup, "src.yaml", trigger, 0, 0, command, "npm test", "${{file_dir}}", ctx, output);
        expect(output.length).toBe(2);
        const cwdValues = output.map(entry => entry.expandedCwd).sort();
        expect(cwdValues).toEqual(["/abs/lib", "/abs/src"]);
    });

    test("collects all files sharing a directory into the same emission's matchedFiles", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm test"], 1, "${{file_dir}}");
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const fileB = makeChangedFile("/abs", "src/b.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fileA, absGroupDir: null },
            { file: fileB, absGroupDir: null },
        ];
        const output: CompiledCommand[] = [];
        emitPerDirectory(filesWithGroup, "src.yaml", trigger, 0, 0, command, "npm test", "${{file_dir}}", ctx, output);
        expect(output.length).toBe(1);
        expect(output[0].matchedFiles).toEqual([fileA, fileB]);
    });

    test("emits nothing when filesWithGroup is empty", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm test"], 1, "${{file_dir}}");
        const command = trigger.commands[0];
        const output: CompiledCommand[] = [];
        emitPerDirectory([], "src.yaml", trigger, 0, 0, command, "npm test", "${{file_dir}}", ctx, output);
        expect(output).toEqual([]);
    });
});

describe("emitPerGroup", () => {
    test("emits one CompiledCommand per unique absGroupDir", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm build"], 1, "${{group_dir}}", "packages/*");
        const command = trigger.commands[0];
        const fooA = makeChangedFile("/abs", "packages/foo/a.ts");
        const fooB = makeChangedFile("/abs", "packages/foo/b.ts");
        const barA = makeChangedFile("/abs", "packages/bar/a.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fooA, absGroupDir: "/abs/packages/foo" },
            { file: fooB, absGroupDir: "/abs/packages/foo" },
            { file: barA, absGroupDir: "/abs/packages/bar" },
        ];
        const output: CompiledCommand[] = [];
        emitPerGroup(filesWithGroup, "src.yaml", trigger, 0, 0, command, "npm build", "${{group_dir}}", ctx, output);
        expect(output.length).toBe(2);
        const cwdValues = output.map(entry => entry.expandedCwd).sort();
        expect(cwdValues).toEqual(["/abs/packages/bar", "/abs/packages/foo"]);
    });

    test("groups files that share absGroupDir into the same matchedFiles", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm build"], 1, "${{group_dir}}", "packages/*");
        const command = trigger.commands[0];
        const fooA = makeChangedFile("/abs", "packages/foo/a.ts");
        const fooB = makeChangedFile("/abs", "packages/foo/b.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fooA, absGroupDir: "/abs/packages/foo" },
            { file: fooB, absGroupDir: "/abs/packages/foo" },
        ];
        const output: CompiledCommand[] = [];
        emitPerGroup(filesWithGroup, "src.yaml", trigger, 0, 0, command, "npm build", "${{group_dir}}", ctx, output);
        expect(output.length).toBe(1);
        expect(output[0].matchedFiles).toEqual([fooA, fooB]);
    });

    test("skips entries whose absGroupDir is null", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm build"], 1, "${{group_dir}}", "packages/*");
        const command = trigger.commands[0];
        const fooA = makeChangedFile("/abs", "packages/foo/a.ts");
        const stray = makeChangedFile("/abs", "src/x.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fooA, absGroupDir: "/abs/packages/foo" },
            { file: stray, absGroupDir: null },
        ];
        const output: CompiledCommand[] = [];
        emitPerGroup(filesWithGroup, "src.yaml", trigger, 0, 0, command, "npm build", "${{group_dir}}", ctx, output);
        expect(output.length).toBe(1);
        expect(output[0].matchedFiles).toEqual([fooA]);
    });
});

describe("emitPerTrigger", () => {
    test("emits a single CompiledCommand with all files attached", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["npm test"], 1);
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const fileB = makeChangedFile("/abs", "src/b.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [
            { file: fileA, absGroupDir: null },
            { file: fileB, absGroupDir: null },
        ];
        const output: CompiledCommand[] = [];
        emitPerTrigger(filesWithGroup, "src.yaml", trigger, 0, 0, command, "npm test", "${{project}}", ctx, output);
        expect(output.length).toBe(1);
        expect(output[0].matchedFiles).toEqual([fileA, fileB]);
        expect(output[0].expandedCwd).toBe("/abs");
        expect(output[0].expandedRun).toBe("npm test");
    });

    test("expands ${{project}} via expandStatic in both run and cwd", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{project}}"], 1, "${{project}}/sub");
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs/scope", "src/a.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [{ file: fileA, absGroupDir: null }];
        const output: CompiledCommand[] = [];
        emitPerTrigger(filesWithGroup, "src.yaml", trigger, 0, 0, command, "echo ${{project}}", "${{project}}/sub", ctx, output);
        expect(output[0].expandedRun).toBe("echo /abs/scope");
        expect(output[0].expandedCwd).toBe("/abs/scope/sub");
    });

    test("throws when run/cwd contain a per-file variable (expandStatic rejects them)", () => {
        const ctx: TemplateContext = { projectDir: "/abs" };
        const trigger: Trigger = makeTrigger(["**/*"], ["echo ${{file_path}}"], 1);
        const command = trigger.commands[0];
        const fileA = makeChangedFile("/abs", "src/a.ts");
        const filesWithGroup: IMatchedFileWithGroup[] = [{ file: fileA, absGroupDir: null }];
        const output: CompiledCommand[] = [];
        expect(() => emitPerTrigger(filesWithGroup, "src.yaml", trigger, 0, 0, command, "echo ${{file_path}}", "${{project}}", ctx, output)).toThrow();
    });
});
