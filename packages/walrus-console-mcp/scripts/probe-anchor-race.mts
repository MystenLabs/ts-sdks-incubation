/**
 * Probe M5: does `recordAnchor`'s read-modify-write race across processes?
 *
 * Background: pre-fix, `recordAnchor` (src/console/anchorStore.ts) loads
 * anchors.json, adds one group, and writes the whole file back with no lock.
 * Four `create_bucket` calls landing on different processes -- concurrent
 * server instances, or a CLI run overlapping a server -- each do this
 * independently; whichever finishes its write last wins, and every earlier
 * writer's group is silently dropped. Worse, every one of those writers still
 * reports `anchorRecorded: true`: `ConsoleStorageService.createBucket`
 * derives that flag from the local write not throwing, never from
 * re-reading, so the loser's `true` is false.
 *
 * This probe spawns 4 `npx tsx` children sharing one `XDG_CONFIG_HOME`, each
 * recording a distinct group into the same space with an aligned start (same
 * busy-wait-until-startAt mechanism as tests/configFile.concurrency.test.ts
 * and tests/anchorStore.test.ts's "concurrent writers" test). Losing an
 * update is a race, not a certainty, so one round is not reliable evidence
 * either way: this probe repeats the race up to 5 times and reports `LOST n`
 * (exit 1) if any round ends with fewer than 4 recorded groups.
 *
 *   Before the fix: at least one round loses an update -> LOST n, exit 1.
 *   After the fix: every round keeps all 4 groups, and `.anchors.json.lock`
 *   does not exist once the last round's record completes -> PASS, exit 0.
 *
 * No credentials, no network. Everything happens under fresh temp
 * directories this script creates and removes, one per round.
 *
 * Run:  npx tsx scripts/probe-anchor-race.mts
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getConfigDir } from "../src/configFile.js";
import { readAnchors } from "../src/console/anchorStore.js";

const MODULE = path.join(import.meta.dirname, "..", "src", "console", "anchorStore.ts");
const ROUNDS = 5;
const GROUPS = ["group_1", "group_2", "group_3", "group_4"];
const CREATOR = `0x${"c".repeat(64)}`;

const t0 = performance.now();
function mark(label: string): void {
  console.log(`[+${(performance.now() - t0).toFixed(1).padStart(7)}ms] ${label}`);
}

function runChild(tmpDir: string, groupId: string, startAt: number): Promise<number | null> {
  const file = path.join(tmpDir, `record-${groupId}.mts`);
  const payload = JSON.stringify({
    groupId,
    bucketId: `bucket_for_${groupId}`,
    creator: CREATOR,
    recordedAt: "2026-08-21T00:00:00.000Z",
  });
  fs.writeFileSync(
    file,
    `import { recordAnchor } from ${JSON.stringify(MODULE)};\n` +
      `while (Date.now() < ${startAt}) {}\n` +
      `recordAnchor("space_1", ${payload});\n`,
  );
  const child = spawn("npx", ["tsx", file], {
    env: { ...process.env, XDG_CONFIG_HOME: tmpDir },
    stdio: "ignore",
  });
  return new Promise((resolve) => child.on("exit", resolve));
}

interface RoundResult {
  readonly groups: string[];
  readonly lockPath: string;
  readonly tmpDir: string;
}

/** Runs one round of 4 racing children and reads back what survived. */
async function runRound(round: number): Promise<RoundResult> {
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), `wcm-anchor-race-r${round}-`));
  const startAt = Date.now() + 1200;
  const codes = await Promise.all(GROUPS.map((g) => runChild(tmpDir, g, startAt)));
  if (!codes.every((c) => c === 0)) {
    throw new Error(`round ${round}: a child process exited non-zero (${codes.join(",")})`);
  }

  // getConfigDir()/readAnchors() read XDG_CONFIG_HOME at call time, so this
  // process can inspect each round's isolated directory without re-exec'ing.
  const originalXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
  const groups = readAnchors("space_1")
    .map((a) => a.groupId)
    .sort();
  const lockPath = path.join(getConfigDir(), ".anchors.json.lock");
  if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalXdg;

  return { groups, lockPath, tmpDir };
}

console.log("Anchor-race probe (M5)\n");

let lostRounds = 0;
let staleLock = false;
for (let round = 1; round <= ROUNDS; round++) {
  const { groups, lockPath, tmpDir } = await runRound(round);
  const complete = groups.length === GROUPS.length;
  mark(
    `round ${round}: ${groups.length}/4 groups kept [${groups.join(", ")}]${complete ? "" : " <- LOST"}`,
  );
  if (!complete) lostRounds++;
  if (complete && fs.existsSync(lockPath)) {
    staleLock = true;
    mark(`round ${round}: .anchors.json.lock is still present at ${lockPath}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (lostRounds > 0) {
  console.log(`\nLOST ${lostRounds} — at least one of ${ROUNDS} rounds lost an update.`);
  console.log("           This is the M5 finding: recordAnchor's read-modify-write races.");
  process.exit(1);
}

if (staleLock) {
  console.log(
    "\nBLOCKED — every round kept all 4 groups, but the lock file outlived a completed record.",
  );
  process.exit(1);
}

console.log(
  `\nPASS — all ${ROUNDS} rounds kept all 4 groups, and .anchors.json.lock is gone each time.`,
);
process.exit(0);
