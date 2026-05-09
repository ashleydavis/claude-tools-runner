import * as crypto from "node:crypto";
import * as path from "node:path";
import { ChangedFile, CommandConfig, CompiledCommand, Trigger } from "./types";
import {
    TemplateContext,
    expandPerFile,
    expandStatic,
    findGroupDir,
    hasFileDirVariable,
    hasGroupDirVariable,
    hasPerFileVariable,
} from "./template";
import { matchFiles } from "./matcher";

// Default working-directory template applied to a command emission whose `CommandConfig.cwd` is unset.
// Mirrors the YAML-side default applied by `parseCommand` in `config.ts` so synthetic `Trigger[]` fixtures
// (used by `StaticLayer` in tests) get the same `expandedCwd` as production triggers loaded from YAML.
const DEFAULT_CWD_TEMPLATE: string = "${{project}}";

// One matched file paired with the absolute group directory it belongs to (or `null` when the parent
// trigger has no `group_by`). Built once per trigger so per-file/per-dir/per-group emissions can dispatch
// off a single uniform structure.
export interface IMatchedFileWithGroup {
    // The matched changed file.
    file: ChangedFile;
    // Absolute group directory for this file, or `null` when the trigger does not declare `group_by`.
    // Already joined with `scopeDir`, so `${{group_dir}}` substitutions can use it verbatim.
    absGroupDir: string | null;
}

// Computes the SHA-256 hex digest of `expandedRun + 0x00 + expandedCwd`. Centralised so every emission
// path produces the same key shape and the lookup in the state file remains content-addressed.
export function computeCommandKey(expandedRun: string, expandedCwd: string): string {
    return crypto.createHash("sha256").update(`${expandedRun}\0${expandedCwd}`).digest("hex");
}

// Constructs a `CompiledCommand` from a fully-expanded `(run, cwd)` pair plus the files that produced it.
// Encapsulates the `commandKey` derivation so callers in the per-file/per-dir/per-group/per-trigger paths
// only have to pass the inputs in their natural shape.
export function buildCompiledCommand(sourceFile: string, sourceLine: number, triggerIndexInFile: number, commandIndex: number, command: CommandConfig, expandedRun: string, expandedCwd: string, matchedFiles: ChangedFile[]): CompiledCommand {
    return {
        sourceFile,
        sourceLine,
        triggerIndexInFile,
        commandIndex,
        command,
        expandedCwd,
        expandedRun,
        commandKey: computeCommandKey(expandedRun, expandedCwd),
        matchedFiles,
    };
}

// Resolves each matched file's absolute group directory using `findGroupDir`. Files whose path does not
// match the trigger's `group_by` glob are dropped with a stderr warning (per the step 10 specification).
// Returns the resulting list, which may be empty if every file was dropped.
export function resolveGroupDirsForFiles(matchedFiles: ChangedFile[], trigger: Trigger, sourceFile: string, triggerIndex: number, scopeDir: string): IMatchedFileWithGroup[] {
    const result: IMatchedFileWithGroup[] = [];
    for (const file of matchedFiles) {
        if (trigger.group_by === undefined) {
            result.push({ file, absGroupDir: null });
            continue;
        }
        const relativeGroupDir = findGroupDir(file.path, trigger.group_by);
        if (relativeGroupDir === null) {
            process.stderr.write(`[tools-runner] ${sourceFile}:trigger ${triggerIndex}: file ${file.path} did not match group_by pattern ${trigger.group_by}, skipping\n`);
            continue;
        }
        result.push({ file, absGroupDir: path.join(scopeDir, relativeGroupDir) });
    }
    return result;
}

// Validates that any command using `${{group_dir}}` belongs to a trigger that declares `group_by`. Throws
// at prepare time when the rule is violated; the error surfaces through the Stop hook's top-level handler.
export function validateGroupDirUsage(runTemplate: string, cwdTemplate: string, trigger: Trigger, sourceFile: string, triggerIndex: number, commandIndex: number): void {
    if (trigger.group_by !== undefined) {
        return;
    }
    if (!hasGroupDirVariable(runTemplate) && !hasGroupDirVariable(cwdTemplate)) {
        return;
    }
    throw new Error(`${sourceFile}:trigger ${triggerIndex} command ${commandIndex}: \${{group_dir}} used but trigger has no group_by`);
}

