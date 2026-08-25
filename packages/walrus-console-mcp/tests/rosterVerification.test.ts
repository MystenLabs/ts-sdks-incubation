import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ConsoleApiClient, type SpaceSignersResponse } from "../src/console/ConsoleApiClient";
import { MAINNET_PACKAGE_CONFIG, TESTNET_PACKAGE_CONFIG } from "../src/console/packageConfig";
import {
  authorVerifiedRoster,
  enumerateAnchorMembers,
  makeRosterChainDeps,
  MAX_ADDRESSES_PER_SIMULATION,
  MAX_ADMITTED_ANCHORS,
  MAX_ROSTER_MEMBERS,
  resolveRosterRoles,
  RosterUnavailableError,
  type AuthorRosterInput,
  type MemberFieldPage,
  type RosterChainDeps,
  type SimulationRead,
} from "../src/console/rosterVerification";

/**
 * `SuiGrpcClient` is stubbed rather than reached: the default deps are a thin
 * adapter and what is worth pinning is the SHAPE it asks the SDK for — content
 * on the object read, the cursor threaded through pagination, and command
 * results on the simulation. Nothing else in this file constructs one.
 */
const { grpcCalls } = vi.hoisted(() => ({
  grpcCalls: [] as { kind: string; input: unknown }[],
}));

vi.mock("@mysten/sui/grpc", () => ({
  SuiGrpcClient: class {
    constructor(options: unknown) {
      grpcCalls.push({ kind: "construct", input: options });
    }
    async getObject(input: unknown) {
      grpcCalls.push({ kind: "getObject", input });
      return { object: { type: "0x2::a::B", content: new Uint8Array([9]) } };
    }
    async listDynamicFields(input: unknown) {
      grpcCalls.push({ kind: "listDynamicFields", input });
      return {
        dynamicFields: [{ fieldId: "0xf", name: { type: "address", bcs: new Uint8Array(32) } }],
        hasNextPage: true,
        cursor: "next-page",
      };
    }
    async simulateTransaction(input: unknown) {
      grpcCalls.push({ kind: "simulateTransaction", input });
      return { commandResults: [{ returnValues: [{ bcs: new Uint8Array([1]) }] }] };
    }
  },
}));

/**
 * The roster is what decides who can decrypt a new bucket, so every test here is
 * about one of two failure directions:
 *
 *  - AUTHORING SOMEONE IN who should not be there (a hostile Console injecting an
 *    address, or a claimed `scope` upgrading a viewer to editor); and
 *  - DROPPING SOMEONE who should be there (a truncated enumeration page, an
 *    address the two sources spell differently).
 *
 * The three drop/keep cases in `authorVerifiedRoster` look alike at a glance and
 * only two of them may legitimately shrink a roster; all three are asserted
 * explicitly, in both directions.
 */

// === Fixtures =============================================================
//
// PROVENANCE — verified, not assumed. On 2026-08-21 a live end-to-end run
// against the COMG-746/761 staging deployment (https://api.testnet.patestation.org)
// confirmed these shapes over gRPC: it enumerated a real anchor group, parsed its
// real BCS content, and authored a member whose role came from the on-chain
// `has_permission` check rather than the `read` scope the API claimed for it. So
// the `PermissionedGroup<T>` layout, the `getGroupObject` / `listMemberFields` /
// `simulate` response shapes and the one-byte bool encoding below all match what
// a fullnode actually served, on that date and that deployment.
//
// The BCS declaration is the one that most needs saying out loud: `bcs.struct()
// .parse` IGNORES trailing bytes, so a declaration SHORTER than the real struct
// parses cleanly and silently — no test in this file could tell the difference.

const CONFIG = TESTNET_PACKAGE_CONFIG;
const ORIGINAL = normalizeSuiAddress(CONFIG.originalPackageId);
const GROUP_PKG = normalizeSuiAddress(CONFIG.permissionedGroupPackageId);
const WITNESS = `${ORIGINAL}::bucket_policy::WalrusConsole`;
const GROUP_TYPE = normalizeStructTag(
  `${GROUP_PKG}::permissioned_group::PermissionedGroup<${WITNESS}>`,
);

const ANCHOR = normalizeSuiAddress("0xa11c0");
const TABLE = normalizeSuiAddress("0x7ab1e");
const ZERO = normalizeSuiAddress("0x0");

/** Deterministic distinct addresses; `addr(1)` is `0x00…01`. */
const addr = (n: number): string => normalizeSuiAddress(`0x${n.toString(16)}`);

const OWNER = addr(0xf1);
const SIGNER = addr(0xf2);
const MANAGER = addr(0xf3);

/** BCS of `PermissionedGroup<T>` exactly as the fullnode serves object content. */
const GroupContentBcs = bcs.struct("PermissionedGroup", {
  id: bcs.Address,
  permissions: bcs.struct("PermissionsTable", { id: bcs.Address, length: bcs.u64() }),
  permissionsAdminCount: bcs.u64(),
  creator: bcs.Address,
});

function groupObject(memberCount: number, tableId = TABLE) {
  return {
    type: GROUP_TYPE,
    content: GroupContentBcs.serialize({
      id: ANCHOR,
      permissions: { id: tableId, length: BigInt(memberCount) },
      permissionsAdminCount: 1n,
      creator: OWNER,
    }).toBytes(),
  };
}

/** One `listDynamicFields` page, shaped as the SDK returns it. */
function memberPage(addresses: readonly string[], next: string | null = null): MemberFieldPage {
  return {
    dynamicFields: addresses.map((a) => ({
      name: { type: "address", bcs: bcs.Address.serialize(a).toBytes() },
    })),
    hasNextPage: next !== null,
    cursor: next,
  };
}

/** `has_permission` returns a bool; simulation gives it back as one BCS byte. */
function boolResults(bools: readonly boolean[]): SimulationRead {
  return {
    commandResults: bools.map((b) => ({
      returnValues: [{ bcs: new Uint8Array([b ? 1 : 0]) }],
    })),
  };
}

interface ChainStub {
  readonly deps: RosterChainDeps;
  readonly groupReads: string[];
  readonly pageReads: [string, string | null][];
  readonly simulations: Transaction[];
}

/** The permissions table of the group at `groupId`, distinct per group. */
const tableOf = (groupId: string): string =>
  normalizeSuiAddress(`0x7ab1e${normalizeSuiAddress(groupId).slice(-8)}`);

/**
 * Chain reads over SEVERAL anchor groups: membership per group id, and a role
 * answer per (group, address).
 *
 * A second stub rather than more options on `chainStub`, because the two model
 * different things. `chainStub` serves a scripted sequence — the shape that can
 * express a truncated page or a malformed field. This one serves a small world
 * of groups, which is what the union, the admission rule and the per-anchor role
 * probe are about.
 */
