import * as path from "node:path";
import picomatch from "picomatch";
import { ChangedFile } from "./types";

// Project-wide template-expansion context. The compile module passes one of these per layer so that
// `${{project}}` substitution and other layer-scoped expansion logic can reference the layer's project root.
// Per-file variables are not part of this context: they come from the `ChangedFile` argument supplied to
// per-file expanders alongside the context.
export interface TemplateContext {
    // Absolute path used as the value of `${{project}}` for any trigger whose layer holds this context.
    // Equals the `scopeDir` of the config layer that owns the trigger.
    projectDir: string;
}

// Recogniser for any of the seven supported template variables. The capture group lets call sites learn
// which variable matched so they can dispatch to the appropriate substitution. Mirrors the syntax described
// in step 9 of the plan: `${{name}}` with two opening and two closing braces (GitHub-Actions style).
const TEMPLATE_VARIABLE_REGEX: RegExp = /\$\{\{(project|file_path|file_name|file_basename|file_ext|file_dir|group_dir)\}\}/g;

// Recogniser for the four per-file variables that depend on a matched `ChangedFile`. Used by
// `hasPerFileVariable` to tell `compileCommands` whether a trigger needs to fan a command out per file.
// `${{file_dir}}` is intentionally excluded because step 9 specifies it is not classified as per-file by
// `hasPerFileVariable` (only the four name/path-derived variables drive per-file fanning).
const PER_FILE_VARIABLE_REGEX: RegExp = /\$\{\{(file_path|file_name|file_basename|file_ext)\}\}/;

// Recogniser for `${{group_dir}}`. Used by `hasGroupDirVariable` to validate that any trigger using the
// variable also defines `group_by`, and to choose the per-group fan-out tier in `compileCommands`.
const GROUP_DIR_VARIABLE_REGEX: RegExp = /\$\{\{group_dir\}\}/;

// Wraps `value` in single quotes and escapes embedded single quotes with the standard `'\''` sequence so
// the result is safe to embed inside a `sh -c` command line. Always produces a quoted result, even for the
// empty string (which becomes `''`). Used only by `expandPerFile` when `forShell === true`.
export function shellQuote(value: string): string {
    const escapedValue = value.replace(/'/g, "'\\''");
    return "'" + escapedValue + "'";
}

// Replaces `${{project}}` with `ctx.projectDir` and throws if any other recognised variable appears. This
// helper is for project-wide static expansion only: every other variable depends on a matched file. No
// shell quoting is applied because `${{project}}` is a configuration value rather than a user-controlled
// file path.
export function expandStatic(input: string, ctx: TemplateContext): string {
    return input.replace(TEMPLATE_VARIABLE_REGEX, (matchedText, variableName) => {
        if (variableName === "project") {
            return ctx.projectDir;
        }
        throw new Error("expandStatic: variable ${{" + variableName + "}} requires a per-file context");
    });
}

// Options bag accepted by `expandPerFile`. `forShell` selects whether per-file substitutions should be
// shell-quoted (for embedding inside a `sh -c` command line) or passed through verbatim (for use as a
// literal `cwd` path on `child_process.spawn`).
export interface ExpandPerFileOptions {
    // True when the result is going into a `sh -c` command line. Per-file path substitutions are wrapped
    // in `shellQuote` so a path containing shell metacharacters cannot inject. False when the result is a
    // literal `cwd` argument to `child_process.spawn` (which does not invoke a shell).
    forShell: boolean;
}

// Replaces every supported template variable with values derived from `ctx`, `file`, and `groupDir`. When
// `opts.forShell === true` the per-file substitutions (`${{file_path}}`, `${{file_name}}`,
// `${{file_basename}}`, `${{file_ext}}`, `${{file_dir}}`, `${{group_dir}}`) are passed through `shellQuote`
// so they cannot inject shell metacharacters. `${{project}}` is never auto-quoted because it is a
// configuration value rather than a user-controlled file path. Throws if `${{group_dir}}` appears but
// `groupDir === null`.
export function expandPerFile(input: string, ctx: TemplateContext, file: ChangedFile, groupDir: string | null, opts: ExpandPerFileOptions): string {
    const fileBasename = path.basename(file.absPath, path.extname(file.absPath));
    const fileExt = path.extname(file.absPath);
    const fileName = path.basename(file.absPath);
    const fileDir = path.dirname(file.absPath);

    return input.replace(TEMPLATE_VARIABLE_REGEX, (matchedText, variableName) => {
        if (variableName === "project") {
            return ctx.projectDir;
        }
        if (variableName === "group_dir") {
            if (groupDir === null) {
                throw new Error("expandPerFile: ${{group_dir}} used but no group_dir is available (trigger has no group_by)");
            }
            return opts.forShell ? shellQuote(groupDir) : groupDir;
        }
        let substitutedValue: string;
        if (variableName === "file_path") {
            substitutedValue = file.absPath;
        }
        else if (variableName === "file_name") {
            substitutedValue = fileName;
        }
        else if (variableName === "file_basename") {
            substitutedValue = fileBasename;
        }
        else if (variableName === "file_ext") {
            substitutedValue = fileExt;
        }
        else if (variableName === "file_dir") {
            substitutedValue = fileDir;
        }
        else {
            throw new Error("expandPerFile: unrecognised variable ${{" + variableName + "}}");
        }
        return opts.forShell ? shellQuote(substitutedValue) : substitutedValue;
    });
}

// Computes the group prefix for `filePath` against a `group_by` glob. Strips a single trailing `/` from
// `groupBy` so users can write either `packages/*` or `packages/*/` interchangeably. Splits `filePath` on
// `/`, builds successively-longer segment-prefixes (1 segment, 2 segments, ..., length-1 segments), and
// tests each prefix against `picomatch(strippedGroupBy, { dot: true })`. Returns the first prefix that
// matches, or `null` if none does. Used by `compileCommands` to compute `${{group_dir}}` for a matched
// file.
export function findGroupDir(filePath: string, groupBy: string): string | null {
    let strippedGroupBy = groupBy;
    if (strippedGroupBy.endsWith("/")) {
        strippedGroupBy = strippedGroupBy.substring(0, strippedGroupBy.length - 1);
    }
    const compiledMatcher = picomatch(strippedGroupBy, { dot: true });
    const segments = filePath.split("/");
    for (let segmentCount = 1; segmentCount < segments.length; segmentCount++) {
        const candidatePrefix = segments.slice(0, segmentCount).join("/");
        if (compiledMatcher(candidatePrefix)) {
            return candidatePrefix;
        }
    }
    return null;
}

// Returns true if `${{file_path}}`, `${{file_name}}`, `${{file_basename}}`, or `${{file_ext}}` appears in
// `input`. Used by `compileCommands` to decide whether to fan a command out per matched file. Note that
// `${{file_dir}}`, `${{group_dir}}`, and `${{project}}` are intentionally excluded: they alone do not
// require a per-file fan-out (per the step 9 specification).
export function hasPerFileVariable(input: string): boolean {
    return PER_FILE_VARIABLE_REGEX.test(input);
}

// Returns true if `${{group_dir}}` appears in `input`. Used by `compileCommands` to validate that a
// trigger using `${{group_dir}}` also has `group_by` set, and to choose the per-group grouping tier.
export function hasGroupDirVariable(input: string): boolean {
    return GROUP_DIR_VARIABLE_REGEX.test(input);
}
