// Top-level shape of a parsed `tools-runner.yaml` config file. One Config exists per loaded YAML layer (home or per-directory).
export interface Config {
    // The triggers declared in this YAML file. May be empty (a layer with no triggers is valid: it simply contributes nothing).
    triggers: Trigger[];
    // Optional glob list of directories (project-relative POSIX paths) the recursive config scanner should not descend into. Matched against each candidate subdirectory's project-relative path during `scanConfigFiles`. Only the project-root config's `ignore` list is consulted; nested configs declare their own subtrees but cannot exclude others'.
    ignore?: string[];
}

// A single trigger node from a YAML config. Pairs a set of glob patterns with the commands to run when matching files change.
export interface Trigger {
    // Glob patterns (repo-relative, POSIX) the trigger watches. Optional: a missing or empty list means the trigger never fires.
    paths?: string[];
    // Optional grouping glob. When set, `${{group_dir}}` is available in each command's `run`/`cwd` and resolves to the group root for each matched file.
    group_by?: string;
    // The commands this trigger emits when its `paths` match changed files. Each command produces one or more `CompiledCommand` records during compilation.
    commands: CommandConfig[];
    // 1-based line number of this trigger node inside its source YAML file. Set by `loadConfigFile` and propagated through `CompiledCommand` so log entries can reference the trigger source location.
    sourceLine: number;
}

// One command declaration inside a trigger. Cooldown and timeout are stored in memory as integer seconds (parsed from YAML duration strings).
export interface CommandConfig {
    // Shell command line to execute via `sh -c`. May contain template variables (e.g. `${{project}}`, `${{file_path}}`).
    run: string;
    // Minimum number of seconds between successful runs of this command. Defaults to 60 (i.e. "1m") when not specified in YAML.
    cooldown?: number;
    // Working directory the command runs in. Defaults to "${{project}}" when not specified in YAML.
    cwd?: string;
    // Maximum runtime in seconds before the command is killed. Defaults to 300 (i.e. "5m") when not specified in YAML.
    timeout?: number;
    // 1-based line number of this command's mapping inside its source YAML file. Set by `loadConfigFile` and propagated through `CompiledCommand` so log entries can reference the exact `run:` location of the command.
    sourceLine: number;
}

// Persistent state stored on disk between hook invocations. Tracks file content hashes and per-command run metadata.
export interface State {
    // Cache of per-file hash entries keyed by absolute file path. Used to short-circuit re-hashing files whose mtime and size have not changed.
    fileHashes: Record<string, FileHashEntry>;
    // One entry per known command (keyed internally by `commandKey`). Records when each command was last successfully run and against which files.
    commandRuns: CommandRunEntry[];
}

// Cached hash of one file. The cache is invalidated when either `mtimeMs` or `size` changes.
export interface FileHashEntry {
    // `fs.Stats.mtimeMs` for the file (milliseconds since the Unix epoch as a JS number).
    mtimeMs: number;
    // Byte size of the file at the time of hashing.
    size: number;
    // SHA-256 hex digest of the file's bytes.
    hash: string;
}

// Persisted record of one command's last successful run. Keyed by `commandKey` (a hash of the expanded run + cwd) so it survives trigger reordering.
export interface CommandRunEntry {
    // SHA-256 hex digest of `expandedRun + "\0" + expandedCwd`. Identifies a command independent of YAML structure.
    commandKey: string;
    // The fully template-expanded `run` string at the time of the last successful run. Stored alongside `commandKey` for human inspection of the state YAML.
    expandedRun: string;
    // The fully template-expanded `cwd` string at the time of the last successful run. Stored for human inspection of the state YAML.
    expandedCwd: string;
    // Absolute path of the YAML config file whose trigger most recently produced this entry. Overwritten on each successful upsert.
    sourceFile: string;
    // 1-based line number of the trigger inside `sourceFile` that most recently produced this entry. Overwritten on each successful upsert.
    sourceLine: number;
    // ISO 8601 timestamp string of the last successful run (`new Date().toISOString()`). The `Date` object is never persisted directly.
    lastRunAt: string;
    // SHA-256 hex digest of the matched files' content at the time of the last successful run. Used by the gate to detect whether files have changed.
    lastFilesHash: string;
    // Sorted array of absolute path strings: the files this command was last triggered against. Used by `saveState` to prune unreferenced `fileHashes` entries.
    matchedFiles: string[];
    // True when this entry has been upserted since load and the per-command file should be rewritten on the next `saveState`. Never persisted to YAML; absent on entries returned by `loadState` (treated as not dirty).
    dirty?: boolean;
}

// JSON payload Claude Code sends to the Stop hook on stdin. All fields are optional so the hook can degrade gracefully on partial input.
export interface StopHookInput {
    // Identifier for the current Claude session.
    session_id?: string;
    // Path to the session's transcript file.
    transcript_path?: string;
    // True when the hook is itself the cause of the stop event; the hook must skip work in this case to avoid recursion.
    stop_hook_active?: boolean;
    // Working directory Claude was running in when the stop event fired.
    cwd?: string;
}

// One file reported as changed by `git status`. Carries both a scope-relative POSIX path (used for glob matching) and an absolute path (used for hashing and templates).
export interface ChangedFile {
    // POSIX path relative to the `scopeDir` of the config that discovered this file. Used as input to glob matching.
    path: string;
    // Absolute path on disk. Used as the cache key for `fileHashes` and as the value for `${{file_path}}` template substitutions.
    absPath: string;
}

// One prepared command emission ready for cooldown/hash gating and execution. Produced by `compile.ts` from a `Trigger` plus matched files.
export interface CompiledCommand {
    // Display path of the YAML layer this command came from (e.g. `"~/.claude/tools-runner.yaml"` or a per-directory path). Used in log lines only.
    sourceFile: string;
    // 1-based line number of the source trigger inside `sourceFile`. Copied from `Trigger.sourceLine`. Used to render editor-jump prefixes in log entries.
    sourceLine: number;
    // 0-based index of the trigger within its source YAML file. Used for stable log line identifiers.
    triggerIndexInFile: number;
    // 0-based index of the command within its trigger. Used for stable log line identifiers.
    commandIndex: number;
    // 1-based line number of this command's mapping inside its source YAML file. Copied from `CommandConfig.sourceLine`. Used to render editor-jump prefixes that point straight at the command's `run:` line.
    commandSourceLine: number;
    // The original command declaration this emission came from. Carries `cooldown`, `timeout`, and the unexpanded `run`/`cwd` strings.
    command: CommandConfig;
    // The fully template-expanded working directory for this emission.
    expandedCwd: string;
    // The fully template-expanded shell command line for this emission.
    expandedRun: string;
    // SHA-256 hex digest of `expandedRun + "\0" + expandedCwd`. Precomputed once during preparation; used as the state lookup key.
    commandKey: string;
    // The files this emission is responsible for. For per-file emissions this is one file; for per-dir/per-group emissions it is the subset sharing the dir/group.
    matchedFiles: ChangedFile[];
}