// Emits one `CompiledCommand` per matched file. Each emission's `matchedFiles` is a single-element array.
// Used when the command's `run` or `cwd` template references any of the four per-file variables
// (`file_path`, `file_name`, `file_basename`, `file_ext`).
export function emitPerFile(matchedFilesWithGroup: IMatchedFileWithGroup[], sourceFile: string, trigger: Trigger, triggerIndex: number, commandIndex: number, command: CommandConfig, runTemplate: string, cwdTemplate: string, ctx: TemplateContext, output: CompiledCommand[]): void {
    for (const entry of matchedFilesWithGroup) {
        const expandedRun = expandPerFile(runTemplate, ctx, entry.file, entry.absGroupDir, { forShell: true });
        const expandedCwd = expandPerFile(cwdTemplate, ctx, entry.file, entry.absGroupDir, { forShell: false });
        output.push(buildCompiledCommand(sourceFile, trigger.sourceLine, triggerIndex, commandIndex, command, expandedRun, expandedCwd, [entry.file]));
    }
}

// Emits one `CompiledCommand` per unique `path.dirname(file.absPath)`. Files sharing a directory are
// grouped into the same emission's `matchedFiles`. Used when only `${{file_dir}}` appears (no per-file
// variables and no `${{group_dir}}`).
export function emitPerDirectory(matchedFilesWithGroup: IMatchedFileWithGroup[], sourceFile: string, trigger: Trigger, triggerIndex: number, commandIndex: number, command: CommandConfig, runTemplate: string, cwdTemplate: string, ctx: TemplateContext, output: CompiledCommand[]): void {
    const directoryBuckets = new Map<string, IMatchedFileWithGroup[]>();
    for (const entry of matchedFilesWithGroup) {
        const directoryKey = path.dirname(entry.file.absPath);
        const existingBucket = directoryBuckets.get(directoryKey);
        if (existingBucket === undefined) {
            directoryBuckets.set(directoryKey, [entry]);
        }
        else {
            existingBucket.push(entry);
        }
    }
    for (const bucket of directoryBuckets.values()) {
        const representativeEntry = bucket[0];
        const expandedRun = expandPerFile(runTemplate, ctx, representativeEntry.file, representativeEntry.absGroupDir, { forShell: true });
        const expandedCwd = expandPerFile(cwdTemplate, ctx, representativeEntry.file, representativeEntry.absGroupDir, { forShell: false });
        const bucketFiles = bucket.map(entry => entry.file);
        output.push(buildCompiledCommand(sourceFile, trigger.sourceLine, triggerIndex, commandIndex, command, expandedRun, expandedCwd, bucketFiles));
    }
}

// Emits one `CompiledCommand` per unique absolute group directory. Files in the same group share an
// emission. Used when only `${{group_dir}}` appears in the command (no per-file or `${{file_dir}}`).
export function emitPerGroup(matchedFilesWithGroup: IMatchedFileWithGroup[], sourceFile: string, trigger: Trigger, triggerIndex: number, commandIndex: number, command: CommandConfig, runTemplate: string, cwdTemplate: string, ctx: TemplateContext, output: CompiledCommand[]): void {
    const groupBuckets = new Map<string, IMatchedFileWithGroup[]>();
    for (const entry of matchedFilesWithGroup) {
        if (entry.absGroupDir === null) {
            continue;
        }
        const existingBucket = groupBuckets.get(entry.absGroupDir);
        if (existingBucket === undefined) {
            groupBuckets.set(entry.absGroupDir, [entry]);
        }
        else {
            existingBucket.push(entry);
        }
    }
    for (const bucket of groupBuckets.values()) {
        const representativeEntry = bucket[0];
        const expandedRun = expandPerFile(runTemplate, ctx, representativeEntry.file, representativeEntry.absGroupDir, { forShell: true });
        const expandedCwd = expandPerFile(cwdTemplate, ctx, representativeEntry.file, representativeEntry.absGroupDir, { forShell: false });
        const bucketFiles = bucket.map(entry => entry.file);
        output.push(buildCompiledCommand(sourceFile, trigger.sourceLine, triggerIndex, commandIndex, command, expandedRun, expandedCwd, bucketFiles));
    }
}

