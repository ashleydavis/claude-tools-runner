// Regex matching the accepted duration format. Captures the digit run as group 1 and the optional unit suffix as group 2.
// Format: "<digits>" (treated as seconds) or "<digits><unit>" with unit one of s, m, h.
// Intentionally rejects leading/trailing whitespace, decimals, negatives, multi-letter units (e.g. "ms"), and any other shape.
const DURATION_REGEX: RegExp = /^(\d+)(s|m|h)?$/;

// Multipliers (in seconds) for each accepted unit suffix. Unit-less inputs default to seconds.
const UNIT_TO_SECONDS: Record<string, number> = {
    "s": 1,
    "m": 60,
    "h": 3600,
};

// Parses a duration string from YAML configuration into integer seconds.
//
// Accepted forms: "30" (= 30s), "30s", "5m", "1h", "0", "0s".
// Rejects: bare numbers (must be a YAML string), decimals, negatives, unsupported units (e.g. "500ms", "7d"),
// the empty string, leading/trailing whitespace, and any non-string type. Validation errors include `fieldName`
// so two failures from different fields (e.g. cooldown vs timeout) are distinguishable in error output.
export function parseDuration(input: any, fieldName: string): number {
    if (typeof input !== "string") {
        const actualType: string = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
        throw new Error(`${fieldName} must be a duration string like "30s", "5m", "1h" (got ${actualType})`);
    }

    const match: RegExpMatchArray | null = input.match(DURATION_REGEX);
    if (match === null) {
        throw new Error(`${fieldName} is not a valid duration: ${JSON.stringify(input)} (expected "<digits>" or "<digits>s|m|h")`);
    }

    const digitsPart: string = match[1];
    const unitPart: string = match[2] === undefined ? "s" : match[2];
    const multiplier: number = UNIT_TO_SECONDS[unitPart];
    const digitsValue: number = parseInt(digitsPart, 10);
    return digitsValue * multiplier;
}
