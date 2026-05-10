import { promises as fs } from "fs";
import { join, dirname, isAbsolute } from "path";
import { spawn } from "child_process";
import { parse as parseYaml } from "yaml";

// Substring/regex check pair used throughout the assertion DSL. `substring` runs a literal substring
// search; `regex` is interpreted as a JavaScript regular expression (no flags).
interface IFileContentExpectation {
    // Path of the file to read (project-relative; supports ${HOME_DIR}/${PROJECT_DIR} prefixes).
    path: string;
    // Literal substring that must appear at least once in the file's contents.
    substring: string;
}

// Asserts a file has exactly the specified number of lines. Trailing-newline lines are NOT counted
// (matches `wc -l` semantics).
interface IFileLineCountExpectation {
    // Path of the file (project-relative; supports prefixes).
    path: string;
    // Required number of newline-terminated lines in the file.
    count: number;
}

// Reference to a previously captured mtime, for change/no-change assertions across steps.
interface IMtimeExpectation {
    // Path of the file (project-relative; supports prefixes).
    path: string;
    // Slot name set earlier via `pre.capture_mtime`.
    slot: string;
}

// Walks `search_dir` (recursively) for files matching `pattern` and verifies that the first matched
// file contains every entry in `substrings`. Used for audit-log + per-command-log assertions.
interface IFindFileContainsExpectation {
    // Directory to walk, project-relative. Walk is recursive.
    search_dir: string;
    // Glob-like pattern (matched against basename); only `*` is honoured. e.g. "*.log".
    pattern: string;
    // Optional minimum depth (counted as path-segments below `search_dir`). Used to skip top-level files
    // that share the same extension but are not the per-command log we want.
    min_depth: number;
    // Literal substrings that all must appear in the matched file. ${PROJECT_DIR}/${HOME_DIR} expanded.
    substrings: string[];
}

// Walks `search_dir` for files matching `pattern` and asserts the count equals `count`.
interface IFindCountExpectation {
    // Directory to walk, project-relative. Walk respects `max_depth`.
    search_dir: string;
    // Glob-like pattern (matched against basename); only `*` is honoured.
    pattern: string;
    // Maximum depth to descend (1 = direct children only).
    max_depth: number;
    // Required number of matches.
    count: number;
}

// Asserts that no basename matching `pattern` appears in BOTH `dir_a` and `dir_b`. Used to verify state
// isolation between layered configurations (scenario 24).
interface INoFilesOverlapExpectation {
    // First directory (project-relative).
    dir_a: string;
    // Second directory (project-relative).
    dir_b: string;
    // Glob-like pattern (matched against basename); only `*` is honoured.
    pattern: string;
}

// Pre-step actions applied to the on-disk sandbox before invoking the hook for that step.
interface IPreActions {
    // Number of seconds to sleep before invoking the hook (used to advance mtimes / cooldowns).
    sleep: number;
    // Map of project-relative path → file content. Overwrites existing files; auto-creates parent dirs.
    write: Record<string, string>;
    // Map of project-relative path → text to append.
    append: Record<string, string>;
    // List of project-relative paths to delete with `rm -f` semantics.
    delete: string[];
    // List of project-relative paths to delete with `rm -rf` semantics.
    delete_recursive: string[];
    // Map of slot name → file path. Records the file's mtime under `slot_name` for later mtime assertions.
    capture_mtime: Record<string, string>;
}

