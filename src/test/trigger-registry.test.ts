import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChangedFile, CommandConfig, CompiledCommand, Trigger } from "../types";
import { TemplateContext } from "../template";
import { FileLayer, ITriggerLayer, StaticLayer, TriggerRegistry, evaluateLayerMatches } from "../trigger-registry";

// Holds a temp directory path for the lifetime of one test, plus helpers to clean it up.
interface TempArea {
    // Absolute path to the per-test temp directory created via `fs.mkdtemp`.
    rootDir: string;
}

// Creates a fresh temp directory under the OS temp root and returns a `TempArea` referencing it.
async function makeTempArea(): Promise<TempArea> {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-trigger-registry-test-"));
    return { rootDir: baseDir };
}

// Removes a temp area created by `makeTempArea`, ignoring missing-directory errors.
async function cleanupTempArea(area: TempArea): Promise<void> {
    await fs.rm(area.rootDir, { recursive: true, force: true });
}

// Writes `content` to `filePath`, creating parent directories as needed.
async function writeFileEnsuringDirs(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
}

// Builds a synthetic `Trigger` for use in `StaticLayer` test fixtures. Each command is filled out with the
// post-parse defaults used elsewhere in the codebase so the resulting trigger looks indistinguishable from
// one produced by `loadConfigFile`.
function makeTrigger(paths: string[], runCommands: string[], sourceLine: number): Trigger {
    const commands: CommandConfig[] = runCommands.map(runValue => ({
        run: runValue,
        cwd: "${{project}}",
        cooldown: 60,
        timeout: 300,
        sourceLine,
    }));
    return {
        paths,
        commands,
        sourceLine,
    };
}

// Builds a `ChangedFile` with both POSIX-relative and absolute paths derived from the supplied scope.
function makeChangedFile(scopeDir: string, relativePath: string): ChangedFile {
    return {
        path: relativePath,
        absPath: path.join(scopeDir, relativePath),
    };
}

