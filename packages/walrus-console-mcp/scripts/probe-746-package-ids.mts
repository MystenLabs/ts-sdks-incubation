/**
 * Probe the live COMG-746/761 staging API for the republished contract's
 * package ids and the exact create-bucket PTB shape.
 *
 * COMG-746 is "align with the republished contract": the bucket-policy package
 * was republished, so `src/console/packageConfig.ts` (a hand-copied mirror of
 * harbor's constants) goes stale and every signature refuses. This reads the
 * ids back out of a real reserve rather than trusting any document.
 *
 * The reserve is left un-finalized: no gas is spent and no bucket is created.
 *
 * Usage: pnpm tsx scripts/probe-746-package-ids.mts
 * Prints no secrets.
 */
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { Effect } from "effect";
import { ConsoleConfigTag, getWebAccountAddress } from "../src/config.js";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient.js";
import { SpaceId } from "../src/console/types.js";
import { AppRuntime, unwrapFiberFailure } from "../src/runtime.js";

interface MoveCallLike {
  package: string;
  module: string;
  function: string;
  typeArguments?: readonly string[];
}

const program = Effect.gen(function* () {
  const cfg = yield* ConsoleConfigTag;
  const api = yield* ConsoleApiClient;
  const owner = getWebAccountAddress(cfg);
  if (owner === undefined) return yield* Effect.fail(new Error("no owner pin configured"));

  const spaces = yield* api.listSpaces();
  const space = spaces[0];
  if (space === undefined) return yield* Effect.fail(new Error("this key has no spaces"));

  const reserve = yield* api.createBucket(
    SpaceId.make(space.id),
    `pkgprobe-${Date.now()}`,
    owner,
    [],
  );
  const data = Transaction.from(fromBase64(reserve.bytes)).getData();

  const calls = data.commands
    .map((c) => (c as { MoveCall?: MoveCallLike }).MoveCall)
    .filter((c): c is MoveCallLike => c !== undefined);

  const packagesByModule: Record<string, string[]> = {};
  for (const call of calls) {
    const seen = (packagesByModule[call.module] ??= []);
    const id = normalizeSuiAddress(call.package);
    if (!seen.includes(id)) seen.push(id);
  }

  const typeArguments = [...new Set(calls.flatMap((c) => c.typeArguments ?? []))];

  const objectInputs: string[] = [];
  for (const input of data.inputs) {
    const object = (input as { Object?: Record<string, { objectId?: string }> }).Object;
    if (!object) continue;
    for (const value of Object.values(object)) {
      if (value?.objectId) objectInputs.push(normalizeSuiAddress(value.objectId));
    }
  }

  return {
    reservedBucketId: reserve.bucket_id,
    ownerEcho: reserve.owner_address ?? null,
    adminEcho: reserve.admin_signer_address ?? null,
    sequence: calls.map((c) => `${c.module}::${c.function}`),
    packagesByModule,
    typeArguments,
    objectInputs,
  };
});

try {
  console.log(JSON.stringify(await AppRuntime.runPromise(program), null, 2));
} catch (err) {
  const unwrapped = unwrapFiberFailure(err);
  console.error(unwrapped instanceof Error ? unwrapped.message : String(unwrapped));
  process.exit(1);
}
