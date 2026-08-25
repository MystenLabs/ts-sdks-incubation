/**
 * Live e2e against the COMG-746/761 staging API.
 *
 * Verifies the clud-bot F1 finding (PR #44 discussion_r3812554546): a create-bucket
 * PTB from a real Console must not be signable with a substituted admin recipient.
 * The shipped arm deleted `add_admin`, pins `add_owner` to the local owner pin,
 * and authors `members` rather than trusting the server's roster.
 *
 * Usage: pnpm tsx scripts/e2e-comg761-create-bucket.mts
 *
 * Reads the real installer config (~/.config/walrus-console-mcp/config.json).
 * Prints no secrets.
 */
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { Effect } from "effect";
import { getKeyAdminAddress, getWebAccountAddress, ConsoleConfigTag } from "../src/config.js";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient.js";
import { ConsoleStorageService } from "../src/console/ConsoleStorageService.js";
import { resolvePackageConfigForBaseUrl } from "../src/console/packageConfig.js";
import { SealCryptoService } from "../src/console/SealCryptoService.js";
import { SpaceId } from "../src/console/types.js";
import { assertExpectedTransaction } from "../src/console/txValidation.js";
import { AppRuntime, unwrapFiberFailure } from "../src/runtime.js";

function commandGraph(bytesBase64: string): string[] {
  const data = Transaction.from(fromBase64(bytesBase64)).getData();
  return data.commands.map((command) => {
    const call = (command as { MoveCall?: { package: string; module: string; function: string } })
      .MoveCall;
    if (!call) return Object.keys(command as object)[0] ?? "unknown";
    return `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}`;
  });
}

const program = Effect.gen(function* () {
  const cfg = yield* ConsoleConfigTag;
  const api = yield* ConsoleApiClient;
  const storage = yield* ConsoleStorageService;
  const seal = yield* SealCryptoService;

  const owner = getWebAccountAddress(cfg);
  const manager = getKeyAdminAddress(cfg);
  if (owner === undefined) {
    return yield* Effect.fail(
      new Error("No owner pin — run `walrus-console-mcp config` against this deployment first."),
    );
  }

  const report: Record<string, unknown> = {
    baseUrl: cfg.baseUrl,
    ownerPin: owner,
    managerPin: manager ?? null,
  };

  const spaces = yield* api.listSpaces();
  report.spaces = spaces.map((s) => ({
    id: s.id,
    type: s.type,
    name: s.name,
    bucket_count: s.bucket_count,
  }));
  const space = spaces[0];
  if (space === undefined) {
    return yield* Effect.fail(new Error("This key has no spaces on this deployment."));
  }
  const spaceId = SpaceId.make(space.id);

  const signers = yield* api.listSpaceSigners();
  report.spaceSigners = {
    count: signers.signers.length,
    scopes: signers.signers.map((s) => s.scope),
    addresses: signers.signers.map((s) => normalizeSuiAddress(s.service_signer_address)),
  };

  const listed = yield* api.listBuckets({ spaceId, visibility: "private" });
  report.existingPrivateBuckets = listed.buckets.length;

  const signerAddress = (yield* seal.getKeypair("working")).toSuiAddress();
  report.signerAddress = normalizeSuiAddress(signerAddress);

  // Inspect-only reserve: decode the live PTB and run the F1 validator against
  // it. Not finalized — a pending reservation is cheaper than duplicating the
  // product path, and the full create below is what actually lands a bucket.
  const inspectName = `e2e-f1-inspect-${Date.now()}`;
  const reserve = yield* api.createBucket(spaceId, inspectName, owner, []);
  const graph = commandGraph(reserve.bytes);
  // Resolve by BASE URL: the staging deploy runs a republished contract, so a
  // network-keyed lookup would pin the wrong package and refuse every signature.
  const packageConfig = resolvePackageConfigForBaseUrl(cfg.baseUrl);
  const pkg = normalizeSuiAddress(packageConfig.packageId);
  report.inspect = {
    bucketId: reserve.bucket_id,
    commandCount: graph.length,
    commands: graph.map((t) => t.split("::").slice(-2).join("::")),
    hasAddAdmin: graph.some((t) => t.endsWith("::add_admin")),
    hasAddOwner: graph.some((t) => t.endsWith("::add_owner")),
    revokeCount: graph.filter((t) => t.endsWith("::revoke_permission")).length,
    lastCommand: graph.at(-1)?.split("::").slice(-2).join("::"),
    packageMatchesConfig: graph.every(
      (t) =>
        t.startsWith(pkg) ||
        t.startsWith(normalizeSuiAddress(packageConfig.permissionedGroupPackageId)) ||
        t.startsWith(normalizeSuiAddress("0x2")),
    ),
  };

  const f1 = {
    addAdminRejectedByAllowlist: !graph.some((t) => t.endsWith("::add_admin")),
    validatorAccepted: false as boolean,
    validatorError: null as string | null,
  };
  try {
    assertExpectedTransaction(
      reserve.bytes,
      signerAddress,
      {
        kind: "createBucketIdentity",
        ownerAddress: owner,
        expectedMembers: [],
        ...(manager === undefined ? {} : { managerAddress: manager }),
      },
      packageConfig,
      manager,
    );
    f1.validatorAccepted = true;
  } catch (err) {
    f1.validatorError = err instanceof Error ? err.message : String(err);
  }
  report.f1 = f1;

  const created = yield* storage.createBucket(spaceId, `e2e-f1-${Date.now()}`);
  report.create = {
    bucketId: created.bucketId,
    sealPolicyId: created.sealPolicyId,
    provisioningState: created.provisioningState,
    identity: {
      owner: created.identity.owner,
      signerRole: created.identity.signerRole,
      memberCount: created.identity.members.length,
      members: created.identity.members,
      manager: created.identity.manager ?? null,
    },
    roster: created.roster,
    anchorRecorded: created.anchorRecorded,
    disclosure: created.disclosure,
    ownerMatchesPin: normalizeSuiAddress(created.identity.owner) === normalizeSuiAddress(owner),
  };

  return report;
});

try {
  const report = await AppRuntime.runPromise(program);
  console.log(JSON.stringify(report, null, 2));
  const f1 = report.f1 as {
    addAdminRejectedByAllowlist: boolean;
    validatorAccepted: boolean;
    validatorError: string | null;
  };
  const create = report.create as { ownerMatchesPin: boolean; roster: { reason: string } };
  const ok =
    f1.addAdminRejectedByAllowlist &&
    f1.validatorAccepted &&
    create.ownerMatchesPin &&
    typeof create.roster.reason === "string";
  process.exit(ok ? 0 : 2);
} catch (err) {
  const unwrapped = unwrapFiberFailure(err);
  console.error(
    JSON.stringify(
      {
        failed: true,
        tag: (unwrapped as { _tag?: string })._tag ?? null,
        reason: (unwrapped as { reason?: string }).reason ?? null,
        message: unwrapped instanceof Error ? unwrapped.message : String(unwrapped),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
