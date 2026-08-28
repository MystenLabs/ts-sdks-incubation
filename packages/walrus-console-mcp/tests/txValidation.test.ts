import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import realFixture from "./fixtures/createBucket746.json" with { type: "json" };
import type { BucketGroupPackageConfig } from "../src/console/packageConfig";
import {
  assertExpectedTransaction,
  type RosterMember,
  type SponsoredTxExpectation,
} from "../src/console/txValidation";
import fixtures from "./fixtures/sponsoredTransactions.json" with { type: "json" };

/**
 * The grant fixtures are REAL sponsored transactions captured from live testnet
 * Console (see scripts/capture-tx-fixtures.mts). That matters: the allowlist was
 * derived from what Console actually builds, not from what the shape of the API
 * suggested it might build — and the two differ. These PTBs span three packages
 * (bucket_policy, permissioned_group, and 0x2::transfer), which was not guessable
 * from the endpoint's signature.
 *
 * `fixtures.createBucket` is a capture of the LEGACY reserve, from before the API
 * rebuilt create-bucket around `add_owner` + the signing key's self-demotion. It
 * is kept, and used below, as a REJECTION input: the identity arm must refuse the
 * old roster-only shape rather than quietly accept it.
 */

/**
 * The package set every fixture in this file was captured against — the testnet
 * deploy that preceded the COMG-786 fresh publish. Pinned literally rather than
 * read from the live testnet config: the captured bytes name these packages, and
 * the live config moves on every republish.
 */
const cfg: BucketGroupPackageConfig = {
  packageId: "0x28d1cf624b03376df62138a0372b506bbd456790ee183e244c25231a39c618db",
  originalPackageId: "0x28d1cf624b03376df62138a0372b506bbd456790ee183e244c25231a39c618db",
  bucketRegistryId: "0x314fc86db4449e75f542015fd952513393b4671f6cf1dea01fd1f94697d97ab6",
  permissionedGroupPackageId: "0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79",
};

const grantExpectation = (scope: "read" | "readwrite") => {
  const f =
    scope === "readwrite" ? fixtures.grantBucketAccessReadWrite : fixtures.grantBucketAccessRead;
  return {
    kind: "grantBucketAccess",
    recipientAddress: f.recipientAddress,
    groupIds: f.groupIds,
    scope,
  } as const;
};

/** The working key: the address that signs the reserve, and gets demoted by it. */
const WORKING = fixtures.workingAddress;
/** The Key-Admin, i.e. the manager `grant_permission` names. */
const ADMIN = fixtures.adminAddress;

const bytesFor = (scope: "read" | "readwrite") =>
  (scope === "readwrite" ? fixtures.grantBucketAccessReadWrite : fixtures.grantBucketAccessRead)
    .bytes;

/** A hostile PTB the endpoint could return instead of the real one. */
const forged = async (
  build: (tx: Transaction) => void,
  sender: string,
  gasOwner = "0x000000000000000000000000000000000000000000000000000000000000dead",
): Promise<string> => {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(gasOwner);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
  ]);
  build(tx);
  return toBase64(await tx.build());
};

/** A distinct sponsor address (never the sender), so the sponsorship check passes. */
const SPONSOR = `0x${"d".repeat(64)}`;
const mk = (c: string) => `0x${c.repeat(64)}`;

/** The human web account the bucket is created FOR — the `add_owner` recipient. */
const OWNER = mk("a");

/**
 * The default fixture's bucket-id argument, BCS-encoded exactly as
 * `tx.pure.string` writes it. The summary surfaces these bytes because they are
 * half the key the new group's object id derives from.
 */
const DEFAULT_BUCKET_UUID = "fa98ed92-aec6-4dce-88c8-58ff76a5cb07";
const BUCKET_ID_ARG = bcs.string().serialize(DEFAULT_BUCKET_UUID).toBytes();
/** An address a hostile endpoint would substitute in. */
const ATTACKER = mk("9");
const MEMBER_ONE = mk("2");
const MEMBER_TWO = mk("3");

// Type identities the create-bucket PTB uses, built exactly as txValidation does.
// Note the roots differ per family: the WalrusConsole witness and BucketAdmin are
// bucket_policy types (v1-rooted, `originalPackageId`); the two *PermissionsAdmin
// types belong to the permissioned_group framework package.
const WALRUS_CONSOLE = `${cfg.originalPackageId}::bucket_policy::WalrusConsole`;
const BUCKET_ADMIN = `${cfg.originalPackageId}::bucket_policy::BucketAdmin`;
const EXT_ADMIN = `${cfg.permissionedGroupPackageId}::permissioned_group::ExtensionPermissionsAdmin`;
const PERMS_ADMIN = `${cfg.permissionedGroupPackageId}::permissioned_group::PermissionsAdmin`;
const PERM_GROUP = `${cfg.permissionedGroupPackageId}::permissioned_group::PermissionedGroup<${cfg.originalPackageId}::bucket_policy::WalrusConsole>`;

/** The signing key's demotion, in the order the PTB performs it. */
const REVOKE_ORDER = ["bucketAdmin", "extensionPermissionsAdmin", "permissionsAdmin"] as const;
type RevokeName = (typeof REVOKE_ORDER)[number];
const REVOKE_TYPE: Record<RevokeName, string> = {
  bucketAdmin: BUCKET_ADMIN,
  extensionPermissionsAdmin: EXT_ADMIN,
  permissionsAdmin: PERMS_ADMIN,
};
/** The bare struct name the validator's refusals use, e.g. `BucketAdmin`. */
const LABEL_OF: Record<RevokeName, string> = {
  bucketAdmin: BUCKET_ADMIN.split("::").at(-1)!,
  extensionPermissionsAdmin: EXT_ADMIN.split("::").at(-1)!,
  permissionsAdmin: PERMS_ADMIN.split("::").at(-1)!,
};