function multiAnchorStub(
  world: Record<string, readonly string[]>,
  roleFor: (groupId: string, address: string) => readonly [boolean, boolean] = () => [false, false],
): ChainStub {
  const groupReads: string[] = [];
  const pageReads: [string, string | null][] = [];
  const simulations: Transaction[] = [];
  const byTable = new Map(
    Object.keys(world).map((groupId) => [tableOf(groupId), normalizeSuiAddress(groupId)]),
  );
  const membersOf = (groupId: string): readonly string[] => world[groupId] ?? [];

  return {
    groupReads,
    pageReads,
    simulations,
    deps: {
      config: CONFIG,
      getGroupObject: async (objectId) => {
        groupReads.push(objectId);
        return {
          type: GROUP_TYPE,
          content: GroupContentBcs.serialize({
            id: objectId,
            permissions: { id: tableOf(objectId), length: BigInt(membersOf(objectId).length) },
            permissionsAdminCount: 1n,
            creator: OWNER,
          }).toBytes(),
        };
      },
      listMemberFields: async (parentId, cursor) => {
        pageReads.push([parentId, cursor]);
        return memberPage(membersOf(byTable.get(parentId) ?? ""));
      },
      simulate: async (tx) => {
        simulations.push(tx);
        const groupId = probedGroup(tx);
        const asked = pureAddresses(tx).filter((_, index) => index % 2 === 0);
        return boolResults(asked.flatMap((address) => [...roleFor(groupId, address)]));
      },
    },
  };
}

/**
 * Chain reads as injected stubs. Every call is recorded so the "zero reads"
 * branches can assert the stubs were never reached, rather than merely that the
 * result happened to be empty.
 */
function chainStub(opts: {
  // `type` is deliberately `unknown`: it arrives from the network, so tests need
  // to serve the shapes the static type promises cannot happen.
  group?: { type: unknown; content: Uint8Array };
  pages?: readonly MemberFieldPage[];
  simulate?: (tx: Transaction, n: number) => SimulationRead;
  failGroup?: string;
  failPages?: string;
  failSimulate?: string;
}): ChainStub {
  const groupReads: string[] = [];
  const pageReads: [string, string | null][] = [];
  const simulations: Transaction[] = [];
  let pageIndex = 0;
  let simIndex = 0;

  const deps: RosterChainDeps = {
    config: CONFIG,
    getGroupObject: async (objectId) => {
      groupReads.push(objectId);
      if (opts.failGroup) throw new Error(opts.failGroup);
      return opts.group as { type: string; content: Uint8Array };
    },
    listMemberFields: async (parentId, cursor) => {
      pageReads.push([parentId, cursor]);
      if (opts.failPages) throw new Error(opts.failPages);
      const page = opts.pages?.[pageIndex++];
      if (!page) throw new Error("test stub ran out of pages");
      return page;
    },
    simulate: async (tx) => {
      simulations.push(tx);
      if (opts.failSimulate) throw new Error(opts.failSimulate);
      if (!opts.simulate) throw new Error("test stub has no simulation");
      return opts.simulate(tx, simIndex++);
    },
  };

  return { deps, groupReads, pageReads, simulations };
}

function candidates(
  ...signers: { address: string; scope?: "read" | "readwrite" }[]
): SpaceSignersResponse {
  return {
    signers: signers.map((s, i) => ({
      api_key_id: `key-${i}`,
      service_signer_address: s.address,
      scope: s.scope ?? "readwrite",
    })),
  };
}

/**
 * Task 6 wires this module in by handing `() => api.listSpaceSigners()` to
 * `listCandidates` verbatim. Asserted at compile time here, because a drift in
 * either shape would otherwise only surface while editing the OTHER task's file.
 */
const _task6Wiring: AuthorRosterInput["listCandidates"] = () =>
  undefined as unknown as ReturnType<typeof ConsoleApiClient.Service.listSpaceSigners>;
void _task6Wiring;

const runOk = <A>(effect: Effect.Effect<A, RosterUnavailableError>) => Effect.runPromise(effect);
const runFail = <A>(effect: Effect.Effect<A, RosterUnavailableError>) =>
  Effect.runPromise(Effect.flip(effect));

/** The MoveCall rows of a simulated PTB, normalized for comparison. */
function moveCalls(tx: Transaction) {
  return tx.getData().commands.map((command) => {
    const call = (command as { MoveCall?: Record<string, unknown> }).MoveCall;
    if (!call) throw new Error("not a move call");
    return {
      target: `${normalizeSuiAddress(call["package"] as string)}::${call["module"]}::${call["function"]}`,
      typeArguments: (call["typeArguments"] as string[]).map((t) => normalizeStructTag(t)),
    };
  });
}

/** The group a role-check PTB asks about — its one unresolved object input. */
function probedGroup(tx: Transaction): string {
  for (const input of tx.getData().inputs) {
    const object = (input as { UnresolvedObject?: { objectId: string } }).UnresolvedObject;
    if (object) return normalizeSuiAddress(object.objectId);
  }
  throw new Error("role-check PTB carries no group object");
}

/** Every 32-byte Pure input of a PTB, as addresses, in input order. */
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

// === 7a — enumeration =====================================================

