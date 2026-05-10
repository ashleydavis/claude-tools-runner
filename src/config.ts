import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
import * as YAML from "yaml";
import { isMap, isScalar, isSeq, YAMLMap } from "yaml";
import { parseDuration } from "./duration";
import { stripLeadingAnchor } from "./matcher";
import { CommandConfig, Config, Trigger } from "./types";

// Top-level YAML keys accepted by the config schema. Any other top-level key is rejected with a validation error.
const ALLOWED_TOP_LEVEL_KEYS: readonly string[] = ["triggers", "ignore"];

// Directory names that are unconditionally skipped during recursive `scanConfigFiles` traversal.
// `.git` and `.cache` are dot-directories already excluded by the dot-prefix rule, but listing them explicitly here
// keeps the rule self-evident at the call site.
const ALWAYS_SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git", ".cache"]);

// Default working directory template applied to a command when its YAML omits `cwd`.
const DEFAULT_CWD_TEMPLATE: string = "${{project}}";

// Default cooldown applied to a command when its YAML omits `cooldown`. Stored as integer seconds (1 minute).
const DEFAULT_COOLDOWN_SECONDS: number = 60;

// Default timeout applied to a command when its YAML omits `timeout`. Stored as integer seconds (5 minutes).
const DEFAULT_TIMEOUT_SECONDS: number = 300;

// Loads and validates a single `claude-tools-runner.yaml` file.
//
// Returns null if the file does not exist (ENOENT). Throws on YAML parse errors, schema validation errors,
// or duration parse errors. Empty documents and documents with `triggers: []` are accepted and yield
// `{ triggers: [] }`. Each returned `Trigger` carries a 1-based `sourceLine` pointing to the first key of its
// YAML mapping; this position flows through to `CompiledCommand` and audit-log entries so users can jump from
// a log line to the YAML source that produced it.
export async function loadConfigFile(filePath: string): Promise<Config | null> {
    let fileText: string;
    try {
        fileText = await fs.readFile(filePath, "utf8");
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return null;
        }
        throw caughtErr;
    }

    const yamlDoc = YAML.parseDocument(fileText, { keepSourceTokens: true });
    if (yamlDoc.errors.length > 0) {
        throw new Error(`failed to parse YAML: ${yamlDoc.errors[0].message}`);
    }

    if (!yamlDoc.contents) {
        return { triggers: [] };
    }

    if (!isMap(yamlDoc.contents)) {
        throw new Error("top-level YAML value must be a mapping");
    }

    const rootMap = yamlDoc.contents;
    const plainData = yamlDoc.toJS();

    for (const topKey of Object.keys(plainData)) {
        if (!ALLOWED_TOP_LEVEL_KEYS.includes(topKey)) {
            throw new Error(`unknown top-level key ${JSON.stringify(topKey)} (allowed: ${ALLOWED_TOP_LEVEL_KEYS.join(", ")})`);
        }
    }

    let parsedIgnore: string[] | undefined = undefined;
    if (plainData.ignore !== undefined && plainData.ignore !== null) {
        if (!Array.isArray(plainData.ignore)) {
            throw new Error("ignore must be a YAML sequence (array) of glob strings");
        }
        for (let ignoreIndex = 0; ignoreIndex < plainData.ignore.length; ignoreIndex++) {
            const ignoreEntry = plainData.ignore[ignoreIndex];
            if (typeof ignoreEntry !== "string" || ignoreEntry.length === 0) {
                throw new Error(`ignore[${ignoreIndex}] must be a non-empty string`);
            }
        }
        parsedIgnore = plainData.ignore;
    }

    if (!plainData.triggers) {
        const emptyResult: Config = { triggers: [] };
        if (parsedIgnore !== undefined) {
            emptyResult.ignore = parsedIgnore;
        }
        return emptyResult;
    }

    if (!Array.isArray(plainData.triggers)) {
        throw new Error("triggers must be a YAML sequence (array)");
    }

    const triggerSourceLines = computeTriggerSourceLines(rootMap, fileText, plainData.triggers.length);
    const commandSourceLinesByTrigger = computeCommandSourceLinesByTrigger(rootMap, fileText, plainData.triggers);

    const triggers: Trigger[] = [];
    for (let triggerIndex = 0; triggerIndex < plainData.triggers.length; triggerIndex++) {
        const rawTrigger = plainData.triggers[triggerIndex];
        const sourceLine = triggerSourceLines[triggerIndex];
        const commandSourceLines = commandSourceLinesByTrigger[triggerIndex];
        const parsedTrigger = parseTrigger(rawTrigger, triggerIndex, sourceLine, commandSourceLines);
        triggers.push(parsedTrigger);
    }
    const result: Config = { triggers };
    if (parsedIgnore !== undefined) {
        result.ignore = parsedIgnore;
    }
    return result;
}