interface Reserve746Opts {
  sender?: string;
  gasOwner?: string;
  registry?: string;
  bucketId?: string;
  /** `add_owner`'s recipient. */
  owner?: string;
  /** Drop `add_owner` entirely. */
  includeOwner?: boolean;
  /** Emit `add_owner` twice. */
  duplicateOwner?: boolean;
  /** The roster, emitted with the builder convention (editor ⇒ viewer + editor). */
  members?: readonly RosterMember[];
  /** Membership calls emitted verbatim, to break the builder convention on purpose. */
  rawMemberCalls?: readonly { address: string; call: "viewer" | "editor" }[];
  /** The signing key's own key scope. */
  signerRole?: "viewer" | "editor";
  /** Drop the signing key's own membership calls. */
  includeSigner?: boolean;
  /** A legacy `add_admin` call, which the identity PTB never makes. */
  addAdmin?: string;
  manager?: string;
  includeGrant?: boolean;
  duplicateGrant?: boolean;
  grantTypeArgs?: [string, string];
  /** Which demotion revokes to emit, in this order. */
  revokes?: readonly RevokeName[];
  revokeTypeArgs?: Partial<Record<RevokeName, [string, string]>>;
  revokeRecipient?: string;
  /** Point one call at the registry instead of the group this PTB creates. */
  misdirect?: "owner" | "revoke";
  extraCreate?: boolean;
  shareTypeArg?: string;
  shareNotLast?: boolean;
  /** An address carried as an input but referenced by no command. */
  unusedAddress?: string;
  /** An address smuggled into an argument position nothing checks. */
  createExtraArgAddress?: string;
  addNonMoveCommand?: boolean;
}

/**
 * Build a create-bucket-identity reserve to the exact shape the API's 746 PTB
 * produces, with knobs to introduce one deviation at a time.
 *
 * The template, in order:
 *   1. create_bucket_group(registry, bucket_id)          → Result:0, the group
 *   2. add_owner(group, registry, A)                     — the human owner
 *   3. add_viewer/add_editor(group, registry, other) × N — the verified roster
 *   4. add_viewer(group, registry, B) [+ add_editor]     — the signing key's scope
 *   5. grant_permission<Witness, EPA>(group, manager)    — absent with no key_admin
 *   6-8. revoke_permission<Witness, {BucketAdmin, EPA, PA}>(group, B) — the demotion
 *   9. public_share_object<PermissionedGroup<Witness>>(group)
 *
 * Rebuilding it locally (rather than mutating captured bytes) is how every reject
 * case below is exercised.
 */
const build746Reserve = async (opts: Reserve746Opts = {}): Promise<string> => {
  const tx = new Transaction();
  const sender = opts.sender ?? WORKING;
  tx.setSender(sender);
  tx.setGasOwner(opts.gasOwner ?? SPONSOR);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
  ]);

  const registry = tx.sharedObjectRef({
    objectId: opts.registry ?? cfg.bucketRegistryId,
    initialSharedVersion: "1",
    mutable: true,
  });
  const bucketId = tx.pure.string(opts.bucketId ?? "fa98ed92-aec6-4dce-88c8-58ff76a5cb07");
  const group = tx.moveCall({
    target: `${cfg.packageId}::bucket_policy::create_bucket_group`,
    arguments: opts.createExtraArgAddress
      ? [registry, bucketId, tx.pure.address(opts.createExtraArgAddress)]
      : [registry, bucketId],
  });
  if (opts.extraCreate) {
    tx.moveCall({
      target: `${cfg.packageId}::bucket_policy::create_bucket_group`,
      arguments: [registry, tx.pure.string("second-bucket-uuid-0000000000000000")],
    });
  }

  const membership = (fn: string, who: string, misdirected = false) =>
    tx.moveCall({
      target: `${cfg.packageId}::bucket_policy::${fn}`,
      arguments: [misdirected ? registry : group, registry, tx.pure.address(who)],
    });

  if (opts.includeOwner !== false) {
    membership("add_owner", opts.owner ?? OWNER, opts.misdirect === "owner");
    if (opts.duplicateOwner) membership("add_owner", opts.owner ?? OWNER);
  }
  for (const member of opts.members ?? []) {
    membership("add_viewer", member.address);
    if (member.role === "editor") membership("add_editor", member.address);
  }
  for (const raw of opts.rawMemberCalls ?? []) {
    membership(raw.call === "editor" ? "add_editor" : "add_viewer", raw.address);
  }
  if (opts.includeSigner !== false) {
    membership("add_viewer", sender);
    if ((opts.signerRole ?? "viewer") === "editor") membership("add_editor", sender);
  }
  if (opts.addAdmin) membership("add_admin", opts.addAdmin);

  if (opts.includeGrant !== false) {
    const grant = () =>
      tx.moveCall({
        target: `${cfg.permissionedGroupPackageId}::permissioned_group::grant_permission`,
        typeArguments: opts.grantTypeArgs ?? [WALRUS_CONSOLE, EXT_ADMIN],
        arguments: [group, tx.pure.address(opts.manager ?? ADMIN)],
      });
    grant();
    if (opts.duplicateGrant) grant();
  }

  for (const name of opts.revokes ?? REVOKE_ORDER) {
    tx.moveCall({
      target: `${cfg.permissionedGroupPackageId}::permissioned_group::revoke_permission`,
      typeArguments: opts.revokeTypeArgs?.[name] ?? [WALRUS_CONSOLE, REVOKE_TYPE[name]],
      arguments: [
        opts.misdirect === "revoke" ? registry : group,
        tx.pure.address(opts.revokeRecipient ?? sender),
      ],
    });
  }

  if (opts.unusedAddress) {
    tx.pure.address(opts.unusedAddress); // carried but never referenced
  }
  tx.moveCall({
    target: `0x2::transfer::public_share_object`,
    typeArguments: [opts.shareTypeArg ?? PERM_GROUP],
    arguments: [group],
  });
  if (opts.shareNotLast) membership("add_viewer", mk("e"));
  if (opts.addNonMoveCommand) tx.splitCoins(tx.gas, [1]);

  return toBase64(await tx.build());
};