// Assertion bag applied after the hook invocation completes. Every populated field is checked; missing
// fields are skipped.
interface IExpectClause {
    // Required exit code from the hook process.
    exit: number;
    // Literal substrings that must all appear in stdout. ${PROJECT_DIR}/${HOME_DIR} expanded.
    stdout_substrings: string[];
    // Regex strings (JS syntax, no flags) that must all match against stdout.
    stdout_regex: string[];
    // Literal substrings that must NOT appear in stdout.
    stdout_not_substrings: string[];
    // Literal substrings that must all appear in stderr. ${PROJECT_DIR}/${HOME_DIR} expanded.
    stderr_substrings: string[];
    // Regex strings that must all match against stderr.
    stderr_regex: string[];
    // Paths that must exist as files.
    file_exists: string[];
    // Paths that must NOT exist as files.
    file_not_exists: string[];
    // Paths that must exist as directories.
    dir_exists: string[];
    // Paths that must NOT exist as directories.
    dir_not_exists: string[];
    // Per-file content checks (literal substring per entry).
    file_contains: IFileContentExpectation[];
    // Per-file line-count checks (`wc -l` semantics).
    file_line_count: IFileLineCountExpectation[];
    // Files whose mtime must be strictly greater than the captured slot.
    mtime_advanced: IMtimeExpectation[];
    // Files whose mtime must equal the captured slot.
    mtime_unchanged: IMtimeExpectation[];
    // Find-and-grep assertions (see IFindFileContainsExpectation).
    find_file_contains: IFindFileContainsExpectation[];
    // Find-and-count assertions (see IFindCountExpectation).
    find_count: IFindCountExpectation[];
    // Cross-directory basename-overlap forbid checks.
    no_files_overlap: INoFilesOverlapExpectation[];
    // When true, runs the scenario-7 hashes/runs YAML structural validation.
    state_file_shape: boolean;
}

// One step in the test: optional pre-mutations + a hook invocation + a bag of assertions.
interface IStep {
    // Human-readable label used when reporting per-step PASS/FAIL.
    description: string;
    // Optional pre-step mutations + mtime captures applied to the sandbox before the hook runs.
    pre: IPreActions;
    // Required assertion clause applied after the hook returns.
    expect: IExpectClause;
}

// Initial sandbox layout, applied once before the first step. No mtime captures or sleeps here -
// those belong on a step's `pre`.
interface ISetup {
    // Directories to `git init -q` (project-relative). e.g. ["."], ["repoA", "repoB"].
    git_init: string[];
    // Files to write into the project. Map of project-relative path → contents. Parent dirs created.
    files: Record<string, string>;
    // Files to write into the home dir. Map of home-relative path → contents.
    home_files: Record<string, string>;
}

// One full test case parsed from test.yaml.
interface ITestCase {
    // Description string used at the top-level reporting line.
    description: string;
    // Initial sandbox layout (filesystem + git inits) before any step runs.
    setup: ISetup;
    // Ordered list of steps; each invokes the hook once.
    steps: IStep[];
}

// Result of running the bundled hook in one step.
interface IHookResult {
    // Process exit code. 0 on success, non-zero on failure.
    exitCode: number;
    // Captured stdout from the hook (UTF-8 decoded).
    stdout: string;
    // Captured stderr from the hook (UTF-8 decoded).
    stderr: string;
}

// Per-test mutable runtime context: paths and the captured-mtime slot map carried across steps.
interface IRunContext {
    // Absolute path of the test sandbox's project root (under <testDir>/tmp/project).
    projectDir: string;
    // Absolute path of the test sandbox's fake home (under <testDir>/tmp/home).
    homeDir: string;
    // Slot map populated by `pre.capture_mtime` and consumed by mtime assertions.
    capturedMtimes: Map<string, number>;
}

// Repository root, derived from this script's location. Used to find the bundled hook + plugin root.
const REPO_ROOT = join(__dirname, "..");

// Path to the bundled Stop hook that every test invokes.
const HOOK_BUNDLE_PATH = join(REPO_ROOT, "plugin", "dist", "stop-hook.js");

// `CLAUDE_PLUGIN_ROOT` value passed into every hook invocation.
const PLUGIN_ROOT = join(REPO_ROOT, "plugin");

// Returns a fully-populated `IPreActions` with empty defaults, merging in any fields the YAML
// provides. Avoids `undefined` checks scattered through the runner.
function normalizePre(rawPre: Record<string, unknown> | undefined): IPreActions {
    const source = rawPre || {};
    return {
        sleep: typeof source.sleep === "number" ? source.sleep : 0,
        write: (source.write as Record<string, string>) || {},
        append: (source.append as Record<string, string>) || {},
        delete: (source.delete as string[]) || [],
        delete_recursive: (source.delete_recursive as string[]) || [],
        capture_mtime: (source.capture_mtime as Record<string, string>) || {},
    };
}

