import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bcs } from "@mysten/sui/bcs";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/atomicWrite";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { MAX_ANCHORS_PER_SPACE, readAnchors, recordAnchor } from "../src/console/anchorStore";
import { ConsoleApiClient, type SpaceSignersResponse } from "../src/console/ConsoleApiClient";
import {
  ConsoleStorageService,
  deriveBucketGroupId,
  RosterChainDepsTag,
} from "../src/console/ConsoleStorageService";
import { TESTNET_PACKAGE_CONFIG } from "../src/console/packageConfig";
import type {
  MemberFieldPage,
  RosterChainDeps,
  SimulationRead,
} from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { SpaceId } from "../src/console/types";
import type {
  CreateBucketIdentitySummary,
  SponsoredTxExpectation,
} from "../src/console/txValidation";

/**
 * Spies on `writeFileAtomic` (`{ spy: true }` keeps every other call's real
 * behaviour — `spyOn(container, "writeFileAtomic").mockImplementation(original)`,
 * per `@vitest/mocker`) so a single test can fail the NEXT write with
 * `mockImplementationOnce` instead of `chmod`ing the config dir. `chmod 0o500`
 * is a no-op under root (root ignores DAC entirely), which made the old version
 * of these tests pass locally and fail in a privileged container — see m2 in
 * `docs/pr44-major-findings-verification.md`. This seam has no such
 * dependency: it fails the call regardless of who is running the process.
 */
vi.mock("../src/atomicWrite", { spy: true });

afterEach(() => {
  // A leaked `mockImplementationOnce` from a test that failed before consuming
  // it would otherwise fail the NEXT write in the NEXT test — `mockReset`
  // clears the once-queue and, because this is a real spy, falls back to the
  // original `writeFileAtomic` rather than a permanent no-op.
  vi.mocked(writeFileAtomic).mockReset();
});

/**
 * The create-bucket flow as a whole: pin gate → verified roster → reserve → echo
 * diagnostics → sign → finalize → anchor.
 *
 * `txValidation.test.ts` proves the PTB checks; `rosterVerification.test.ts`
 * proves the roster decisions. What is only provable HERE is the wiring, and the
 * wiring is where this flow can quietly become worthless:
 *
 *  - the roster authored onto the reserve and the roster ENFORCED at the signer
 *    must be the same object, not two computations that happen to agree today;
 *  - `bootstrap`, `no_other_signers`, `no_admitted_anchor` and `chain_verified`
 *    produce IDENTICAL bytes and identical server state, so only the returned
 *    result tells a benign empty roster from a consequential one; and
 *  - the anchor has to be recorded, or every future create in this space falls
 *    back to bootstrap forever and the scheme never becomes inductive.
 */

// === Fixtures =============================================================

const CONFIG = TESTNET_PACKAGE_CONFIG;
const ORIGINAL = normalizeSuiAddress(CONFIG.originalPackageId);
const GROUP_PKG = normalizeSuiAddress(CONFIG.permissionedGroupPackageId);
const GROUP_TYPE = normalizeStructTag(
  `${GROUP_PKG}::permissioned_group::PermissionedGroup<${ORIGINAL}::bucket_policy::WalrusConsole>`,
);

const addr = (n: number): string => normalizeSuiAddress(`0x${n.toString(16)}`);

const WEB_ACCOUNT = addr(0xa1);
const KEY_ADMIN = addr(0xa2);
const MEMBER = addr(0xa4);
const STRANGER = addr(0xa5);

const SPACE = "space-1";
const ANCHOR = normalizeSuiAddress("0xa11c0");
const TABLE = normalizeSuiAddress("0x7ab1e");

/**
 * A REAL testnet derivation, captured from a `GroupDerived` event and reused
 * verbatim from harbor's own `deriveBucketGroupId` unit vector.
 *
 * Using ground truth here rather than "whatever our derivation returns" is the
 * whole point: this file is what proves the anchor id is computed correctly, and
 * a test that compared our implementation against itself would pass just as
 * happily with the BCS layout or the type-tag root wrong — and a wrong anchor
 * silently poisons every later roster in the space. `CONFIG` is
 * `TESTNET_PACKAGE_CONFIG`, whose registry and original package id are the same
 * two the vector was captured against.
 */
const SIGNER = normalizeSuiAddress(
  "0x5a3e25849766e4bf120a9aff641b8e7f665261726e4191ab03ad2a0a49bfafb5",
);
const BUCKET_UUID = "b3b7930f-5f5a-4a2c-8e0d-3aa6c7287184";
/** `create_bucket_group`'s bucket-id argument, as the PTB carries it. */
const BUCKET_ID_ARG = bcs.string().serialize(BUCKET_UUID).toBytes();
/** The group `derived_object::claim` actually produced for that triple, on chain. */
const DERIVED_GROUP = normalizeSuiAddress(
  "0xbfeeed093c6cc91e815793383cc30122b68315864d578dffcdbd4576d8da951b",
);
/** Some other group entirely — what a substituting endpoint would report. */
const IMPOSTOR_GROUP = normalizeSuiAddress("0xbad9e77");

const BASE_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: WEB_ACCOUNT,
  keyAdminAddress: "",
};

const GroupContentBcs = bcs.struct("PermissionedGroup", {
  id: bcs.Address,
  permissions: bcs.struct("PermissionsTable", { id: bcs.Address, length: bcs.u64() }),
  permissionsAdminCount: bcs.u64(),
  creator: bcs.Address,
});

/** A well-formed anchor group holding exactly `members`. */
function groupObject(members: readonly string[], tableId: string = TABLE) {
  return {
    type: GROUP_TYPE,
    content: GroupContentBcs.serialize({
      id: ANCHOR,
      permissions: { id: tableId, length: BigInt(members.length) },
      permissionsAdminCount: 1n,
      creator: WEB_ACCOUNT,
    }).toBytes(),
  };
}

function memberPage(addresses: readonly string[]): MemberFieldPage {
  return {
    dynamicFields: addresses.map((a) => ({
      name: { type: "address", bcs: bcs.Address.serialize(a).toBytes() },
    })),
    hasNextPage: false,
    cursor: null,
  };
}

function signers(...addresses: readonly string[]): SpaceSignersResponse {
  return {
    signers: addresses.map((address, i) => ({
      api_key_id: `key-${i}`,
      service_signer_address: address,
      scope: "readwrite" as const,
    })),
  };
}

/**
 * The same list with a per-signer scope.
 *
 * The scope matters to more than disclosure: the API rejects an authored role
 * that contradicts the key's own scope, so the client drops a member whose
 * chain-derived role disagrees with what the signer list claims. A test that
 * wants a `viewer` on the roster has to say `read` here.
 */