interface ValidateOpts {
  /** The pinned human owner the caller asked Console to create the bucket for. */
  owner?: string;
  /** The config-pinned Key-Admin, i.e. `CONSOLE_KEY_ADMIN_ADDRESS`. */
  manager?: string;
  /** The chain-verified roster the caller intends the PTB to grant. */
  members?: readonly RosterMember[];
  /**
   * The locally-DERIVED admin-keypair address (5th positional argument). Pass it
   * explicitly as `undefined` to model a host holding no admin credential.
   */
  derivedManager?: string | undefined;
  signer?: string;
}

const validate = (bytes: string, opts: ValidateOpts = {}) => {
  const expectation: SponsoredTxExpectation = {
    kind: "createBucketIdentity",
    ownerAddress: opts.owner ?? OWNER,
    expectedMembers: opts.members ?? [],
    ...(opts.manager === undefined ? {} : { managerAddress: opts.manager }),
  };
  return assertExpectedTransaction(
    bytes,
    opts.signer ?? WORKING,
    expectation,
    cfg,
    "derivedManager" in opts ? opts.derivedManager : ADMIN,
  );
};

describe("the real transactions Console builds are accepted", () => {
  it("accepts the captured readwrite grant", () => {
    expect(() =>
      assertExpectedTransaction(bytesFor("readwrite"), ADMIN, grantExpectation("readwrite"), cfg),
    ).not.toThrow();
  });

  it("accepts the captured read grant", () => {
    expect(() =>
      assertExpectedTransaction(bytesFor("read"), ADMIN, grantExpectation("read"), cfg),
    ).not.toThrow();
  });
});

describe("signing identity", () => {
  it("rejects a transaction whose sender is not us", async () => {
    // Signing for a sender we are not is the clearest sign the bytes were not
    // built for this credential.
    const bytes = await build746Reserve();
    expect(() => validate(bytes, { signer: Ed25519Keypair.generate().toSuiAddress() })).toThrow(
      /sent by/i,
    );
  });

  it("rejects the working-key flow presented with the admin transaction", () => {
    // Cross-flow substitution: the admin PTB is legitimate, just not something the
    // working key should ever be asked to sign.
    expect(() => validate(bytesFor("readwrite"))).toThrow();
  });
});

describe("scope is not advisory", () => {
  it("rejects a readwrite grant when read was requested", () => {
    // The whole point of asking for `read` is that the recipient cannot write.
    // add_editor where add_viewer was expected silently upgrades that.
    expect(() =>
      assertExpectedTransaction(bytesFor("readwrite"), ADMIN, grantExpectation("read"), cfg),
    ).toThrow(/add_editor|not permitted|scope/i);
  });
});

describe("recipient and targets cannot be substituted", () => {
  it("rejects a grant to an address we did not ask for", () => {
    const tampered = {
      ...grantExpectation("readwrite"),
      recipientAddress: Ed25519Keypair.generate().toSuiAddress(),
    };
    expect(() => assertExpectedTransaction(bytesFor("readwrite"), ADMIN, tampered, cfg)).toThrow(
      /recipient/i,
    );
  });

  it("rejects a grant touching a group we did not ask for", () => {
    const tampered = {
      ...grantExpectation("readwrite"),
      groupIds: [fixtures.grantBucketAccessReadWrite.groupIds[0] as string],
    };
    expect(() => assertExpectedTransaction(bytesFor("readwrite"), ADMIN, tampered, cfg)).toThrow(
      /group|object/i,
    );
  });
});

describe("grant: every requested group must actually receive a call (F1)", () => {
  it("rejects a PTB that grants only some of the requested groups", async () => {
    const f = fixtures.grantBucketAccessReadWrite;
    const bytes = await forged((tx) => {
      const registry = tx.sharedObjectRef({
        objectId: cfg.bucketRegistryId,
        initialSharedVersion: "1",
        mutable: true,
      });
      // Only the first two of the three requested groups get a call; the
      // third is silently dropped, the way a zero- or partial-command PTB
      // would drop it.
      for (const groupId of f.groupIds.slice(0, 2)) {
        const group = tx.sharedObjectRef({
          objectId: groupId,
          initialSharedVersion: "1",
          mutable: true,
        });
        tx.moveCall({
          target: `${cfg.packageId}::bucket_policy::add_editor`,
          arguments: [group, registry, tx.pure.address(f.recipientAddress)],
        });
      }
    }, ADMIN);

    expect(() =>
      assertExpectedTransaction(bytes, ADMIN, grantExpectation("readwrite"), cfg),
    ).toThrow(new RegExp(`does not grant access to group ${f.groupIds[2]}`));
  });

  it("rejects a zero-command PTB instead of accepting it as an empty no-op grant", async () => {
    const f = fixtures.grantBucketAccessReadWrite;
    const bytes = await forged(() => {}, ADMIN);

    expect(() =>
      assertExpectedTransaction(bytes, ADMIN, grantExpectation("readwrite"), cfg),
    ).toThrow(new RegExp(`does not grant access to group ${f.groupIds[0]}`));
  });
});

