import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sleepFor, tryStealStaleLock, withFileLock } from "../lock";

// Holds a temp directory path for the lifetime of one test.
interface TempArea {
    // Absolute path to the per-test temp directory created via `fs.mkdtemp`.
    rootDir: string;
}

// Creates a fresh temp directory under the OS temp root.
async function makeTempArea(): Promise<TempArea> {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-lock-test-"));
    return { rootDir: baseDir };
}

// Removes a temp area created by `makeTempArea`, ignoring missing-directory errors.
async function cleanupTempArea(area: TempArea): Promise<void> {
    await fs.rm(area.rootDir, { recursive: true, force: true });
}

// Returns true if `dirPath` exists, false on ENOENT, propagates other errors.
async function dirExists(dirPath: string): Promise<boolean> {
    try {
        await fs.stat(dirPath);
        return true;
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return false;
        }
        throw caughtErr;
    }
}

describe("withFileLock", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns the value produced by fn", async () => {
        const lockPath = path.join(tempArea.rootDir, "lock");
        const result = await withFileLock(lockPath, async () => 42);
        expect(result).toBe(42);
    });

    test("creates the lock directory while fn runs and removes it afterwards", async () => {
        const lockPath = path.join(tempArea.rootDir, "lock");
        let observedDuringFn = false;
        await withFileLock(lockPath, async () => {
            observedDuringFn = await dirExists(lockPath);
        });
        expect(observedDuringFn).toBe(true);
        expect(await dirExists(lockPath)).toBe(false);
    });

    test("releases the lock even when fn throws", async () => {
        const lockPath = path.join(tempArea.rootDir, "lock");
        await expect(withFileLock(lockPath, async () => {
            throw new Error("boom");
        })).rejects.toThrow("boom");
        expect(await dirExists(lockPath)).toBe(false);
    });

    test("tolerates the lock directory disappearing before release", async () => {
        const lockPath = path.join(tempArea.rootDir, "lock");
        await withFileLock(lockPath, async () => {
            await fs.rmdir(lockPath);
        });
        expect(await dirExists(lockPath)).toBe(false);
    });

    test("serializes two concurrent acquirers (second waits for the first to release)", async () => {
        const lockPath = path.join(tempArea.rootDir, "lock");
        const lockOpts = { initialBackoffMs: 1, staleLockMs: 60_000 };
        let firstReleased = false;
        let secondAcquired = false;
        let secondAcquiredBeforeRelease = false;

        const firstHolder = withFileLock(lockPath, async () => {
            await sleepFor(40);
            firstReleased = true;
        }, lockOpts);

        await sleepFor(5);

        const secondHolder = withFileLock(lockPath, async () => {
            secondAcquired = true;
            secondAcquiredBeforeRelease = !firstReleased;
        }, lockOpts);

        await Promise.all([firstHolder, secondHolder]);
        expect(firstReleased).toBe(true);
        expect(secondAcquired).toBe(true);
        expect(secondAcquiredBeforeRelease).toBe(false);
    });

    test("steals a stale lock whose mtime is older than staleLockMs", async () => {
        const lockPath = path.join(tempArea.rootDir, "lock");
        await fs.mkdir(lockPath);
        const oldTime = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, oldTime, oldTime);

        const result = await withFileLock(lockPath, async () => "stole-it", { staleLockMs: 50, initialBackoffMs: 1 });
        expect(result).toBe("stole-it");
        expect(await dirExists(lockPath)).toBe(false);
    });

    test("propagates errors other than EEXIST from mkdir", async () => {
        const lockPath = path.join(tempArea.rootDir, "missing-parent", "lock");
        await expect(withFileLock(lockPath, async () => "ok")).rejects.toThrow();
    });
});

describe("tryStealStaleLock", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns true when the lock directory does not exist", async () => {
        const lockPath = path.join(tempArea.rootDir, "missing");
        const result = await tryStealStaleLock(lockPath, 30_000);
        expect(result).toBe(true);
    });

    test("returns false when the lock is fresh (mtime within staleLockMs)", async () => {
        const lockPath = path.join(tempArea.rootDir, "fresh");
        await fs.mkdir(lockPath);
        const result = await tryStealStaleLock(lockPath, 30_000);
        expect(result).toBe(false);
        expect(await dirExists(lockPath)).toBe(true);
    });

    test("returns true and removes the lock when mtime is older than staleLockMs", async () => {
        const lockPath = path.join(tempArea.rootDir, "stale");
        await fs.mkdir(lockPath);
        const oldTime = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, oldTime, oldTime);
        const result = await tryStealStaleLock(lockPath, 50);
        expect(result).toBe(true);
        expect(await dirExists(lockPath)).toBe(false);
    });
});

describe("sleepFor", () => {
    test("resolves after at least the requested number of milliseconds", async () => {
        const startedAt = Date.now();
        await sleepFor(20);
        const elapsed = Date.now() - startedAt;
        expect(elapsed).toBeGreaterThanOrEqual(15);
    });
});