function scopedSigners(
  ...entries: readonly { address: string; scope: "read" | "readwrite" }[]
): SpaceSignersResponse {
  return {
    signers: entries.map((entry, i) => ({
      api_key_id: `key-${i}`,
      service_signer_address: entry.address,
      scope: entry.scope,
    })),
  };
}

/** The bucket-group id this client derives for `bucketId`, created by SIGNER. */
const groupOf = (bucketId: string): string =>
  deriveBucketGroupId(CONFIG, bcs.string().serialize(bucketId).toBytes(), SIGNER);

/**
 * Every 32-byte Pure input of a role-check PTB, as addresses, in input order.
 *
 * `buildRoleCheckPtb` emits one `tx.pure.address` per has_permission call and
 * the SDK does not de-duplicate Pure inputs, so an address appears twice: once
 * for the BucketEditor query and once for BucketViewer.
 */
function pureAddresses(tx: Transaction): string[] {
  const out: string[] = [];
  for (const input of tx.getData().inputs) {
    const pure = (input as { Pure?: { bytes: string } }).Pure;
    if (!pure) continue;
    const raw = Uint8Array.from(atob(pure.bytes), (c) => c.charCodeAt(0));
    if (raw.length === 32) out.push(bcs.Address.parse(raw));
  }
  return out;
}

/** The group a role-check PTB is asking about — its one unresolved object input. */
function probedGroup(tx: Transaction): string {
  for (const input of tx.getData().inputs) {
    const object = (input as { UnresolvedObject?: { objectId: string } }).UnresolvedObject;
    if (object) return normalizeSuiAddress(object.objectId);
  }
  throw new Error("role-check PTB carries no group object");
}

// === Harness ==============================================================

interface Reserve {
  readonly spaceId: string;
  readonly name: string;
  readonly ownerAddress: string;
  readonly members: unknown;
}

interface HarnessOptions {
  readonly config?: Partial<ConsoleConfig>;
  /** Chain membership of the anchor group; drives the `chain_verified` path. */
  readonly chainMembers?: readonly string[];
  /** Per-address `[isEditor, isViewer]` answers, in enumeration order. */
  readonly roles?: readonly (readonly [boolean, boolean])[];
  /**
   * Bucket ids handed out to successive creates, in order (the last one repeats).
   *
   * A create's bucket id is what its anchor group id derives FROM, so a test
   * that runs several creates in one space needs distinct ids or every create
   * would re-record the same anchor. Defaults to the single real vector.
   */
  readonly bucketIds?: readonly string[];
  /**
   * Chain membership PER GROUP, for tests that span several anchors. Takes the
   * place of `chainMembers`, which answers the same membership for any group id.
   */
  readonly groupMembers?: (groupId: string) => readonly string[];
  /**
   * `[isEditor, isViewer]` per (group, address), for the same tests. Takes the
   * place of `roles`, which answers positionally and knows nothing of groups.
   */
  readonly roleFor?: (groupId: string, address: string) => readonly [boolean, boolean];
  readonly candidates?: () => Effect.Effect<SpaceSignersResponse, unknown>;
  /**
   * Echo fields the reserve response carries back. Typed loosely on purpose: the
   * response is an unchecked cast over a JSON body, so a test must be able to put
   * a non-string there.
   */
  readonly echo?: Record<string, unknown>;
  /** Replace the validator summary the signer hands back. */
  readonly summary?: (
    expectation: SponsoredTxExpectation,
  ) => CreateBucketIdentitySummary | undefined;
  /** What finalize REPORTS as `seal_policy_id`; `undefined` means "the real one". */
  readonly sealPolicyId?: unknown;
  /** What finalize REPORTS as `bucket_id`; `undefined` means the reserved id. */
  readonly finalizeBucketId?: unknown;
  /** Make finalize fail, to prove nothing is cached when it does. */
  readonly finalizeFails?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const reserves: Reserve[] = [];
  const seen: SponsoredTxExpectation[] = [];
  const finalized: string[] = [];
  const chainReads: string[] = [];
  let candidateCalls = 0;

  // The bucket id of the create currently in flight. Set by the reserve and read
  // by the signer and by finalize, exactly as the real flow threads it.
  let currentBucketId = opts.bucketIds?.[0] ?? BUCKET_UUID;

  const api = {
    createBucket: (spaceId: string, name: string, ownerAddress: string, members: unknown) => {
      currentBucketId = opts.bucketIds?.[reserves.length] ?? currentBucketId;
      reserves.push({ spaceId, name, ownerAddress, members });
      return Effect.succeed({
        bucket_id: currentBucketId,
        bytes: "AAAA",
        digest: "0xdigest",
        provisioning_state: "pending_policy" as const,
        ...opts.echo,
      });
    },
    finalizeBucket: (bucketId: string) => {
      finalized.push(bucketId);
      if (opts.finalizeFails) return Effect.fail(new Error("504 Gateway Timeout"));
      return Effect.succeed({
        bucket_id: opts.finalizeBucketId === undefined ? currentBucketId : opts.finalizeBucketId,
        seal_policy_id:
          opts.sealPolicyId === undefined ? groupOf(currentBucketId) : opts.sealPolicyId,
        provisioning_state: "active",
      });
    },
    listSpaceSigners: () => {
      candidateCalls += 1;
      return opts.candidates?.() ?? Effect.succeed(signers());
    },
  };

  const seal = {
    getKeypair: () => Effect.succeed({ toSuiAddress: () => SIGNER }),
    signTransactionBytes: (_bytes: string, expectation: SponsoredTxExpectation) => {
      seen.push(expectation);
      const create =
        opts.summary !== undefined
          ? opts.summary(expectation)
          : expectation.kind === "createBucketIdentity"
            ? ({
                owner: expectation.ownerAddress,
                members: expectation.expectedMembers,
                signerRole: "editor",
                ...(expectation.managerAddress === undefined
                  ? {}
                  : { manager: expectation.managerAddress }),
                bucketIdArg: bcs.string().serialize(currentBucketId).toBytes(),
              } satisfies CreateBucketIdentitySummary)
            : undefined;
      return Effect.succeed({ signature: "c2lnbmF0dXJl", create });
    },
  };

  // One permissions table per group, so `listMemberFields` can tell which group
  // it is being asked about. Assigned on first sight and remembered both ways.
  const tableOfGroup = new Map<string, string>();
  const groupOfTable = new Map<string, string>();
  const tableFor = (groupId: string): string => {
    const existing = tableOfGroup.get(groupId);
    if (existing !== undefined) return existing;
    const tableId = normalizeSuiAddress(`0x7ab1e${tableOfGroup.size.toString(16)}`);
    tableOfGroup.set(groupId, tableId);
    groupOfTable.set(tableId, groupId);
    return tableId;
  };