describe("grant: a group is only credited when argument 1 is really the registry (F8)", () => {
  it("does not credit a group whose add_editor call's argument 1 is not the bucket registry", async () => {
    // groupA gets a correctly-wired call (argument 1 is really the
    // registry). groupB gets only a MALFORMED call: argument 0 names groupB
    // (a legitimately-requested group), but argument 1 is groupA's object,
    // not the registry — a shared object that passes the step-5 allowlist on
    // its own, so nothing else in this file catches the substitution. Before
    // the F8 fix, the group-touched collection trusted argument 0 alone, so
    // groupB was (wrongly) credited as touched despite never really being
    // wired to the registry. After the fix, a call whose argument 1 does not
    // resolve to the registry is not credited at all, so groupB is correctly
    // reported as never granted.
    const f = fixtures.grantBucketAccessReadWrite;
    const groupA = f.groupIds[0] as string;
    const groupB = f.groupIds[1] as string;
    const tampered = { ...grantExpectation("readwrite"), groupIds: [groupA, groupB] };

    const bytes = await forged((tx) => {
      const registry = tx.sharedObjectRef({
        objectId: cfg.bucketRegistryId,
        initialSharedVersion: "1",
        mutable: true,
      });
      const groupARef = tx.sharedObjectRef({
        objectId: groupA,
        initialSharedVersion: "1",
        mutable: true,
      });
      const groupBRef = tx.sharedObjectRef({
        objectId: groupB,
        initialSharedVersion: "1",
        mutable: true,
      });
      // A correctly-wired call for groupA.
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [groupARef, registry, tx.pure.address(f.recipientAddress)],
      });
      // A malformed call: argument 0 is groupB, but argument 1 is groupA's
      // object, not the registry. Move-VM argument type-checking would
      // reject this on-chain (the function's second parameter is typed as
      // the registry), but this client-side structural check does not see
      // Move types — only object identity — so before the fix this call's
      // argument 0 alone was enough to (wrongly) credit groupB as touched,
      // even though it was never really wired to the registry.
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [groupBRef, groupARef, tx.pure.address(f.recipientAddress)],
      });
    }, ADMIN);

    // Before the extraction into `assertGrantBucketAccessStructure`, this
    // malformed call was silently NOT credited, and the failure surfaced
    // later as the deferred completeness message ("does not grant access to
    // group groupB"). After the extraction, the per-call pin on argument 1
    // (mirroring `membershipRecipient`'s registry pin) rejects this call
    // IMMEDIATELY, with a message naming the registry mismatch rather than
    // the eventual missing-coverage symptom.
    expect(() => assertExpectedTransaction(bytes, ADMIN, tampered, cfg)).toThrow(
      /uses a different registry/i,
    );
  });

  it("rejects a forged add_editor whose argument 1 is some other shared object, not the registry", async () => {
    // The dispatch's literal scenario: argument 0 is a legitimately-requested
    // group, argument 1 is not the bucket registry. This particular shape is
    // already rejected today via the step-5 object allowlist (the substitute
    // object is neither the registry nor a requested group) regardless of
    // the F8 fix — kept as a regression test proving the layered defense
    // holds either way.
    const f = fixtures.grantBucketAccessReadWrite;
    const groupA = f.groupIds[0] as string;
    const notRegistry = `0x${"7".repeat(64)}`;

    const bytes = await forged((tx) => {
      const groupARef = tx.sharedObjectRef({
        objectId: groupA,
        initialSharedVersion: "1",
        mutable: true,
      });
      const notRegistryRef = tx.sharedObjectRef({
        objectId: notRegistry,
        initialSharedVersion: "1",
        mutable: true,
      });
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [groupARef, notRegistryRef, tx.pure.address(f.recipientAddress)],
      });
    }, ADMIN);

    expect(() =>
      assertExpectedTransaction(bytes, ADMIN, grantExpectation("readwrite"), cfg),
    ).toThrow(/not the bucket registry|does not grant access to group/i);
  });
});

describe("grant: group, registry and recipient are pinned together per call", () => {
  // These exercise `assertGrantBucketAccessStructure` directly: the per-call
  // pin that mirrors create-bucket's `membershipRecipient` (group, registry,
  // recipient checked TOGETHER, not as three independent passes over the
  // whole PTB), plus the exact-once coverage a `Map<groupId, count>` gives
  // that a `Set` could not.
  const registryRef = (tx: Transaction) =>
    tx.sharedObjectRef({
      objectId: cfg.bucketRegistryId,
      initialSharedVersion: "1",
      mutable: true,
    });
  const groupRef = (tx: Transaction, groupId: string) =>
    tx.sharedObjectRef({ objectId: groupId, initialSharedVersion: "1", mutable: true });

  it("rejects a duplicate add_editor for the same group", async () => {
    const f = fixtures.grantBucketAccessReadWrite;
    const groupId = f.groupIds[0] as string;
    const tampered = { ...grantExpectation("readwrite"), groupIds: [groupId] };

    const bytes = await forged((tx) => {
      const registry = registryRef(tx);
      const group = groupRef(tx, groupId);
      // Two correctly-wired calls for the SAME group. A `Set` cannot tell
      // one call for a group from two; a `Map<groupId, count>` can.
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [group, registry, tx.pure.address(f.recipientAddress)],
      });
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [group, registry, tx.pure.address(f.recipientAddress)],
      });
    }, ADMIN);

    expect(() => assertExpectedTransaction(bytes, ADMIN, tampered, cfg)).toThrow(
      new RegExp(`grants access to group ${groupId} more than once`),
    );
  });

  it("rejects a call with a missing recipient argument, rather than silently not crediting it", async () => {
    const f = fixtures.grantBucketAccessReadWrite;
    const groupId = f.groupIds[0] as string;
    const tampered = { ...grantExpectation("readwrite"), groupIds: [groupId] };

    const bytes = await forged((tx) => {
      const registry = registryRef(tx);
      const group = groupRef(tx, groupId);
      // Group and registry are wired correctly; the recipient argument is
      // missing entirely (only 2 arguments), not merely wrong. The old
      // Set-based code only checked `groupId && wiredToRegistry`, so this
      // call would have been silently credited and the PTB accepted.
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [group, registry],
      });
    }, ADMIN);

    expect(() => assertExpectedTransaction(bytes, ADMIN, tampered, cfg)).toThrow(
      /is not the requested recipient/i,
    );
  });

  it("rejects a call whose first argument is the registry, not a requested group", async () => {
    const f = fixtures.grantBucketAccessReadWrite;
    const groupId = f.groupIds[0] as string;
    const tampered = { ...grantExpectation("readwrite"), groupIds: [groupId] };

    const bytes = await forged((tx) => {
      const registry = registryRef(tx);
      const group = groupRef(tx, groupId);
      // A legitimate call for the real group — completeness is satisfied —
      // PLUS a bogus call whose FIRST argument is the registry itself. The
      // registry passes the step-5 object allowlist on its own (every grant
      // references it), so only a per-call check that argument 0 is a
      // REQUESTED GROUP, not merely an allowed object, catches this.
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [group, registry, tx.pure.address(f.recipientAddress)],
      });
      tx.moveCall({
        target: `${cfg.packageId}::bucket_policy::add_editor`,
        arguments: [registry, registry, tx.pure.address(f.recipientAddress)],
      });
    }, ADMIN);

    expect(() => assertExpectedTransaction(bytes, ADMIN, tampered, cfg)).toThrow(
      /is not one of the groups this flow asked for/i,
    );
  });

  it("still rejects an address smuggled in as an unreferenced input (preserves the closing sweep)", async () => {
    // Passes today, before the extraction — this proves the whole-PTB
    // closing Pure-address sweep (which is not equivalent to the per-call
    // recipient pin above: the pin only reads argument 2 of a call already
    // narrowed to add_editor/add_viewer) survives moving into the new
    // function as its last check.
    const f = fixtures.grantBucketAccessReadWrite;

    const bytes = await forged((tx) => {
      const registry = registryRef(tx);
      for (const groupId of f.groupIds) {
        const group = groupRef(tx, groupId);
        tx.moveCall({
          target: `${cfg.packageId}::bucket_policy::add_editor`,
          arguments: [group, registry, tx.pure.address(f.recipientAddress)],
        });
      }
      // Carried by the PTB but referenced by no command.
      tx.pure.address(ATTACKER);
    }, ADMIN);

    expect(() =>
      assertExpectedTransaction(bytes, ADMIN, grantExpectation("readwrite"), cfg),
    ).toThrow(/grants access to .*, not the requested recipient/i);
  });
});