describe("StaticLayer", () => {
    test("reports isEmpty: false for a non-empty trigger fixture", () => {
        const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const layer = new StaticLayer(triggers, "static-source", "/abs/scope", ctx);
        expect(layer.isEmpty()).toBe(false);
    });

    test("reports isEmpty: true for an empty trigger fixture", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const layer = new StaticLayer([], "static-source", "/abs/scope", ctx);
        expect(layer.isEmpty()).toBe(true);
    });

    test("exposes sourceFile, scopeDir, and ctx as constructed", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const layer = new StaticLayer([], "static-source", "/abs/scope", ctx);
        expect(layer.sourceFile).toBe("static-source");
        expect(layer.scopeDir).toBe("/abs/scope");
        expect(layer.ctx).toBe(ctx);
    });

    test("compileCommands returns the expected CompiledCommand[] for a matching changed-file set", () => {
        const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo first", "echo second"], 7)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const layer = new StaticLayer(triggers, "static-source", "/abs/scope", ctx);
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/foo.ts")];

        const compiled: CompiledCommand[] = layer.compileCommands(changed);
        expect(compiled.length).toBe(2);
        expect(compiled[0].sourceFile).toBe("static-source");
        expect(compiled[0].sourceLine).toBe(7);
        expect(compiled[0].triggerIndexInFile).toBe(0);
        expect(compiled[0].commandIndex).toBe(0);
        expect(compiled[0].expandedRun).toBe("echo first");
        expect(compiled[1].sourceFile).toBe("static-source");
        expect(compiled[1].triggerIndexInFile).toBe(0);
        expect(compiled[1].commandIndex).toBe(1);
        expect(compiled[1].expandedRun).toBe("echo second");
    });

    test("compileCommands returns [] when no files have changed", () => {
        const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo a"], 1)];
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const layer = new StaticLayer(triggers, "static-source", "/abs/scope", ctx);
        expect(layer.compileCommands([])).toEqual([]);
    });

    test("triggerCount returns the number of triggers held by the layer", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const emptyLayer = new StaticLayer([], "static-empty", "/abs/scope", ctx);
        expect(emptyLayer.triggerCount()).toBe(0);
        const triggers: Trigger[] = [
            makeTrigger(["src/**/*.ts"], ["echo a"], 1),
            makeTrigger(["docs/**/*.md"], ["echo b"], 4),
        ];
        const populatedLayer = new StaticLayer(triggers, "static-pop", "/abs/scope", ctx);
        expect(populatedLayer.triggerCount()).toBe(2);
    });

    test("evaluateMatches returns one entry per trigger with matched and unmatched files split", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const triggers: Trigger[] = [
            makeTrigger(["src/**/*.ts"], ["echo a"], 7),
            makeTrigger(["docs/**/*.md"], ["echo b"], 12),
        ];
        const layer = new StaticLayer(triggers, "static-source", "/abs/scope", ctx);
        const changed: ChangedFile[] = [
            makeChangedFile("/abs/scope", "src/a.ts"),
            makeChangedFile("/abs/scope", "src/b.ts"),
            makeChangedFile("/abs/scope", "docs/x.md"),
            makeChangedFile("/abs/scope", "README"),
        ];
        const matches = layer.evaluateMatches(changed);
        expect(matches).toHaveLength(2);
        expect(matches[0].sourceFile).toBe("static-source");
        expect(matches[0].sourceLine).toBe(7);
        expect(matches[0].triggerIndex).toBe(0);
        expect(matches[0].patterns).toEqual(["src/**/*.ts"]);
        expect(matches[0].matchedFiles.map(file => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
        expect(matches[0].unmatchedFiles.map(file => file.path).sort()).toEqual(["README", "docs/x.md"]);
        expect(matches[1].sourceFile).toBe("static-source");
        expect(matches[1].sourceLine).toBe(12);
        expect(matches[1].triggerIndex).toBe(1);
        expect(matches[1].matchedFiles.map(file => file.path)).toEqual(["docs/x.md"]);
        expect(matches[1].unmatchedFiles.map(file => file.path).sort()).toEqual(["README", "src/a.ts", "src/b.ts"]);
    });

    test("evaluateMatches returns an empty array when the layer holds no triggers", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const layer = new StaticLayer([], "static-empty", "/abs/scope", ctx);
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/a.ts")];
        expect(layer.evaluateMatches(changed)).toEqual([]);
    });

    test("evaluateMatches returns an entry per trigger even when nothing matched", () => {
        const ctx: TemplateContext = { projectDir: "/abs/scope" };
        const triggers: Trigger[] = [makeTrigger(["src/**/*.ts"], ["echo a"], 3)];
        const layer = new StaticLayer(triggers, "static-source", "/abs/scope", ctx);
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "docs/x.md")];
        const matches = layer.evaluateMatches(changed);
        expect(matches).toHaveLength(1);
        expect(matches[0].matchedFiles).toEqual([]);
        expect(matches[0].unmatchedFiles.map(file => file.path)).toEqual(["docs/x.md"]);
    });
});