  let roleIndex = 0;
  const rosterDeps: RosterChainDeps = {
    config: CONFIG,
    getGroupObject: async (objectId) => {
      chainReads.push(`group:${objectId}`);
      const members = opts.groupMembers?.(objectId) ?? opts.chainMembers ?? [];
      return groupObject(members, tableFor(objectId));
    },
    listMemberFields: async (parentId) => {
      chainReads.push(`fields:${parentId}`);
      const groupId = groupOfTable.get(parentId);
      const members =
        groupId === undefined
          ? (opts.chainMembers ?? [])
          : (opts.groupMembers?.(groupId) ?? opts.chainMembers ?? []);
      return memberPage(members);
    },
    simulate: async (tx): Promise<SimulationRead> => {
      chainReads.push("simulate");
      if (opts.roleFor !== undefined) {
        // The PTB names both the group and the addresses, so the answers are
        // looked up rather than counted off — several anchors are probed per
        // create and each may answer differently for the same address.
        const groupId = probedGroup(tx);
        const asked = pureAddresses(tx).filter((_, index) => index % 2 === 0);
        return {
          commandResults: asked.flatMap((address) => {
            const [isEditor, isViewer] = opts.roleFor?.(groupId, address) ?? [false, false];
            return [
              { returnValues: [{ bcs: new Uint8Array([isEditor ? 1 : 0]) }] },
              { returnValues: [{ bcs: new Uint8Array([isViewer ? 1 : 0]) }] },
            ];
          }),
        };
      }
      const answers = opts.roles ?? [];
      const chunk = answers.slice(roleIndex);
      roleIndex = answers.length;
      return {
        commandResults: chunk.flatMap(([isEditor, isViewer]) => [
          { returnValues: [{ bcs: new Uint8Array([isEditor ? 1 : 0]) }] },
          { returnValues: [{ bcs: new Uint8Array([isViewer ? 1 : 0]) }] },
        ]),
      };
    },
  };

  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, { ...BASE_CONFIG, ...opts.config }),
        Layer.succeed(RosterChainDepsTag, rosterDeps),
      ),
    ),
  );

  return {
    layer,
    reserves,
    seen,
    finalized,
    chainReads,
    candidateCalls: () => candidateCalls,
  };
}

const create = (layer: Layer.Layer<ConsoleStorageService>) =>
  ConsoleStorageService.pipe(
    Effect.flatMap((storage) => storage.createBucket(SpaceId.make(SPACE), "notes")),
    Effect.provide(layer),
  );

/** A stored anchor that actually re-derives, so roster tests reach the verifier. */
const REPRODUCING_ANCHOR = {
  groupId: DERIVED_GROUP,
  bucketId: BUCKET_UUID,
  creator: SIGNER,
  // The package ids the group id was derived under. Recorded so a create can
  // tell "the config moved under this anchor" (stale — bootstrap) from "these
  // inputs do not produce this id" (tampered — refuse).
  bucketRegistryId: CONFIG.bucketRegistryId,
  originalPackageId: CONFIG.originalPackageId,
  recordedAt: "2026-01-01T00:00:00.000Z",
} as const;

function seedAnchor(over: Partial<typeof REPRODUCING_ANCHOR> = {}): void {
  recordAnchor(SPACE, { ...REPRODUCING_ANCHOR, ...over });
}

/**
 * The anchor a create just recorded — the newest of the space's list.
 *
 * Newest rather than only: a create ADDS an anchor now instead of replacing the
 * one before it, which is what keeps anchoring monotone.
 */
const latestAnchor = () => readAnchors(SPACE)[0];

/**
 * Write `anchors.json` verbatim, for shapes `recordAnchor` can no longer produce.
 *
 * Takes a list as readily as a single entry: the bare-object shape is what a file
 * written before anchors became a list carries, and a list is how two entries
 * that `recordAnchor` would refuse to write (an anchor with no derivation inputs
 * beside one recorded under a superseded registry) get on disk together.
 */