// Emits a single `CompiledCommand` for the trigger with all matched files attached. Uses `expandStatic`
// because the command references no per-file/per-dir/per-group variables; only `${{project}}` is in scope.
export function emitPerTrigger(matchedFilesWithGroup: IMatchedFileWithGroup[], sourceFile: string, trigger: Trigger, triggerIndex: number, commandIndex: number, command: CommandConfig, runTemplate: string, cwdTemplate: string, ctx: TemplateContext, output: CompiledCommand[]): void {
    const expandedRun = expandStatic(runTemplate, ctx);
    const expandedCwd = expandStatic(cwdTemplate, ctx);
    const allFiles = matchedFilesWithGroup.map(entry => entry.file);
    output.push(buildCompiledCommand(sourceFile, trigger.sourceLine, triggerIndex, commandIndex, command, expandedRun, expandedCwd, allFiles));
}

// Compiles one layer's triggers into a flat list of `CompiledCommand` records. The function is pure: each
// per-layer caller (`StaticLayer.compileCommands` / `FileLayer.compileCommands`) supplies its privately
// held trigger list along with the layer's `sourceFile`, `ctx`, and `scopeDir`. Returns `[]` when no files
// have changed. For each trigger, files are filtered through `matchFiles` against `trigger.paths`,
// resolved through `group_by` (with mismatched files dropped and warned), and then fanned out per the
// unified grouping rule (per-file / per-dir / per-group / per-trigger) based on which template variables
// appear in the command's `run` or `cwd`.
export function compileCommands(triggers: Trigger[], sourceFile: string, ctx: TemplateContext, scopeDir: string, changed: ChangedFile[]): CompiledCommand[] {
    if (changed.length === 0) {
        return [];
    }
    const compiled: CompiledCommand[] = [];
    for (let triggerIndex = 0; triggerIndex < triggers.length; triggerIndex++) {
        const trigger = triggers[triggerIndex];
        const filesAfterPaths = matchFiles(changed, trigger.paths);
        if (filesAfterPaths.length === 0) {
            continue;
        }
        const filesWithGroup = resolveGroupDirsForFiles(filesAfterPaths, trigger, sourceFile, triggerIndex, scopeDir);
        if (filesWithGroup.length === 0) {
            continue;
        }
        for (let commandIndex = 0; commandIndex < trigger.commands.length; commandIndex++) {
            const command = trigger.commands[commandIndex];
            const runTemplate = command.run;
            const cwdTemplate = command.cwd ?? DEFAULT_CWD_TEMPLATE;
            validateGroupDirUsage(runTemplate, cwdTemplate, trigger, sourceFile, triggerIndex, commandIndex);
            const usesPerFile = hasPerFileVariable(runTemplate) || hasPerFileVariable(cwdTemplate);
            const usesFileDir = hasFileDirVariable(runTemplate) || hasFileDirVariable(cwdTemplate);
            const usesGroupDir = hasGroupDirVariable(runTemplate) || hasGroupDirVariable(cwdTemplate);
            if (usesPerFile) {
                emitPerFile(filesWithGroup, sourceFile, trigger, triggerIndex, commandIndex, command, runTemplate, cwdTemplate, ctx, compiled);
            }
            else if (usesFileDir) {
                emitPerDirectory(filesWithGroup, sourceFile, trigger, triggerIndex, commandIndex, command, runTemplate, cwdTemplate, ctx, compiled);
            }
            else if (usesGroupDir) {
                emitPerGroup(filesWithGroup, sourceFile, trigger, triggerIndex, commandIndex, command, runTemplate, cwdTemplate, ctx, compiled);
            }
            else {
                emitPerTrigger(filesWithGroup, sourceFile, trigger, triggerIndex, commandIndex, command, runTemplate, cwdTemplate, ctx, compiled);
            }
        }
    }
    return compiled;
}