describe("forged transactions from a hostile endpoint", () => {
  const sender = fixtures.workingAddress;

  it("rejects a coin transfer disguised as a bucket reserve", async () => {
    // The headline attack: any endpoint that passes the base-URL allowlist could
    // return this and walk away with a signature that moves the signer's coins.
    const bytes = await forged((tx) => {
      const [coin] = tx.splitCoins(tx.gas, [1_000_000]);
      tx.transferObjects([coin!], `0x${"9".repeat(64)}`);
    }, sender);

    expect(() => validate(bytes, { signer: sender })).toThrow(
      /SplitCoins|TransferObjects|only move calls/i,
    );
  });

  it("rejects a call into a package that is not ours", async () => {
    const bytes = await forged((tx) => {
      tx.moveCall({ target: `0x${"a".repeat(64)}::drainer::drain`, arguments: [] });
    }, sender);

    expect(() => validate(bytes, { signer: sender })).toThrow(/does not use/i);
  });

  it("rejects an unexpected function inside our own package", async () => {
    // Package-level allowlisting alone is not enough: our package has functions
    // that this flow has no business calling.
    const bytes = await forged((tx) => {
      tx.moveCall({ target: `${cfg.packageId}::bucket_policy::remove_admin`, arguments: [] });
    }, sender);

    expect(() => validate(bytes, { signer: sender })).toThrow(/remove_admin/i);
  });

  it("rejects a transaction we would be paying for ourselves", async () => {
    // These flows are sponsored — Console pays. A PTB billing our own gas coins is
    // not the flow we asked for, and gas coins are spendable value.
    const bytes = await forged(
      (tx) => {
        tx.moveCall({
          target: `${cfg.packageId}::bucket_policy::create_bucket_group`,
          arguments: [],
        });
      },
      sender,
      sender,
    );

    expect(() => validate(bytes, { signer: sender })).toThrow(/not sponsored/i);
  });

  it("rejects bytes that are not a transaction at all", () => {
    expect(() => validate("bm90LWEtdHJhbnNhY3Rpb24=")).toThrow();
  });
});