describe("FileLayer", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("constructed with a non-existent path: isEmpty true, compileCommands returns [], no thrown error", async () => {
        const missingPath = path.join(tempArea.rootDir, "missing.yaml");
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        const layer = await FileLayer.create(missingPath, missingPath, tempArea.rootDir, ctx);
        expect(layer.isEmpty()).toBe(true);
        const changed: ChangedFile[] = [makeChangedFile(tempArea.rootDir, "src/foo.ts")];
        expect(layer.compileCommands(changed)).toEqual([]);
    });

    test("constructed with a null path: isEmpty true, compileCommands returns []", async () => {
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        const layer = await FileLayer.create(null, "<no-config>", tempArea.rootDir, ctx);
        expect(layer.isEmpty()).toBe(true);
        expect(layer.compileCommands([])).toEqual([]);
    });

    test("constructed with a valid YAML file: isEmpty false, exposes fields, compileCommands returns expected output", async () => {
        const yamlText = [
            "triggers:",
            "  - paths:",
            "      - \"src/**/*.ts\"",
            "    commands:",
            "      - run: \"echo a\"",
            "",
        ].join("\n");
        const yamlPath = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(yamlPath, yamlText);
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };

        const layer = await FileLayer.create(yamlPath, yamlPath, tempArea.rootDir, ctx);
        expect(layer.isEmpty()).toBe(false);
        expect(layer.sourceFile).toBe(yamlPath);
        expect(layer.scopeDir).toBe(tempArea.rootDir);
        expect(layer.ctx).toBe(ctx);

        const changed: ChangedFile[] = [makeChangedFile(tempArea.rootDir, "src/foo.ts")];
        const compiled: CompiledCommand[] = layer.compileCommands(changed);
        expect(compiled.length).toBe(1);
        expect(compiled[0].sourceFile).toBe(yamlPath);
        expect(compiled[0].expandedRun).toBe("echo a");
    });

    test("FileLayer.create rejects when the YAML file fails to parse", async () => {
        const yamlPath = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(yamlPath, "triggers:\n  - paths: [\n    : :\n");
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        await expect(FileLayer.create(yamlPath, yamlPath, tempArea.rootDir, ctx)).rejects.toThrow();
    });

    test("FileLayer.create rejects when the YAML file fails validation", async () => {
        const yamlText = [
            "triggers:",
            "  - paths: [\"src/foo.ts\"]",
            "    commands:",
            "      - run: \"\"",
            "",
        ].join("\n");
        const yamlPath = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(yamlPath, yamlText);
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        await expect(FileLayer.create(yamlPath, yamlPath, tempArea.rootDir, ctx)).rejects.toThrow(/run must be a non-empty string/);
    });

    test("FileLayer.triggerCount reports the number of triggers parsed out of the YAML", async () => {
        const yamlText = [
            "triggers:",
            "  - paths: [\"src/**/*.ts\"]",
            "    commands:",
            "      - run: \"echo a\"",
            "  - paths: [\"docs/**/*.md\"]",
            "    commands:",
            "      - run: \"echo b\"",
            "",
        ].join("\n");
        const yamlPath = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(yamlPath, yamlText);
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        const layer = await FileLayer.create(yamlPath, yamlPath, tempArea.rootDir, ctx);
        expect(layer.triggerCount()).toBe(2);
    });

    test("FileLayer.triggerCount is 0 for a missing-file layer", async () => {
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        const layer = await FileLayer.create(null, "<no-config>", tempArea.rootDir, ctx);
        expect(layer.triggerCount()).toBe(0);
    });

    test("FileLayer.evaluateMatches emits one info per trigger using the trigger's source line", async () => {
        const yamlText = [
            "triggers:",
            "  - paths: [\"src/**/*.ts\"]",
            "    commands:",
            "      - run: \"echo a\"",
            "  - paths: [\"docs/**/*.md\"]",
            "    commands:",
            "      - run: \"echo b\"",
            "",
        ].join("\n");
        const yamlPath = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(yamlPath, yamlText);
        const ctx: TemplateContext = { projectDir: tempArea.rootDir };
        const layer = await FileLayer.create(yamlPath, "claude-tools-runner.yaml", tempArea.rootDir, ctx);
        const changed: ChangedFile[] = [
            makeChangedFile(tempArea.rootDir, "src/a.ts"),
            makeChangedFile(tempArea.rootDir, "docs/x.md"),
        ];
        const matches = layer.evaluateMatches(changed);
        expect(matches).toHaveLength(2);
        expect(matches[0].sourceFile).toBe("claude-tools-runner.yaml");
        expect(matches[0].sourceLine).toBe(2);
        expect(matches[0].triggerIndex).toBe(0);
        expect(matches[0].patterns).toEqual(["src/**/*.ts"]);
        expect(matches[0].matchedFiles.map(file => file.path)).toEqual(["src/a.ts"]);
        expect(matches[0].unmatchedFiles.map(file => file.path)).toEqual(["docs/x.md"]);
        expect(matches[1].sourceLine).toBe(5);
        expect(matches[1].matchedFiles.map(file => file.path)).toEqual(["docs/x.md"]);
    });
});

