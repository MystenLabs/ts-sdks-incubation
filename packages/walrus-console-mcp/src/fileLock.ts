import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cross-process file lock, backed by `link()`'s atomic create-only semantics.
 *
 * Shared by every read-modify-write over a file in the config directory that
 * more than one process can touch at once (`configFile.ts`'s `config.json`,
 * `anchorStore.ts`'s `anchors.json`): each caller picks its own lock path so
 * the two files' writers never block each other, but the acquire/reclaim/
 * release machinery — and its failure modes — is the same for both.
 */

/**
 * How long a lock whose holder is *still running* may be held before a later
 * run treats it as leaked.
 *
 * A dead holder's lock is reclaimed on sight — nothing can be inside the
 * critical section. A live holder is the opposite case: the section is a read
 * plus a rename, so a long hold means that process is stalled, not finished, and
 * a stall is not rare (a laptop suspended mid-merge, a wedged network home
 * directory, a paused process). Taking the lock from it reopens the very
 * lost-update race the lock closes, so age alone must not be enough.
 *
 * The one thing that can leave a live pid holding forever is pid reuse after a
 * SIGKILL, and this threshold exists only to unwedge that. It therefore sits far
 * above any plausible stall: a run that collides now hits the loud timeout in
 * `acquireLock`, and only a run started much later heals the leak.
 */
const LOCK_LIVE_HOLDER_STALE_MS = 10 * 60_000;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

interface FileLock {
  path: string;
  /**
   * Identifies this hold specifically. A pid cannot: it is recycled after a
   * crash, and a retry of the same command reuses it exactly.
   */
  nonce: string;
}

/** Block the thread briefly. The whole config path is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering one.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Delete the lock if whoever holds it can no longer be inside the critical
 * section. Returns whether it was reclaimed.
 *
 * Without this a SIGKILL between acquire and release would wedge every later
 * run through this lock path — and for `config.json`, `config` is the command
 * you reach for when the setup is already broken, so a permanently stuck lock
 * would be worse than the race it prevents.
 *
 * Aliveness is what decides, not age. A holder that is still running is still
 * mid-merge however long it has been there, and reclaiming from it would put two
 * read-merge-writes over the same file — one of them losing data.
 */
function reclaimIfStale(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const holder = JSON.parse(raw) as { pid?: number; at?: number };
    if (typeof holder.pid === "number" && isProcessAlive(holder.pid)) {
      const age = Date.now() - (holder.at ?? 0);
      if (age < LOCK_LIVE_HOLDER_STALE_MS) return false;
    }
  } catch {
    // Missing, unreadable, or truncated (a crash between create and write):
    // nothing here can be trusted to name a live holder, so treat it as stale.
  }
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the exclusive lock at `lockPath`.
 *
 * The holder record is written to a private temp file and then `link()`ed into
 * place. link() is the atomic primitive here: it fails with EEXIST rather than
 * overwriting, so exactly one process wins, and — unlike open(…, "wx") followed
 * by a write — the lock file is never observable in a half-written state. That
 * gap matters: a rival that reads an empty lock cannot tell it from a corrupt
 * one, would declare it stale, and both processes would proceed.
 *
 * Throws rather than proceeding unlocked if the lock cannot be taken — silently
 * losing an update is worse than a loud failure the caller can retry.
 */
function acquireLock(lockPath: string): FileLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${lockPath}.${process.pid}.tmp`;
  const nonce = randomUUID();

  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      fs.writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        fs.linkSync(tmpPath, lockPath);
        return { path: lockPath, nonce };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Reclaiming frees the name immediately, so retry without sleeping.
        if (!reclaimIfStale(lockPath)) sleepSync(LOCK_RETRY_MS);
      }
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  throw new Error(
    `Timed out waiting for the lock at ${lockPath}. ` +
      `Another walrus-console-mcp process is still writing; retry, or delete that file if none is running.`,
  );
}

/**
 * Drop the lock, but only while it is still the hold we took.
 *
 * A reclaim hands the name to somebody else, and deleting by path alone would
 * then remove *that* process's lock and let a third one merge beside it — one
 * misjudged hold turning into an unbounded cascade. Matching the nonce keeps the
 * damage to the pair that already overlapped. Declining to delete leaks nothing
 * for long: once this process exits, its pid reads as dead and the next run
 * reclaims on sight.
 *
 * The read and the unlink are not one operation, so a reclaim landing between
 * them still slips through. That window is microseconds, against the minutes a
 * lock must age before anyone may take it from a live holder.
 */
function releaseLock(lock: FileLock): void {
  try {
    const holder = JSON.parse(fs.readFileSync(lock.path, "utf-8")) as { nonce?: string };
    if (holder.nonce !== lock.nonce) return;
  } catch {
    // Gone already, or unreadable — either way not provably ours to delete. Our
    // own record can never be the unreadable one: link() publishes it whole.
    return;
  }
  fs.rmSync(lock.path, { force: true });
}

/**
 * Run `fn` with the exclusive lock at `lockPath` held, releasing it whether
 * `fn` returns or throws.
 *
 * The lock is released even on a throw — a failed write inside `fn` must not
 * leave the lock file behind for a stalled-not-dead holder that later runs
 * time out against (see `reclaimIfStale`'s aliveness rule above).
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const lock = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}