// Walks the YAML node tree and returns, for each trigger by index, an array of 1-based line numbers
// (one per command mapping under its `commands:` key). Triggers whose `commands` cannot be resolved as a
// YAML sequence get an empty array; individual commands without a resolvable position fall back to the
// trigger's first line. The shape mirrors the JS-side `triggers[].commands[]` so callers can index by both.
export function computeCommandSourceLinesByTrigger(rootMap: YAMLMap, sourceText: string, plainTriggers: any[]): number[][] {
    const result: number[][] = [];
    let triggersValueNode: any = null;
    for (const pair of rootMap.items) {
        const pairKey: any = pair.key;
        if (isScalar(pairKey) && pairKey.value === "triggers") {
            triggersValueNode = pair.value;
            break;
        }
    }

    if (!isSeq(triggersValueNode)) {
        for (let triggerIndex = 0; triggerIndex < plainTriggers.length; triggerIndex++) {
            result.push([]);
        }
        return result;
    }

    const triggersSeq = triggersValueNode;
    for (let triggerIndex = 0; triggerIndex < plainTriggers.length; triggerIndex++) {
        const triggerItemNode: any = triggersSeq.items[triggerIndex];
        const commandLines: number[] = [];
        if (triggerItemNode && isMap(triggerItemNode)) {
            let commandsValueNode: any = null;
            for (const pair of triggerItemNode.items) {
                const pairKey: any = pair.key;
                if (isScalar(pairKey) && pairKey.value === "commands") {
                    commandsValueNode = pair.value;
                    break;
                }
            }
            if (isSeq(commandsValueNode)) {
                const expectedCount = Array.isArray(plainTriggers[triggerIndex]?.commands) ? plainTriggers[triggerIndex].commands.length : 0;
                for (let commandIndex = 0; commandIndex < expectedCount; commandIndex++) {
                    const commandItemNode: any = commandsValueNode.items[commandIndex];
                    const commandLine = lineNumberOfNode(commandItemNode, sourceText);
                    commandLines.push(commandLine);
                }
            }
        }
        result.push(commandLines);
    }
    return result;
}

// Compiled directory-path matcher used to skip subtrees during the recursive config scan. Receives a
// project-relative POSIX directory path (e.g. `e2e/20-yaml-parse-error/tmp`) and returns true when the
// path matches one of the user-supplied `ignore` globs.
type CompiledIgnoreMatcher = (relativeDirPath: string) => boolean;

// Compiles the project root config's `ignore` glob list into a single matcher function. Patterns are
// project-relative POSIX globs interpreted by picomatch with `dot: true`; a leading `./` or `/` anchor is
// stripped so users can write the same forms accepted by `paths:`. Returns a no-op matcher when `patterns`
// is undefined or empty.
export function compileIgnoreMatcher(patterns: string[] | undefined): CompiledIgnoreMatcher {
    if (patterns === undefined || patterns.length === 0) {
        return () => false;
    }
    const compiledMatchers: ((candidate: string) => boolean)[] = [];
    for (const rawPattern of patterns) {
        const normalizedPattern = stripLeadingAnchor(rawPattern);
        compiledMatchers.push(picomatch(normalizedPattern, { dot: true }));
    }
    return (relativeDirPath: string) => {
        for (const compiledMatcher of compiledMatchers) {
            if (compiledMatcher(relativeDirPath)) {
                return true;
            }
        }
        return false;
    };
}