describe("TriggerRegistry", () => {
    test("isEmpty returns true when every layer is empty", () => {
        const ctx: TemplateContext = { projectDir: "/abs/a" };
        const layerOne = new StaticLayer([], "layer-one", "/abs/a", ctx);
        const layerTwo = new StaticLayer([], "layer-two", "/abs/a", ctx);
        const registry = new TriggerRegistry([layerOne, layerTwo]);
        expect(registry.isEmpty()).toBe(true);
    });

    test("isEmpty returns false when any layer holds triggers", () => {
        const ctxA: TemplateContext = { projectDir: "/abs/a" };
        const ctxB: TemplateContext = { projectDir: "/abs/b" };
        const emptyLayer = new StaticLayer([], "layer-one", "/abs/a", ctxA);
        const populatedLayer = new StaticLayer([makeTrigger(["**/*"], ["echo a"], 1)], "layer-two", "/abs/b", ctxB);
        const registry = new TriggerRegistry([emptyLayer, populatedLayer]);
        expect(registry.isEmpty()).toBe(false);
    });

    test("isEmpty returns true for a registry with zero layers", () => {
        const registry = new TriggerRegistry([]);
        expect(registry.isEmpty()).toBe(true);
    });

    test("compileCommands iterates layers in registration order and concatenates their outputs", () => {
        const homeCtx: TemplateContext = { projectDir: "/home/user/.claude" };
        const configACtx: TemplateContext = { projectDir: "/abs/a" };
        const configBCtx: TemplateContext = { projectDir: "/abs/b" };
        const homeLayer = new StaticLayer(
            [makeTrigger(["**/*"], ["echo home"], 1)],
            "home-source",
            "/home/user/.claude",
            homeCtx,
        );
        const configLayerA = new StaticLayer(
            [makeTrigger(["**/*"], ["echo a-one", "echo a-two"], 3)],
            "config-a",
            "/abs/a",
            configACtx,
        );
        const configLayerB = new StaticLayer(
            [makeTrigger(["**/*"], ["echo b"], 5)],
            "config-b",
            "/abs/b",
            configBCtx,
        );
        const registry = new TriggerRegistry([homeLayer, configLayerA, configLayerB]);
        const changed: ChangedFile[] = [makeChangedFile("/abs/a", "src/foo.ts")];

        const compiled: CompiledCommand[] = registry.compileCommands(changed);
        expect(compiled.length).toBe(4);
        expect(compiled[0].sourceFile).toBe("home-source");
        expect(compiled[0].expandedRun).toBe("echo home");
        expect(compiled[1].sourceFile).toBe("config-a");
        expect(compiled[1].expandedRun).toBe("echo a-one");
        expect(compiled[2].sourceFile).toBe("config-a");
        expect(compiled[2].expandedRun).toBe("echo a-two");
        expect(compiled[3].sourceFile).toBe("config-b");
        expect(compiled[3].expandedRun).toBe("echo b");
    });

    test("compileCommands of a registry with only the home layer returns just home's output", () => {
        const homeCtx: TemplateContext = { projectDir: "/home/user/.claude" };
        const homeLayer = new StaticLayer(
            [makeTrigger(["**/*"], ["echo home"], 1)],
            "home-source",
            "/home/user/.claude",
            homeCtx,
        );
        const registry = new TriggerRegistry([homeLayer]);
        const changed: ChangedFile[] = [makeChangedFile("/home/user/.claude", "src/foo.ts")];

        const compiled: CompiledCommand[] = registry.compileCommands(changed);
        expect(compiled.length).toBe(1);
        expect(compiled[0].sourceFile).toBe("home-source");
    });

    test("two config layers with different scopeDir values: outputs never cross-contaminate sourceFile", () => {
        const ctxA: TemplateContext = { projectDir: "/abs/a" };
        const ctxB: TemplateContext = { projectDir: "/abs/b" };
        const layerA = new StaticLayer(
            [makeTrigger(["**/*"], ["echo a"], 2)],
            "config-a",
            "/abs/a",
            ctxA,
        );
        const layerB = new StaticLayer(
            [makeTrigger(["**/*"], ["echo b"], 4)],
            "config-b",
            "/abs/b",
            ctxB,
        );
        const registry = new TriggerRegistry([layerA, layerB]);
        const changed: ChangedFile[] = [makeChangedFile("/abs/a", "src/foo.ts")];

        const compiled: CompiledCommand[] = registry.compileCommands(changed);
        expect(compiled.length).toBe(2);
        const fromA = compiled.filter(entry => entry.sourceFile === "config-a");
        const fromB = compiled.filter(entry => entry.sourceFile === "config-b");
        expect(fromA.length).toBe(1);
        expect(fromB.length).toBe(1);
        expect(fromA[0].expandedRun).toBe("echo a");
        expect(fromB[0].expandedRun).toBe("echo b");
    });

    test("compileCommands returns [] when every layer's compileCommands returns []", () => {
        const ctx: TemplateContext = { projectDir: "/abs/a" };
        const emptyLayer = new StaticLayer([], "empty-one", "/abs/a", ctx);
        const populatedLayer = new StaticLayer([makeTrigger(["**/*"], ["echo a"], 1)], "populated", "/abs/a", ctx);
        const registry = new TriggerRegistry([emptyLayer, populatedLayer]);
        // No changed files: even the populated layer compiles to [].
        expect(registry.compileCommands([])).toEqual([]);
    });

    test("ITriggerLayer accepts custom implementations", () => {
        // Sanity check that the interface is wide enough for non-StaticLayer/FileLayer implementations.
        const customLayer: ITriggerLayer = {
            sourceFile: "custom",
            scopeDir: "/abs/custom",
            ctx: { projectDir: "/abs/custom" },
            isEmpty: () => true,
            triggerCount: () => 0,
            compileCommands: () => [],
            evaluateMatches: () => [],
        };
        const registry = new TriggerRegistry([customLayer]);
        expect(registry.isEmpty()).toBe(true);
        expect(registry.compileCommands([])).toEqual([]);
    });
});