describe("create-bucket identity: the shapes Console legitimately builds", () => {
  it("accepts a read-scope reserve", async () => {
    const bytes = await build746Reserve();
    expect(validate(bytes).create).toEqual({
      owner: OWNER,
      members: [],
      signerRole: "viewer",
      manager: ADMIN,
      bucketIdArg: BUCKET_ID_ARG,
    });
  });

  it("accepts a readwrite-scope reserve", async () => {
    const bytes = await build746Reserve({ signerRole: "editor" });
    expect(validate(bytes).create).toEqual({
      owner: OWNER,
      members: [],
      signerRole: "editor",
      manager: ADMIN,
      bucketIdArg: BUCKET_ID_ARG,
    });
  });

  it("accepts a reserve from a space with no key_admin key (no grant_permission)", async () => {
    // The grant command is absent whenever the space holds no key-admin key. Its
    // absence is always legal; only an unverifiable PRESENT grant is refused.
    const bytes = await build746Reserve({ includeGrant: false });
    expect(validate(bytes, { derivedManager: undefined }).create).toEqual({
      owner: OWNER,
      members: [],
      signerRole: "viewer",
      bucketIdArg: BUCKET_ID_ARG,
    });
  });

  it("accepts a reserve granting exactly the verified roster", async () => {
    const members: RosterMember[] = [
      { address: MEMBER_ONE, role: "viewer" },
      { address: MEMBER_TWO, role: "editor" },
    ];
    const bytes = await build746Reserve({ members });
    expect(validate(bytes, { members }).create).toEqual({
      owner: OWNER,
      members,
      signerRole: "viewer",
      manager: ADMIN,
      bucketIdArg: BUCKET_ID_ARG,
    });
  });

  it("surfaces create_bucket_group's own bucket-id argument, verbatim", async () => {
    // The caller derives the new group's object id from these bytes, so they have
    // to be the ones IN the transaction rather than anything reconstructed
    // alongside it — a different bucket id derives a different group, and caching
    // that would point every later roster check at an object nobody controls.
    const bucketId = "0f7c1c5e-2b41-4c8a-9c0e-1d2e3f405162";
    const bytes = await build746Reserve({ bucketId });
    const surfaced = validate(bytes).create?.bucketIdArg;

    expect(surfaced).toEqual(bcs.string().serialize(bucketId).toBytes());
    expect(bcs.string().parse(surfaced as Uint8Array)).toBe(bucketId);
  });

  it("compares addresses canonically, not textually", async () => {
    // `isValidSuiAddress` accepts mixed case and a 64-hex value with no `0x`, and
    // the config pins are stored raw. A legitimately-pinned owner written in
    // non-canonical form must still validate, or every create would refuse.
    const bytes = await build746Reserve({ members: [{ address: MEMBER_ONE, role: "viewer" }] });
    expect(() =>
      validate(bytes, {
        owner: OWNER.slice(2).toUpperCase(),
        manager: ADMIN.toUpperCase(),
        members: [{ address: MEMBER_ONE.slice(2).toUpperCase(), role: "viewer" }],
      }),
    ).not.toThrow();
  });
});

describe("create-bucket identity: the owner pin (F1)", () => {
  // This inverts the test that used to read "STILL accepts a substituted add_admin
  // recipient (the disclosed, unclosed residual)". `add_owner` has NO type-argument
  // bound, so the recipient pin is the ONLY thing covering it — and a forged
  // add_owner combined with the signing key's self-demotion would leave the
  // attacker as sole owner of a bucket the PTB then disarms itself out of.
  it("rejects a forged add_owner recipient", async () => {
    const bytes = await build746Reserve({ owner: ATTACKER });
    // Asserted on text UNIQUE to the recipient comparison. A looser match such as
    // /owner/i or the attacker's address alone is also satisfied by the closing
    // address sweep, which would leave this — the file's most security-critical
    // pin — passing even with the comparison deleted.
    expect(() => validate(bytes)).toThrow(new RegExp(`the bucket's owner, not ${OWNER}`));
  });

  it("rejects a reserve that grants no owner at all", async () => {
    // The chain also fails closed here (revoking the signer's PermissionsAdmin
    // aborts on the last-admin guard), but the client must not depend on that.
    const bytes = await build746Reserve({ includeOwner: false });
    expect(() => validate(bytes)).toThrow(/add_owner/i);
  });

  it("rejects a second add_owner call", async () => {
    const bytes = await build746Reserve({ duplicateOwner: true });
    expect(() => validate(bytes)).toThrow(/add_owner calls/i);
  });

  it("rejects an add_owner pointed at a group this PTB did not create", async () => {
    const bytes = await build746Reserve({ misdirect: "owner" });
    expect(() => validate(bytes)).toThrow(/new bucket group/i);
  });
});

describe("create-bucket identity: the roster is exact, both directions", () => {
  it("rejects a roster address the chain check did not confirm", async () => {
    const bytes = await build746Reserve({ members: [{ address: ATTACKER, role: "editor" }] });
    expect(() => validate(bytes, { members: [] })).toThrow(/verified roster does not include/i);
  });

  it("rejects a reserve missing a verified member", async () => {
    const bytes = await build746Reserve({ members: [] });
    expect(() => validate(bytes, { members: [{ address: MEMBER_ONE, role: "viewer" }] })).toThrow(
      /does not grant/i,
    );
  });

  it("rejects a viewer upgraded to editor", async () => {
    const bytes = await build746Reserve({ members: [{ address: MEMBER_ONE, role: "editor" }] });
    expect(() => validate(bytes, { members: [{ address: MEMBER_ONE, role: "viewer" }] })).toThrow(
      /editor.*viewer|viewer.*editor/i,
    );
  });

  it("rejects an editor downgraded to viewer", async () => {
    const bytes = await build746Reserve({ members: [{ address: MEMBER_ONE, role: "viewer" }] });
    expect(() => validate(bytes, { members: [{ address: MEMBER_ONE, role: "editor" }] })).toThrow(
      /editor.*viewer|viewer.*editor/i,
    );
  });

  it("rejects an add_editor with no matching add_viewer", async () => {
    // The builder convention is add_viewer for a viewer, BOTH calls for an editor.
    // Anything else is a shape this client has never verified.
    const bytes = await build746Reserve({
      rawMemberCalls: [{ address: MEMBER_ONE, call: "editor" }],
    });
    expect(() => validate(bytes, { members: [{ address: MEMBER_ONE, role: "editor" }] })).toThrow(
      /membership calls/i,
    );
  });

  it("rejects a repeated add_viewer for the same address", async () => {
    const bytes = await build746Reserve({
      members: [{ address: MEMBER_ONE, role: "viewer" }],
      rawMemberCalls: [{ address: MEMBER_ONE, call: "viewer" }],
    });
    expect(() => validate(bytes, { members: [{ address: MEMBER_ONE, role: "viewer" }] })).toThrow(
      /membership calls/i,
    );
  });

  it("rejects a reserve that never grants the signing key its key scope", async () => {
    const bytes = await build746Reserve({ includeSigner: false });
    // /signing key/i alone matches five different refusals in this file.
    expect(() => validate(bytes)).toThrow(/never grants the signing key/);
  });

  it("rejects the legacy add_admin call outright", async () => {
    // add_admin is gone from the allowlist: the identity PTB grants ownership with
    // add_owner and nothing in this flow hands out group admin.
    const bytes = await build746Reserve({ addAdmin: ATTACKER });
    expect(() => validate(bytes)).toThrow(/add_admin/i);
  });

  it("rejects an expected roster that names the same address twice", async () => {
    const bytes = await build746Reserve({ members: [{ address: MEMBER_ONE, role: "viewer" }] });
    expect(() =>
      validate(bytes, {
        members: [
          { address: MEMBER_ONE, role: "viewer" },
          { address: MEMBER_ONE, role: "editor" },
        ],
      }),
    ).toThrow(/twice/i);
  });
});