// Recursively walks `projectDir` and returns absolute paths to every `.claude/claude-tools-runner.yaml` file found.
// Skips `node_modules/`, `.git/`, `.cache/`, and any directory whose name starts with `.` other than `.claude`.
// When `ignorePatterns` is non-empty, also skips any subdirectory whose project-relative POSIX path matches
// one of the supplied globs (compiled via `compileIgnoreMatcher`). The returned list is sorted lexicographically
// so the discovery order is deterministic across runs.
export async function scanConfigFiles(projectDir: string, ignorePatterns?: string[]): Promise<string[]> {
    const results: string[] = [];
    const isIgnored = compileIgnoreMatcher(ignorePatterns);
    await scanDirectoryRecursive(projectDir, projectDir, results, isIgnored);
    results.sort();
    return results;
}

// Reads the project root's `${projectDir}/.claude/claude-tools-runner.yaml` and returns its `ignore` glob
// list, or an empty array when the file is missing, has no `ignore` key, or fails to parse. The scanner
// uses this list to prune subtrees before any other config is loaded; the same file is loaded again later
// through the normal `FileLayer.create` path, where any parse error surfaces as a `hook_error` audit entry,
// so swallowing the error here just defers reporting rather than hiding it.
export async function loadProjectRootIgnorePatterns(projectDir: string): Promise<string[]> {
    const rootConfigPath = path.join(projectDir, ".claude", "claude-tools-runner.yaml");
    let rootConfig: Config | null;
    try {
        rootConfig = await loadConfigFile(rootConfigPath);
    }
    catch {
        return [];
    }
    if (rootConfig === null || rootConfig.ignore === undefined) {
        return [];
    }
    return rootConfig.ignore;
}

// Returns the absolute path to the home-level `claude-tools-runner.yaml`, or null if `$HOME` is unset.
// The home layer is loaded before any per-project layers so home-level triggers always run first.
export function homeConfigPath(): string | null {
    const homeDir = process.env["HOME"];
    if (!homeDir) {
        return null;
    }
    return path.join(homeDir, ".claude", "claude-tools-runner.yaml");
}

// Static display path for the home-level `claude-tools-runner.yaml` used in log output and as the `sourceFile`
// field of the home `FileLayer`. The literal `~` is preserved (not expanded) so log lines remain anchored
// at a stable, user-recognisable string irrespective of the actual `$HOME` value.
export const HOME_DISPLAY_PATH: string = "~/.claude/claude-tools-runner.yaml";

// Walks one directory, recording any `.claude/claude-tools-runner.yaml` it contains and recursing into eligible subdirectories.
// `results` is mutated in place. Subdirectory names are filtered by `shouldRecurseInto`; the project-relative
// POSIX path of each candidate is then checked against `isIgnored` so the project root config's `ignore`
// globs can prune subtrees (e.g. `e2e/**/tmp`).
export async function scanDirectoryRecursive(projectDir: string, currentDir: string, results: string[], isIgnored: CompiledIgnoreMatcher): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const dirName = entry.name;
        if (dirName === ".claude") {
            const candidatePath = path.join(currentDir, ".claude", "claude-tools-runner.yaml");
            try {
                const candidateStat = await fs.stat(candidatePath);
                if (candidateStat.isFile()) {
                    results.push(candidatePath);
                }
            }
            catch (caughtErr) {
                const errnoErr = caughtErr as NodeJS.ErrnoException;
                if (errnoErr.code !== "ENOENT") {
                    throw caughtErr;
                }
            }
            continue;
        }
        if (!shouldRecurseInto(dirName)) {
            continue;
        }
        const childAbsoluteDir = path.join(currentDir, dirName);
        const childRelativeDir = path.relative(projectDir, childAbsoluteDir).split(path.sep).join("/");
        if (childRelativeDir.length > 0 && isIgnored(childRelativeDir)) {
            continue;
        }
        await scanDirectoryRecursive(projectDir, childAbsoluteDir, results, isIgnored);
    }
}

