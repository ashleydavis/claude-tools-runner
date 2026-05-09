import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { aggregateHash, hashFileWithCache } from "../hash";
import { ChangedFile, FileHashEntry } from "../types";

// Holds a temp directory path for the lifetime of one test. Created via `fs.mkdtemp` and torn down by
// `cleanupTempArea` so each test gets an isolated working area.
interface TempArea {
    // Absolute path to the per-test temp directory.
    rootDir: string;
}

// Creates a fresh temp directory under the OS temp root and returns a `TempArea` referencing it.
async function makeTempArea(): Promise<TempArea> {
    const baseDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-hash-test-"));
    return { rootDir: baseDir };
}

// Removes a temp area created by `makeTempArea`, ignoring missing-directory errors.
async function cleanupTempArea(area: TempArea): Promise<void> {
    await fs.rm(area.rootDir, { recursive: true, force: true });
}

// Writes `content` to a file inside `area.rootDir` and returns a `ChangedFile` for it. The relative `path`
// of the returned `ChangedFile` is `relativePath`; the `absPath` is the joined absolute location.
async function writeChangedFile(area: TempArea, relativePath: string, content: string): Promise<ChangedFile> {
    const absolutePath: string = path.join(area.rootDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return { path: relativePath, absPath: absolutePath };
}

// Returns the SHA-256 hex digest of `text` encoded as UTF-8. Used by tests to assert against a known
// reference value computed independently of the production code path.
function sha256HexOf(text: string): string {
    const hasher = crypto.createHash("sha256");
    hasher.update(text);
    return hasher.digest("hex");
}

describe("hashFileWithCache", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns a stable SHA-256 hex digest for fixed contents", async () => {
        const fixedContent: string = "hello world\n";
        const changedFile: ChangedFile = await writeChangedFile(tempArea, "fixed.txt", fixedContent);
        const cache: Record<string, FileHashEntry> = {};

        const computedHash: string = await hashFileWithCache(changedFile, cache);

        expect(computedHash).toBe(sha256HexOf(fixedContent));
        expect(computedHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("uses the cached value when mtimeMs and size both match", async () => {
        const changedFile: ChangedFile = await writeChangedFile(tempArea, "cached.txt", "real content");
        const cache: Record<string, FileHashEntry> = {};
        await hashFileWithCache(changedFile, cache);

        // Overwrite the cached hash with a sentinel to prove the cached value is what gets returned.
        cache[changedFile.absPath].hash = "cachedSentinelHash";

        const secondHash: string = await hashFileWithCache(changedFile, cache);

        expect(secondHash).toBe("cachedSentinelHash");
    });

    test("recomputes when mtimeMs differs (cache miss)", async () => {
        const changedFile: ChangedFile = await writeChangedFile(tempArea, "mtime.txt", "v1");
        const cache: Record<string, FileHashEntry> = {};
        await hashFileWithCache(changedFile, cache);

        // Bump the mtime without changing the content; this should force a recompute and overwrite the cache.
        cache[changedFile.absPath].hash = "staleHashValue";
        const futureTime: Date = new Date(Date.now() + 5_000);
        await fs.utimes(changedFile.absPath, futureTime, futureTime);

        const recomputedHash: string = await hashFileWithCache(changedFile, cache);

        expect(recomputedHash).toBe(sha256HexOf("v1"));
        expect(cache[changedFile.absPath].hash).toBe(sha256HexOf("v1"));
    });

    test("returns the missing sentinel and leaves the cache untouched when the file does not exist", async () => {
        const missingFile: ChangedFile = {
            path: "missing.txt",
            absPath: path.join(tempArea.rootDir, "missing.txt"),
        };
        const cache: Record<string, FileHashEntry> = {};

        const result: string = await hashFileWithCache(missingFile, cache);

        expect(result).toBe("<missing>");
        expect(cache).toEqual({});
    });
});

describe("aggregateHash", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns the SHA-256 of the empty string for an empty file list", async () => {
        const cache: Record<string, FileHashEntry> = {};

        const result: string = await aggregateHash([], cache);

        expect(result).toBe(sha256HexOf(""));
    });

    test("is independent of input order for the same set of files", async () => {
        const fileAlpha: ChangedFile = await writeChangedFile(tempArea, "alpha.txt", "alpha-content");
        const fileBeta: ChangedFile = await writeChangedFile(tempArea, "beta.txt", "beta-content");
        const cacheForwardOrder: Record<string, FileHashEntry> = {};
        const cacheReverseOrder: Record<string, FileHashEntry> = {};

        const forwardHash: string = await aggregateHash([fileAlpha, fileBeta], cacheForwardOrder);
        const reverseHash: string = await aggregateHash([fileBeta, fileAlpha], cacheReverseOrder);

        expect(forwardHash).toBe(reverseHash);
    });

    test("changes when one file's contents change", async () => {
        const fileAlpha: ChangedFile = await writeChangedFile(tempArea, "alpha.txt", "alpha-original");
        const fileBeta: ChangedFile = await writeChangedFile(tempArea, "beta.txt", "beta-content");
        const cache: Record<string, FileHashEntry> = {};

        const originalHash: string = await aggregateHash([fileAlpha, fileBeta], cache);

        // Mutate one file's contents and bump its mtime so the cache invalidates.
        await fs.writeFile(fileAlpha.absPath, "alpha-mutated", "utf8");
        const futureTime: Date = new Date(Date.now() + 5_000);
        await fs.utimes(fileAlpha.absPath, futureTime, futureTime);

        const mutatedHash: string = await aggregateHash([fileAlpha, fileBeta], cache);

        expect(mutatedHash).not.toBe(originalHash);
    });
});
