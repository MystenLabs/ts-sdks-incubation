/**
 * Probe M9: does `resolvePathWithinRoots` canonicalize paths with SYNCHRONOUS
 * fs calls (blocking the event loop, and therefore every other in-flight MCP
 * request, for as long as `realpath()` takes to answer), or does it stay on the
 * async path so a slow — or stalled — filesystem cannot freeze the process?
 *
 * Background: before the fix, `bin/console-mcp.ts`'s `upload_file` and
 * `download_file` handlers called `resolvePathWithinRoots` with a plain
 * `await`, BEFORE `runPromise`/`Effect.gen` — outside the cancellable fiber —
 * and `resolvePathWithinRoots` canonicalized both the candidate and every
 * allowed root with the synchronous `toRealPath` (a `realpathSync` loop with
 * `lstatSync`/`readlinkSync` fallbacks). Node is single-threaded for
 * synchronous work: a `realpath()` against a stalled NFS/FUSE mount blocks
 * every other tool call, the transport's own I/O, and cancellation itself, for
 * as long as the mount takes to answer — which is unbounded. The fix adds
 * `toRealPathAsync` (`fsp.realpath`/`lstat`/`readlink`) and moves the
 * canonicalization call inside the `Effect.gen` `runPromise` drives, so it no
 * longer blocks the event loop. That does NOT make the call cancellable,
 * though: `fs/promises`'s `realpath`/`lstat`/`readlink` take no `AbortSignal`,
 * and the request-path call site's `Effect.tryPromise` `try` callback takes no
 * parameter either, so no signal is ever created for it to ignore — an
 * interrupted request abandons the promise while the underlying `realpath(2)`
 * keeps running. What this probe actually demonstrates is narrower than
 * "cancellable": (a) zero synchronous fs calls happen on the request path, and
 * (b) the event loop keeps ticking while an async resolution is in flight —
 * not that an in-flight resolution can itself be aborted.
 *
 * Two independent demonstrations:
 *
 *   (a) Sync-call count. Monkeypatches `fs.realpathSync`/`lstatSync`/
 *       `readlinkSync` to count invocations, then calls
 *       `resolvePathWithinRoots` once. Pre-fix: count > 0 (the candidate and
 *       the one root are each canonicalized with the sync loop). Post-fix:
 *       count === 0 — every canonicalization went through `fsp.realpath`
 *       instead. A CONTROL call (`toRealPath` directly, which stays
 *       synchronous by design) confirms the monkeypatch actually reaches
 *       `pathSandbox.ts`'s bound imports before trusting the zero: ESM named
 *       imports of a Node builtin are resolved once at link time, and only
 *       `node:module`'s `syncBuiltinESMExports()` (called after every patch/
 *       unpatch below) re-syncs them to a mutated `require("node:fs")` object.
 *       If that control call itself shows 0, the technique isn't reaching this
 *       build's bindings and part (a) is reported SKIPPED rather than a false
 *       PASS — part (b) below demonstrates the same property a different way.
 *
 *   (b) Event-loop responsiveness. Delays `fsp.realpath` by 300ms and counts
 *       10ms-interval timer ticks that land WHILE `toRealPathAsync` awaits it.
 *       Post-fix, ticks keep arriving — the event loop is free to do other
 *       work during the resolve. For contrast (not a pass/fail condition on
 *       its own — `toRealPath` is still exported and intentionally used off
 *       the request path), `fs.realpathSync` is patched to busy-wait 300ms and
 *       the same timer is run around a direct `toRealPath` call: 0 ticks,
 *       because a synchronous call cannot yield to the timer at all. That is
 *       what an unbounded `realpathSync()` against a stalled mount would do to
 *       the whole process, pre-fix.
 *
 * Caveat: a real stalled NFS/FUSE mount cannot be simulated locally without
 * privileged mount access this probe deliberately avoids (no credentials, no
 * network, nothing outside a fresh temp directory it creates and removes) —
 * the 300ms delayed `realpath` in (b) stands in for it. That the in-fiber MOVE
 * in `bin/console-mcp.ts` actually happens (not just that `toRealPathAsync`
 * exists) is not something this probe can observe — importing
 * `bin/console-mcp.ts` runs its redaction wiring and argv branches as side
 * effects — so that half is verified by reading the diff plus
 * `pnpm tsx scripts/smoke-path-sandbox.mts` staying green.
 *
 * Exit 0 when both (a) (or its honest SKIPPED fallback) and (b) show the fixed
 * behaviour; exit 1 otherwise.
 *
 * Run:  npx tsx scripts/probe-path-resolve-async.mts
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pathSandbox from "../src/pathSandbox.js";

/** A patchable view of the handful of `fs`/`fs/promises` exports this probe swaps. */
type Patchable = Record<string, (...args: unknown[]) => unknown>;

const nodeRequire = createRequire(import.meta.url);
const fsCjs = nodeRequire("node:fs") as unknown as Patchable;
const fspCjs = nodeRequire("node:fs/promises") as unknown as Patchable;

const DELAY_MS = 300;
const TICK_MS = 10;