describe("enumerateAnchorMembers", () => {
  it("paginates fully and returns normalized member addresses", async () => {
    const members = [addr(1), addr(2), addr(3), addr(4), addr(5)];
    const stub = chainStub({
      group: groupObject(5),
      pages: [
        memberPage(members.slice(0, 2), "cursor-1"),
        memberPage(members.slice(2, 4), "cursor-2"),
        memberPage(members.slice(4)),
      ],
    });

    const result = await runOk(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(result).toEqual(members);
    // Three pages read, each continuing from the previous page's cursor: a loop
    // that stopped after page one would return a silently shorter roster.
    expect(stub.pageReads).toEqual([
      [TABLE, null],
      [TABLE, "cursor-1"],
      [TABLE, "cursor-2"],
    ]);
    expect(stub.groupReads).toEqual([ANCHOR]);
  });

  it("fails closed when the enumerated count disagrees with member_count", async () => {
    // The group says six members; pagination yielded two. A truncated page must
    // never quietly shrink the roster.
    const stub = chainStub({
      group: groupObject(6),
      pages: [memberPage([addr(1), addr(2)])],
    });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error).toBeInstanceOf(RosterUnavailableError);
    expect(error.stage).toBe("enumeration");
    // Both numbers in the role the message gives them: a bare `toContain("2")`
    // would pass on any message that happens to mention a 2.
    expect(error.message).toContain("reports 6 members but");
    expect(error.message).toContain("produced 2");
  });

  it("fails closed when the anchor object is not a PermissionedGroup<WalrusConsole>", async () => {
    const stub = chainStub({
      group: { ...groupObject(1), type: `${GROUP_PKG}::permissioned_group::SomethingElse` },
      pages: [memberPage([addr(1)])],
    });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error.stage).toBe("enumeration");
    expect(error.message).toContain("SomethingElse");
    // The wrong object is refused before its dynamic fields are trusted as members.
    expect(stub.pageReads).toEqual([]);
  });

  it.each([
    ["a bare package id", "0x2"],
    ["a primitive type", "u64"],
    ["an empty string", ""],
    ["no type at all", undefined],
    ["a null type", null],
    // `normalizeStructTag` accepts a StructTag OBJECT too, so these two do not
    // throw — they are the inputs the `typeof` guard, not the catch, refuses.
    ["a non-string", 42],
    ["a struct-tag object", { address: GROUP_PKG, module: "permissioned_group", name: "Other" }],
  ])("refuses (never dies) when the anchor object's type is %s", async (_label, type) => {
    // `normalizeStructTag` THROWS on each of these. Unguarded, that throw is an
    // Effect DEFECT — no `catchTag` recovers it and the "delete anchors.json"
    // remedy never prints — so this asserts the typed refusal, not just failure.
    const stub = chainStub({ group: { ...groupObject(1), type }, pages: [] });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error).toBeInstanceOf(RosterUnavailableError);
    expect(error.stage).toBe("enumeration");
    expect(error.message).toContain("anchors.json");
    expect(stub.pageReads).toEqual([]);
  });

  it("fails closed when a dynamic-field name is not an address", async () => {
    const stub = chainStub({
      group: groupObject(1),
      pages: [
        {
          dynamicFields: [{ name: { type: "u64", bcs: new Uint8Array(8) } }],
          hasNextPage: false,
          cursor: null,
        },
      ],
    });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error.stage).toBe("enumeration");
    expect(error.message).toContain("u64");
  });

  it("fails closed when a page claims more results but supplies no cursor", async () => {
    // Continuing is impossible and stopping would under-count, so neither is done.
    const stub = chainStub({
      group: groupObject(2),
      pages: [{ ...memberPage([addr(1)]), hasNextPage: true, cursor: null }],
    });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error.stage).toBe("enumeration");
    expect(error.message).toContain("cursor");
  });

  it("refuses when the group object cannot be read", async () => {
    const stub = chainStub({ failGroup: "fullnode unreachable" });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error.stage).toBe("enumeration");
    expect(error.message).toContain("fullnode unreachable");
  });

  it("names the anchor and the remedy when its object cannot be fetched", async () => {
    // A recorded anchor naming an object the fullnode has nothing for — deleted,
    // or never created — is a PERMANENT condition, and it used to take the
    // generic "this is transient — retry" message shared with the page and
    // simulation reads. That leaves the space's `create_bucket` dead with no
    // remedy in sight, while the type-mismatch branch one step later names one.
    //
    // Both causes must be named and NEITHER asserted: from here a fullnode
    // outage and a missing object are the same failed read.
    const stub = chainStub({ failGroup: "object not found" });

    const error = await runFail(enumerateAnchorMembers(stub.deps, ANCHOR));

    expect(error.stage).toBe("enumeration");
    // The cause survives — it is the only clue about which of the two it was.
    expect(error.message).toContain("object not found");
    // The offending anchor, by id, so the entry to remove is identifiable.
    expect(error.message).toContain(ANCHOR);
    expect(error.message).toContain("anchors.json");
    expect(error.message).toMatch(/fullnode/i);
    // Not sold as a passing blip when it is usually anything but.
    expect(error.message).not.toMatch(/this is transient/i);
  });
});

// === 7b — role check ======================================================

describe("resolveRosterRoles", () => {
  it("builds one sender-0x0 PTB with both has_permission calls per address", async () => {
    const stub = chainStub({
      simulate: () => boolResults([false, true, true, true]),
    });

    const result = await runOk(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [addr(1), addr(2)] }),
    );

    expect(result).toEqual([
      { address: addr(1), role: "viewer" },
      { address: addr(2), role: "editor" },
    ]);

    expect(stub.simulations).toHaveLength(1);
    const tx = stub.simulations[0] as Transaction;
    // Sender 0x0: `has_permission` takes the member as a pure argument and never
    // reads `ctx.sender`, so no credential is involved in this read.
    expect(tx.getData().sender).toBe(ZERO);
    expect(moveCalls(tx)).toEqual([
      {
        target: `${GROUP_PKG}::permissioned_group::has_permission`,
        typeArguments: [
          normalizeStructTag(WITNESS),
          normalizeStructTag(`${ORIGINAL}::bucket_policy::BucketEditor`),
        ],
      },
      {
        target: `${GROUP_PKG}::permissioned_group::has_permission`,
        typeArguments: [
          normalizeStructTag(WITNESS),
          normalizeStructTag(`${ORIGINAL}::bucket_policy::BucketViewer`),
        ],
      },
      {
        target: `${GROUP_PKG}::permissioned_group::has_permission`,
        typeArguments: [
          normalizeStructTag(WITNESS),
          normalizeStructTag(`${ORIGINAL}::bucket_policy::BucketEditor`),
        ],
      },
      {
        target: `${GROUP_PKG}::permissioned_group::has_permission`,
        typeArguments: [
          normalizeStructTag(WITNESS),
          normalizeStructTag(`${ORIGINAL}::bucket_policy::BucketViewer`),
        ],
      },
    ]);
    expect(pureAddresses(tx)).toEqual([addr(1), addr(1), addr(2), addr(2)]);
  });

  it("excludes an address holding neither bucket permission", async () => {
    const stub = chainStub({ simulate: () => boolResults([false, false]) });

    const result = await runOk(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [addr(9)] }),
    );

    expect(result).toEqual([]);
  });

  it("normalizes and de-duplicates the addresses it is asked about", async () => {
    const stub = chainStub({ simulate: () => boolResults([true, true]) });

    const result = await runOk(
      resolveRosterRoles(stub.deps, {
        anchorGroupId: ANCHOR,
        // Same address three ways: mixed case, no `0x`, short form.
        addresses: [`0x${"0".repeat(63)}A`, `${"0".repeat(63)}a`, "0xa"],
      }),
    );

    expect(result).toEqual([{ address: addr(0xa), role: "editor" }]);
    expect(moveCalls(stub.simulations[0] as Transaction)).toHaveLength(2);
  });

  it("performs no simulation at all for an empty address list", async () => {
    const stub = chainStub({});

    const result = await runOk(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [] }),
    );

    expect(result).toEqual([]);
    expect(stub.simulations).toEqual([]);
  });

  it("chunks at the 512-address boundary so no PTB exceeds 1024 commands", async () => {
    const many = Array.from({ length: MAX_ADDRESSES_PER_SIMULATION + 1 }, (_, i) => addr(i + 1));
    const stub = chainStub({
      simulate: (tx) => boolResults(tx.getData().commands.map(() => false)),
    });

    await runOk(resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: many }));

    expect(stub.simulations).toHaveLength(2);
    expect(moveCalls(stub.simulations[0] as Transaction)).toHaveLength(
      MAX_ADDRESSES_PER_SIMULATION * 2,
    );
    expect(moveCalls(stub.simulations[1] as Transaction)).toHaveLength(2);
    // The boundary itself stays one call: 512 addresses is exactly 1024 commands.
    const exact = chainStub({
      simulate: (tx) => boolResults(tx.getData().commands.map(() => false)),
    });
    await runOk(
      resolveRosterRoles(exact.deps, {
        anchorGroupId: ANCHOR,
        addresses: many.slice(0, MAX_ADDRESSES_PER_SIMULATION),
      }),
    );
    expect(exact.simulations).toHaveLength(1);
  });

  it("fails closed when the simulation returns the wrong number of results", async () => {
    const stub = chainStub({ simulate: () => boolResults([true]) });

    const error = await runFail(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [addr(1)] }),
    );

    expect(error.stage).toBe("roles");
    // The query count, not merely the digit: one address is two queries.
    expect(error.message).toContain("results for 2 queries");
  });

  it.each([
    ["the wrong width", new Uint8Array([7, 7])],
    // One byte, but not 0 or 1. `!!byte` would silently turn this into a grant.
    ["a byte that is not 0 or 1", new Uint8Array([2])],
    ["no bytes at all", new Uint8Array([])],
  ])("fails closed when a return value has %s instead of a BCS bool", async (_label, raw) => {
    const stub = chainStub({
      simulate: () => ({
        commandResults: [
          { returnValues: [{ bcs: new Uint8Array([1]) }] },
          { returnValues: [{ bcs: raw }] },
        ],
      }),
    });

    const error = await runFail(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [addr(1)] }),
    );

    expect(error.stage).toBe("roles");
    expect(error.message).toContain("bool");
  });

  it("fails closed when a command returns more than one value", async () => {
    const stub = chainStub({
      simulate: () => ({
        commandResults: [
          { returnValues: [{ bcs: new Uint8Array([1]) }] },
          { returnValues: [{ bcs: new Uint8Array([1]) }, { bcs: new Uint8Array([1]) }] },
        ],
      }),
    });

    const error = await runFail(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [addr(1)] }),
    );

    expect(error.stage).toBe("roles");
    expect(error.message).toContain("bool");
  });

  it("refuses when the simulation call itself fails", async () => {
    const stub = chainStub({ failSimulate: "grpc deadline exceeded" });

    const error = await runFail(
      resolveRosterRoles(stub.deps, { anchorGroupId: ANCHOR, addresses: [addr(1)] }),
    );

    expect(error.stage).toBe("roles");
    expect(error.message).toContain("grpc deadline exceeded");
  });
});