// Returns a fully-populated `IExpectClause` with empty defaults, merging in any fields the YAML
// provides. Avoids `undefined` checks scattered through the runner.
function normalizeExpect(rawExpect: Record<string, unknown> | undefined): IExpectClause {
    const source = rawExpect || {};
    return {
        exit: typeof source.exit === "number" ? source.exit : 0,
        stdout_substrings: (source.stdout_substrings as string[]) || [],
        stdout_regex: (source.stdout_regex as string[]) || [],
        stdout_not_substrings: (source.stdout_not_substrings as string[]) || [],
        stderr_substrings: (source.stderr_substrings as string[]) || [],
        stderr_regex: (source.stderr_regex as string[]) || [],
        file_exists: (source.file_exists as string[]) || [],
        file_not_exists: (source.file_not_exists as string[]) || [],
        dir_exists: (source.dir_exists as string[]) || [],
        dir_not_exists: (source.dir_not_exists as string[]) || [],
        file_contains: (source.file_contains as IFileContentExpectation[]) || [],
        file_line_count: (source.file_line_count as IFileLineCountExpectation[]) || [],
        mtime_advanced: (source.mtime_advanced as IMtimeExpectation[]) || [],
        mtime_unchanged: (source.mtime_unchanged as IMtimeExpectation[]) || [],
        find_file_contains: (source.find_file_contains as IFindFileContainsExpectation[]) || [],
        find_count: (source.find_count as IFindCountExpectation[]) || [],
        no_files_overlap: (source.no_files_overlap as INoFilesOverlapExpectation[]) || [],
        state_file_shape: source.state_file_shape === true,
    };
}

// Parses one test.yaml file off disk and returns a fully-normalized `ITestCase`.
async function loadTestCase(testFilePath: string): Promise<ITestCase> {
    const raw = await fs.readFile(testFilePath, "utf8");
    const rawDoc = parseYaml(raw) as Record<string, unknown>;
    const rawSetup = (rawDoc.setup as Record<string, unknown>) || {};
    const setup: ISetup = {
        git_init: (rawSetup.git_init as string[]) || [],
        files: (rawSetup.files as Record<string, string>) || {},
        home_files: (rawSetup.home_files as Record<string, string>) || {},
    };
    const rawSteps = (rawDoc.steps as Record<string, unknown>[]) || [];
    const steps: IStep[] = rawSteps.map((rawStep: Record<string, unknown>) => ({
        description: (rawStep.description as string) || "",
        pre: normalizePre(rawStep.pre as Record<string, unknown>),
        expect: normalizeExpect(rawStep.expect as Record<string, unknown>),
    }));
    return {
        description: (rawDoc.description as string) || "",
        setup,
        steps,
    };
}

// Resolves a YAML-relative path to an absolute path on disk. `${HOME_DIR}` and `${PROJECT_DIR}`
// prefixes select the home or project sandbox. Absolute paths in YAML are passed through unchanged
// so substituted-template paths land where the YAML author expects.
function resolveSandboxPath(rawPath: string, ctx: IRunContext): string {
    if (rawPath.startsWith("${HOME_DIR}/")) {
        return join(ctx.homeDir, rawPath.slice("${HOME_DIR}/".length));
    }
    if (rawPath.startsWith("${PROJECT_DIR}/")) {
        return join(ctx.projectDir, rawPath.slice("${PROJECT_DIR}/".length));
    }
    if (isAbsolute(rawPath)) {
        return rawPath;
    }
    return join(ctx.projectDir, rawPath);
}

// Expands `${PROJECT_DIR}` / `${HOME_DIR}` placeholders inside a substring before grep-style
// matching. Used so audit-log assertions can reference the sandbox path as a verbatim substring.
function expandTemplate(text: string, ctx: IRunContext): string {
    return text
        .replaceAll("${PROJECT_DIR}", ctx.projectDir)
        .replaceAll("${HOME_DIR}", ctx.homeDir);
}