function seedRawAnchor(entry: Record<string, unknown> | readonly Record<string, unknown>[]): void {
  const dir = path.join(tmpDir, "walrus-console-mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "anchors.json"), JSON.stringify({ [SPACE]: entry }), "utf-8");
}

// === XDG isolation ========================================================
//
// `createBucket` reads and WRITES the anchor cache, so without this every run of
// this file would edit the developer's own ~/.config/walrus-console-mcp.

let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-create-test-"));
  originalEnv = { ...process.env };
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === Tests ================================================================

describe("deriveBucketGroupId", () => {
  it("reproduces a real on-chain derived_object::claim result", () => {
    expect(deriveBucketGroupId(CONFIG, BUCKET_ID_ARG, SIGNER)).toBe(DERIVED_GROUP);
  });

  it("roots the type tag at originalPackageId, not the upgraded packageId", () => {
    // Move type identities carry the DEFINING package address, so an upgrade must
    // not move the derivation. Testnet's two ids are identical, so the real flow
    // cannot distinguish them — this is the only thing that does, and harbor's own
    // derivation carries the same warning.
    const upgraded = { ...CONFIG, packageId: normalizeSuiAddress("0xfeed") };
    expect(deriveBucketGroupId(upgraded, BUCKET_ID_ARG, SIGNER)).toBe(DERIVED_GROUP);

    const wrongRoot = { ...CONFIG, originalPackageId: normalizeSuiAddress("0xfeed") };
    expect(deriveBucketGroupId(wrongRoot, BUCKET_ID_ARG, SIGNER)).not.toBe(DERIVED_GROUP);
  });

  it("binds the address to the creator and to the registry", () => {
    // The creator is half the key: it is what stops anyone but the signing key
    // from naming a group at this address, and therefore what makes the derived
    // anchor unforgeable by the endpoint.
    expect(deriveBucketGroupId(CONFIG, BUCKET_ID_ARG, WEB_ACCOUNT)).not.toBe(DERIVED_GROUP);
    expect(
      deriveBucketGroupId({ ...CONFIG, bucketRegistryId: addr(2) }, BUCKET_ID_ARG, SIGNER),
    ).not.toBe(DERIVED_GROUP);
  });

  it("binds the address to the bucket id", () => {
    const other = bcs.string().serialize("00000000-0000-4000-8000-000000000000").toBytes();
    expect(deriveBucketGroupId(CONFIG, other, SIGNER)).not.toBe(DERIVED_GROUP);
  });
});

describe("createBucket — the owner pin gate", () => {
  it("refuses before any API call when no owner is pinned", async () => {
    const h = makeHarness({ config: { webAccountAddress: "" } });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("missing_owner_pin");
    expect((error as { message: string }).message).toMatch(/CONSOLE_WEB_ACCOUNT_ADDRESS/);
    expect(h.reserves).toEqual([]);
    expect(h.candidateCalls()).toBe(0);
  });
});

describe("createBucket — the roster reaches both the reserve and the signer", () => {
  it("bootstraps with an empty roster and reads nothing at all", async () => {
    const h = makeHarness();

    const result = await Effect.runPromise(create(h.layer));

    expect(h.candidateCalls()).toBe(0);
    expect(h.chainReads).toEqual([]);
    expect(h.reserves[0]?.members).toEqual([]);
    expect(result.roster.reason).toBe("bootstrap");
    expect(result.roster.members).toEqual([]);
  });

  it("reports no_other_signers distinctly, without reading chain", async () => {
    seedAnchor();
    const h = makeHarness({ candidates: () => Effect.succeed(signers(WEB_ACCOUNT, SIGNER)) });

    const result = await Effect.runPromise(create(h.layer));

    expect(h.candidateCalls()).toBe(1);
    expect(h.chainReads).toEqual([]);
    expect(result.roster.reason).toBe("no_other_signers");
    expect(result.roster.members).toEqual([]);
  });

  it("authors a chain-verified roster and enforces the SAME array at the signer", async () => {
    seedAnchor();
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(SIGNER, MEMBER, STRANGER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    const expected = [{ address: MEMBER, role: "editor" }];
    expect(result.roster.reason).toBe("chain_verified");
    expect(result.roster.members).toEqual(expected);
    expect(h.reserves[0]?.members).toEqual(expected);

    // The one assertion the whole flow turns on: what was SENT as `members` and
    // what is ENFORCED as `expectedMembers` are the same object, so no future
    // edit can loosen one without the other.
    expect(h.seen[0]).toMatchObject({ kind: "createBucketIdentity", ownerAddress: WEB_ACCOUNT });
    const expectation = h.seen[0] as Extract<
      SponsoredTxExpectation,
      { kind: "createBucketIdentity" }
    >;
    expect(expectation.expectedMembers).toBe(h.reserves[0]?.members);
    expect(expectation.expectedMembers).toEqual(expected);

    // The candidate chain never vouched for is disclosed, not silently dropped.
    expect(result.roster.droppedCandidates).toEqual([STRANGER]);
  });

  it("omits managerAddress entirely when no Key-Admin is pinned", async () => {
    const h = makeHarness();

    await Effect.runPromise(create(h.layer));

    expect(h.seen[0]).not.toHaveProperty("managerAddress");
  });

  it("passes the pinned Key-Admin through to the signer", async () => {
    const h = makeHarness({ config: { keyAdminAddress: KEY_ADMIN } });

    await Effect.runPromise(create(h.layer));

    expect(h.seen[0]).toMatchObject({ managerAddress: KEY_ADMIN });
  });

  it("surfaces a roster refusal with its remedy, having reserved nothing", async () => {
    seedAnchor();
    const h = makeHarness({ candidates: () => Effect.fail(new Error("502 Bad Gateway")) });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("RosterUnavailableError");
    expect((error as { message: string }).message).toMatch(/retry/i);
    expect(h.reserves).toEqual([]);
    expect(h.seen).toEqual([]);
  });
});

describe("createBucket — echo diagnostics", () => {
  it("accepts a reserve that echoes nothing back", async () => {
    const h = makeHarness();

    const result = await Effect.runPromise(create(h.layer));

    expect(result.bucketId).toBe(BUCKET_UUID);
    expect(h.seen).toHaveLength(1);
  });

  it("accepts a null admin echo when a Key-Admin is pinned", async () => {
    // `null` means "this space holds no key_admin key", which is a legitimate
    // state for a host that pinned one — the PTB simply carries no grant.
    const h = makeHarness({
      config: { keyAdminAddress: KEY_ADMIN },
      echo: { owner_address: WEB_ACCOUNT, admin_signer_address: null },
    });

    await Effect.runPromise(create(h.layer));

    expect(h.seen).toHaveLength(1);
  });

  it("accepts matching echoes spelled differently", async () => {
    const h = makeHarness({
      config: { keyAdminAddress: KEY_ADMIN },
      echo: {
        owner_address: WEB_ACCOUNT.replace("0x", "").toUpperCase(),
        admin_signer_address: KEY_ADMIN,
      },
    });

    await Effect.runPromise(create(h.layer));

    expect(h.seen).toHaveLength(1);
  });

  it("refuses before signing when the owner echo contradicts the pin", async () => {
    const h = makeHarness({ echo: { owner_address: STRANGER } });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("owner_echo_mismatch");
    expect(h.seen).toEqual([]);
    expect(h.finalized).toEqual([]);
  });

  it("refuses before signing when the admin echo contradicts the Key-Admin pin", async () => {
    const h = makeHarness({
      config: { keyAdminAddress: KEY_ADMIN },
      echo: { admin_signer_address: STRANGER },
    });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("admin_echo_mismatch");
    expect(h.seen).toEqual([]);
    expect(h.finalized).toEqual([]);
  });

  it("refuses on an echo that is present but not a string, with the remedy intact", async () => {
    // `owner_address` is typed `string | undefined`, but that type is an unchecked
    // cast over a JSON body. Un-guarded, `normalizeSuiAddress(42)` throws inside
    // the generator — an Effect DEFECT no `catchTag` recovers and whose text
    // carries none of the remedy, letting a hostile endpoint choose the shape of
    // our failure. A present-but-unreadable echo is a contradicting echo.
    const h = makeHarness({ echo: { owner_address: 42 } });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("owner_echo_mismatch");
    expect((error as { message: string }).message).toMatch(/CONSOLE_WEB_ACCOUNT_ADDRESS/);
    expect(h.seen).toEqual([]);
  });

  it("refuses on a non-string admin echo too (null stays the legitimate absence)", async () => {
    const h = makeHarness({
      config: { keyAdminAddress: KEY_ADMIN },
      echo: { admin_signer_address: {} },
    });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("admin_echo_mismatch");
    expect((error as { message: string }).message).toMatch(/CONSOLE_KEY_ADMIN_ADDRESS/);
  });
});

describe("createBucket — the anchor is DERIVED, never taken from the server", () => {
  it("records the group id derived from the validated transaction", async () => {
    // The expectation is a real on-chain `GroupDerived` result, so this pins the
    // BCS layout, the type-tag root and the hashing scheme against the chain —
    // not against our own implementation.
    const h = makeHarness();

    const result = await Effect.runPromise(create(h.layer));

    const anchor = latestAnchor();
    expect(anchor?.groupId).toBe(DERIVED_GROUP);
    expect(anchor?.bucketId).toBe(BUCKET_UUID);
    expect(anchor?.creator).toBe(SIGNER);
    expect(Date.parse(anchor?.recordedAt ?? "")).not.toBeNaN();
    expect(result.sealPolicyId).toBe(DERIVED_GROUP);
  });

  it("refuses and caches NOTHING when the server names a different group", async () => {
    // The attack this exists for: the reserve passes every validator pin honestly,
    // then finalize reports a group the endpoint controls. Cached, it would be
    // enumerated by the next create, whose "chain-verified" roster would then be
    // the attacker's — authored by us, and self-propagating from there.
    const h = makeHarness({ sealPolicyId: IMPOSTOR_GROUP });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("group_id_mismatch");
    expect(readAnchors(SPACE)).toEqual([]);
  });

  it("names BOTH ids and BOTH causes in the mismatch message", async () => {
    // A mismatch is not necessarily an attack: a Sui change to derived-object
    // addressing, or stale package ids in this build, diverge with no adversary
    // anywhere — and that is somebody else's fix. The message has to route it.
    const h = makeHarness({ sealPolicyId: IMPOSTOR_GROUP });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));
    const message = (error as { message: string }).message;

    expect(message).toContain(DERIVED_GROUP);
    expect(message).toContain(IMPOSTOR_GROUP);
    expect(message).toContain(BUCKET_UUID);
    expect(message).toMatch(/derivation in this build no longer matches the chain/i);
    expect(message).toMatch(/naming a group of its own choosing/i);
  });

  it("refuses on a reported group id that is not a string", async () => {
    const h = makeHarness({ sealPolicyId: 7 });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect((error as { reason?: string }).reason).toBe("group_id_mismatch");
    expect(readAnchors(SPACE)).toEqual([]);
  });

  it("refuses before finalize when the PTB bucket id does not match the reserve", async () => {
    const h = makeHarness({
      summary: (expectation) =>
        expectation.kind === "createBucketIdentity"
          ? {
              owner: expectation.ownerAddress,
              members: expectation.expectedMembers,
              signerRole: "editor",
              bucketIdArg: bcs.string().serialize("some-other-bucket").toBytes(),
            }
          : undefined,
    });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect((error as { reason?: string }).reason).toBe("bucket_id_arg_mismatch");
    expect(h.finalized).toEqual([]);
    expect(readAnchors(SPACE)).toEqual([]);
  });

  it("refuses and caches NOTHING when finalize reports a different bucket id", async () => {
    const h = makeHarness({ finalizeBucketId: "not-the-reserved-id" });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect((error as { reason?: string }).reason).toBe("bucket_id_mismatch");
    expect((error as { message: string }).message).toContain(BUCKET_UUID);
    expect((error as { message: string }).message).toContain("not-the-reserved-id");
    expect(readAnchors(SPACE)).toEqual([]);
  });

  it("refuses a stored anchor whose group id does not reproduce", async () => {
    seedAnchor({ groupId: IMPOSTOR_GROUP });
    const h = makeHarness();

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect((error as { reason?: string }).reason).toBe("anchor_id_mismatch");
    expect(h.reserves).toEqual([]);
    expect((error as { message: string }).message).toMatch(/anchors\.json/);
    // The remedy names the offending entry first: deleting the whole file now
    // discards every OTHER space's accumulated anchors too, which is a far bigger
    // hammer than one bad row needs.
    expect((error as { message: string }).message).toMatch(/remove that one entry/i);
    // Findable: the entry to remove is named by the very id it records.
    expect((error as { message: string }).message).toContain(IMPOSTOR_GROUP);
  });

  it("refuses with the anchors.json remedy when the stored creator is not an address", async () => {
    // `bcs.Address.serialize` THROWS on a malformed address, and a throw inside
    // the generator is an Effect DEFECT: no BucketCreatePinError, so the remedy
    // this branch exists to print never prints and the operator is left with an
    // unexplained failure on a file they can simply delete. The recorded
    // derivation inputs match, so this is the tamper case, not the stale one.
    seedAnchor({ creator: "not-an-address" });
    const h = makeHarness();

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("anchor_id_mismatch");
    expect((error as { message: string }).message).toMatch(/anchors\.json/);
    expect(h.reserves).toEqual([]);
  });

  it("degrades to bootstrap when the anchor was derived under different package ids", async () => {
    // packageConfig.ts SCHEDULES this: when the republish merges, the staging
    // entry is deleted and every anchor recorded under it stops reproducing at
    // once. A config that moved under an anchor is a stale cache, not a tamper —
    // hard-refusing every create in every affected space until each operator
    // deletes anchors.json by hand is what `anchorStore` says must not happen.
    seedAnchor({ bucketRegistryId: addr(0xdead) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("bootstrap");
    expect(h.chainReads).toEqual([]);
    expect(h.reserves[0]?.members).toEqual([]);
    expect(spy.mock.calls.map((call) => String(call[0])).join(" ")).toMatch(/stale/i);
    // And it SELF-HEALS: the bucket just created replaces the stale entry,
    // recorded under the ids in force now, so the next create verifies again.
    expect(latestAnchor()).toMatchObject({
      groupId: DERIVED_GROUP,
      bucketRegistryId: CONFIG.bucketRegistryId,
      originalPackageId: CONFIG.originalPackageId,
    });
  });

  it("treats an entry written before derivation inputs were recorded as stale", async () => {
    // Old files carry no bucketRegistryId/originalPackageId, so nothing says
    // which ids their group id came from. Unknown inputs are stale, never
    // tampered: accusing a file this client itself wrote would be both wrong and
    // unfixable except by deleting it.
    seedRawAnchor({
      groupId: DERIVED_GROUP,
      bucketId: BUCKET_UUID,
      creator: SIGNER,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("bootstrap");
    expect(h.chainReads).toEqual([]);
  });

  it("treats a pre-derivation anchor (no creator) as missing, not as a chain source", async () => {
    // loadAnchors drops entries without creator, so a mid-development file cannot
    // become the next create's chain-verified roster.
    seedRawAnchor({
      groupId: IMPOSTOR_GROUP,
      bucketId: BUCKET_UUID,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("bootstrap");
    expect(h.chainReads).toEqual([]);
  });

  it("records the derived group even when the server reports none", async () => {
    // Absent is not contradicting — the same rule the reserve echoes follow. The
    // derived id never depended on the server's answer, so there is nothing to
    // withhold.
    const h = makeHarness({ sealPolicyId: null });

    const result = await Effect.runPromise(create(h.layer));

    expect(latestAnchor()?.groupId).toBe(DERIVED_GROUP);
    expect(result.anchorRecorded).toBe(true);
    expect(result.sealPolicyId).toBe(DERIVED_GROUP);
    // The TRUE side of the conditional re-anchor claim: recording succeeded, so
    // the bootstrap arm's promise that this bucket joins the space's anchors is
    // one this create is entitled to make.
    expect(result.disclosure).toMatch(/this bucket joins the space's anchors/i);
  });

  it("ADDS the group just created without evicting the anchors already on file", async () => {
    // Replacing was the ratchet: an identity-only create would throw away the
    // one anchor that carried evidence. The new group goes to the FRONT, because
    // both caps drop the oldest when they bite.
    // Reproducing, like every entry this client writes: an anchor that did not
    // re-derive would refuse the create outright rather than sit beside a new one.
    recordAnchor(SPACE, {
      ...REPRODUCING_ANCHOR,
      groupId: groupOf("earlier-bucket"),
      bucketId: "earlier-bucket",
    });
    const h = makeHarness({ candidates: () => Effect.succeed(signers(SIGNER)) });

    await Effect.runPromise(create(h.layer));

    expect(readAnchors(SPACE).map((anchor) => anchor.groupId)).toEqual([
      DERIVED_GROUP,
      groupOf("earlier-bucket"),
    ]);
  });

  it("keeps at most MAX_ANCHORS_PER_SPACE anchors, dropping the oldest", async () => {
    // Retention is finite because every retained anchor costs the next create an
    // enumeration, not just disk. It is deliberately larger than the verifier's
    // consult cap, so the store never silently pre-applies a recency cap of its
    // own — see `MAX_ANCHORS_PER_SPACE`.
    for (let i = 0; i < MAX_ANCHORS_PER_SPACE; i++) {
      recordAnchor(SPACE, {
        ...REPRODUCING_ANCHOR,
        groupId: groupOf(`filler-${i}`),
        bucketId: `filler-${i}`,
      });
    }
    const oldest = groupOf("filler-0");
    expect(readAnchors(SPACE)).toHaveLength(MAX_ANCHORS_PER_SPACE);

    const h = makeHarness({ candidates: () => Effect.succeed(signers(SIGNER)) });
    await Effect.runPromise(create(h.layer));

    const groupIds = readAnchors(SPACE).map((anchor) => anchor.groupId);
    expect(groupIds).toHaveLength(MAX_ANCHORS_PER_SPACE);
    expect(groupIds[0]).toBe(DERIVED_GROUP);
    expect(groupIds).not.toContain(oldest);
  });

  it("caches nothing when finalize fails", async () => {
    // The transaction never landed, so there is no group at the derived address.
    // Caching one would point the next roster check at an object that does not
    // exist, and the enumeration would refuse every create until it was cleared.
    const h = makeHarness({ finalizeFails: true });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error).toBeInstanceOf(Error);
    expect(readAnchors(SPACE)).toEqual([]);
  });

  it("refuses before finalize when the group id cannot be derived", async () => {
    // No trustworthy anchor means no create: falling back to the server's id is
    // exactly what this whole path exists to avoid. Nothing is submitted.
    const h = makeHarness({
      summary: (expectation) =>
        expectation.kind === "createBucketIdentity"
          ? {
              owner: expectation.ownerAddress,
              members: expectation.expectedMembers,
              signerRole: "editor",
              bucketIdArg: undefined as unknown as Uint8Array,
            }
          : undefined,
    });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    expect((error as { reason?: string }).reason).toBe("group_id_underivable");
    expect(h.finalized).toEqual([]);
    expect(readAnchors(SPACE)).toEqual([]);
  });

  it("still returns the created bucket when the anchor cannot be written", async () => {
    // The bucket EXISTS on chain by this point; a cache write is not allowed to
    // turn that into a failed tool call. Make the config dir unwritable by
    // pointing XDG_CONFIG_HOME at a regular file.
    const blocker = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    process.env["XDG_CONFIG_HOME"] = blocker;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness();

    const result = await Effect.runPromise(create(h.layer));

    expect(result.bucketId).toBe(BUCKET_UUID);
    expect(result.anchorRecorded).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not claim this bucket joined the space's anchors when the write failed (bootstrap)", async () => {
    // Same combination as the test above — bootstrap (no anchor seeded) plus an
    // unwritable config dir — but checked against the DISCLOSURE text rather
    // than just `anchorRecorded`. The `bootstrap` arm's wording used to assert
    // unconditionally that "this bucket joins the space's anchors", which is
    // exactly false in this case: the write failed, so nothing was cached and
    // the next create_bucket here has no improved position to start from.
    const blocker = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    process.env["XDG_CONFIG_HOME"] = blocker;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness();

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("bootstrap");
    expect(result.anchorRecorded).toBe(false);
    // The claim the TRUE branch makes must be absent here.
    expect(result.disclosure).not.toMatch(/this bucket joins the space's anchors/i);
    // The create still succeeded — this must not read as an error — and the
    // disclosure has to say plainly that nothing was cached and why that
    // matters for the next create in this space.
    expect(result.disclosure).toMatch(/was not cached/i);
    expect(result.disclosure).toMatch(/bucket exists and is exactly as permissioned/i);
    expect(result.disclosure).toMatch(/starts from this same bootstrap position/i);
    warn.mockRestore();
  });

  it("does not claim a self-heal from stale anchors either, when the write fails", async () => {
    // The `stale` clause carries the SAME class of claim ("this heals by
    // itself — the group this bucket creates is anchored under the ids in
    // force now"), computed once and shared across every arm. Proven here on
    // `chain_verified` (one reproducing anchor plus one stale one), with the
    // write of THIS create's own anchor failed via the `writeFileAtomic` spy
    // (module doc comment above) instead of a chmod — `mockImplementationOnce`
    // fails exactly the NEXT write, which is `recordAnchor`'s inside `create`;
    // the two setup writes above (`recordAnchor`, `seedAnchor`) have already
    // gone through the real implementation by the time it is installed.
    recordAnchor(SPACE, {
      ...REPRODUCING_ANCHOR,
      groupId: groupOf("stale-bucket"),
      bucketId: "stale-bucket",
      bucketRegistryId: addr(0xdead),
    });
    seedAnchor();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    vi.mocked(writeFileAtomic).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("chain_verified");
    expect(result.roster.anchorsStale).toBe(1);
    expect(result.anchorRecorded).toBe(false);
    expect(result.disclosure).toMatch(/stale/i);
    expect(result.disclosure).not.toMatch(/this heals by itself/i);
    expect(result.disclosure).toMatch(/did not land this time/i);
    warn.mockRestore();
  });

  it("does not claim a re-anchor from no_admitted_anchor either, when the write fails", async () => {
    // Same fault-tolerant write, checked against the OTHER arm with its own
    // unconditional claim: "This bucket joins the space's anchors either way."
    seedAnchor();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      // A bootstrap-shaped anchor: nobody beyond the three identities this
      // client already knows, so nothing is admitted.
      chainMembers: [WEB_ACCOUNT, SIGNER],
    });

    vi.mocked(writeFileAtomic).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("no_admitted_anchor");
    expect(result.anchorRecorded).toBe(false);
    expect(result.disclosure).not.toMatch(/this bucket joins the space's anchors either way/i);
    expect(result.disclosure).toMatch(/was not cached/i);
    warn.mockRestore();
  });
});

describe("createBucket — anchoring is monotone (acceptance 9)", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR, observed live on testnet 2026-08-23.
   *
   * Anchoring on the single MOST RECENT validated bucket is a ratchet toward
   * empty: a create whose roster comes out identity-only produces a group with
   * no evidence in it, that group becomes the anchor, and the NEXT create finds
   * nothing to verify against — so it drops a key it had authored as
   * chain-verified one bucket earlier, and produces another empty anchor. The
   * induction never recovers on its own.
   *
   * The run below is that exact sequence, end to end through the service:
   *
   *  1. BOOTSTRAP. No anchor on file, so nobody beyond the owner and the signer
   *     is granted. Its group is recorded as the space's first anchor.
   *  2. MEMBER's key is minted. Mint-time backfill grants a newly minted key
   *     access to every EXISTING private bucket, so MEMBER lands in bucket 1's
   *     group — which is why the chain membership of that group below contains
   *     an address bucket 1 never authored.
   *  3. IDENTITY-ONLY. Console lists only the signer for this create (the new
   *     key is still `registering`), so the roster is empty again and bucket 2's
   *     group holds nothing beyond the identities this client already knows.
   *  4. The create under test. Console lists MEMBER again. Bucket 2's group is
   *     the most recent anchor and carries no evidence; bucket 1's does.
   *
   * Under most-recent anchoring step 4 authors `[]` and MEMBER loses access it
   * had already been verified for. Under a union over the admitted anchor set it
   * authors MEMBER, because bucket 2's group is not admitted at all and bucket
   * 1's still is.
   */
  const BUCKETS = ["bucket-bootstrap", "bucket-identity-only", "bucket-under-test"] as const;

  /** Chain membership per group, as steps 1-3 above leave it. */
  const MEMBERSHIP: Record<string, readonly string[]> = {
    [groupOf(BUCKETS[0])]: [WEB_ACCOUNT, SIGNER, MEMBER],
    [groupOf(BUCKETS[1])]: [WEB_ACCOUNT, SIGNER],
  };

  function monotoneHarness() {
    // Creates COMPLETED so far, not candidate reads: the bootstrap create never
    // asks for the signer list at all, so counting the reads is off by one.
    let created = 0;
    const h = makeHarness({
      bucketIds: BUCKETS,
      // Only the middle create sees a signer list without MEMBER in it.
      candidates: () => Effect.succeed(created === 1 ? signers(SIGNER) : signers(SIGNER, MEMBER)),
      groupMembers: (groupId) => MEMBERSHIP[groupId] ?? [],
      // MEMBER really is an editor on the bootstrap bucket's group.
      roleFor: (groupId, address) =>
        groupId === groupOf(BUCKETS[0]) && address === MEMBER ? [true, true] : [false, false],
    });
    const next = async () => {
      const result = await Effect.runPromise(create(h.layer));
      created += 1;
      return result;
    };
    return { ...h, next };
  }

  it("an identity-only create does not shrink the roster the next create can verify", async () => {
    const h = monotoneHarness();

    const bootstrap = await h.next();
    const identityOnly = await h.next();
    const next = await h.next();

    // The two creates that came first really were identity-only — without that
    // the third one proves nothing.
    expect(bootstrap.roster.reason).toBe("bootstrap");
    expect(bootstrap.roster.members).toEqual([]);
    expect(identityOnly.roster.members).toEqual([]);

    // THE ASSERTION. MEMBER is exactly the member the second create could have
    // authored had Console listed it: it is a member of an anchor this client
    // created and validated, and it is on the candidate list now.
    expect(next.roster.members).toEqual([{ address: MEMBER, role: "editor" }]);
    expect(next.roster.reason).toBe("chain_verified");
    expect(next.roster.droppedCandidates).toEqual([]);
    // And it says which anchor backed it: the bootstrap bucket's group, not the
    // most recent one, which carried no evidence and was never admitted.
    expect(next.roster.anchorGroupIds).toEqual([groupOf(BUCKETS[0])]);
    expect(h.reserves[2]?.members).toEqual([{ address: MEMBER, role: "editor" }]);
  });

  it("keeps every earlier anchor in play, not just the one that happened to be last", async () => {
    // The same run, read from the other side: the group with no evidence is
    // still ENUMERATED (it might have held evidence), it is simply not admitted.
    const h = monotoneHarness();

    await h.next();
    await h.next();
    h.chainReads.length = 0;
    await h.next();

    expect(h.chainReads).toContain(`group:${groupOf(BUCKETS[1])}`);
    expect(h.chainReads).toContain(`group:${groupOf(BUCKETS[0])}`);
    // Most recent first, so the newest anchor is the one consulted first.
    expect(h.chainReads[0]).toBe(`group:${groupOf(BUCKETS[1])}`);
  });
});

describe("createBucket — the result never reports a bare success", () => {
  it("carries the identity summary, the roster, the reason and the disclosure", async () => {
    seedAnchor();
    const h = makeHarness({
      config: { keyAdminAddress: KEY_ADMIN },
      // `read`, because chain says viewer-only below and the API refuses a
      // roster row whose role contradicts the key's own scope.
      candidates: () => Effect.succeed(scopedSigners({ address: MEMBER, scope: "read" })),
      chainMembers: [MEMBER],
      roles: [[false, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result).toMatchObject({
      bucketId: BUCKET_UUID,
      sealPolicyId: DERIVED_GROUP,
      // camelCase in the result, snake_case on the wire. The wire field is
      // `provisioning_state`; reading `state` (the DB column's name, which leaks
      // into server-side code) silently produced `undefined` until the live e2e
      // asked for it and got nothing back.
      provisioningState: "active",
      identity: {
        owner: WEB_ACCOUNT,
        members: [{ address: MEMBER, role: "viewer" }],
        signerRole: "editor",
        manager: KEY_ADMIN,
      },
      roster: {
        members: [{ address: MEMBER, role: "viewer" }],
        reason: "chain_verified",
        droppedCandidates: [],
        // The anchors that backed it, plural: the roster is a union over the
        // space's admitted anchor set, and the count is part of the disclosure.
        anchorGroupIds: [DERIVED_GROUP],
      },
      anchorRecorded: true,
    });
    // Nothing was left unread, so the truncation note is absent rather than zero.
    expect(result.roster).not.toHaveProperty("anchorsNotConsulted");
    // The sentence must not claim more than the code proved. It says the anchor's
    // identity was DERIVED locally (not that Console vouched for it), that the
    // membership was read from chain, and that a fullnode is what it still rests
    // on — the poisoned-anchor failure mode was manufactured assurance, so the
    // wording is part of the fix, not decoration.
    expect(result.disclosure).toMatch(/derived locally/i);
    expect(result.disclosure).toMatch(/on-chain membership/i);
    expect(result.disclosure).toMatch(/fullnode/i);
  });

  it("says out loud that a bootstrap roster grants nobody else access", async () => {
    const h = makeHarness();

    const result = await Effect.runPromise(create(h.layer));

    expect(result.disclosure).toMatch(/bootstrap|no other|nobody/i);
    expect(result.disclosure).toMatch(/anchor/i);
  });

  it("distinguishes no_other_signers from bootstrap in the disclosure", async () => {
    // Same empty roster, same bytes, same server state — only the text differs.
    // The bootstrap run goes first, with no anchor cached; recording one then
    // moves the second run onto the other branch.
    const bootstrap = await Effect.runPromise(create(makeHarness().layer));
    seedAnchor();
    const h = makeHarness({ candidates: () => Effect.succeed(signers(SIGNER)) });
    const lone = await Effect.runPromise(create(h.layer));

    expect(lone.roster.members).toEqual(bootstrap.roster.members);
    expect(lone.roster.reason).not.toBe(bootstrap.roster.reason);
    expect(lone.disclosure).not.toBe(bootstrap.disclosure);
  });

  it("renders a no-admitted-anchor disclosure that claims nothing was read", async () => {
    // THE RENDERING THIS ARM EXISTS FOR. Folded into `chain_verified`, this state
    // printed "0 service account(s) were granted access after being read from the
    // on-chain membership of 0 anchor group(s) of this space (none)" — a sentence
    // describing a chain read that never happened, for a create that verified
    // nothing.
    seedAnchor();
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      // A bootstrap bucket's group: the three identities this client already
      // knows and nobody else, so the anchor is enumerated and not admitted.
      chainMembers: [WEB_ACCOUNT, SIGNER],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("no_admitted_anchor");
    expect(result.roster.members).toEqual([]);
    expect(result.roster.anchorGroupIds).toEqual([]);
    // It must not describe a membership read, and it must say what actually
    // happened: the anchors held nothing this client did not already know, so
    // there was no evidence to verify against and nobody else was granted.
    expect(result.disclosure).not.toMatch(/on-chain membership/i);
    // Worded against the candidate list rather than against "an address beyond
    // the three this client knows": the verifier admits an anchor when it holds
    // one of Console's listed signers, which is a test that does not change
    // depending on whether this host pins a Key-Admin.
    expect(result.disclosure).toMatch(/not one of them holds any of the service accounts/i);
    expect(result.disclosure).toMatch(/nothing was read/i);
    expect(result.disclosure).toMatch(/nobody beyond/i);
    // And it must not be sold as the self-healing bootstrap case.
    expect(result.disclosure).toMatch(/does not clear itself/i);
    // And the dropped candidate is named here as it is on every other arm.
    expect(result.roster.droppedCandidates).toEqual([MEMBER]);
    expect(result.disclosure).toContain(MEMBER);
  });

  it("distinguishes no_admitted_anchor from bootstrap in the disclosure", async () => {
    // Same empty roster, same bytes, same server state — and different remedies:
    // bootstrap heals as soon as any create authors members, while an anchor set
    // that carries no evidence stays that way until something grants a role on
    // one of this space's buckets. The first create records the anchor the second
    // one then finds unusable.
    const bootstrap = await Effect.runPromise(create(makeHarness().layer));
    const h = makeHarness({
      bucketIds: ["second-bucket"],
      candidates: () => Effect.succeed(signers(MEMBER)),
      chainMembers: [WEB_ACCOUNT, SIGNER],
    });

    const none = await Effect.runPromise(create(h.layer));

    expect(none.roster.members).toEqual(bootstrap.roster.members);
    expect(none.roster.reason).not.toBe(bootstrap.roster.reason);
    expect(none.disclosure).not.toBe(bootstrap.disclosure);
  });

  it("counts and discloses the anchors skipped as stale when others still verify", async () => {
    // PARTIAL STALENESS. Before the anchor set became a union, one stale anchor
    // meant the `bootstrap` arm, whose text names staleness itself. Now
    // some-stale + some-reproducing lands on `chain_verified`, which says nothing
    // about the skipped ones — and stderr is not what an agent shows a human.
    recordAnchor(SPACE, {
      ...REPRODUCING_ANCHOR,
      groupId: groupOf("stale-bucket"),
      bucketId: "stale-bucket",
      // Recorded under a registry this build no longer resolves, which is the
      // scheduled event `checkStoredAnchor` exists for — stale, never tampered.
      bucketRegistryId: addr(0xdead),
    });
    seedAnchor();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("chain_verified");
    expect(result.roster.members).toEqual([{ address: MEMBER, role: "editor" }]);
    expect(result.roster.anchorsStale).toBe(1);
    expect(result.disclosure).toMatch(/stale/i);
    // NOT folded into the cap-truncation count: the two have different causes and
    // different remedies, so one number cannot stand for both.
    expect(result.roster).not.toHaveProperty("anchorsNotConsulted");
  });

  it("names every distinct reason an anchor was skipped as stale, not just the first", async () => {
    // A count of N beside a single reason hides the rest, and a file can hold
    // both kinds of stale entry at once: one written before the derivation inputs
    // were recorded, and one recorded under a registry that has since moved.
    seedRawAnchor([
      {
        groupId: DERIVED_GROUP,
        bucketId: BUCKET_UUID,
        creator: SIGNER,
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ...REPRODUCING_ANCHOR,
        groupId: groupOf("older-bucket"),
        bucketId: "older-bucket",
        bucketRegistryId: addr(0xdead),
      },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness({ candidates: () => Effect.succeed(signers(MEMBER)) });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.reason).toBe("bootstrap");
    expect(result.roster.anchorsStale).toBe(2);
    const logged = spy.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).toContain("records no bucket-policy ids");
    expect(logged).toContain("was derived under registry");
  });

  it("names the dropped candidates in the disclosure", async () => {
    seedAnchor();
    const h = makeHarness({
      candidates: () => Effect.succeed(signers(MEMBER, STRANGER)),
      chainMembers: [MEMBER],
      roles: [[true, true]],
    });

    const result = await Effect.runPromise(create(h.layer));

    expect(result.roster.droppedCandidates).toEqual([STRANGER]);
    expect(result.disclosure).toContain(STRANGER);
  });

  it("refuses rather than reporting a create it cannot describe", async () => {
    // Defensive: the validator always returns a summary for this arm. If it ever
    // did not, the result would carry no owner/roster/manager to confirm — and a
    // disclosure nobody can read is the one thing this flow must not produce.
    const h = makeHarness({ summary: () => undefined });

    const error = await Effect.runPromise(create(h.layer).pipe(Effect.flip));

    expect(error._tag).toBe("SealCryptoError");
    expect(h.finalized).toEqual([]);
  });
});