// === 7c — assembly ========================================================

/** The default `authorVerifiedRoster` input, overridable per test. */
function input(overrides: Partial<Parameters<typeof authorVerifiedRoster>[1]> = {}) {
  return {
    anchorGroupIds: [ANCHOR],
    // The default anchors record no creator of their own, so the tests that are
    // not about the creator exclusion see exactly the three subtractions they
    // were written against.
    anchorCreators: [],
    ownerAddress: OWNER,
    signerAddress: SIGNER,
    managerAddress: MANAGER,
    listCandidates: () => Effect.succeed(candidates()),
    ...overrides,
  };
}

describe("authorVerifiedRoster", () => {
  it("authors [] with reason `bootstrap` and performs NO reads when no anchor is recorded", async () => {
    const stub = chainStub({});
    let candidateCalls = 0;

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [],
          listCandidates: () =>
            Effect.sync(() => {
              candidateCalls += 1;
              return candidates({ address: addr(1) });
            }),
        }),
      ),
    );

    expect(result.members).toEqual([]);
    expect(result.reason).toBe("bootstrap");
    expect(result.anchorGroupIds).toEqual([]);
    // The outcome cannot change, so nothing is read — not the candidate list and
    // not the chain.
    expect(candidateCalls).toBe(0);
    expect(stub.groupReads).toEqual([]);
    expect(stub.pageReads).toEqual([]);
    expect(stub.simulations).toEqual([]);
  });

  it("authors [] with reason `no_other_signers` and performs ZERO chain reads", async () => {
    const stub = chainStub({});
    let candidateCalls = 0;

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.sync(() => {
              candidateCalls += 1;
              // Only the addresses that are subtracted anyway.
              return candidates({ address: OWNER }, { address: SIGNER }, { address: MANAGER });
            }),
        }),
      ),
    );

    expect(result.members).toEqual([]);
    expect(result.reason).toBe("no_other_signers");
    expect(candidateCalls).toBe(1);
    // Intersecting with an empty candidate set is empty regardless of what chain
    // holds, so the chain stubs must never be reached.
    expect(stub.groupReads).toEqual([]);
    expect(stub.pageReads).toEqual([]);
    expect(stub.simulations).toEqual([]);
  });

  it("distinguishes the two empty-roster reasons, which produce identical bytes", async () => {
    const bootstrap = await runOk(
      authorVerifiedRoster(chainStub({}).deps, input({ anchorGroupIds: [] })),
    );
    const noSigners = await runOk(authorVerifiedRoster(chainStub({}).deps, input()));

    expect(bootstrap.members).toEqual(noSigners.members);
    expect(bootstrap.reason).not.toBe(noSigners.reason);
  });

  it("REFUSES when the candidate read fails, rather than degrading to identity-only", async () => {
    const stub = chainStub({});

    const error = await runFail(
      authorVerifiedRoster(
        stub.deps,
        input({ listCandidates: () => Effect.fail(new Error("503 from Console")) }),
      ),
    );

    expect(error).toBeInstanceOf(RosterUnavailableError);
    expect(error.stage).toBe("candidates");
    expect(error.message).toContain("503 from Console");
    // Retry is the remedy, and the message has to say so.
    expect(error.message.toLowerCase()).toContain("retry");
    expect(stub.groupReads).toEqual([]);
  });

  it("REFUSES a candidate response that carries no signer list at all", async () => {
    const stub = chainStub({});

    const error = await runFail(
      authorVerifiedRoster(
        stub.deps,
        // A body without `signers` is a failed read wearing a 200, not an empty
        // space — it must not fall through to `no_other_signers`.
        input({ listCandidates: () => Effect.succeed({} as SpaceSignersResponse) }),
      ),
    );

    expect(error.stage).toBe("candidates");
    expect(stub.groupReads).toEqual([]);
  });

  it.each([
    ["an entry with no address field", { api_key_id: "k" }],
    ["an entry whose address is not a string", { api_key_id: "k", service_signer_address: 42 }],
    ["a null entry", null],
    ["a non-object entry", "0xdeadbeef"],
  ])("REFUSES (never dies) on a candidate reply carrying %s", async (_label, entry) => {
    const stub = chainStub({});

    // `SpaceSignersResponse` is an unchecked cast over whatever Console
    // returned, so this body clears the `Array.isArray` gate and then reaches
    // `normalizeSuiAddress`, which THROWS on a non-string. Unguarded that is an
    // Effect DEFECT: `catchAll` does not recover it and Task 6's `catchTag`
    // never sees it. This is the one party the module exists to distrust, so it
    // must not get to choose the shape of our failures.
    const error = await runFail(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.succeed({ signers: [entry] } as unknown as SpaceSignersResponse),
        }),
      ),
    );

    expect(error).toBeInstanceOf(RosterUnavailableError);
    expect(error.stage).toBe("candidates");
    expect(error.message.toLowerCase()).toContain("retry");
    // Refused before any chain read, and never treated as `no_other_signers`.
    expect(stub.groupReads).toEqual([]);
  });

  it("REFUSES when the chain enumeration fails", async () => {
    const stub = chainStub({ failGroup: "fullnode unreachable" });

    const error = await runFail(
      authorVerifiedRoster(
        stub.deps,
        input({ listCandidates: () => Effect.succeed(candidates({ address: addr(1) })) }),
      ),
    );

    expect(error).toBeInstanceOf(RosterUnavailableError);
    expect(error.stage).toBe("enumeration");
  });

  it("REFUSES when the chain role check fails", async () => {
    const stub = chainStub({
      group: groupObject(1),
      pages: [memberPage([addr(1)])],
      failSimulate: "grpc unavailable",
    });

    const error = await runFail(
      authorVerifiedRoster(
        stub.deps,
        input({ listCandidates: () => Effect.succeed(candidates({ address: addr(1) })) }),
      ),
    );

    expect(error.stage).toBe("roles");
  });

  it("DROPS a chain member that is not a candidate (the collaborator-wallet case)", async () => {
    const collaborator = addr(0xcc);
    const stub = chainStub({
      group: groupObject(2),
      pages: [memberPage([addr(1), collaborator])],
      simulate: () => boolResults([true, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({ listCandidates: () => Effect.succeed(candidates({ address: addr(1) })) }),
      ),
    );

    expect(result.members).toEqual([{ address: addr(1), role: "editor" }]);
    // The collaborator is not a candidate, so it is not a candidate that got
    // dropped — it was simply never in scope.
    expect(result.droppedCandidates).toEqual([]);
    // Only the intersection is role-checked.
    expect(pureAddresses(stub.simulations[0] as Transaction)).toEqual([addr(1), addr(1)]);
  });

  it("DROPS a candidate that is not on chain, and reports it", async () => {
    const neverAnchored = addr(0xbb);
    const stub = chainStub({
      group: groupObject(1),
      pages: [memberPage([addr(1)])],
      simulate: () => boolResults([false, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            // `read` on the kept one, because chain says viewer and a roster row
            // whose role contradicts the key's scope is refused by the API.
            Effect.succeed(
              candidates({ address: addr(1), scope: "read" }, { address: neverAnchored }),
            ),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: addr(1), role: "viewer" }]);
    expect(result.droppedCandidates).toEqual([neverAnchored]);
  });

  it("NEVER DROPS a candidate that IS on chain, however the two sources spell it", async () => {
    const member = addr(0xab);
    const stub = chainStub({
      group: groupObject(1),
      pages: [memberPage([member])],
      simulate: () => boolResults([true, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            // Mixed-case, no `0x`, and short-form spellings of the SAME address.
            Effect.succeed(
              candidates(
                { address: `0x${"0".repeat(62)}AB` },
                { address: `${"0".repeat(62)}ab` },
                { address: "0xaB" },
              ),
            ),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: member, role: "editor" }]);
    expect(result.droppedCandidates).toEqual([]);
  });

  it("takes the role from CHAIN, and the claimed scope never chooses one", async () => {
    const viewer = addr(1); // chain: viewer only. Console agrees: `read`.
    const editor = addr(2); // chain: editor. Console agrees: `readwrite`.
    const stub = chainStub({
      group: groupObject(2),
      pages: [memberPage([viewer, editor])],
      simulate: () => boolResults([false, true, true, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.succeed(
              candidates(
                { address: viewer, scope: "read" },
                { address: editor, scope: "readwrite" },
              ),
            ),
        }),
      ),
    );

    // Both roles came off the chain read. The scopes agree here, which is the
    // ordinary case — the two tests below are what happens when they do not.
    expect(result.members).toEqual([
      { address: viewer, role: "viewer" },
      { address: editor, role: "editor" },
    ]);
  });

  it("DROPS rather than upgrades when Console claims a scope above the chain role", async () => {
    // The hostile-relabel case. Console says `readwrite`; chain says the address
    // holds BucketViewer only. Authoring `editor` would carry Console's claim
    // into `expectedMembers`, where the validator would accept it — so the claim
    // must not be able to raise a role. It cannot: the only thing a disagreement
    // does is remove the member, which Console could achieve anyway by leaving
    // it off the candidate list.
    const relabelled = addr(1);
    const stub = chainStub({
      group: groupObject(1),
      pages: [memberPage([relabelled])],
      simulate: () => boolResults([false, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.succeed(candidates({ address: relabelled, scope: "readwrite" })),
        }),
      ),
    );

    expect(result.members).toEqual([]);
    expect(result.droppedCandidates).toEqual([relabelled]);
  });

  it("DROPS rather than 400s when the chain role is above the claimed scope", async () => {
    // The partial-grant case, and the reason this is a drop and not a failure:
    // `validateAuthoredMembers` rejects any authored role that contradicts the
    // key's own `expectedPermission`, so sending `editor` for a `read` key turns
    // the whole create into a 400 instead of a quiet under-grant. One member
    // omitted beats no bucket at all.
    const partial = addr(2);
    const stub = chainStub({
      group: groupObject(1),
      pages: [memberPage([partial])],
      simulate: () => boolResults([true, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () => Effect.succeed(candidates({ address: partial, scope: "read" })),
        }),
      ),
    );

    expect(result.members).toEqual([]);
    expect(result.droppedCandidates).toEqual([partial]);
  });

  it("subtracts the owner pin, this signing key, and the Key-Admin", async () => {
    const other = addr(7);
    const stub = chainStub({
      group: groupObject(4),
      pages: [memberPage([OWNER, SIGNER, MANAGER, other])],
      simulate: () => boolResults([true, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.succeed(
              candidates(
                { address: OWNER },
                { address: SIGNER },
                { address: MANAGER },
                { address: other },
              ),
            ),
        }),
      ),
    );

    // All three are on chain AND named as candidates; they are still excluded,
    // because each is pinned by its own row of the PTB.
    expect(result.members).toEqual([{ address: other, role: "editor" }]);
    expect(pureAddresses(stub.simulations[0] as Transaction)).toEqual([other, other]);
  });

  it("drops a candidate that is an anchor member but holds neither bucket role", async () => {
    const roleless = addr(3);
    const stub = chainStub({
      group: groupObject(2),
      pages: [memberPage([addr(1), roleless])],
      // addr(1): editor. roleless: neither.
      simulate: () => boolResults([true, true, false, false]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.succeed(candidates({ address: addr(1) }, { address: roleless })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: addr(1), role: "editor" }]);
    expect(result.droppedCandidates).toEqual([roleless]);
  });

  it("returns a deterministic, address-sorted roster", async () => {
    const members = [addr(0x30), addr(0x10), addr(0x20)];
    const stub = chainStub({
      group: groupObject(3),
      pages: [memberPage(members)],
      simulate: () => boolResults([true, true, true, true, true, true]),
    });

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () =>
            Effect.succeed(candidates(...members.map((address) => ({ address })))),
        }),
      ),
    );

    expect(result.members.map((m) => m.address)).toEqual([addr(0x10), addr(0x20), addr(0x30)]);
    expect(result.reason).toBe("chain_verified");
    expect(result.anchorGroupIds).toEqual([ANCHOR]);
    expect(result.anchorsNotConsulted).toBeUndefined();
  });

  // === the anchor SET ======================================================
  //
  // Anchoring on the single most recent validated bucket is a ratchet toward
  // empty (see `authorVerifiedRoster`), so these are the properties that make it
  // monotone again. They are asserted here at the decision layer;
  // `storageCreateBucket.test.ts` proves the same thing end to end across three
  // real creates.

  it("UNIONS membership across anchors — a member of an OLDER anchor is verified", async () => {
    const older = addr(0xa1);
    const newer = addr(0xa2);
    const inherited = addr(1);
    // The newest anchor is an identity-only bucket: nothing but the three
    // addresses this client already knows. The older one carries the evidence.
    const stub = multiAnchorStub(
      { [newer]: [OWNER, SIGNER, MANAGER], [older]: [OWNER, SIGNER, inherited] },
      () => [true, true],
    );

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [newer, older],
          listCandidates: () => Effect.succeed(candidates({ address: inherited })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: inherited, role: "editor" }]);
    expect(result.droppedCandidates).toEqual([]);
    // Only the anchor that carried evidence is reported as having backed it.
    expect(result.anchorGroupIds).toEqual([older]);
  });

  it("does NOT admit an anchor holding only the owner, the signer and the manager", async () => {
    // ADMISSION, and the trap it avoids: this group's member COUNT is three, not
    // zero, so `member_count > 0` would admit it and leave the ratchet intact.
    // The test is `|members \ {owner, signer, manager}| > 0`.
    const identityOnly = addr(0xa1);
    const stub = multiAnchorStub({ [identityOnly]: [OWNER, SIGNER, MANAGER] }, () => [true, true]);

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [identityOnly],
          listCandidates: () => Effect.succeed(candidates({ address: addr(1) })),
        }),
      ),
    );

    expect(result.members).toEqual([]);
    expect(result.reason).toBe("no_admitted_anchor");
    expect(result.anchorGroupIds).toEqual([]);
    expect(result.droppedCandidates).toEqual([addr(1)]);
    // Enumerated (it might have held evidence), never role-probed (it cannot).
    expect(stub.groupReads).toEqual([identityOnly]);
    expect(stub.simulations).toEqual([]);
  });

  it("reports `no_admitted_anchor` when anchors exist but NONE of them is admitted", async () => {
    // THE STATE THE UNION MADE REACHABLE, and the reason it needs a name of its
    // own: anchors on file, candidates on the list, and not one anchor admitted.
    // Reported as `chain_verified` — which is what it was — the result claims a
    // roster was verified against on-chain membership when nothing was read from
    // anything, and a caller branching on `reason` is told a create that verified
    // nothing verified something.
    const newer = addr(0xa1);
    const older = addr(0xa2);
    const stub = multiAnchorStub(
      { [newer]: [OWNER, SIGNER, MANAGER], [older]: [OWNER, SIGNER] },
      () => [true, true],
    );

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [newer, older],
          listCandidates: () => Effect.succeed(candidates({ address: addr(2) })),
        }),
      ),
    );

    expect(result.reason).toBe("no_admitted_anchor");
    expect(result.members).toEqual([]);
    // Nothing backed it, and nothing was left unread either — the consult cap
    // cannot bite before 20 anchors are ADMITTED, so it can never be the reason
    // this set is empty.
    expect(result.anchorGroupIds).toEqual([]);
    expect(result.anchorsNotConsulted).toBeUndefined();
    // The candidate is still named, exactly as the other arms name theirs.
    expect(result.droppedCandidates).toEqual([addr(2)]);
    // Every anchor was enumerated (each might have carried evidence); none was
    // role-probed, because none could contribute a member.
    expect(stub.groupReads).toEqual([newer, older]);
    expect(stub.simulations).toEqual([]);
  });

  it("does NOT fold `no_admitted_anchor` into `bootstrap` — the remedies differ", async () => {
    // Both author `[]` and write identical bytes, and they are still different
    // situations: bootstrap self-heals as soon as any create authors members,
    // while an unusable anchor set persists until something grants a role on one
    // of this space's buckets. A caller that could not tell them apart could not
    // say which.
    const identityOnly = addr(0xa1);
    const stub = multiAnchorStub({ [identityOnly]: [OWNER, SIGNER, MANAGER] }, () => [true, true]);
    const withCandidate = () => Effect.succeed(candidates({ address: addr(1) }));

    const none = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({ anchorGroupIds: [identityOnly], listCandidates: withCandidate }),
      ),
    );
    const bootstrap = await runOk(
      authorVerifiedRoster(
        multiAnchorStub({}).deps,
        input({ anchorGroupIds: [], listCandidates: withCandidate }),
      ),
    );
    const loneSigner = await runOk(
      authorVerifiedRoster(
        multiAnchorStub({ [identityOnly]: [OWNER, SIGNER, MANAGER] }).deps,
        input({
          anchorGroupIds: [identityOnly],
          listCandidates: () => Effect.succeed(candidates({ address: SIGNER })),
        }),
      ),
    );

    expect(none.members).toEqual(bootstrap.members);
    expect(none.members).toEqual(loneSigner.members);
    expect(none.reason).toBe("no_admitted_anchor");
    // Three empty rosters, three distinct reasons.
    expect(new Set([none.reason, bootstrap.reason, loneSigner.reason]).size).toBe(3);
  });

  it("takes the role from the NEWEST anchor that holds the address, not the maximum", async () => {
    const older = addr(0xa1);
    const newest = addr(0xa2);
    const member = addr(1);
    // Editor on the older anchor, viewer on the newest: what a `revoke_permission`
    // of `BucketEditor` across this space's recent buckets looks like from here.
    // Maximising across the anchors would author `editor` again and undo the
    // operator's downgrade — grants are atomic, revocations are not.
    const stub = multiAnchorStub(
      { [newest]: [OWNER, member], [older]: [OWNER, member] },
      (groupId) => (groupId === older ? [true, true] : [false, true]),
    );

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [newest, older],
          // `read`, so the viewer role the newest anchor reports is one the API
          // will accept. With `readwrite` the scope filter would drop the member
          // either way and hide which role was chosen.
          listCandidates: () => Effect.succeed(candidates({ address: member, scope: "read" })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: member, role: "viewer" }]);
    expect(result.droppedCandidates).toEqual([]);
    expect(result.anchorGroupIds).toEqual([newest, older]);
  });

  it("settles a member on the newest anchor holding it, even when that grants NO role", async () => {
    // The same revocation taken all the way: both permissions removed on the
    // recent buckets, the member row still there. Falling through to an older
    // anchor for "a role, any role" is the maximum wearing a different shape, so
    // the member is dropped and disclosed instead.
    const older = addr(0xa1);
    const newest = addr(0xa2);
    const member = addr(1);
    const stub = multiAnchorStub(
      { [newest]: [OWNER, member], [older]: [OWNER, member] },
      (groupId) => (groupId === older ? [true, true] : [false, false]),
    );

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [newest, older],
          listCandidates: () => Effect.succeed(candidates({ address: member })),
        }),
      ),
    );

    expect(result.members).toEqual([]);
    expect(result.droppedCandidates).toEqual([member]);
  });

  it("probes each anchor only for the candidates it holds that a newer one has not settled", async () => {
    const shared = addr(0xa1);
    const solo = addr(0xa2);
    const onBoth = addr(1);
    const onSoloOnly = addr(2);
    const stub = multiAnchorStub(
      { [solo]: [OWNER, onBoth, onSoloOnly], [shared]: [OWNER, onBoth] },
      () => [true, true],
    );

    await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          // `shared` is the newer of the two, so it settles `onBoth`.
          anchorGroupIds: [shared, solo],
          listCandidates: () =>
            Effect.succeed(candidates({ address: onBoth }, { address: onSoloOnly })),
        }),
      ),
    );

    // `has_permission` would answer false for a non-member anyway, so skipping
    // non-members changes no outcome — it just does not spend commands that
    // cannot matter. Skipping the already-settled `onBoth` on the older anchor is
    // load-bearing instead: that answer must not be able to override the newer
    // one, so it is not even asked for.
    expect(pureAddresses(stub.simulations[0] as Transaction)).toEqual([onBoth, onBoth]);
    expect(pureAddresses(stub.simulations[1] as Transaction)).toEqual([onSoloOnly, onSoloOnly]);
  });

  it("EXCLUDES an anchor's recorded creator, so a rotated-away key is not vouched for", async () => {
    // The key-scope row of a create grants the SIGNING KEY both bucket
    // permissions on the group it makes, so every anchor holds the key that
    // created it as an ordinary chain-verified member. That row is this client's
    // own footprint, never evidence about a third party — and after a working-key
    // rotation it is the PREVIOUS key, which is precisely the address that must
    // not be re-admitted on the word of the candidate list if the rotation
    // happened because that key was compromised.
    const previous = addr(0xf9);
    const member = addr(1);
    const anchor = addr(0xa1);
    const stub = multiAnchorStub({ [anchor]: [OWNER, SIGNER, previous, member] }, () => [
      true,
      true,
    ]);

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [anchor],
          anchorCreators: [previous],
          listCandidates: () =>
            Effect.succeed(candidates({ address: previous }, { address: member })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: member, role: "editor" }]);
    expect(result.droppedCandidates).toEqual([previous]);
    // Not even asked about: it is subtracted before the intersection, exactly as
    // the owner pin and this signing key are.
    expect(pureAddresses(stub.simulations[0] as Transaction)).toEqual([member, member]);
  });

  it("does NOT admit an anchor whose only extra member is the key that created it", async () => {
    // The admission side of the same subtraction: a bootstrap group made by a
    // since-rotated key holds four addresses rather than three, and the fourth is
    // no more evidence than the other three.
    const previous = addr(0xf9);
    const anchor = addr(0xa1);
    const stub = multiAnchorStub({ [anchor]: [OWNER, SIGNER, MANAGER, previous] }, () => [
      true,
      true,
    ]);

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: [anchor],
          anchorCreators: [previous],
          listCandidates: () => Effect.succeed(candidates({ address: previous })),
        }),
      ),
    );

    expect(result.reason).toBe("no_admitted_anchor");
    expect(result.members).toEqual([]);
    expect(result.droppedCandidates).toEqual([previous]);
    expect(stub.simulations).toEqual([]);
  });

  it("admits the same anchors whether or not this host pins the Key-Admin", async () => {
    // ADMISSION MUST NOT DEPEND ON WHICH PINS THIS HOST HOLDS. Tested against
    // `{owner, signer, manager}` the manager is only subtracted when it is
    // pinned, so an unpinned host counted the space's Key-Admin — a member of
    // every group — as "an address beyond the three", admitted an identity-only
    // anchor on the strength of it, and reported `chain_verified` with zero
    // members for a space that is plainly `no_admitted_anchor`. Two of the four
    // reasons stop being distinguishable at that point, which is the one thing
    // they exist for.
    const identityOnly = addr(0xa1);
    const world = { [identityOnly]: [OWNER, SIGNER, MANAGER] };
    const withCandidate = () => Effect.succeed(candidates({ address: addr(1) }));

    const pinned = await runOk(
      authorVerifiedRoster(
        multiAnchorStub(world, () => [true, true]).deps,
        input({ anchorGroupIds: [identityOnly], listCandidates: withCandidate }),
      ),
    );
    const unpinned = await runOk(
      authorVerifiedRoster(
        multiAnchorStub(world, () => [true, true]).deps,
        input({
          anchorGroupIds: [identityOnly],
          managerAddress: undefined,
          listCandidates: withCandidate,
        }),
      ),
    );

    expect(unpinned.reason).toBe("no_admitted_anchor");
    expect(unpinned.reason).toBe(pinned.reason);
    expect(unpinned.members).toEqual([]);
    expect(unpinned.anchorGroupIds).toEqual([]);
    expect(unpinned.droppedCandidates).toEqual([addr(1)]);
  });

  it("caps the consulted anchors at MAX_ADMITTED_ANCHORS and DISCLOSES the truncation", async () => {
    const member = addr(1);
    const anchors = Array.from({ length: MAX_ADMITTED_ANCHORS + 3 }, (_, i) => addr(0xa000 + i));
    const world = Object.fromEntries(anchors.map((groupId) => [groupId, [OWNER, member]]));
    const stub = multiAnchorStub(world, () => [true, true]);

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          anchorGroupIds: anchors,
          listCandidates: () => Effect.succeed(candidates({ address: member })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: member, role: "editor" }]);
    expect(result.anchorGroupIds).toEqual(anchors.slice(0, MAX_ADMITTED_ANCHORS));
    // The three it never looked at are reported, because an unread anchor can
    // only cost a key access — silently is exactly how it must not do that.
    expect(result.anchorsNotConsulted).toBe(3);
    // Twenty anchors were ADMITTED and enumerated; one was role-probed. The
    // newest anchor holding the member settles it, so the other nineteen have
    // nothing left to ask about — the cap bounds enumerations and round trips,
    // not one simulation each.
    expect(stub.groupReads).toHaveLength(MAX_ADMITTED_ANCHORS);
    expect(stub.simulations).toHaveLength(1);
  });

  it("caps the ADMITTED set, so a run of identity-only anchors cannot evict the evidence", async () => {
    // THE CAP AND THE ADMISSION RULE ARE LOAD-BEARING TOGETHER. Capping the
    // recorded list on recency first would push the one anchor that carries
    // evidence out of the window here — the original bug wearing a bound.
    const member = addr(1);
    const empties = Array.from({ length: MAX_ADMITTED_ANCHORS + 5 }, (_, i) => addr(0xb000 + i));
    const carriesEvidence = addr(0xc001);
    const stub = multiAnchorStub(
      {
        ...Object.fromEntries(empties.map((groupId) => [groupId, [OWNER, SIGNER, MANAGER]])),
        [carriesEvidence]: [OWNER, member],
      },
      () => [true, true],
    );

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          // The evidence-bearing anchor is the OLDEST of the lot, well past the
          // cap if recency alone decided.
          anchorGroupIds: [...empties, carriesEvidence],
          listCandidates: () => Effect.succeed(candidates({ address: member })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: member, role: "editor" }]);
    expect(result.anchorGroupIds).toEqual([carriesEvidence]);
    expect(result.anchorsNotConsulted).toBeUndefined();
  });

  it("de-duplicates the recorded anchors instead of paying twice for one group", async () => {
    const anchor = addr(0xa1);
    const member = addr(1);
    const stub = multiAnchorStub({ [anchor]: [OWNER, member] }, () => [true, true]);

    const result = await runOk(
      authorVerifiedRoster(
        stub.deps,
        input({
          // The same group spelled three ways, as a hand-edited file might.
          anchorGroupIds: [anchor, anchor.replace("0x", "").toUpperCase(), "0xa1"],
          listCandidates: () => Effect.succeed(candidates({ address: member })),
        }),
      ),
    );

    expect(result.members).toEqual([{ address: member, role: "editor" }]);
    expect(result.anchorGroupIds).toEqual([anchor]);
    expect(stub.groupReads).toEqual([anchor]);
  });

  it("REFUSES when ANY anchor fails to enumerate, rather than unioning what it got", async () => {
    // Fail-closed survives the union: a read that failed is not evidence of
    // absence, and quietly proceeding on the anchors that did answer would
    // under-permission the bucket for a reason nothing surfaces.
    const good = addr(0xa1);
    const broken = addr(0xa2);
    const base = multiAnchorStub({ [good]: [OWNER, addr(1)] }, () => [true, true]);
    const deps: RosterChainDeps = {
      ...base.deps,
      getGroupObject: async (objectId) => {
        if (objectId === broken) throw new Error("fullnode unreachable");
        return base.deps.getGroupObject(objectId);
      },
    };

    const error = await runFail(
      authorVerifiedRoster(
        deps,
        input({
          anchorGroupIds: [broken, good],
          listCandidates: () => Effect.succeed(candidates({ address: addr(1) })),
        }),
      ),
    );

    expect(error).toBeInstanceOf(RosterUnavailableError);
    expect(error.stage).toBe("enumeration");
  });

  it("REFUSES a roster larger than the space's key cap rather than truncating it", async () => {
    const many = Array.from({ length: MAX_ROSTER_MEMBERS + 1 }, (_, i) => addr(i + 1));
    const stub = chainStub({
      group: groupObject(many.length),
      pages: [memberPage(many)],
      simulate: () => boolResults(many.flatMap(() => [true, true])),
    });

    const error = await runFail(
      authorVerifiedRoster(
        stub.deps,
        input({
          listCandidates: () => Effect.succeed(candidates(...many.map((address) => ({ address })))),
        }),
      ),
    );

    expect(error.stage).toBe("invariant");
    expect(error.message).toContain(String(MAX_ROSTER_MEMBERS));
    // Refused BEFORE the role check — truncating to fit is never an option.
    expect(stub.simulations).toEqual([]);
  });
});