// Recursively removes `dirPath` if it exists. Tolerant of missing dirs (no error on first run).
async function removeIfExists(dirPath: string): Promise<void> {
    await fs.rm(dirPath, { recursive: true, force: true });
}

// Writes `content` to `filePath`, creating any missing parent directories.
async function writeFileEnsuringDirs(filePath: string, content: string): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
}

// Appends `content` to `filePath`, creating any missing parent directories.
async function appendFileEnsuringDirs(filePath: string, content: string): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, content);
}

// Spawns `git init -q` in `dirPath`. Does not throw on non-zero exit (the runner surfaces failures
// via the test's own assertions).
async function gitInitDir(dirPath: string): Promise<void> {
    await new Promise<void>((resolve) => {
        const child = spawn("git", ["-C", dirPath, "init", "-q"], { stdio: "ignore" });
        child.on("close", () => resolve());
    });
}

// Builds the initial sandbox: creates project + home, runs git inits, writes seed files. Called
// exactly once per test before any step.
async function applySetup(setup: ISetup, ctx: IRunContext): Promise<void> {
    await fs.mkdir(ctx.projectDir, { recursive: true });
    await fs.mkdir(ctx.homeDir, { recursive: true });
    for (const relativeDir of setup.git_init) {
        const absoluteDir = join(ctx.projectDir, relativeDir);
        await fs.mkdir(absoluteDir, { recursive: true });
        await gitInitDir(absoluteDir);
    }
    for (const relativePath of Object.keys(setup.files)) {
        const absolutePath = join(ctx.projectDir, relativePath);
        await writeFileEnsuringDirs(absolutePath, setup.files[relativePath]);
    }
    for (const relativePath of Object.keys(setup.home_files)) {
        const absolutePath = join(ctx.homeDir, relativePath);
        await writeFileEnsuringDirs(absolutePath, setup.home_files[relativePath]);
    }
}

// Applies one step's `pre` actions: sleep, write, append, delete, delete_recursive, capture_mtime.
async function applyPre(pre: IPreActions, ctx: IRunContext): Promise<void> {
    if (pre.sleep > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.round(pre.sleep * 1000)));
    }
    for (const relativePath of Object.keys(pre.write)) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        await writeFileEnsuringDirs(absolutePath, pre.write[relativePath]);
    }
    for (const relativePath of Object.keys(pre.append)) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        await appendFileEnsuringDirs(absolutePath, pre.append[relativePath]);
    }
    for (const relativePath of pre.delete) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        await fs.rm(absolutePath, { force: true });
    }
    for (const relativePath of pre.delete_recursive) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        await fs.rm(absolutePath, { recursive: true, force: true });
    }
    for (const slotName of Object.keys(pre.capture_mtime)) {
        const relativePath = pre.capture_mtime[slotName];
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        const fileStat = await fs.stat(absolutePath);
        ctx.capturedMtimes.set(slotName, fileStat.mtimeMs);
    }
}

// Spawns the bundled hook with stdin '{}' and the sandboxed env. Resolves with exit code +
// captured stdout/stderr. Never throws on non-zero exit; assertions decide pass/fail.
async function invokeHook(ctx: IRunContext): Promise<IHookResult> {
    return await new Promise<IHookResult>((resolve) => {
        const childEnv: Record<string, string> = {};
        for (const envKey of Object.keys(process.env)) {
            const envValue = process.env[envKey];
            if (envValue !== undefined) {
                childEnv[envKey] = envValue;
            }
        }
        childEnv["CLAUDE_PROJECT_DIR"] = ctx.projectDir;
        childEnv["CLAUDE_PLUGIN_ROOT"] = PLUGIN_ROOT;
        childEnv["HOME"] = ctx.homeDir;
        const child = spawn("bun", [HOOK_BUNDLE_PATH], { env: childEnv });
        let stdoutBuffer = "";
        let stderrBuffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderrBuffer += chunk.toString("utf8");
        });
        child.on("close", (exitCode) => {
            resolve({
                exitCode: typeof exitCode === "number" ? exitCode : -1,
                stdout: stdoutBuffer,
                stderr: stderrBuffer,
            });
        });
        child.stdin.write("{}");
        child.stdin.end();
    });
}