describe("evaluateLayerMatches", () => {
    test("returns one ITriggerMatchInfo per trigger with matched/unmatched files split by matchFiles", () => {
        const triggers: Trigger[] = [
            makeTrigger(["src/**/*.ts"], ["echo a"], 7),
            makeTrigger(["docs/**/*.md"], ["echo b"], 12),
        ];
        const changed: ChangedFile[] = [
            makeChangedFile("/abs/scope", "src/a.ts"),
            makeChangedFile("/abs/scope", "docs/x.md"),
        ];
        const result = evaluateLayerMatches(triggers, "layer.yaml", changed);
        expect(result).toHaveLength(2);
        expect(result[0].sourceFile).toBe("layer.yaml");
        expect(result[0].sourceLine).toBe(7);
        expect(result[0].triggerIndex).toBe(0);
        expect(result[0].patterns).toEqual(["src/**/*.ts"]);
        expect(result[0].matchedFiles.map(file => file.path)).toEqual(["src/a.ts"]);
        expect(result[0].unmatchedFiles.map(file => file.path)).toEqual(["docs/x.md"]);
        expect(result[1].sourceLine).toBe(12);
        expect(result[1].triggerIndex).toBe(1);
        expect(result[1].matchedFiles.map(file => file.path)).toEqual(["docs/x.md"]);
    });

    test("returns an empty array when triggers is empty", () => {
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/a.ts")];
        expect(evaluateLayerMatches([], "layer.yaml", changed)).toEqual([]);
    });

    test("returns a fresh patterns array (slice) so mutation cannot leak back into the trigger", () => {
        const trigger = makeTrigger(["src/**/*.ts"], ["echo a"], 1);
        const result = evaluateLayerMatches([trigger], "layer.yaml", []);
        expect(result[0].patterns).not.toBe(trigger.paths);
        expect(result[0].patterns).toEqual(trigger.paths);
    });

    test("renders patterns as [] when the trigger has no paths declared", () => {
        const trigger: Trigger = {
            commands: [{ run: "echo hi", sourceLine: 1 }],
            sourceLine: 1,
        };
        const changed: ChangedFile[] = [makeChangedFile("/abs/scope", "src/a.ts")];
        const result = evaluateLayerMatches([trigger], "layer.yaml", changed);
        expect(result).toHaveLength(1);
        expect(result[0].patterns).toEqual([]);
        expect(result[0].matchedFiles).toEqual([]);
        expect(result[0].unmatchedFiles.map(file => file.path)).toEqual(["src/a.ts"]);
    });
});
