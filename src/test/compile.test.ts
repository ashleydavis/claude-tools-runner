import * as crypto from "node:crypto";
import { ChangedFile, CommandConfig, CompiledCommand, Trigger } from "../types";
import { TemplateContext } from "../template";
import { compileCommands } from "../compile";

// Builds a `Trigger` for tests. Mirrors the post-parse defaults `parseCommand` applies in `config.ts` so the
// fixtures look indistinguishable from triggers loaded by `loadConfigFile`.
function makeTrigger(paths: string[] | undefined, runCommands: string[], sourceLine: number, cwd?: string): Trigger {
    const commands: CommandConfig[] = runCommands.map(runValue => {
        const command: CommandConfig = {
            run: runValue,
            cooldown: 60,
            timeout: 300,
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

    test("emits one CompiledCommand per (trigger, command) pair", () => {
        const triggers: Trigger[] = [
            makeTrigger(["src/**/*.ts"], ["echo a", "echo b"], 5),
            makeTrigger(["scripts/**/*.sh"], ["echo c"], 9),
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

    test("attaches the full changed-file set as matchedFiles on every emission", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [
            makeChangedFile("/abs/scope", "src/a.ts"),
            makeChangedFile("/abs/scope", "src/b.ts"),
        ];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(1);
        expect(result[0].matchedFiles).toBe(changed);
    });

    test("expandedCwd defaults to ${{project}} when CommandConfig.cwd is undefined", () => {
        const triggers: Trigger[] = [makeTrigger(["**/*"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result[0].expandedCwd).toBe("${{project}}");
    });

    test("expandedCwd preserves the supplied CommandConfig.cwd verbatim", () => {
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

    test("two commands with the same expandedRun and expandedCwd share commandKey across emissions", () => {
        const triggers: Trigger[] = [
            makeTrigger(["**/*"], ["echo a"], 1, "/same/cwd"),
            makeTrigger(["scripts/*"], ["echo a"], 2, "/same/cwd"),
        ];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];
        const result = compileCommands(triggers, "source", ctx, "/abs/scope", changed);
        expect(result.length).toBe(2);
        expect(result[0].commandKey).toBe(result[1].commandKey);
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
});
