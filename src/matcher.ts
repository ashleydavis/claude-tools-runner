import picomatch from "picomatch";
import { ChangedFile } from "./types";

// Strips a single leading "./" or "/" from a glob pattern so users can write
// "/src/**/*.ts" or "./src/**/*.ts" interchangeably with "src/**/*.ts" and have the
// pattern anchor to the scope root. Input file paths are never absolute, so without this
// strip a pattern starting with "/" would never match. Only one leading anchor is removed:
// "//foo" becomes "/foo" and ".//foo" becomes "/foo". Exported so the prefix-handling rule
// can be unit-tested directly without going through `matchFiles`.
export function stripLeadingAnchor(pattern: string): string {
    if (pattern.startsWith("./")) {
        return pattern.substring(2);
    }
    if (pattern.startsWith("/")) {
        return pattern.substring(1);
    }
    return pattern;
}

// Matcher function compiled once per pattern. Receives a scope-relative POSIX path and
// returns true when the path matches the pattern under picomatch's `{ dot: true }` defaults.
type CompiledPatternMatcher = (candidatePath: string) => boolean;

// Filters `files` down to those matching the trigger's `paths` patterns. Patterns are
// scopeDir-relative POSIX globs interpreted by picomatch with `dot: true` and case-sensitive
// matching. A leading "!" denotes a negation: a file is included only when at least one
// positive pattern matches it AND no negation pattern matches it. An empty or undefined
// `paths` (and a `paths` consisting only of negations) matches no files. No template
// variable expansion is performed: `${{...}}` placeholders would be circular here.
export function matchFiles(files: ChangedFile[], paths: string[] | undefined): ChangedFile[] {
    if (paths === undefined || paths.length === 0) {
        return [];
    }

    const positiveMatchers: CompiledPatternMatcher[] = [];
    const negativeMatchers: CompiledPatternMatcher[] = [];

    for (const rawPattern of paths) {
        const isNegation = rawPattern.startsWith("!");
        const patternBody = isNegation ? rawPattern.substring(1) : rawPattern;
        const normalizedPattern = stripLeadingAnchor(patternBody);
        const compiledMatcher = picomatch(normalizedPattern, { dot: true });
        if (isNegation) {
            negativeMatchers.push(compiledMatcher);
        }
        else {
            positiveMatchers.push(compiledMatcher);
        }
    }

    if (positiveMatchers.length === 0) {
        return [];
    }

    const matchedFiles: ChangedFile[] = [];
    for (const candidateFile of files) {
        let hasPositiveMatch = false;
        for (const positiveMatcher of positiveMatchers) {
            if (positiveMatcher(candidateFile.path)) {
                hasPositiveMatch = true;
                break;
            }
        }
        if (!hasPositiveMatch) {
            continue;
        }
        let isExcludedByNegation = false;
        for (const negativeMatcher of negativeMatchers) {
            if (negativeMatcher(candidateFile.path)) {
                isExcludedByNegation = true;
                break;
            }
        }
        if (isExcludedByNegation) {
            continue;
        }
        matchedFiles.push(candidateFile);
    }
    return matchedFiles;
}