// True when a subdirectory name is eligible for recursive descent during `scanConfigFiles`.
// Excludes the always-skipped names plus any dot-prefixed directory (other than `.claude`, which the caller handles separately).
export function shouldRecurseInto(dirName: string): boolean {
    if (ALWAYS_SKIPPED_DIR_NAMES.has(dirName)) {
        return false;
    }
    if (dirName.startsWith(".")) {
        return false;
    }
    return true;
}

// Looks up the YAML seq node corresponding to the top-level `triggers` key and returns the 1-based line number
// of each trigger item. When a trigger has no resolvable position (synthetic node, missing range info), its line is `1`.
// `expectedCount` matches the JS-side trigger count so the returned array always lines up positionally with the
// triggers used for validation.
export function computeTriggerSourceLines(rootMap: YAMLMap, sourceText: string, expectedCount: number): number[] {
    const lineNumbers: number[] = [];
    let triggersValueNode: any = null;
    for (const pair of rootMap.items) {
        const pairKey: any = pair.key;
        if (isScalar(pairKey) && pairKey.value === "triggers") {
            triggersValueNode = pair.value;
            break;
        }
    }

    if (!isSeq(triggersValueNode)) {
        for (let triggerIndex = 0; triggerIndex < expectedCount; triggerIndex++) {
            lineNumbers.push(1);
        }
        return lineNumbers;
    }

    const triggersSeq = triggersValueNode;
    for (let triggerIndex = 0; triggerIndex < expectedCount; triggerIndex++) {
        const itemNode = triggersSeq.items[triggerIndex];
        const lineNumber = lineNumberOfNode(itemNode, sourceText);
        lineNumbers.push(lineNumber);
    }
    return lineNumbers;
}

// Resolves the 1-based line number for a single YAML node by looking up its `range[0]` byte offset in `sourceText`.
// Returns `1` when the node is missing, has no `range`, or `range[0]` is not a number.
export function lineNumberOfNode(node: any, sourceText: string): number {
    if (!node || typeof node !== "object") {
        return 1;
    }
    const rangeField: any = node.range;
    if (!Array.isArray(rangeField)) {
        return 1;
    }
    const rangeStart: any = rangeField[0];
    if (typeof rangeStart !== "number") {
        return 1;
    }
    return byteOffsetToLineNumber(sourceText, rangeStart);
}

// Converts a character offset into `sourceText` to a 1-based line number by counting `\n`s up to (but not including) the offset.
// `offset` is clamped to the source length so out-of-range offsets degrade to "last line" rather than throwing.
export function byteOffsetToLineNumber(sourceText: string, offset: number): number {
    let lineNumber = 1;
    const cap = Math.min(offset, sourceText.length);
    for (let charIndex = 0; charIndex < cap; charIndex++) {
        if (sourceText.charCodeAt(charIndex) === 10) {
            lineNumber++;
        }
    }
    return lineNumber;
}