// === Default deps =========================================================

describe("makeRosterChainDeps", () => {
  it("follows the Console base URL to the right network's fullnode and package ids", () => {
    grpcCalls.length = 0;

    expect(makeRosterChainDeps("https://api.testnet.example").config).toEqual(
      TESTNET_PACKAGE_CONFIG,
    );
    expect(makeRosterChainDeps("https://api.mainnet.example").config).toEqual(
      MAINNET_PACKAGE_CONFIG,
    );

    expect(grpcCalls.map((c) => c.input)).toEqual([
      { baseUrl: "https://fullnode.testnet.sui.io:443", network: "testnet" },
      { baseUrl: "https://fullnode.mainnet.sui.io:443", network: "mainnet" },
    ]);
  });

  it("asks the SDK for content, threads the cursor, and asks for command results", async () => {
    grpcCalls.length = 0;
    const deps = makeRosterChainDeps("https://api.testnet.example");

    // The object read must ask for `content`: the permissions-table id and the
    // member count are read out of the Move struct's BCS, not out of JSON.
    expect(await deps.getGroupObject(ANCHOR)).toEqual({
      type: "0x2::a::B",
      content: new Uint8Array([9]),
    });

    const page = await deps.listMemberFields(TABLE, "cursor-1");
    expect(page.hasNextPage).toBe(true);
    expect(page.cursor).toBe("next-page");
    expect(page.dynamicFields).toEqual([{ name: { type: "address", bcs: new Uint8Array(32) } }]);

    const tx = new Transaction();
    expect(await deps.simulate(tx)).toEqual({
      commandResults: [{ returnValues: [{ bcs: new Uint8Array([1]) }] }],
    });

    expect(grpcCalls.slice(1)).toEqual([
      { kind: "getObject", input: { objectId: ANCHOR, include: { content: true } } },
      { kind: "listDynamicFields", input: { parentId: TABLE, cursor: "cursor-1" } },
      {
        kind: "simulateTransaction",
        input: { transaction: tx, include: { commandResults: true } },
      },
    ]);
  });
});