// Translates a glob-style pattern (only `*` honoured, mapped to `.*`) into a regex anchored to the
// full basename. Used by find-style assertions (find_file_contains, find_count, no_files_overlap).
function patternToRegex(pattern: string): RegExp {
    let regexBody = "";
    for (const character of pattern) {
        if (character === "*") {
            regexBody += ".*";
        }
        else if (".+?^${}()|[]\\".includes(character)) {
            regexBody += "\\" + character;
        }
        else {
            regexBody += character;
        }
    }
    return new RegExp("^" + regexBody + "$");
}

// Recursively walks `searchDir` and returns the absolute paths of every file (not directory) whose
// basename matches `pattern`, optionally filtered by min/max depth. Depth 0 = files directly inside
// `searchDir`. Tolerant of missing directories (returns []).
async function findFiles(
    searchDir: string,
    pattern: string,
    minDepth: number,
    maxDepth: number,
): Promise<string[]> {
    const matches: string[] = [];
    const patternRegex = patternToRegex(pattern);
    async function walk(currentDir: string, currentDepth: number): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (currentDepth + 1 <= maxDepth) {
                    await walk(fullPath, currentDepth + 1);
                }
            }
            else if (entry.isFile()) {
                if (currentDepth >= minDepth && patternRegex.test(entry.name)) {
                    matches.push(fullPath);
                }
            }
        }
    }
    await walk(searchDir, 0);
    matches.sort();
    return matches;
}

// Runs the scenario-7 structural validation against `<projectDir>/.claude/claude-tools-runner/`.
// Returns an array of human-readable error strings; empty array means valid.
async function validateStateFileShape(projectDir: string): Promise<string[]> {
    const errors: string[] = [];
    const hashesPath = join(projectDir, ".claude", "claude-tools-runner", "hashes.yaml");
    const runsDir = join(projectDir, ".claude", "claude-tools-runner", "runs");
    let hashesExists = true;
    try {
        await fs.access(hashesPath);
    }
    catch {
        hashesExists = false;
    }
    if (!hashesExists) {
        errors.push(`hashes file does not exist at ${hashesPath}`);
        return errors;
    }
    const hashesText = await fs.readFile(hashesPath, "utf8");
    const hashesDoc = parseYaml(hashesText) as Record<string, unknown>;
    if (!hashesDoc || typeof hashesDoc !== "object" || Array.isArray(hashesDoc)) {
        errors.push("hashes file root is not a mapping");
    }
    else {
        const fileHashes = hashesDoc.fileHashes as Record<string, unknown>;
        if (!fileHashes || typeof fileHashes !== "object" || Array.isArray(fileHashes) || Object.keys(fileHashes).length < 1) {
            errors.push("fileHashes must be a non-empty mapping");
        }
    }
    let runEntries: string[];
    try {
        runEntries = await fs.readdir(runsDir);
    }
    catch {
        errors.push(`runs directory does not exist at ${runsDir}`);
        return errors;
    }
    const runYamlFiles = runEntries.filter((name) => name.endsWith(".yaml"));
    if (runYamlFiles.length < 1) {
        errors.push("runs directory must contain at least one .yaml file");
        return errors;
    }
    const firstRunPath = join(runsDir, runYamlFiles[0]);
    const runText = await fs.readFile(firstRunPath, "utf8");
    const runDoc = parseYaml(runText) as Record<string, unknown>;
    if (!runDoc || typeof runDoc !== "object" || Array.isArray(runDoc)) {
        errors.push("run file root is not a mapping");
        return errors;
    }
    if (typeof runDoc.commandKey !== "string" || !/^[0-9a-f]+$/.test(runDoc.commandKey as string)) {
        errors.push("commandKey must be a hex string");
    }
    if (typeof runDoc.expandedRun !== "string") {
        errors.push("expandedRun must be a string");
    }
    if (typeof runDoc.expandedCwd !== "string") {
        errors.push("expandedCwd must be a string");
    }
    if (typeof runDoc.sourceFile !== "string") {
        errors.push("sourceFile must be a string");
    }
    if (typeof runDoc.sourceLine !== "number") {
        errors.push("sourceLine must be a number");
    }
    if (typeof runDoc.lastRunAt !== "string") {
        errors.push("lastRunAt must be a string");
    }
    if (typeof runDoc.lastFilesHash !== "string") {
        errors.push("lastFilesHash must be a string");
    }
    if (!Array.isArray(runDoc.matchedFiles)) {
        errors.push("matchedFiles must be a sequence");
    }
    return errors;
}