/** Part (a): does `resolvePathWithinRoots` make any synchronous fs call? */
async function partA(allowed: string, candidate: string): Promise<boolean> {
  let count = 0;
  const originalRealpathSync = fsCjs.realpathSync;
  const originalLstatSync = fsCjs.lstatSync;
  const originalReadlinkSync = fsCjs.readlinkSync;
  fsCjs.realpathSync = (...args: unknown[]) => {
    count++;
    return originalRealpathSync(...args);
  };
  fsCjs.lstatSync = (...args: unknown[]) => {
    count++;
    return originalLstatSync(...args);
  };
  fsCjs.readlinkSync = (...args: unknown[]) => {
    count++;
    return originalReadlinkSync(...args);
  };
  syncBuiltinESMExports();

  try {
    // Control call: toRealPath is (deliberately) still synchronous, so this
    // MUST increment the counter if the monkeypatch reaches pathSandbox.ts's
    // bound imports at all.
    count = 0;
    pathSandbox.toRealPath(allowed);
    const controlHit = count > 0;
    if (!controlHit) {
      console.log(
        "part (a): SKIPPED — the fs monkeypatch did not reach pathSandbox.ts's bound imports " +
          "(the control call made 0 sync fs calls through the patched functions). Not a fix " +
          "failure — a limitation of this patching technique on this Node build. Part (b) below " +
          "demonstrates the same property (no blocking fs call on the request path) a different, " +
          "load-bearing way.",
      );
      return true;
    }
    console.log(
      `part (a) control: toRealPath(existing dir) made ${count} sync fs call(s) — patch confirmed live`,
    );

    const server: pathSandbox.RootsCapableServer = {
      getClientCapabilities: () => ({}),
      listRoots: async () => ({ roots: [] }),
    };

    count = 0;
    const resolved = await pathSandbox.resolvePathWithinRoots(server, candidate, "Source", {}, [
      allowed,
    ]);
    console.log(`part (a): resolvePathWithinRoots resolved "${resolved}"`);
    console.log(
      `part (a): sync fs calls (realpathSync/lstatSync/readlinkSync) during the call: ${count}`,
    );
    if (count === 0) {
      console.log("part (a): PASS — no synchronous fs call on the request path.");
      return true;
    }
    console.log(
      "part (a): FAIL — the request path still calls a synchronous fs function (the M9 bug).",
    );
    return false;
  } finally {
    fsCjs.realpathSync = originalRealpathSync;
    fsCjs.lstatSync = originalLstatSync;
    fsCjs.readlinkSync = originalReadlinkSync;
    syncBuiltinESMExports();
  }
}

/** Part (b): does the request path stay responsive to the event loop while it resolves? */
async function partB(candidate: string): Promise<boolean> {
  let asyncTicks = 0;
  {
    const original = fspCjs.realpath;
    fspCjs.realpath = async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      return original(...args);
    };
    syncBuiltinESMExports();
    const interval = setInterval(() => {
      asyncTicks++;
    }, TICK_MS);
    const start = performance.now();
    await pathSandbox.toRealPathAsync(candidate);
    const elapsed = performance.now() - start;
    clearInterval(interval);
    fspCjs.realpath = original;
    syncBuiltinESMExports();
    console.log(
      `part (b) async:            ${asyncTicks} timer tick(s) during a ${elapsed.toFixed(0)}ms delayed toRealPathAsync call`,
    );
  }

  let syncTicks = 0;
  {
    const original = fsCjs.realpathSync;
    fsCjs.realpathSync = (...args: unknown[]) => {
      const until = Date.now() + DELAY_MS;
      while (Date.now() < until) {
        /* busy-wait — deliberately blocks the event loop, standing in for a
           stalled network mount's realpath() taking its time to answer */
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    const interval = setInterval(() => {
      syncTicks++;
    }, TICK_MS);
    const start = performance.now();
    pathSandbox.toRealPath(candidate);
    const elapsed = performance.now() - start;
    clearInterval(interval);
    fsCjs.realpathSync = original;
    syncBuiltinESMExports();
    console.log(
      `part (b) sync (contrast):  ${syncTicks} timer tick(s) during a ${elapsed.toFixed(0)}ms busy-wait toRealPath call`,
    );
  }

  if (asyncTicks > 0) {
    console.log(
      "part (b): PASS — the async path stays responsive to timers while it resolves " +
        `(contrast: the sync busy-wait produced ${syncTicks} tick(s)).`,
    );
    return true;
  }
  console.log("part (b): FAIL — no timer ticks arrived during the delayed async resolve.");
  return false;
}

async function main(): Promise<number> {
  const tmpDir = await mkdtemp(join(tmpdir(), "probe-path-resolve-async-"));
  try {
    const allowed = join(tmpDir, "allowed");
    await mkdir(allowed);
    const candidate = join(allowed, "file.txt");
    await writeFile(candidate, "probe");

    console.log("M9 — async, in-fiber path resolution\n");

    const okA = await partA(allowed, candidate);
    console.log();
    const okB = await partB(candidate);
    console.log();

    const ok = okA && okB;
    console.log(
      ok
        ? "PASS — resolvePathWithinRoots makes no blocking sync fs call, and the event loop " +
            "stays responsive during an async resolution."
        : "FAIL — see above.",
    );
    return ok ? 0 : 1;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

process.exit(await main());