describe("create-bucket identity: the signing key's demotion", () => {
  for (const missing of REVOKE_ORDER) {
    it(`rejects a reserve missing the ${missing} revoke`, async () => {
      const bytes = await build746Reserve({ revokes: REVOKE_ORDER.filter((r) => r !== missing) });
      // The one assertion in this file that rejects an OMISSION rather than a
      // commission: without all three revokes the signing key keeps admin rights
      // over a group it was only ever meant to bootstrap.
      //
      // Named per-permission rather than /revoke/i, which every message in the
      // demotion family satisfies — a bare "exactly three" count check would pass
      // all three of these while saying nothing about WHICH permission is missing.
      expect(() => validate(bytes)).toThrow(new RegExp(`does not revoke ${LABEL_OF[missing]}`));
    });
  }

  it("rejects revokes emitted out of order", async () => {
    const bytes = await build746Reserve({
      revokes: ["permissionsAdmin", "bucketAdmin", "extensionPermissionsAdmin"],
    });
    expect(() => validate(bytes)).toThrow(/not the signing key's demotion in order/);
  });

  it("rejects a revoke aimed at someone other than the signing key", async () => {
    // A demotion pointed elsewhere leaves the signer's admin rights intact while
    // still looking, command-for-command, like the PTB we asked for.
    const bytes = await build746Reserve({ revokeRecipient: ATTACKER });
    expect(() => validate(bytes)).toThrow(/demotes .*, not the signing key/);
  });

  it("rejects a revoke whose type arguments are not the demotion set", async () => {
    const bytes = await build746Reserve({
      revokeTypeArgs: { bucketAdmin: [WALRUS_CONSOLE, PERMS_ADMIN] },
    });
    expect(() => validate(bytes)).toThrow(/BucketAdmin/i);
  });

  it("rejects a revoke whose witness type argument is not WalrusConsole", async () => {
    const bytes = await build746Reserve({
      revokeTypeArgs: { extensionPermissionsAdmin: ["0x2::sui::SUI", EXT_ADMIN] },
    });
    expect(() => validate(bytes)).toThrow(/type arguments/i);
  });

  it("rejects a revoke pointed at a group this PTB did not create", async () => {
    const bytes = await build746Reserve({ misdirect: "revoke" });
    expect(() => validate(bytes)).toThrow(/new bucket group/i);
  });
});

describe("create-bucket identity: manager precedence", () => {
  it("accepts a grant matching the config-pinned manager when this host has no admin key", async () => {
    const bytes = await build746Reserve({ manager: ADMIN });
    expect(() => validate(bytes, { manager: ADMIN, derivedManager: undefined })).not.toThrow();
  });

  it("accepts a grant matching the locally-derived manager when nothing is pinned", async () => {
    const bytes = await build746Reserve({ manager: ADMIN });
    expect(() => validate(bytes, { derivedManager: ADMIN })).not.toThrow();
  });

  it("refuses when the pinned and derived manager disagree", async () => {
    const bytes = await build746Reserve({ manager: ADMIN });
    expect(() => validate(bytes, { manager: ADMIN, derivedManager: ATTACKER })).toThrow(
      /CONSOLE_KEY_ADMIN_ADDRESS/,
    );
  });

  it("refuses a grant_permission when no manager address is available at all", async () => {
    // A deliberate behaviour change from the legacy arm, which skipped the check.
    // The refusal names the three ways to supply one.
    const bytes = await build746Reserve();
    expect(() => validate(bytes, { derivedManager: undefined })).toThrow(
      /credential bundle.*CONSOLE_KEY_ADMIN_ADDRESS.*walrus-console-mcp config/s,
    );
  });

  it("rejects a grant to an address that is neither pinned nor derived", async () => {
    const bytes = await build746Reserve({ manager: ATTACKER });
    expect(() => validate(bytes, { derivedManager: ADMIN })).toThrow(/hands group management to/);
  });

  it("rejects grant_permission type args that are not [WalrusConsole, ExtensionPermissionsAdmin]", async () => {
    // The highest-value type pin: the raw-grant route to pause()+burn (permanent
    // EGroupPaused, all Seal content undecryptable) needs no admin role at all,
    // only a grant with the wrong extension type.
    const bytes = await build746Reserve({ grantTypeArgs: [WALRUS_CONSOLE, PERMS_ADMIN] });
    expect(() => validate(bytes)).toThrow(/type arguments/i);
  });

  it("still pins the grant TYPE arguments when only the config pin supplies the manager", async () => {
    const bytes = await build746Reserve({ grantTypeArgs: ["0x2::sui::SUI", "0x2::sui::SUI"] });
    expect(() => validate(bytes, { manager: ADMIN, derivedManager: undefined })).toThrow(
      /type arguments/i,
    );
  });

  it("rejects two grant_permission calls", async () => {
    const bytes = await build746Reserve({ duplicateGrant: true });
    expect(() => validate(bytes)).toThrow(/grant_permission calls/i);
  });
});

describe("create-bucket identity: structural hardening", () => {
  it("rejects the captured legacy roster reserve at the target allowlist", async () => {
    // Pins WHICH check fires, because a bare `.toThrow()` here was a blind
    // claim: this capture is rejected at step 4 (the allowlist) and never
    // reaches a single identity check, so the assertion was satisfied by at
    // least three unrelated refusals — and it survived the mutation that puts
    // `add_admin` back in the allowlist, i.e. the exact downgrade it is named
    // for. What this test proves is narrow and now says so.
    expect(() => validate(fixtures.createBucket.bytes)).toThrow(/add_admin/i);
  });

  it("rejects the legacy SHAPE even when add_admin is not the giveaway", async () => {
    // The claim the test above was mistakenly credited with. A legacy-shaped
    // reserve minus `add_admin` clears the allowlist, so the identity structure
    // is what has to refuse it: no add_owner, and no demotion of the signing
    // key. Without this, nothing exercises the arm against the old shape.
    const bytes = await build746Reserve({
      includeOwner: false,
      revokes: [],
      members: [{ address: mk("a"), role: "viewer" }],
    });
    expect(() => validate(bytes)).toThrow(/add_owner/i);
  });

  it("rejects two create_bucket_group calls", async () => {
    const bytes = await build746Reserve({ extraCreate: true });
    expect(() => validate(bytes)).toThrow(/create_bucket_group calls/i);
  });

  it("rejects a share that is not the last command", async () => {
    const bytes = await build746Reserve({ shareNotLast: true });
    expect(() => validate(bytes)).toThrow(/last command is not public_share_object/i);
  });

  it("rejects a share of the wrong type", async () => {
    const bytes = await build746Reserve({ shareTypeArg: WALRUS_CONSOLE });
    expect(() => validate(bytes)).toThrow(/PermissionedGroup<WalrusConsole>/i);
  });

  it("rejects an unreferenced address carried alongside the real inputs", async () => {
    const bytes = await build746Reserve({ unusedAddress: mk("f") });
    expect(() => validate(bytes)).toThrow(/never used/i);
  });

  it("rejects an address smuggled into an argument nothing else checks", async () => {
    // The global sweep is the backstop behind the per-command pins: every Pure
    // 32-byte input must be an address this flow already accounts for.
    const bytes = await build746Reserve({ createExtraArgAddress: ATTACKER });
    expect(() => validate(bytes)).toThrow(/carries the address/i);
  });

  it("rejects a non-move-call command smuggled into the reserve", async () => {
    const bytes = await build746Reserve({ addNonMoveCommand: true });
    expect(() => validate(bytes)).toThrow(/only move calls/i);
  });

  it("does not run the create-bucket structural checks for a grant", () => {
    // Regression: a grant PTB has no create_bucket_group, so if the structural
    // step leaked onto it, it would throw. It must return no summary instead.
    const result = assertExpectedTransaction(
      bytesFor("readwrite"),
      ADMIN,
      grantExpectation("readwrite"),
      cfg,
    );
    expect(result.create).toBeUndefined();
  });
});

/**
 * The one create-bucket PTB in this suite whose shape we did not author.
 *
 * Every other acceptance test calls `build746Reserve`, which encodes what this
 * repository BELIEVES the API sends. That is a closed loop: it proves the
 * validator agrees with our model, never that our model is right. This branch
 * already shipped a bug of that exact shape — a response field read under a name
 * the wire never used, with stubs asserting the same wrong shape the client
 * believed in — so the failure mode is demonstrated, not hypothetical.
 *
 * These bytes came off the real COMG-746/761 deployment
 * (`scripts/capture-746-fixture.mts`). If the API's shape moves and our builder
 * does not, THIS is the test that breaks.
 */
describe("create-bucket identity: a real reserve, captured from a live Console", () => {
  const real = realFixture;
  const realExpectation: SponsoredTxExpectation = {
    kind: "createBucketIdentity",
    ownerAddress: real.ownerAddress,
    expectedMembers: [],
    ...(real.managerAddress === null ? {} : { managerAddress: real.managerAddress }),
  };

  it("accepts bytes a real Console actually built", () => {
    const summary = assertExpectedTransaction(
      real.bytes,
      real.signerAddress,
      realExpectation,
      real.packageConfig,
      real.managerAddress ?? undefined,
    ).create;

    expect(summary?.owner).toBe(real.ownerAddress);
    expect(summary?.members).toEqual([]);
    expect(summary?.manager).toBe(real.managerAddress);
    // The signer's own scope is whatever that key holds; both are legal. What
    // matters is that it was READ, not that it took a particular value.
    expect(["viewer", "editor"]).toContain(summary?.signerRole);
  });

  it("carries the same command graph our hand-built reserve does", async () => {
    // The anti-fiction check. `build746Reserve` is the basis of ~40 other tests;
    // if it drifts from what a real Console builds, all of them keep passing
    // while testing a shape that no longer exists. Comparing the two graphs is
    // what turns that silent drift into a failure.
    const shape = (bytesBase64: string): string[] =>
      Transaction.from(fromBase64(bytesBase64))
        .getData()
        .commands.map((command) => {
          const call = (command as { MoveCall?: { module: string; function: string } }).MoveCall;
          return call ? `${call.module}::${call.function}` : "non-move-call";
        });

    // Built to match the captured reserve: readwrite signer, manager present,
    // empty roster — the same three knobs the capture used.
    const ours = await build746Reserve({ signerRole: "editor" });
    expect(shape(real.bytes)).toEqual(shape(ours));
  });

  it("still refuses a forged owner in bytes that are otherwise genuine", () => {
    // The owner pin, exercised against real bytes rather than our own. Proves the
    // check is not merely consistent with our builder's idea of a reserve.
    expect(() =>
      assertExpectedTransaction(
        real.bytes,
        real.signerAddress,
        { ...realExpectation, ownerAddress: ATTACKER },
        real.packageConfig,
        real.managerAddress ?? undefined,
      ),
    ).toThrow(new RegExp(`the bucket's owner, not ${ATTACKER}`));
  });
});
