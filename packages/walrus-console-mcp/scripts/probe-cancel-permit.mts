/**
 * Probe M8: when an MCP request is cancelled mid-encrypt, does the transfer
 * permit stay held until the abandoned Seal promise settles — or is a second
 * payload admitted while the first one is still live in memory?
 *
 * Background: `ConsoleStorageService`'s `transferLock` is a size-1 semaphore
 * that bounds peak memory to one payload phase at a time (plaintext + Seal
 * ciphertext ~= 2 x cap). `Effect.tryPromise` does NOT cancel the promise it
 * wraps — on interruption it aborts the signal it handed the callback and then
 * abandons the promise — and no Seal 1.3.x API takes a signal, so a cancelled
 * `sealClient.encrypt`/`decrypt` keeps running with both buffers reachable.
 * Meanwhile the permit is released during fiber teardown, so a retry starts its
 * OWN payload phase immediately: peak memory exceeds the 1 x 2 x cap the
 * semaphore is supposed to guarantee. `src/effectPromise.ts`'s
 * `tryPromiseSettling` closes that by holding the fiber's interruption open —
 * uninterruptibly, and therefore ahead of the semaphore's release — until the
 * abandoned promise settles or a bound expires.
 *
 * This probe drives the real `ConsoleStorageService` (its real semaphore) with
 * a stubbed `ConsoleApiClient` and a stubbed `SealCryptoService` whose `encrypt`
 * is `tryPromiseSettling` around a gate the probe controls — the same shape the
 * real `SealCryptoService.encrypt` now has, stubbed the way
 * `tests/storageTransfer.test.ts` stubs it. Upload A runs under an
 * `AbortController` (what an MCP request cancellation does, via
 * `runPromise(effect, signal)` in `src/runtime.ts`) and is aborted while its
 * encrypt promise is still pending; upload B starts right after, and the probe
 * times when B's encrypt is entered.
 *
 *   Scenario 1 (default bound): B must NOT start while A's gate is closed.
 *     -> `HELD` when it waits, `OVERLAP` (the finding) when it does not.
 *   Scenario 2 (`settleTimeoutMs: 500`, a gate that never opens): the wait must
 *     be bounded, or this trades a memory bug for a deadlock. Expect the
 *     "releasing the transfer permit …" line on stderr after ~500ms and B to
 *     proceed -> `BOUND-EXPIRED`.
 *
 * Exit 0 only when BOTH scenarios show the fixed behaviour.
 *
 * No credentials, no network. Everything happens under a fresh temp directory
 * this script creates and removes.
 *
 * Run:  npx tsx scripts/probe-cancel-permit.mts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config.js";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient.js";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService.js";
import type { RosterChainDeps } from "../src/console/rosterVerification.js";
import { SealCryptoService } from "../src/console/SealCryptoService.js";
import { BucketId, FileId } from "../src/console/types.js";
import { tryPromiseSettling } from "../src/effectPromise.js";

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

/**
 * Record every stderr line the code under test writes, and let it through. The
 * bound-expiry message is the observable this probe checks in scenario 2, and
 * reading it directly beats inferring it from timing.
 */
