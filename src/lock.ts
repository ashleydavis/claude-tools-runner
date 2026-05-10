import * as fs from "node:fs/promises";

// Maximum age (milliseconds) of a held lock before it is considered stale and stolen by a new acquirer.
// A process that crashes or is SIGKILLed while holding the lock leaves the lock directory on disk; without
// this timeout the next hook would block forever. 30 seconds sits well above the typical lifetime of a
// `saveState` write (hundreds of milliseconds at most) so the timeout never trips during normal operation
// but recovers quickly after a crash.
const STALE_LOCK_MS: number = 30_000;

// Initial backoff delay (milliseconds) between failed lock-acquisition attempts. Doubled on each subsequent
// failure up to `MAX_BACKOFF_MS` so contention resolves quickly without busy-waiting the CPU.
const INITIAL_BACKOFF_MS: number = 5;

// Upper bound on the per-attempt backoff (milliseconds). Caps the doubling sequence so the wait between
// retries never grows beyond this many milliseconds.
const MAX_BACKOFF_MS: number = 200;

// Optional knobs accepted by `withFileLock`. Both fields are test-only seams: production calls
// `withFileLock` without `opts` so the runtime constants are used.
export interface WithFileLockOptions {
    // Override for the stale-lock threshold. Tests pass a small value (e.g. 50ms) to exercise the
    // stale-lock-steal path without sleeping for the full `STALE_LOCK_MS`.
    staleLockMs?: number;
    // Override for the initial backoff between failed acquisition attempts. Tests pass a tiny value to
    // keep total test runtime bounded under contention.
    initialBackoffMs?: number;
}

// Acquires an exclusive lock on `lockPath` (a directory path used purely as a lock token), runs `fn` while
// the lock is held, and releases the lock before returning. The lock primitive is `fs.mkdir`: `mkdir` either
// succeeds (we hold the lock) or fails with EEXIST (someone else does). On EEXIST the function inspects the
// existing lock directory's mtime; if older than the stale threshold it is stolen (rmdir + retry); otherwise
// the function sleeps with exponential backoff and retries. The lock is released even when `fn` throws so
// a faulty save never strands the lock.
export async function withFileLock<ResultType>(lockPath: string, fn: () => Promise<ResultType>, opts?: WithFileLockOptions): Promise<ResultType> {
    const staleLockMs = opts?.staleLockMs !== undefined ? opts.staleLockMs : STALE_LOCK_MS;
    const initialBackoffMs = opts?.initialBackoffMs !== undefined ? opts.initialBackoffMs : INITIAL_BACKOFF_MS;
    let backoffMs = initialBackoffMs;
    while (true) {
        try {
            await fs.mkdir(lockPath);
            break;
        }
        catch (caughtErr) {
            const errnoErr = caughtErr as NodeJS.ErrnoException;
            if (errnoErr.code !== "EEXIST") {
                throw caughtErr;
            }
            const stolen = await tryStealStaleLock(lockPath, staleLockMs);
            if (stolen) {
                continue;
            }
            await sleepFor(backoffMs);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
    }
    try {
        return await fn();
    }
    finally {
        try {
            await fs.rmdir(lockPath);
        }
        catch (releaseErr) {
            const errnoReleaseErr = releaseErr as NodeJS.ErrnoException;
            if (errnoReleaseErr.code !== "ENOENT") {
                throw releaseErr;
            }
        }
    }
}

// Inspects the lock directory at `lockPath` and removes it when its mtime is older than `staleLockMs`.
// Returns true when the lock was found stale and removed (or when the directory disappeared between the
// initial EEXIST and the stat) so the caller can retry the mkdir immediately. Returns false when the lock
// is held by a live process; the caller then sleeps and retries.
export async function tryStealStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
    let lockStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        lockStat = await fs.stat(lockPath);
    }
    catch (statErr) {
        const errnoStatErr = statErr as NodeJS.ErrnoException;
        if (errnoStatErr.code === "ENOENT") {
            return true;
        }
        throw statErr;
    }
    if (Date.now() - lockStat.mtimeMs <= staleLockMs) {
        return false;
    }
    try {
        await fs.rmdir(lockPath);
    }
    catch (removeErr) {
        const errnoRemoveErr = removeErr as NodeJS.ErrnoException;
        if (errnoRemoveErr.code === "ENOENT") {
            return true;
        }
        throw removeErr;
    }
    return true;
}

// Resolves after `ms` milliseconds. Wraps `setTimeout` in a `Promise` so callers can `await` a backoff
// without referencing the callback API directly.
export function sleepFor(ms: number): Promise<void> {
    return new Promise<void>((resolveCallback) => {
        setTimeout(resolveCallback, ms);
    });
}