// Returns true if `path` exists as a file; false otherwise (including when the path resolves to a
// directory).
async function pathIsFile(absolutePath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(absolutePath);
        return stat.isFile();
    }
    catch {
        return false;
    }
}

// Returns true if `path` exists as a directory; false otherwise.
async function pathIsDirectory(absolutePath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(absolutePath);
        return stat.isDirectory();
    }
    catch {
        return false;
    }
}

// Counts `\n` occurrences in `text` (matches `wc -l` semantics: trailing-newline lines are counted,
// a non-newline-terminated final fragment is not).
function countNewlines(text: string): number {
    let count = 0;
    for (const character of text) {
        if (character === "\n") {
            count += 1;
        }
    }
    return count;
}

// Runs every assertion in `expectClause` against `hookResult` and the on-disk sandbox. Returns an
// array of failure strings; empty array means all assertions passed.
async function evaluateExpect(
    expectClause: IExpectClause,
    hookResult: IHookResult,
    ctx: IRunContext,
): Promise<string[]> {
    const failures: string[] = [];
    if (hookResult.exitCode !== expectClause.exit) {
        failures.push(`exit=${hookResult.exitCode} (expected ${expectClause.exit})`);
    }
    for (const literal of expectClause.stdout_substrings) {
        const expanded = expandTemplate(literal, ctx);
        if (!hookResult.stdout.includes(expanded)) {
            failures.push(`stdout missing substring: ${JSON.stringify(expanded)}`);
        }
    }
    for (const pattern of expectClause.stdout_regex) {
        const compiled = new RegExp(pattern, "m");
        if (!compiled.test(hookResult.stdout)) {
            failures.push(`stdout missing regex: ${pattern}`);
        }
    }
    for (const literal of expectClause.stdout_not_substrings) {
        const expanded = expandTemplate(literal, ctx);
        if (hookResult.stdout.includes(expanded)) {
            failures.push(`stdout unexpectedly contains: ${JSON.stringify(expanded)}`);
        }
    }
    for (const literal of expectClause.stderr_substrings) {
        const expanded = expandTemplate(literal, ctx);
        if (!hookResult.stderr.includes(expanded)) {
            failures.push(`stderr missing substring: ${JSON.stringify(expanded)}`);
        }
    }
    for (const pattern of expectClause.stderr_regex) {
        const compiled = new RegExp(pattern, "m");
        if (!compiled.test(hookResult.stderr)) {
            failures.push(`stderr missing regex: ${pattern}`);
        }
    }
    for (const relativePath of expectClause.file_exists) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        const isFile = await pathIsFile(absolutePath);
        if (!isFile) {
            failures.push(`expected file to exist: ${relativePath}`);
        }
    }
    for (const relativePath of expectClause.file_not_exists) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        const isFile = await pathIsFile(absolutePath);
        if (isFile) {
            failures.push(`expected file to NOT exist: ${relativePath}`);
        }
    }
    for (const relativePath of expectClause.dir_exists) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        const isDir = await pathIsDirectory(absolutePath);
        if (!isDir) {
            failures.push(`expected directory to exist: ${relativePath}`);
        }
    }
    for (const relativePath of expectClause.dir_not_exists) {
        const absolutePath = resolveSandboxPath(relativePath, ctx);
        const isDir = await pathIsDirectory(absolutePath);
        if (isDir) {
            failures.push(`expected directory to NOT exist: ${relativePath}`);
        }
    }
    for (const expectation of expectClause.file_contains) {
        const absolutePath = resolveSandboxPath(expectation.path, ctx);
        const isFile = await pathIsFile(absolutePath);
        if (!isFile) {
            failures.push(`file_contains: ${expectation.path} does not exist`);
            continue;
        }
        const contents = await fs.readFile(absolutePath, "utf8");
        const expanded = expandTemplate(expectation.substring, ctx);
        if (!contents.includes(expanded)) {
            failures.push(`file_contains: ${expectation.path} missing ${JSON.stringify(expanded)}`);
        }
    }
    for (const expectation of expectClause.file_line_count) {
        const absolutePath = resolveSandboxPath(expectation.path, ctx);
        const isFile = await pathIsFile(absolutePath);
        if (!isFile) {
            failures.push(`file_line_count: ${expectation.path} does not exist`);
            continue;
        }
        const contents = await fs.readFile(absolutePath, "utf8");
        const actualLines = countNewlines(contents);
        if (actualLines !== expectation.count) {
            failures.push(`file_line_count: ${expectation.path} has ${actualLines} lines (expected ${expectation.count})`);
        }
    }
    for (const expectation of expectClause.mtime_advanced) {
        const absolutePath = resolveSandboxPath(expectation.path, ctx);
        const previousMtime = ctx.capturedMtimes.get(expectation.slot);
        if (previousMtime === undefined) {
            failures.push(`mtime_advanced: slot '${expectation.slot}' not captured`);
            continue;
        }
        const isFile = await pathIsFile(absolutePath);
        if (!isFile) {
            failures.push(`mtime_advanced: ${expectation.path} does not exist`);
            continue;
        }
        const currentStat = await fs.stat(absolutePath);
        if (currentStat.mtimeMs <= previousMtime) {
            failures.push(`mtime_advanced: ${expectation.path} mtime did not advance (before=${previousMtime} after=${currentStat.mtimeMs})`);
        }
    }
    for (const expectation of expectClause.mtime_unchanged) {
        const absolutePath = resolveSandboxPath(expectation.path, ctx);
        const previousMtime = ctx.capturedMtimes.get(expectation.slot);
        if (previousMtime === undefined) {
            failures.push(`mtime_unchanged: slot '${expectation.slot}' not captured`);
            continue;
        }
        const isFile = await pathIsFile(absolutePath);
        if (!isFile) {
            failures.push(`mtime_unchanged: ${expectation.path} does not exist`);
            continue;
        }
        const currentStat = await fs.stat(absolutePath);
        if (currentStat.mtimeMs !== previousMtime) {
            failures.push(`mtime_unchanged: ${expectation.path} mtime changed (before=${previousMtime} after=${currentStat.mtimeMs})`);
        }
    }
    for (const expectation of expectClause.find_file_contains) {
        const absoluteSearchDir = resolveSandboxPath(expectation.search_dir, ctx);
        const minDepth = typeof expectation.min_depth === "number" ? expectation.min_depth : 0;
        const matches = await findFiles(absoluteSearchDir, expectation.pattern, minDepth, 32);
        if (matches.length === 0) {
            failures.push(`find_file_contains: no file matching ${expectation.pattern} under ${expectation.search_dir}`);
            continue;
        }
        const firstMatch = matches[0];
        const contents = await fs.readFile(firstMatch, "utf8");
        for (const literal of expectation.substrings) {
            const expanded = expandTemplate(literal, ctx);
            if (!contents.includes(expanded)) {
                failures.push(`find_file_contains: ${firstMatch} missing ${JSON.stringify(expanded)}`);
            }
        }
    }
    for (const expectation of expectClause.find_count) {
        const absoluteSearchDir = resolveSandboxPath(expectation.search_dir, ctx);
        const matches = await findFiles(absoluteSearchDir, expectation.pattern, 0, expectation.max_depth);
        if (matches.length !== expectation.count) {
            failures.push(`find_count: ${expectation.pattern} under ${expectation.search_dir} -> ${matches.length} (expected ${expectation.count})`);
        }
    }
    for (const expectation of expectClause.no_files_overlap) {
        const absoluteDirA = resolveSandboxPath(expectation.dir_a, ctx);
        const absoluteDirB = resolveSandboxPath(expectation.dir_b, ctx);
        const matchesA = await findFiles(absoluteDirA, expectation.pattern, 0, 1);
        const matchesB = await findFiles(absoluteDirB, expectation.pattern, 0, 1);
        const basenamesA = new Set(matchesA.map((path) => path.split("/").pop() || ""));
        for (const matchB of matchesB) {
            const basenameB = matchB.split("/").pop() || "";
            if (basenamesA.has(basenameB)) {
                failures.push(`no_files_overlap: ${basenameB} present in both ${expectation.dir_a} and ${expectation.dir_b}`);
            }
        }
    }
    if (expectClause.state_file_shape) {
        const stateErrors = await validateStateFileShape(ctx.projectDir);
        for (const errorMessage of stateErrors) {
            failures.push(`state_file_shape: ${errorMessage}`);
        }
    }
    return failures;
}

