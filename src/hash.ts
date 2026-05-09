import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { ChangedFile, FileHashEntry } from "./types";

// Sentinel returned by `hashFileWithCache` when the target file does not exist at the time of stat. Encodes
// the race between `git status` reporting a path and a subsequent `fs.stat` lookup (the file may have been
// deleted in the interim). Returned in place of a real digest so `aggregateHash` can still produce a stable
// per-file line. The cache is intentionally NOT updated for missing files.
const MISSING_FILE_SENTINEL: string = "<missing>";

// Returns the SHA-256 hex digest of `file`'s contents, using `cache` (a `state.fileHashes`-shaped map keyed
// by absolute path) to short-circuit re-reading unchanged files. A cache hit requires the cached entry's
// `mtimeMs` AND `size` to match the current `fs.stat` result; if either differs, the file is re-read and the
// cache entry is overwritten. Files that no longer exist (ENOENT on stat) yield the literal
// `MISSING_FILE_SENTINEL` and the cache is left untouched. All other stat / read errors propagate.
export async function hashFileWithCache(file: ChangedFile, cache: Record<string, FileHashEntry>): Promise<string> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(file.absPath);
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return MISSING_FILE_SENTINEL;
        }
        throw caughtErr;
    }

    const cachedEntry: FileHashEntry | undefined = cache[file.absPath];
    if (cachedEntry !== undefined && cachedEntry.mtimeMs === stat.mtimeMs && cachedEntry.size === stat.size) {
        return cachedEntry.hash;
    }

    const fileBytes: Buffer = await fs.readFile(file.absPath);
    const hasher = crypto.createHash("sha256");
    hasher.update(fileBytes);
    const hexDigest: string = hasher.digest("hex");

    cache[file.absPath] = { mtimeMs: stat.mtimeMs, size: stat.size, hash: hexDigest };
    return hexDigest;
}

// Returns a single SHA-256 hex digest representing the combined content of `files`. Files are sorted by
// `absPath` so the result is independent of input order, then each file's hash is fetched via
// `hashFileWithCache` (in parallel with `Promise.all`; per-key writes to `cache` are deterministic so a
// last-writer-wins overwrite produces the same value). The aggregate digest is computed over
// `${absPath}\0${perFileHash}\n` lines so neither the path nor the hash can collide across boundaries. An
// empty `files` array returns the SHA-256 of the empty string.
export async function aggregateHash(files: ChangedFile[], cache: Record<string, FileHashEntry>): Promise<string> {
    const sortedFiles: ChangedFile[] = [...files].sort((leftFile, rightFile) => {
        if (leftFile.absPath < rightFile.absPath) {
            return -1;
        }
        if (leftFile.absPath > rightFile.absPath) {
            return 1;
        }
        return 0;
    });

    const perFileHashes: string[] = await Promise.all(
        sortedFiles.map(sortedFile => hashFileWithCache(sortedFile, cache)),
    );

    const aggregator = crypto.createHash("sha256");
    for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
        aggregator.update(sortedFiles[fileIndex].absPath);
        aggregator.update("\0");
        aggregator.update(perFileHashes[fileIndex]);
        aggregator.update("\n");
    }
    return aggregator.digest("hex");
}