// Parses one raw trigger entry from the YAML-decoded JS data into a typed `Trigger` with defaults filled.
// `commandSourceLines` carries the 1-based YAML line of each command mapping under this trigger; when an
// entry is missing the parser falls back to the trigger's own `sourceLine` so audit lines still point inside
// the right block. Throws a descriptive validation error when the trigger is structurally invalid.
export function parseTrigger(rawTrigger: any, triggerIndex: number, sourceLine: number, commandSourceLines: number[]): Trigger {
    if (!rawTrigger || typeof rawTrigger !== "object" || Array.isArray(rawTrigger)) {
        throw new Error(`trigger at index ${triggerIndex} must be a YAML mapping`);
    }

    let parsedPaths: string[] | undefined = undefined;
    if (rawTrigger.paths) {
        if (!Array.isArray(rawTrigger.paths)) {
            throw new Error(`trigger at index ${triggerIndex}: paths must be an array of strings`);
        }
        for (let pathIndex = 0; pathIndex < rawTrigger.paths.length; pathIndex++) {
            const rawPath = rawTrigger.paths[pathIndex];
            if (typeof rawPath !== "string") {
                throw new Error(`trigger at index ${triggerIndex}: paths[${pathIndex}] must be a string`);
            }
        }
        const pathsArray: string[] = rawTrigger.paths;
        parsedPaths = pathsArray;
    }

    let parsedGroupBy: string | undefined = undefined;
    if (rawTrigger.group_by !== undefined && rawTrigger.group_by !== null) {
        if (typeof rawTrigger.group_by !== "string" || rawTrigger.group_by.length === 0) {
            throw new Error(`trigger at index ${triggerIndex}: group_by must be a non-empty string`);
        }
        const groupByValue: string = rawTrigger.group_by;
        parsedGroupBy = groupByValue;
    }

    if (!rawTrigger.commands) {
        throw new Error(`trigger at index ${triggerIndex}: commands is required`);
    }
    if (!Array.isArray(rawTrigger.commands)) {
        throw new Error(`trigger at index ${triggerIndex}: commands must be a YAML sequence (array)`);
    }
    if (rawTrigger.commands.length === 0) {
        throw new Error(`trigger at index ${triggerIndex}: commands must contain at least one entry`);
    }

    const parsedCommands: CommandConfig[] = [];
    for (let commandIndex = 0; commandIndex < rawTrigger.commands.length; commandIndex++) {
        const rawCommand = rawTrigger.commands[commandIndex];
        const commandLine = commandSourceLines[commandIndex] ?? sourceLine;
        const parsedCommand = parseCommand(rawCommand, triggerIndex, commandIndex, commandLine);
        parsedCommands.push(parsedCommand);
    }

    const result: Trigger = {
        commands: parsedCommands,
        sourceLine,
    };
    if (parsedPaths !== undefined) {
        result.paths = parsedPaths;
    }
    if (parsedGroupBy !== undefined) {
        result.group_by = parsedGroupBy;
    }
    return result;
}

// Parses one raw command entry within a trigger into a `CommandConfig` with defaults applied.
// `cooldown` and `timeout` are converted from YAML duration strings (or omitted) into integer seconds via `parseDuration`.
// `sourceLine` is the 1-based YAML line of the command's mapping, used by audit-log entries to point at the
// command's `run:` line. Throws a descriptive validation error when the command is structurally invalid.
export function parseCommand(rawCommand: any, triggerIndex: number, commandIndex: number, sourceLine: number): CommandConfig {
    if (!rawCommand || typeof rawCommand !== "object" || Array.isArray(rawCommand)) {
        throw new Error(`trigger ${triggerIndex} command ${commandIndex} must be a YAML mapping`);
    }

    if (typeof rawCommand.run !== "string" || rawCommand.run.length === 0) {
        throw new Error(`trigger ${triggerIndex} command ${commandIndex}: run must be a non-empty string`);
    }
    const runValue: string = rawCommand.run;

    let parsedCwd: string;
    if (rawCommand.cwd === undefined) {
        parsedCwd = DEFAULT_CWD_TEMPLATE;
    }
    else {
        if (typeof rawCommand.cwd !== "string") {
            throw new Error(`trigger ${triggerIndex} command ${commandIndex}: cwd must be a string`);
        }
        parsedCwd = rawCommand.cwd;
    }

    let parsedCooldown: number;
    if (rawCommand.cooldown === undefined) {
        parsedCooldown = DEFAULT_COOLDOWN_SECONDS;
    }
    else {
        parsedCooldown = parseDuration(rawCommand.cooldown, "cooldown");
    }

    let parsedTimeout: number;
    if (rawCommand.timeout === undefined) {
        parsedTimeout = DEFAULT_TIMEOUT_SECONDS;
    }
    else {
        parsedTimeout = parseDuration(rawCommand.timeout, "timeout");
    }

    return {
        run: runValue,
        cwd: parsedCwd,
        cooldown: parsedCooldown,
        timeout: parsedTimeout,
        sourceLine,
    };
}