// Runs all steps for one test case. Returns true if every step passed; false on the first failure.
// Per-step PASS/FAIL is logged with the test description prefix.
async function runTestCase(testFilePath: string): Promise<boolean> {
    const testCase = await loadTestCase(testFilePath);
    const testDir = dirname(testFilePath);
    const tmpDir = join(testDir, "tmp");
    await removeIfExists(tmpDir);
    const ctx: IRunContext = {
        projectDir: join(tmpDir, "project"),
        homeDir: join(tmpDir, "home"),
        capturedMtimes: new Map<string, number>(),
    };
    await applySetup(testCase.setup, ctx);
    let allPassed = true;
    for (let stepIndex = 0; stepIndex < testCase.steps.length; stepIndex += 1) {
        const step = testCase.steps[stepIndex];
        await applyPre(step.pre, ctx);
        const hookResult = await invokeHook(ctx);
        const failures = await evaluateExpect(step.expect, hookResult, ctx);
        const stepLabel = `${testCase.description} :: step ${stepIndex + 1} (${step.description})`;
        if (failures.length === 0) {
            process.stdout.write(`PASS: ${stepLabel}\n`);
        }
        else {
            process.stdout.write(`FAIL: ${stepLabel}\n`);
            for (const failureMessage of failures) {
                process.stdout.write(`  ${failureMessage}\n`);
            }
            if (hookResult.stdout.length > 0) {
                process.stdout.write(`  --- hook stdout ---\n`);
                for (const stdoutLine of hookResult.stdout.split("\n")) {
                    process.stdout.write(`  ${stdoutLine}\n`);
                }
            }
            if (hookResult.stderr.length > 0) {
                process.stdout.write(`  --- hook stderr ---\n`);
                for (const stderrLine of hookResult.stderr.split("\n")) {
                    process.stdout.write(`  ${stderrLine}\n`);
                }
            }
            allPassed = false;
            break;
        }
    }
    return allPassed;
}

// Entry point: takes either a path to a test.yaml or a directory containing one. Exits 0 on pass.
async function main(): Promise<void> {
    const argument = process.argv[2];
    if (!argument) {
        process.stderr.write("Usage: bun run scripts/run-e2e-test.ts <test-dir-or-test.yaml>\n");
        process.exit(1);
    }
    let testFilePath = argument;
    const argStat = await fs.stat(argument);
    if (argStat.isDirectory()) {
        testFilePath = join(argument, "test.yaml");
    }
    const passed = await runTestCase(testFilePath);
    process.exit(passed ? 0 : 1);
}

main();
