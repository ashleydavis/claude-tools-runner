import * as childProcess from "node:child_process";
import * as path from "node:path";
import { ChangedFile } from "./types";

// Spawns `git status --porcelain=v1 -z --untracked-files=all` against `scopeDir` and returns the changed
// files whose absolute paths fall under `scopeDir`. Both staged and unstaged entries are returned, including
// untracked files. Renames return the destination path. Entries deleted in the worktree are skipped. Throws
// an `Error` whose message contains `"git binary missing on PATH"` (and which preserves the original
// `ENOENT` `code`) when the `git` binary is not available on `$PATH`, so the Stop hook can match either the
// message substring or `err.code === "ENOENT"` to log the canonical skip message and exit 0.
export async function collectChangedFiles(scopeDir: string): Promise<ChangedFile[]> {
    const repoRootText = await runGitCommand(scopeDir, ["rev-parse", "--show-toplevel"]);
    const repoRoot = repoRootText.trimEnd();

    const statusOutput = await runGitCommand(scopeDir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    ]);

    const reportedPaths = parsePorcelainV1Z(statusOutput);
    const seenAbsPaths = new Set<string>();
    const changedFiles: ChangedFile[] = [];
    const scopePrefix = scopeDir.endsWith(path.sep) ? scopeDir : scopeDir + path.sep;
    for (const reportedPath of reportedPaths) {
        const absPath = path.resolve(repoRoot, reportedPath);
        if (!absPath.startsWith(scopePrefix)) {
            continue;
        }
        if (seenAbsPaths.has(absPath)) {
            continue;
        }
        seenAbsPaths.add(absPath);
        const relativePath = path.relative(scopeDir, absPath).split(path.sep).join("/");
        changedFiles.push({ path: relativePath, absPath });
    }
    return changedFiles;
}

// Spawns `git -C scopeDir <args...>` and resolves to the captured stdout (UTF-8 decoded). On `ENOENT` from
// the spawn (the `git` binary is not on `$PATH`), rejects with an `Error` whose message starts with
// `"git binary missing on PATH"` and whose `code` field is preserved as `"ENOENT"` so callers can detect the
// missing-binary case via either the message substring or the error code. All other failure modes (non-zero
// exit, non-ENOENT spawn errors) reject with the original error so the Stop hook's top-level `try/catch` can
// surface them. Exported so the spawn lifecycle (stdout capture, exit handling, ENOENT mapping) can be
// unit-tested directly without going through `collectChangedFiles`.
export async function runGitCommand(scopeDir: string, gitArgs: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = childProcess.spawn(
            "git",
            ["-C", scopeDir, ...gitArgs],
            { stdio: ["ignore", "pipe", "pipe"] },
        );

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;

        child.stdout!.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
        });
        child.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });
        child.on("error", (caughtErr: NodeJS.ErrnoException) => {
            if (settled) {
                return;
            }
            settled = true;
            if (caughtErr.code === "ENOENT") {
                const missingErr: NodeJS.ErrnoException = new Error("git binary missing on PATH");
                missingErr.code = "ENOENT";
                reject(missingErr);
                return;
            }
            reject(caughtErr);
        });
        child.on("close", (exitCode: number | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (exitCode !== 0) {
                const stderrText = Buffer.concat(stderrChunks).toString("utf8");
                reject(new Error(`git ${gitArgs.join(" ")} exited with code ${exitCode}: ${stderrText}`));
                return;
            }
            const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
            resolve(stdoutText);
        });
    });
}

// Parses NUL-delimited records emitted by `git status --porcelain=v1 -z` and returns the destination path of
// each non-deletion entry. Each record has the shape `XY <space> <path>`; rename and copy entries (X or Y is
// `R` or `C`) are followed by an additional NUL-terminated original path which is consumed and discarded.
// Entries with `D` in the worktree column (an unstaged deletion) are excluded so that downstream hashing does
// not have to handle missing files reported as changed. Exported so the parser can be unit-tested directly
// against canned porcelain byte streams without spawning a real `git` process.
export function parsePorcelainV1Z(stdoutText: string): string[] {
    const records = stdoutText.split("\0");
    const reportedPaths: string[] = [];
    let recordIndex = 0;
    while (recordIndex < records.length) {
        const record = records[recordIndex];
        recordIndex += 1;
        if (record.length < 4) {
            continue;
        }
        const indexStatus = record.charAt(0);
        const worktreeStatus = record.charAt(1);
        const reportedPath = record.substring(3);

        const isRenameOrCopy = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
        if (isRenameOrCopy) {
            recordIndex += 1;
        }

        if (worktreeStatus === "D") {
            continue;
        }

        reportedPaths.push(reportedPath);
    }
    return reportedPaths;
}