const stderrLines: string[] = [];
const realConsoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  stderrLines.push(args.map(String).join(" "));
  realConsoleError(...args);
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Poll a predicate up to `capMs`, so a broken tree fails fast instead of hanging. */
async function waitUntil(predicate: () => boolean, capMs: number): Promise<boolean> {
  const deadline = performance.now() + capMs;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
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

function stubApi() {
  let uploads = 0;
  return {
    uploadBucketFile: () =>
      Effect.sync(() => {
        uploads += 1;
        return { data: { id: FileId.make(`file-${uploads}`) } };
      }),
    getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
  };
}

interface Scenario {
  /**
   * Whether A's abandoned encrypt promise is ever allowed to settle. False models
   * a Seal key server that accepted the request and then stopped answering — the
   * case the settle bound exists for.
   */
  readonly gateEventuallyOpens: boolean;
  /** How long the interrupt cleanup waits before releasing anyway. */
  readonly settleTimeoutMs: number;
}

/**
 * Runs upload A under an AbortSignal, aborts it mid-encrypt, then starts upload
 * B and reports how long B waited for the permit.
 */
async function runCancelledRetry(
  tmpDir: string,
  name: string,
  scenario: Scenario,
): Promise<{ waitedForGate: boolean; bHeldMs: number; bCompleted: boolean }> {
  const srcFile = join(tmpDir, `${name}.bin`);
  await writeFile(srcFile, "seal-probe payload");

  const gateA = deferred<void>();
  let encryptCalls = 0;
  let bEncryptStarted = false;

  const seal = {
    encrypt: (plaintext: Uint8Array) =>
      tryPromiseSettling({
        try: () => {
          encryptCalls += 1;
          const which = encryptCalls === 1 ? "A" : "B";
          mark(`encrypt ${which} entered — holds plaintext + ciphertext`);
          if (which === "B") bEncryptStarted = true;
          return which === "A"
            ? gateA.promise.then(() => {
                mark("encrypt A's promise finally settled");
                return plaintext;
              })
            : Promise.resolve(plaintext);
        },
        catch: (cause) => cause as Error,
        settleTimeoutMs: scenario.settleTimeoutMs,
        label: "Seal encrypt",
      }),
  };

  const runtime = ManagedRuntime.make(buildLayer(stubApi(), seal));
  const uploadEffect = ConsoleStorageService.pipe(
    Effect.flatMap((s) => s.uploadFileToBucket(BucketId.make("bucket-1"), "0xpolicy", srcFile)),
  );

  try {
    const abort = new AbortController();
    mark("upload A: started under an MCP request AbortSignal");
    // Deliberately not awaited: this promise does not settle until the abandoned
    // encrypt does, which is the property under test.
    const aDone = runtime.runPromise(uploadEffect, { signal: abort.signal }).then(
      () => "completed",
      () => "interrupted",
    );

    if (!(await waitUntil(() => encryptCalls >= 1, 2000))) {
      throw new Error("upload A never reached encrypt");
    }

    mark("upload A: MCP request cancelled while encrypt's promise is still pending");
    abort.abort();

    mark("upload B: started (the retry an agent issues after a cancel)");
    const bStartedAt = performance.now();
    const bDone = runtime.runPromise(uploadEffect).then(
      () => true,
      () => false,
    );

    // Long enough that an unheld permit is unmistakable, short enough that
    // scenario 2's 500ms bound has not expired yet.
    const startedImmediately = await waitUntil(() => bEncryptStarted, 250);
    if (!startedImmediately) {
      mark("upload B: still waiting — the permit is held by the cancelled upload A");
      if (scenario.gateEventuallyOpens) gateA.resolve();
    }

    const bCompleted = (await waitUntil(() => bEncryptStarted, 3000)) && (await bDone);
    const bHeldMs = performance.now() - bStartedAt;
    mark(`upload B: completed=${bCompleted}; upload A finished as ${await aDone}`);

    return { waitedForGate: !startedImmediately, bHeldMs, bCompleted };
  } finally {
    await runtime.dispose();
  }
}

/** Scenario 1: does a cancelled upload's permit outlive its abandoned promise? */
async function runOverlapScenario(tmpDir: string): Promise<number> {
  console.log("Scenario 1 — cancellation must not admit a second payload (M8)\n");

  const result = await runCancelledRetry(tmpDir, "scenario-1", {
    gateEventuallyOpens: true,
    // Well above anything this scenario needs: the gate is what releases B here,
    // not the bound, so a bound that fired first would mask the property.
    settleTimeoutMs: 5_000,
  });

  console.log();
  if (!result.waitedForGate) {
    console.log("OVERLAP — B's encrypt began while A's abandoned promise was still pending.");
    console.log("          Two payloads are live at once; the size-1 permit bounded nothing.");
    console.log("          This is the M8 finding.");
    return 1;
  }
  if (!result.bCompleted) {
    console.log("DEADLOCK — B never completed even after A's promise settled.");
    return 1;
  }
  console.log("HELD — B's encrypt waited until A's abandoned promise settled.");
  console.log("       Only one payload was ever live, which is what the permit promises.");
  return 0;
}

/** Scenario 2: a promise that never settles must not wedge the permit forever. */
async function runBoundScenario(tmpDir: string): Promise<number> {
  console.log("\nScenario 2 — the settle wait is bounded (settleTimeoutMs=500)\n");

  const before = stderrLines.length;
  const result = await runCancelledRetry(tmpDir, "scenario-2", {
    gateEventuallyOpens: false,
    settleTimeoutMs: 500,
  });
  const expired = stderrLines
    .slice(before)
    .some((line) =>
      line.includes(
        "[console-mcp] releasing the transfer permit while a cancelled Seal encrypt is still pending",
      ),
    );

  console.log();
  if (!result.waitedForGate) {
    console.log("OVERLAP — B started immediately; the permit was not held at all.");
    return 1;
  }
  if (!result.bCompleted) {
    console.log("DEADLOCK — B never completed; the settle wait is unbounded.");
    return 1;
  }
  if (!expired) {
    console.log("FAIL — B proceeded, but the bound-expiry line never appeared on stderr.");
    return 1;
  }
  console.log(
    `BOUND-EXPIRED — B waited ${result.bHeldMs.toFixed(0)}ms, then the bound released the permit`,
  );
  console.log("                and said so on stderr. Held, not deadlocked.");
  return 0;
}

async function main(): Promise<number> {
  const tmpDir = await mkdtemp(join(tmpdir(), "probe-cancel-permit-"));
  try {
    const overlap = await runOverlapScenario(tmpDir);
    const bound = await runBoundScenario(tmpDir);
    return overlap === 0 && bound === 0 ? 0 : 1;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

process.exit(await main());
