/**
 * Probe M6: when two `writeFileAtomicAsync` attempts target the SAME
 * destination and are started concurrently (neither awaited before the other
 * starts), do they get independent temp files — or does the second collide
 * with the first?
 *
 * Background: `atomicTempPath` used to be a pure function of destination +
 * pid: `.<basename>.<pid>.tmp`. Two attempts on the same destination — a
 * retry racing an abandoned write, or genuinely concurrent callers — computed
 * the IDENTICAL temp path. Every cleanup in the writers (`rm(tmpPath, {force:
 * true})` on a failed write, an abort before rename, or a failed rename)
 * targeted that shared name with no ownership check, so the second attempt
 * either failed `open(…, "wx")` with EEXIST, or — if it won that race — had
 * its temp deleted out from under it by the first attempt's abort cleanup,
 * failing its own `rename`. `ConsoleStorageService.ts` used to paper over this
 * with a second `removeAtomicTemp(destPath)` call on interrupt, recomputing
 * the same name; that call is gone (M3/M8), so this is now the only guard.
 *
 * This probe starts two `writeFileAtomicAsync` attempts on the same
 * destination without awaiting either first, records each attempt's temp
 * path via `onTempCreated`, and aborts the first attempt's OWN controller
 * from inside its own `onTempCreated` callback — i.e. right after its temp
 * exists on disk but before its rename. The second attempt is never touched
 * and should publish normally.
 *
 *   Before the fix: the two attempts race for the SAME temp name -> the
 *   loser hits EEXIST at open(), or (if it opened first) has its temp deleted
 *   by the aborted attempt's cleanup and fails at rename with ENOENT ->
 *   BLOCKED, exit 1.
 *   After the fix: each attempt gets a temp name carrying its own random
 *   nonce -> both opens succeed, the aborted attempt's cleanup only ever
 *   touches its own temp, the survivor renames cleanly, and `readdir(dir)`
 *   is exactly `[target]` -> PASS, exit 0.
 *
 * No credentials, no network. Everything happens under a fresh temp
 * directory this script creates and removes.
 *
 * Run:  npx tsx scripts/probe-atomic-temp.mts
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicAsync } from "../src/atomicWrite.js";

const t0 = performance.now();
function mark(label: string): void {
  console.log(`[+${(performance.now() - t0).toFixed(1).padStart(7)}ms] ${label}`);
}

async function settled(p: Promise<void>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await p;
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "probe-atomic-temp-"));
  try {
    const target = join(dir, "shared.json");
    const observedTemps: string[] = [];
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    mark("starting two overlapping writeFileAtomicAsync attempts on the same destination");

    const attemptA = writeFileAtomicAsync(target, "from A", {
      mode: 0o600,
      signal: controllerA.signal,
      onTempCreated: (tmpPath) => {
        mark(`A: temp created -> ${tmpPath}`);
        observedTemps.push(tmpPath);
        mark("A: aborting itself mid-write (before its own rename)");
        controllerA.abort();
      },
    });

    const attemptB = writeFileAtomicAsync(target, "from B", {
      mode: 0o600,
      signal: controllerB.signal,
      onTempCreated: (tmpPath) => {
        mark(`B: temp created -> ${tmpPath}`);
        observedTemps.push(tmpPath);
      },
    });

    const [resultA, resultB] = await Promise.all([settled(attemptA), settled(attemptB)]);
    console.log();

    if (resultA.ok) {
      console.log(
        "FAIL — attempt A was aborted from inside its own onTempCreated but resolved anyway.",
      );
      return 1;
    }
    mark(`A rejected as expected: ${resultA.message}`);

    if (!resultB.ok) {
      console.log();
      console.log(`FAIL — attempt B (never aborted) rejected: ${resultB.message}`);
      console.log("       This is the M6 collision: B's open()/rename hit the SAME temp name as A");
      console.log("       (EEXIST at open, or ENOENT at rename after A's cleanup deleted it).");
      return 1;
    }
    mark("B resolved — the survivor published");

    if (observedTemps.length !== 2 || observedTemps[0] === observedTemps[1]) {
      console.log();
      console.log(
        `FAIL — expected two distinct temp names, observed: ${JSON.stringify(observedTemps)}`,
      );
      return 1;
    }
    mark(
      `temp names differ:\n            A: ${observedTemps[0]}\n            B: ${observedTemps[1]}`,
    );

    const content = await readFile(target, "utf-8");
    if (content !== "from B") {
      console.log();
      console.log(`FAIL — target has unexpected content: ${JSON.stringify(content)}`);
      return 1;
    }

    const listing = (await readdir(dir)).sort();
    if (listing.length !== 1 || listing[0] !== "shared.json") {
      console.log();
      console.log(`FAIL — directory is not clean, contains: ${JSON.stringify(listing)}`);
      return 1;
    }
    mark(`readdir(dir) = ${JSON.stringify(listing)} — no stray temps left behind`);

    console.log();
    console.log("PASS — two overlapping attempts on one destination got distinct temp names;");
    console.log("       aborting one left the other's temp untouched and it published cleanly.");
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

process.exit(await main());
