/**
 * Probe M12: does `uploadFileToBucket` release the transfer permit as soon as
 * the bytes are ACCEPTED, or does it hold the permit through status polling?
 *
 * Background: `ConsoleStorageService`'s `transferLock` is a size-1 semaphore
 * meant to bound peak memory (only one payload — plaintext + Seal ciphertext —
 * in flight at a time, across uploads and downloads). Before the fix, the
 * permit wrapped the WHOLE upload body, including `pollUntilTerminal`, which
 * can run up to `UPLOAD_POLL_ATTEMPTS` (90) x 2s of real wall-clock time
 * holding NOTHING but ids by that point. A second transfer — upload or
 * download — could not even start until the first one's poll finished, even
 * though there was no payload left to bound.
 *
 * This probe forks two uploads through a stubbed `ConsoleStorageService`:
 * upload A's status check never reaches a terminal state (so its poll would
 * run forever, pre-fix, if the permit were still held); upload B's status
 * check completes immediately. It waits (capped, so a still-broken tree
 * fails fast instead of hanging) for B's upload POST to fire, then for B to
 * finish, and prints a timestamped timeline.
 *
 *   Before the fix: B's POST never fires within the cap (A holds the permit
 *   through its unbounded poll) -> BLOCKED, exit 1.
 *   After the fix: B's POST fires within milliseconds of "A accepted", and B
 *   finishes -> PASS, exit 0.
 *
 * Also demonstrates that the split left the OTHER guard — the per-transfer
 * byte cap (`transferLimits.ts` / `CONSOLE_MCP_MAX_TRANSFER_BYTES`) — intact:
 * set that env var before running and the probe instead confirms an oversized
 * source file is still rejected before it ever reaches the permit.
 *
 * No credentials, no network: `ConsoleApiClient` and `SealCryptoService` are
 * stubbed exactly like `tests/storageTransfer.test.ts`. Everything happens
 * under a fresh temp directory this script creates and removes.
 *
 * Run:  npx tsx scripts/probe-transfer-permit.mts
 *       CONSOLE_MCP_MAX_TRANSFER_BYTES=5 npx tsx scripts/probe-transfer-permit.mts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config.js";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient.js";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService.js";
import type { RosterChainDeps } from "../src/console/rosterVerification.js";
import { SealCryptoService } from "../src/console/SealCryptoService.js";
import { BucketId, FileId } from "../src/console/types.js";
import { MAX_TRANSFER_BYTES_ENV } from "../src/transferLimits.js";

const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_probe_key"),
  servicePrivateKey: Redacted.make("suiprivkey1probe"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: "",
  keyAdminAddress: "",
};

// Nothing in this probe creates a bucket, so an unreachable stub is enough —
// stated rather than defaulted, so this can never accidentally reach a real
// fullnode.
const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

const t0 = performance.now();
function mark(label: string): void {
  console.log(`[+${(performance.now() - t0).toFixed(1).padStart(7)}ms] ${label}`);
}

function buildLayer(api: unknown, seal: unknown) {
  return ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
        NO_CHAIN_READS,
      ),
    ),
  );
}

/** Main scenario: does B's POST wait on A's (never-ending) poll? */
async function runPermitDemo(tmpDir: string): Promise<number> {
  const srcFile = join(tmpDir, "note.txt");
  await writeFile(srcFile, "hello, permit probe");

  let uploadCount = 0;
  const api = {
    uploadBucketFile: () =>
      Effect.sync(() => {
        uploadCount += 1;
        const n = uploadCount;
        mark(n === 1 ? "A accepted" : "B upload POST");
        return { data: { id: FileId.make(`file-${n}`) } };
      }),
    // file-1 (upload A) never reaches a terminal state: pre-fix, that keeps the
    // permit held forever, since polling ran INSIDE `withPermits(1)`.
    getFileUploadStatus: (_bucketId: BucketId, fileId: FileId) =>
      fileId === FileId.make("file-1")
        ? Effect.never
        : Effect.succeed({ data: { state: "completed" as const } }),
  };
  const seal = { encrypt: (plaintext: Uint8Array) => Effect.succeed(plaintext) };
  const layer = buildLayer(api, seal);

  const uploadEffect = ConsoleStorageService.pipe(
    Effect.flatMap((s) => s.uploadFileToBucket(BucketId.make("bucket-1"), "0xpolicy", srcFile)),
  );

  const program = Effect.gen(function* () {
    const a = yield* Effect.fork(uploadEffect);
    // Give A a chance to clear its payload phase and start its (never-ending)
    // poll before B is forked.
    yield* Effect.sleep("20 millis");
    const b = yield* Effect.fork(uploadEffect);

    // Cap the wait: a still-broken tree would otherwise hang for A's full
    // 90 x 2s poll budget before B's POST ever fires.
    yield* Fiber.join(b).pipe(Effect.timeout("3 seconds"));
    mark("B done");

    yield* Fiber.interrupt(a);
  }).pipe(Effect.provide(layer));

  const exit = await Effect.runPromiseExit(program);

  console.log();
  if (Exit.isSuccess(exit)) {
    console.log("PASS — B's upload POST was not blocked on A's still-running poll.");
    return 0;
  }
  console.log("BLOCKED — B's upload POST did not fire within the 3s cap.");
  console.log(
    "          The permit was still held across status polling — this is the M12 finding.",
  );
  return 1;
}

/** Caveat scenario: confirm the byte cap (a different guard) is unaffected. */
async function runByteCapDemo(tmpDir: string, overrideBytes: string): Promise<number> {
  const cap = Number(overrideBytes);
  const oversizedContent = "x".repeat(Math.max(cap, 0) + 16);
  const srcFile = join(tmpDir, "oversized.bin");
  await writeFile(srcFile, oversizedContent);

  mark(
    `${MAX_TRANSFER_BYTES_ENV}=${overrideBytes}; source file is ${oversizedContent.length} bytes`,
  );

  const api = {
    uploadBucketFile: () =>
      Effect.sync(() => {
        mark("upload POST (should not be reached — cap should reject the read first)");
        return { data: { id: FileId.make("file-should-not-exist") } };
      }),
    getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
  };
  const seal = { encrypt: (plaintext: Uint8Array) => Effect.succeed(plaintext) };
  const layer = buildLayer(api, seal);

  const program = ConsoleStorageService.pipe(
    Effect.flatMap((s) => s.uploadFileToBucket(BucketId.make("bucket-1"), "0xpolicy", srcFile)),
    Effect.provide(layer),
  );

  const exit = await Effect.runPromiseExit(program);

  console.log();
  if (Exit.isFailure(exit)) {
    const message = String(exit.cause);
    if (message.includes("byte limit")) {
      mark("rejected before upload — the byte cap fired, unaffected by the M12 permit split");
      console.log("PASS — the byte cap still rejects an oversized file before any bytes ship.");
      return 0;
    }
    console.log(`FAIL — rejected, but not for the byte cap:\n${message}`);
    return 1;
  }
  console.log("FAIL — an oversized file was accepted; the byte cap did not fire.");
  return 1;
}

async function main(): Promise<number> {
  const tmpDir = await mkdtemp(join(tmpdir(), "probe-transfer-permit-"));
  try {
    const overrideBytes = process.env[MAX_TRANSFER_BYTES_ENV];
    if (overrideBytes !== undefined) {
      console.log(`Byte-cap caveat run (${MAX_TRANSFER_BYTES_ENV}=${overrideBytes})\n`);
      return await runByteCapDemo(tmpDir, overrideBytes);
    }
    console.log("Permit-scope run (M12)\n");
    return await runPermitDemo(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

process.exit(await main());
