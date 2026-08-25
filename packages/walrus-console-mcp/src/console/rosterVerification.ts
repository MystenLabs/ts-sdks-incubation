import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { Data, Effect } from "effect";
import type { SpaceSignersResponse } from "./ConsoleApiClient";
import {
  type BucketGroupPackageConfig,
  resolveFullnodeUrl,
  resolvePackageConfigForBaseUrl,
  resolveSuiNetwork,
} from "./packageConfig";
import type { RosterMember } from "./txValidation";

/**
 * Author the roster of a NEW bucket from state the client can verify, so the
 * Console endpoint never gets to choose who receives access to it (F1).
 *
 * `txValidation.ts` enforces this roster against the PTB the server actually
 * builds, as an exact `(address, role)` multiset. That check is only worth
 * anything if the expectation it compares against was not itself supplied by the
 * server — which is what this module produces.
 *
 * TWO SOURCES COMPOSE HERE, AND NEITHER ONE IS SUFFICIENT ALONE. A future reader
 * will be tempted to "simplify" one away; both simplifications are security
 * regressions, in opposite directions:
 *
 *  - CHAIN (the anchor groups' on-chain membership) answers "is this address
 *    already trusted on a bucket THIS MCP created and validated?" An anchor group
 *    is exactly that — a bucket group we built and checked on an earlier
 *    occasion, recorded locally by `anchorStore.ts` — so its membership is
 *    trustworthy state rather than a server claim. What chain CANNOT answer is
 *    "is this address a service account of this space": a session user may share
 *    any bucket with an arbitrary collaborator wallet, so the anchor group's
 *    membership is a SUPERSET of the space's service signers. Authoring from
 *    chain alone would grant bucket #1's collaborator wallet access to bucket #2
 *    — silent over-permissioning, the exact direction this design exists to
 *    avoid.
 *  - CANDIDATES (`listSpaceSigners()`) answers "which addresses are active
 *    service signers of this space?" It is UNTRUSTED input. Authoring from
 *    candidates alone would let a hostile endpoint name any address it likes.
 *
 * THE INTERSECTION IS CORRECT IN BOTH DIRECTIONS. The candidate list can only
 * ever NARROW the chain-derived set: dropping is safe (the result is
 * under-permissioned, never over-permissioned) and it can never ADD anyone,
 * because everything it names must still survive the chain check.
 *
 * THE ANCHOR SET IS A UNION, AND IT IS WHAT MAKES ANCHORING MONOTONE. Every
 * recorded anchor was created and validated by this client, so membership in ANY
 * of them is equally good evidence, and unioning them can only widen the verified
 * set — never past the candidate intersection, which still bounds it from the
 * other side. Anchoring on the most recent group alone is a ratchet toward empty:
 * see `authorVerifiedRoster` for the sequence, which was observed live.
 *
 * WHAT THE UNION COSTS, SAID PLAINLY: the untrusted side still makes the
 * SELECTION, and the union widens the set it selects from — from one bucket's
 * membership to that of up to `MAX_ADMITTED_ANCHORS` of them. Since anchor
 * membership is a superset of the space's service signers, a hostile endpoint can
 * still pick out, say, a collaborator wallet somebody once shared an anchored
 * bucket with. What it CANNOT do is name an address that holds no bucket role on
 * any of them. That is the bound this module achieves — a large reduction from
 * "any address", and not zero.
 *
 * ROLES COME FROM CHAIN, NEVER FROM THE CANDIDATE'S CLAIMED `scope`. Otherwise a
 * hostile server upgrades a legitimate viewer to editor by relabeling it — and
 * the roster would carry that upgrade into `expectedMembers`, where the validator
 * would dutifully accept it. The claimed scope is consulted for exactly one thing
 * and in exactly one direction: a chain-derived role that CONTRADICTS it drops
 * the member (see `expectedRoleForScope`), because the API rejects such a roster
 * outright — so the claim can only ever narrow, and never names a role we author.
 *
 * FAILURE REFUSES, IT DOES NOT DEGRADE. Every read below happens BEFORE the
 * reserve call, so refusing costs one retry: no orphaned bucket, no partial
 * state, no gas. Degrading to an identity-only roster instead produces a
 * permanently under-permissioned bucket that NEITHER system can enumerate — the
 * API derives its expected-grant rows FROM the authored roster, so an authored
 * `[]` writes no row for the omitted signers and the diagnostics endpoint stays
 * empty. Silent-and-permanently-wrong loses to loud-and-retryable.
 *
 * Type identities are rooted at `originalPackageId` so they survive a
 * `bucket_policy` upgrade, exactly as in `txValidation.ts`; the roots differ per
 * family, with `WalrusConsole` / `BucketEditor` / `BucketViewer` living in
 * `bucket_policy` and `PermissionedGroup` in the `permissioned_group` framework
 * package.
 */

/**
 * A roster read failed, so the create is refused instead of proceeding with an
 * unverified (or silently shortened) roster.
 *
 * `stage` is the machine-readable half: `candidates` is a Console-side read and
 * `enumeration` / `roles` are fullnode reads, which point at different things to
 * check, while `invariant` is neither — it means the verified roster came back
 * impossibly large and this build refuses to guess which members to keep.
 */
export class RosterUnavailableError extends Data.TaggedError("RosterUnavailableError")<{
  readonly message: string;
  readonly stage: "candidates" | "enumeration" | "roles" | "invariant";
  readonly cause?: unknown;
}> {}

/**
 * The most members a verified roster may contain.
 *
 * A space's key cap is 25, so a real roster is at most 24 once the signing key is
 * subtracted. Anything past this is not a big space, it is a state this client
 * has never seen and cannot vouch for — so it REFUSES rather than truncating.
 * Truncation would produce exactly the silent under-permissioning the whole
 * module is built to avoid.
 */
export const MAX_ROSTER_MEMBERS = 32;

/**
 * Addresses per role-check simulation.
 *
 * Each address costs two `has_permission` commands and a PTB may hold 1024
 * commands, so 512 addresses is the boundary, not a safety margin below it.
 */
export const MAX_ADDRESSES_PER_SIMULATION = 512;

/**
 * The most ADMITTED anchors one create will consult.
 *
 * What it bounds is chain WORK: each admitted anchor costs an enumeration (an
 * object read plus its member pages) and at most one role-probe simulation, so
 * 20 bounds the round trips a create pays.
 *
 * It was originally sized against the PTB command limit too — two
 * `has_permission` calls per (candidate, anchor) pair puts 24 candidates (the
 * ≤25-keys-per-space ceiling, once the signing key is subtracted) across 20
 * anchors at 960 commands, just inside the 1024 limit. That is now slack rather
 * than the binding constraint: step 2h probes each candidate on the newest anchor
 * that holds it and on no other, so one create asks about each address exactly
 * once however many anchors are admitted.
 *
 * IT CAPS THE ADMITTED SET, NEVER THE RECORDED ONE, and the difference is the
 * whole bug. Capping the recorded list on recency first would let a run of
 * identity-only creates push the one anchor that carries evidence out of the
 * window — the original ratchet wearing a bound. Anchors that fail admission
 * cost an enumeration but no slot.
 */
export const MAX_ADMITTED_ANCHORS = 20;

/**
 * Pages a single enumeration may read before giving up.
 *
 * The member-count cross-check below cannot fire until the pagination loop ends,
 * so a fullnode that answers `hasNextPage: true` forever would hang the create
 * rather than fail it. Generous enough that no real group reaches it.
 */
const MAX_MEMBER_PAGES = 100;

/** The object content read of a `PermissionedGroup`, as the fullnode serves it. */
export interface GroupObjectRead {
  /** Fully-qualified Move type of the object. */
  readonly type: string;
  /** BCS bytes of the Move struct's fields. */
  readonly content: Uint8Array;
}

/** One page of the permissions table's dynamic fields. */
export interface MemberFieldPage {
  readonly dynamicFields: readonly {
    readonly name: { readonly type: string; readonly bcs: Uint8Array };
  }[];
  readonly hasNextPage: boolean;
  readonly cursor: string | null;
}

/** A simulated PTB's per-command return values. */
export interface SimulationRead {
  readonly commandResults?:
    readonly { readonly returnValues: readonly { readonly bcs: Uint8Array }[] }[] | undefined;
}

/**
 * The chain reads this module needs, injected.
 *
 * Injected rather than taken on a client handle so the decision logic is testable
 * without a network, and so the transport can move without touching any of the
 * checks. `SealCryptoService` privately owns its own `SuiGrpcClient`; this module
 * does NOT reach into it — `makeRosterChainDeps` builds its own.
 */
export interface RosterChainDeps {
  readonly config: BucketGroupPackageConfig;
  readonly getGroupObject: (objectId: string) => Promise<GroupObjectRead>;
  readonly listMemberFields: (parentId: string, cursor: string | null) => Promise<MemberFieldPage>;
  readonly simulate: (transaction: Transaction) => Promise<SimulationRead>;
}

/**
 * `PermissionedGroup<T>` as BCS, mirroring sui_groups
 * `permissioned_group.move` (the struct) and `permissions_table.move` (the
 * nested table). `T` is phantom and contributes no bytes.
 *
 * Read as BCS rather than as parsed JSON deliberately: the JSON shape of an
 * object's fields differs between fullnode APIs, while the BCS layout is the Move
 * struct itself and cannot drift without a contract upgrade.
 *
 * `permissions.length` is the authoritative member count — `member_count<T>()` is
 * literally `self.permissions.length()`, so reading the field is the same number
 * the view function returns, without a second round trip.
 */
const PermissionedGroupContent = bcs.struct("PermissionedGroup", {
  id: bcs.Address,
  permissions: bcs.struct("PermissionsTable", { id: bcs.Address, length: bcs.u64() }),
  permissionsAdminCount: bcs.u64(),
  creator: bcs.Address,
});

/** `{permissionedGroupPackageId}::permissioned_group::PermissionedGroup<WalrusConsole>`. */
function permissionedGroupType(config: BucketGroupPackageConfig): string {
  return normalizeStructTag(
    `${normalizeSuiAddress(config.permissionedGroupPackageId)}::permissioned_group::PermissionedGroup<${witnessType(config)}>`,
  );
}

/** `{originalPackageId}::bucket_policy::WalrusConsole`. */
function witnessType(config: BucketGroupPackageConfig): string {
  return `${normalizeSuiAddress(config.originalPackageId)}::bucket_policy::WalrusConsole`;
}

/** `{originalPackageId}::bucket_policy::{name}`. */
function bucketPolicyType(config: BucketGroupPackageConfig, name: string): string {
  return `${normalizeSuiAddress(config.originalPackageId)}::bucket_policy::${name}`;
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Wrap a chain read so a transport failure becomes a refusal, never a shrug. */
function chainRead<A>(
  stage: "enumeration" | "roles",
  what: string,
  read: () => Promise<A>,
): Effect.Effect<A, RosterUnavailableError> {
  return Effect.tryPromise({
    try: read,
    catch: (cause) =>
      new RosterUnavailableError({
        stage,
        cause,
        message:
          `Refusing to create the bucket: ${what} failed (${describeCause(cause)}), so the roster of ` +
          `service accounts that may read it could not be verified against chain state. This is ` +
          `transient — retry. Nothing was reserved, so a retry costs no gas and leaves no ` +
          `half-created bucket behind.`,
      }),
  });
}

// === 7a — enumeration =====================================================

/**
 * Every member address of the anchor group, read from chain.
 *
 * `PermissionsTable` maps `address -> VecSet<TypeName>` as DYNAMIC FIELDS hung off
 * its own UID, so membership is fully enumerable: read the group object, take the
 * permissions-table id out of its content, and page the table's dynamic fields —
 * each field's NAME is a member address.
 *
 * The count cross-check at the end is the point of the whole function. A page
 * that silently came back short would shrink the roster, and a shorter roster is
 * a bucket some legitimate service key can never read — so a disagreement between
 * the enumerated count and the group's own `member_count` FAILS CLOSED rather
 * than returning what it managed to collect.
 */
export function enumerateAnchorMembers(
  deps: RosterChainDeps,
  anchorGroupId: string,
): Effect.Effect<readonly string[], RosterUnavailableError> {
  return Effect.gen(function* () {
    const groupId = normalizeSuiAddress(anchorGroupId);

    // DELIBERATELY NOT `chainRead`. Its message ends "this is transient — retry",
    // which is right for a member page or a simulation against an object that
    // exists and wrong for this read: the commonest reason a recorded anchor
    // cannot be fetched is that it names an object the fullnode has nothing for
    // — a group deleted, or an id from a file that was hand-edited — and no
    // number of retries produces one. Labelled transient, that leaves the space's
    // `create_bucket` permanently refusing with no remedy in sight, while the
    // type-mismatch branch below, which is the same situation caught one step
    // later, names one.
    //
    // BOTH CAUSES ARE NAMED AND NEITHER IS ASSERTED. A fullnode outage and a
    // missing object are the same failed promise from here, so the message
    // carries the remedy for each and lets the operator's retry decide which it
    // was. Removing one entry is the narrow remedy on purpose (deleting the whole
    // file costs every other space a bootstrap create), and it is safe to suggest
    // because an anchor is recoverable cache.
    const object = yield* Effect.tryPromise({
      try: () => deps.getGroupObject(groupId),
      catch: (cause) =>
        new RosterUnavailableError({
          stage: "enumeration",
          cause,
          message:
            `Refusing to create the bucket: the recorded anchor group ${groupId} could not be ` +
            `read from chain (${describeCause(cause)}), so the roster of service accounts that ` +
            `may read the new bucket could not be verified. Two causes look identical from here. ` +
            `The fullnode may simply be unreachable, in which case retrying is the whole remedy ` +
            `— nothing was reserved, so a retry costs no gas and leaves no half-created bucket ` +
            `behind. Or the anchor names an object that does not exist, which no retry fixes: ` +
            `remove THAT ONE ENTRY — the one recording group ${groupId} — from \`anchors.json\` ` +
            `in the config directory, which costs this space one create on the bootstrap path ` +
            `and re-records a validated anchor.`,
        }),
    });

    // The anchor id comes from a local cache that `anchorStore` deliberately does
    // NOT authenticate (a corrupt entry is meant to be survivable, not fatal). So
    // the object it names is checked to actually BE a bucket group of this
    // package before its dynamic fields are trusted as a membership list — a
    // tampered anchor pointing at an attacker's group would otherwise supply the
    // very chain evidence this module exists to demand.
    const expectedType = permissionedGroupType(deps.config);

    // `normalizeStructTag` THROWS on a string that is not a parseable struct tag
    // — a bare package id, a primitive type, an empty string — and on `undefined`
    // or `null`. A throw inside this generator is an Effect DEFECT that no
    // `catchTag("RosterUnavailableError")` recovers and that prints none of the
    // remedy below. Every one of those inputs means what the mismatch below
    // means (the recorded anchor does not name a bucket group of this package),
    // so they take the same refusal rather than escaping as one.
    //
    // The `typeof` guard is belt to the catch's braces, and it is kept
    // deliberately: `normalizeStructTag` also accepts a StructTag OBJECT
    // (`typeof type === "string" ? parseStructTag(type) : type`), so a non-string
    // does not reliably throw — a number destructures to
    // `"undefined::undefined::undefined"`, which this refuses only by way of the
    // string comparison happening not to match. Refusing a non-string outright
    // makes that outcome intentional instead of incidental.
    let actualType: string | undefined;
    if (typeof object.type === "string") {
      try {
        actualType = normalizeStructTag(object.type);
      } catch {
        actualType = undefined;
      }
    }
    if (actualType !== expectedType) {
      return yield* new RosterUnavailableError({
        stage: "enumeration",
        message:
          `Refusing to create the bucket: the recorded anchor group ${groupId} does not name a ` +
          `${expectedType} — its type is ${JSON.stringify(object.type) ?? "missing"}. The local ` +
          `anchor cache is wrong or stale — delete \`anchors.json\` from the config directory ` +
          `and retry, which falls back to the bootstrap path and re-records a validated anchor.`,
      });
    }

    let state: ReturnType<typeof PermissionedGroupContent.parse>;
    try {
      state = PermissionedGroupContent.parse(object.content);
    } catch (cause) {
      return yield* new RosterUnavailableError({
        stage: "enumeration",
        cause,
        message:
          `Refusing to create the bucket: the anchor group ${groupId} did not decode as a ` +
          `PermissionedGroup (${describeCause(cause)}), so its membership could not be read. Retry; ` +
          `if it persists the bucket-policy package ids in this build are out of date.`,
      });
    }

    const tableId = state.permissions.id;
    const expectedCount = Number(state.permissions.length);

    const members: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; ; page++) {
      if (page >= MAX_MEMBER_PAGES) {
        return yield* new RosterUnavailableError({
          stage: "enumeration",
          message:
            `Refusing to create the bucket: enumerating the anchor group's members did not ` +
            `terminate after ${MAX_MEMBER_PAGES} pages. Retry; if it persists the fullnode is ` +
            `paginating incorrectly.`,
        });
      }

      const current: string | null = cursor;
      const result: MemberFieldPage = yield* chainRead(
        "enumeration",
        `listing the anchor group's members (table ${tableId})`,
        () => deps.listMemberFields(tableId, current),
      );

      for (const field of result.dynamicFields) {
        // Every member entry is keyed by `address`. A field of any other name
        // type is not a membership row, and guessing which it is would either
        // invent a member or lose one.
        if (field.name.type !== "address") {
          return yield* new RosterUnavailableError({
            stage: "enumeration",
            message:
              `Refusing to create the bucket: the anchor group's permissions table holds a ` +
              `field keyed by ${field.name.type}, not address, so its membership could not be ` +
              `read reliably. Retry; if it persists the bucket-policy package ids in this build ` +
              `are out of date.`,
          });
        }
        if (field.name.bcs.length !== 32) {
          return yield* new RosterUnavailableError({
            stage: "enumeration",
            message:
              `Refusing to create the bucket: a member key of the anchor group is ` +
              `${field.name.bcs.length} bytes, not a 32-byte address. Retry; if it persists the ` +
              `fullnode is serving malformed dynamic fields.`,
          });
        }
        // Canonical `0x`-prefixed 64-hex, straight from the 32 raw bytes, so the
        // chain side of every later comparison has exactly one spelling.
        const address = bcs.Address.parse(field.name.bcs);
        if (!seen.has(address)) {
          seen.add(address);
          members.push(address);
        }
      }

      if (!result.hasNextPage) break;
      if (result.cursor === null) {
        // Continuing is impossible and stopping would under-count. Neither is
        // done: this is precisely the silent truncation the guard exists for.
        return yield* new RosterUnavailableError({
          stage: "enumeration",
          message:
            `Refusing to create the bucket: the fullnode reported more anchor-group members ` +
            `but supplied no cursor to read them, so the membership list would be incomplete. ` +
            `Retry.`,
        });
      }
      cursor = result.cursor;
    }

    // THE TRUNCATION GUARD. `member_count<T>()` returns `permissions.length`, the
    // field parsed above, and it is maintained by the contract on every add and
    // remove — so it is an independent witness to how many rows the pagination
    // above should have produced.
    if (members.length !== expectedCount) {
      return yield* new RosterUnavailableError({
        stage: "enumeration",
        message:
          `Refusing to create the bucket: the anchor group reports ${expectedCount} members but ` +
          `enumerating its permissions table produced ${members.length}. A partially-read ` +
          `membership list would silently under-permission the new bucket, so it is not used. ` +
          `Retry.`,
      });
    }

    return members;
  });
}

// === 7b — role check ======================================================

/**
 * Build the batched role-check PTB: two `has_permission` views per address.
 *
 * `has_permission<T, Permission>(&PermissionedGroup<T>, address)` is a public view
 * that takes the member as a PURE argument and never reads `ctx.sender`, so
 * simulating it with sender `0x0` needs no credential and no gas. The SDK's
 * per-member helper would cost one round trip each; this is one round trip for up
 * to `MAX_ADDRESSES_PER_SIMULATION` members.
 *
 * Command order is the contract with the parser below: for address `i`, command
 * `2i` asks BucketEditor and command `2i + 1` asks BucketViewer.
 */
function buildRoleCheckPtb(
  config: BucketGroupPackageConfig,
  groupId: string,
  addresses: readonly string[],
): Transaction {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress("0x0"));

  const target = `${normalizeSuiAddress(config.permissionedGroupPackageId)}::permissioned_group::has_permission`;
  const witness = witnessType(config);
  const editor = bucketPolicyType(config, "BucketEditor");
  const viewer = bucketPolicyType(config, "BucketViewer");

  for (const address of addresses) {
    for (const permission of [editor, viewer]) {
      tx.moveCall({
        target,
        typeArguments: [witness, permission],
        arguments: [tx.object(groupId), tx.pure.address(address)],
      });
    }
  }
  return tx;
}

/** One `bool` return value, refusing anything that is not exactly that. */
function parseBool(
  result: { readonly returnValues: readonly { readonly bcs: Uint8Array }[] } | undefined,
): boolean | undefined {
  const value = result?.returnValues;
  if (!value || value.length !== 1) return undefined;
  const raw = value[0]?.bcs;
  // BCS writes a bool as one byte that is 0 or 1. Anything else is not a bool,
  // and coercing it (`!!byte`) would turn a malformed response into a grant.
  if (!raw || raw.length !== 1) return undefined;
  if (raw[0] === 0) return false;
  if (raw[0] === 1) return true;
  return undefined;
}

/**
 * The role each address actually holds on the anchor group, read from chain.
 *
 * `editor` when it holds `BucketEditor`, otherwise `viewer` when it holds
 * `BucketViewer`, otherwise EXCLUDED. The exclusion is real and load-bearing: a
 * group's creator holds `PermissionsAdmin` and frequently neither bucket
 * permission, and an address with no bucket role has no membership to mirror onto
 * a new bucket.
 *
 * The two calls are asked independently rather than assuming the builder's
 * "editor implies viewer" convention, because that convention is a property of
 * the PTB the API builds, not of the contract — an `ExtensionPermissionsAdmin`
 * can grant `BucketEditor` directly, and such a member really is an editor.
 *
 * PRECONDITION, and the caller's job: `anchorGroupId` must already have been
 * checked to BE a `PermissionedGroup<WalrusConsole>` of this package. This
 * function does not re-check it — `authorVerifiedRoster` establishes it by
 * running `enumerateAnchorMembers` on the same id first, which is also where the
 * addresses passed here come from. Calling this standalone with an unverified id
 * would simulate `has_permission` against whatever object that id names, and
 * believe the answer.
 */
export function resolveRosterRoles(
  deps: RosterChainDeps,
  args: { readonly anchorGroupId: string; readonly addresses: readonly string[] },
): Effect.Effect<readonly RosterMember[], RosterUnavailableError> {
  return Effect.gen(function* () {
    const groupId = normalizeSuiAddress(args.anchorGroupId);

    // Normalized once here so the PTB carries canonical addresses and a caller
    // that spells the same address two ways does not pay for two checks.
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of args.addresses) {
      const address = normalizeSuiAddress(raw);
      if (seen.has(address)) continue;
      seen.add(address);
      unique.push(address);
    }
    if (unique.length === 0) return [];

    const roster: RosterMember[] = [];

    for (let start = 0; start < unique.length; start += MAX_ADDRESSES_PER_SIMULATION) {
      const chunk = unique.slice(start, start + MAX_ADDRESSES_PER_SIMULATION);
      const tx = buildRoleCheckPtb(deps.config, groupId, chunk);

      const simulation = yield* chainRead(
        "roles",
        `checking bucket permissions for ${chunk.length} address(es) on group ${groupId}`,
        () => deps.simulate(tx),
      );

      const results = simulation.commandResults;
      // One result per command, or the pairing below would read one address's
      // answer as another's. Nothing about a short result set is recoverable.
      if (!results || results.length !== chunk.length * 2) {
        return yield* new RosterUnavailableError({
          stage: "roles",
          message:
            `Refusing to create the bucket: the permission check returned ` +
            `${results?.length ?? 0} results for ${chunk.length * 2} queries, so the roles of ` +
            `the space's service accounts could not be determined. Retry.`,
        });
      }

      for (const [index, address] of chunk.entries()) {
        const isEditor = parseBool(results[index * 2]);
        const isViewer = parseBool(results[index * 2 + 1]);
        if (isEditor === undefined || isViewer === undefined) {
          return yield* new RosterUnavailableError({
            stage: "roles",
            message:
              `Refusing to create the bucket: the permission check for ${address} did not ` +
              `return a bool, so its role could not be read from chain. Retry.`,
          });
        }
        if (isEditor) roster.push({ address, role: "editor" });
        else if (isViewer) roster.push({ address, role: "viewer" });
      }
    }

    return roster;
  });
}

// === 7c — assembly ========================================================

/**
 * Why the returned roster is what it is.
 *
 * THREE OF THE FOUR AUTHOR `[]`, and they produce IDENTICAL bytes and identical
 * server state, so they are reported separately on purpose: they are different
 * situations, and a caller that could not tell them apart could not disclose any
 * of them honestly. Each also has a different remedy, which is the sharper reason
 * they must not be merged:
 *
 *  - `bootstrap` — this space has no anchor this client can use. SELF-HEALS as
 *    soon as any create in it authors members.
 *  - `no_other_signers` — this space has exactly one signer, so an empty roster
 *    is the whole roster. Nothing to remedy.
 *  - `no_admitted_anchor` — anchors exist and candidates exist, but not one
 *    anchor holds any of the candidates, so there was no evidence to verify
 *    anything against. PERSISTS until somebody is granted a role on one of this
 *    space's buckets; it does not clear itself the way `bootstrap` does, which is
 *    exactly why it is not folded into it.
 *
 * `chain_verified` is the only one that means a membership was actually read. It
 * must NOT be returned for a create that read nothing: a programmatic caller
 * branching on this field would be told a create that verified nothing had
 * verified something, and the disclosure would describe a chain read that never
 * happened.
 */
export type RosterOrigin =
  "bootstrap" | "no_other_signers" | "no_admitted_anchor" | "chain_verified";

export interface AuthoredRoster {
  /** Send as `members` on the reserve, enforce as `expectedMembers`. Address-sorted. */
  readonly members: readonly RosterMember[];
  readonly reason: RosterOrigin;
  /**
   * Candidate signers that did NOT make the roster, for disclosure.
   *
   * Covers every way a candidate is dropped: not a member of ANY admitted anchor
   * (the never-anchored residual — a freshly minted key whose backfill has not
   * landed — and equally the injection case, which is the same mechanism), a
   * member holding neither bucket role on the newest anchor that holds it, and a
   * member whose chain role contradicts the scope its key claims. All three mean
   * "this key will not be able to read the new bucket", which is what a caller
   * needs to say out loud.
   */
  readonly droppedCandidates: readonly string[];
  /**
   * The anchor groups whose membership actually backed this roster — admitted,
   * enumerated and role-probed, most recent first.
   *
   * Empty on all three empty-roster paths, and empty means the same thing on
   * each: nothing backed this roster. `bootstrap` has no anchor to consult,
   * `no_other_signers` short-circuits before any chain read (see the branch
   * comment), and `no_admitted_anchor` enumerated every anchor and admitted none.
   * On `chain_verified` this is NON-EMPTY by construction, and its LENGTH is the
   * disclosure — how many independently validated groups vouched for the members
   * below.
   */
  readonly anchorGroupIds: readonly string[];
  /**
   * Recorded anchors this create did NOT look at because `MAX_ADMITTED_ANCHORS`
   * was already full. Present only when the cap actually bit, because a
   * truncated view can only under-permission and the caller has to be able to
   * say so.
   */
  readonly anchorsNotConsulted?: number;
}

export interface AuthorRosterInput {
  /**
   * The anchor groups recorded for this space, MOST RECENT FIRST — the
   * re-derived `groupId` of each usable entry from `readAnchors(spaceId)`.
   * Empty when the space has none yet, or none that still re-derives.
   *
   * Passed in rather than read here so this module stays free of filesystem I/O
   * and stays testable without one.
   */
  readonly anchorGroupIds: readonly string[];
  /**
   * The recorded `creator` of each anchor above — the working key that signed
   * the create which made it. An unordered set, not a parallel array: every one
   * of these is struck from every anchor's membership (see `anchorCreators` in
   * `authorVerifiedRoster`), so which anchor a given creator made changes nothing
   * here.
   *
   * REQUIRED rather than optional, though an empty list is legitimate (a space
   * whose anchors were all made by the key signing now needs nothing subtracted
   * that is not already). A caller that forgets it authors a rotated-away key
   * onto new buckets, which is exactly the failure this input exists to prevent,
   * so it does not get to be forgotten silently.
   */
  readonly anchorCreators: readonly string[];
  /** `CONSOLE_WEB_ACCOUNT_ADDRESS`; the PTB's `add_owner` row pins it separately. */
  readonly ownerAddress: string;
  /** The address about to sign the reserve; the PTB's key-scope row pins it separately. */
  readonly signerAddress: string;
  /** The Key-Admin, when one is known; the PTB's `grant_permission` row pins it separately. */
  readonly managerAddress?: string | undefined;
  /**
   * The UNTRUSTED candidate list, as a thunk so the bootstrap path can prove it
   * never ran. Task 6 passes `() => api.listSpaceSigners()`.
   */
  readonly listCandidates: () => Effect.Effect<SpaceSignersResponse, unknown>;
}

/**
 * The role the API will REQUIRE for a key of this claimed scope.
 *
 * A mirror of the server's own `roleForScope` (`readwrite → editor`, everything
 * else → `viewer`), including its totality: the scope arrives on the same
 * unchecked cast as the address, so an unexpected value must produce an answer
 * rather than a throw — and the answer the server would give for that same value
 * is the one that predicts what it will do with our roster.
 */
function expectedRoleForScope(scope: unknown): RosterMember["role"] {
  return scope === "readwrite" ? "editor" : "viewer";
}

/**
 * Produce the roster to author on a create-bucket reserve, or refuse.
 *
 * The order is candidates-first and it is deliberate: the common single-key MCP
 * host learns from ONE http call that there is nothing to author, and pays no
 * chain latency at all.
 *
 * ANCHORING IS MONOTONE, AND THE UNION IS WHAT MAKES IT SO. The sequence this
 * function is shaped around, confirmed live on testnet 2026-08-23:
 *
 *  1. A create with an identity-only roster — the bootstrap path, or a moment
 *     when Console lists no other signer — grants nobody beyond the owner, the
 *     signer and the manager, and its group is recorded as an anchor.
 *  2. Anchoring on the most recent group alone, the next create finds no other
 *     member, authors `[]`, and DROPS a key it had authored as chain-verified
 *     one bucket earlier.
 *  3. That create's group is also empty, and becomes the anchor in turn. The
 *     induction never recovers.
 *
 * Unioning an admitted set fixes it without loosening anything: adding anchors
 * can only widen the chain side, and the candidate intersection below still
 * bounds the result from the other direction, so no union can over-permission.
 */
export function authorVerifiedRoster(
  deps: RosterChainDeps,
  input: AuthorRosterInput,
): Effect.Effect<AuthoredRoster, RosterUnavailableError> {
  return Effect.gen(function* () {
    // 1. BOOTSTRAP. With no anchor there is no chain state to verify anything
    //    against, so the only roster this client can vouch for is the empty one:
    //    the bucket is created with the owner and this signing key alone, and it
    //    becomes the anchor that lets the NEXT create author a real roster. No
    //    read of any kind happens, because no answer could change the outcome.
    if (input.anchorGroupIds.length === 0) {
      return {
        members: [],
        reason: "bootstrap",
        droppedCandidates: [],
        anchorGroupIds: [],
      } as const;
    }

    // Normalized and de-duplicated once, so a list that spells one group two
    // ways cannot spend two anchor slots and two enumerations on it.
    const anchorGroupIds: string[] = [];
    const seenAnchors = new Set<string>();
    for (const raw of input.anchorGroupIds) {
      const groupId = normalizeSuiAddress(raw);
      if (seenAnchors.has(groupId)) continue;
      seenAnchors.add(groupId);
      anchorGroupIds.push(groupId);
    }

    // 2. CANDIDATES FIRST — one HTTP call on the working-key lane.
    const response = yield* input.listCandidates().pipe(
      Effect.catchAll((cause) =>
        // 2a. REFUSE. "No other signers" and "the read failed" are
        //     indistinguishable from here, and treating a failure as the former
        //     writes a bucket that is permanently under-permissioned and that
        //     nothing surfaces: the API derives its expected-grant rows from the
        //     roster we author, so an authored `[]` leaves the diagnostics
        //     endpoint empty rather than showing a missing grant. This refusal
        //     happens before the reserve, so it costs one retry and no gas.
        Effect.fail(
          new RosterUnavailableError({
            stage: "candidates",
            cause,
            message:
              `Refusing to create the bucket: the list of this space's service signers could ` +
              `not be read (${describeCause(cause)}), so the roster of accounts that may read the ` +
              `new bucket could not be authored. This is transient — retry. Nothing was ` +
              `reserved, so a retry costs no gas and leaves no half-created bucket behind.`,
          }),
        ),
      ),
    );

    // THE PARSE BOUNDARY. `SpaceSignersResponse` is an unchecked cast over
    // whatever Console returned (`ConsoleApiClient`'s `res.json as …`), so the
    // static type is a claim about this body, not a fact about it. Everything
    // below reads it as `unknown` and checks each field it uses — an unchecked
    // field access here would throw a bare TypeError, and a throw inside this
    // generator is an Effect DEFECT: `catchAll` does not recover it, Task 6's
    // `catchTag` never sees it, and none of the remedy text below ever prints.
    // This is the one party the module exists to distrust; it does not get to
    // choose the shape of our failures.
    const claimedSigners: unknown = response?.signers;

    // A body that does not carry a signer LIST is a read that failed, not a space
    // with no signers — the same distinction 2a turns on, so it takes the same
    // refusal. (A hostile server gains nothing here: it could send `[]` instead,
    // which is legitimate and handled by 2b.)
    if (!Array.isArray(claimedSigners)) {
      return yield* new RosterUnavailableError({
        stage: "candidates",
        message:
          `Refusing to create the bucket: the list of this space's service signers came back ` +
          `without a signer list, so the roster of accounts that may read the new bucket could ` +
          `not be authored. Retry; if it persists this build and the Console API disagree on ` +
          `the shape of /api/v1/api-keys/space-signers.`,
      });
    }

    // Subtract the three addresses that have their own dedicated rows in the PTB
    // and their own pins in `txValidation`. For the owner and the signing key the
    // dedicated row IS a membership grant, so listing either on the roster would
    // have its membership calls consumed by the dedicated check and then be
    // reported as a missing roster entry. The manager is excluded for a different
    // reason: its dedicated row is `grant_permission`, which hands over group
    // MANAGEMENT rather than bucket access, so a roster entry for it would be
    // asking for a second, unrelated grant — and the address it must equal is
    // already pinned at that row.
    const excluded = new Set(
      [input.ownerAddress, input.signerAddress, input.managerAddress]
        .filter((value): value is string => value !== undefined)
        .map((value) => normalizeSuiAddress(value)),
    );

    // THE ANCHOR CREATORS ARE STRUCK FROM THE MEMBERSHIP INSTEAD, and the
    // difference from `excluded` is deliberate. The key-scope row of a create
    // grants the SIGNING KEY both bucket permissions on the group that create
    // makes, so every anchor holds the key that made it as an ordinary
    // chain-verified member. That row is this client's own footprint, never
    // evidence about who belongs on a roster — so what it invalidates is the
    // EVIDENCE, not the candidacy. Struck at 2d, where the membership is read.
    //
    // It matters after a working-key rotation. The PREVIOUS key is a member of
    // every anchor it created and stays vouched for until those age out of
    // `anchorStore`'s 32, so if the rotation happened because that key was
    // COMPROMISED, the only thing keeping it off new buckets would be Console's
    // candidate list — the one input this module treats as untrusted.
    //
    // Kept OUT of `excluded` so a creator Console still lists is dropped by the
    // intersection like any other unvouched-for candidate, and therefore
    // DISCLOSED. The three above are silent because each has a dedicated PTB row
    // that grants it access anyway; a struck creator gets nothing, which is
    // exactly the kind of omission `droppedCandidates` exists to say out loud.
    //
    // Struck from EVERY anchor, not only from the ones it created. A per-anchor
    // rule is possible — the store records which anchor each creator made — and
    // it would keep a creator that also holds a genuine grant on some other
    // anchor. It is not what this does: the address in question is a key this
    // host has rotated away from, so keeping it costs nothing when the rotation
    // was routine (grant it explicitly, as with any never-anchored key) and costs
    // the whole mechanism when it was not. Erring toward under-permissioning is
    // the direction every other decision here takes.
    const anchorCreators = new Set(input.anchorCreators.map((value) => normalizeSuiAddress(value)));

    // Normalized because `isValidSuiAddress` accepts mixed-case and `0x`-less
    // forms, config pins are stored raw, and chain and the API may spell the same
    // address differently. Getting this wrong drops a legitimate member. No
    // separate validity filter: an address that is not a real one simply fails to
    // match any chain member and is dropped by the intersection below.
    const candidates: string[] = [];
    const seenCandidates = new Set<string>();
    // The role the API will insist on for each candidate, derived from the scope
    // it claims. Never used to CHOOSE a role — only to drop a member whose
    // chain-derived role the server would reject (step 2i).
    const requiredRole = new Map<string, RosterMember["role"]>();
    for (const signer of claimedSigners as readonly unknown[]) {
      const claimed = (signer as { service_signer_address?: unknown } | null | undefined)
        ?.service_signer_address;

      // A MALFORMED ENTRY REFUSES, it is not skipped. Skipping would be sound
      // against injection — candidates only ever narrow — but that is not the
      // axis that decides it: an entry whose address we cannot read may well be
      // a legitimate signer whose address was mangled, and dropping it writes a
      // permanently under-permissioned bucket nothing surfaces. That is exactly
      // the silent-and-permanently-wrong outcome branch 2a rejects, and this is
      // the same class of defect as a body with no `signers` array at all, so it
      // takes the same refusal.
      if (typeof claimed !== "string") {
        return yield* new RosterUnavailableError({
          stage: "candidates",
          message:
            `Refusing to create the bucket: one of this space's service signers came back ` +
            `without a usable address (${JSON.stringify(claimed) ?? "missing"}), so the roster ` +
            `of accounts that may read the new bucket could not be authored. Retry; if it ` +
            `persists this build and the Console API disagree on the shape of ` +
            `/api/v1/api-keys/space-signers.`,
        });
      }

      // Safe now, and only now: `normalizeSuiAddress` cannot throw for a string,
      // but it throws for everything else.
      const address = normalizeSuiAddress(claimed);
      if (excluded.has(address) || seenCandidates.has(address)) continue;
      seenCandidates.add(address);
      candidates.push(address);
      requiredRole.set(address, expectedRoleForScope((signer as { scope?: unknown }).scope));
    }

    // 2b. EMPTY CANDIDATES → author `[]` and SKIP THE CHAIN READS ENTIRELY.
    //
    //     The shape of this branch invites a future reader to "harden" it by
    //     reading chain anyway. Doing so would change no outcome, and here is
    //     why it is not a trust shortcut:
    //
    //     The candidate list is untrusted, so an empty one could be a hostile
    //     server suppressing the roster. The ONLY thing that produces is a bucket
    //     with FEWER grants. Under-permissioning is available to that server
    //     regardless — it can omit names from any list it serves — and it is not
    //     a breach: nobody gains access they should not have. Meanwhile the
    //     intersection of the chain membership with an empty candidate set is
    //     empty for every possible chain membership, so reading chain here
    //     cannot produce a different roster.
    //
    //     This is therefore a latency optimization — the common single-key MCP
    //     host pays zero chain round trips — and not a weakening of the check.
    if (candidates.length === 0) {
      return {
        members: [],
        reason: "no_other_signers",
        droppedCandidates: [],
        anchorGroupIds: [],
      } as const;
    }

    // 2c. CHAIN. Any failure below refuses, for the reason spelled out in 2a.
    //
    //     Walked most-recent-first, admitting as it goes and stopping once the
    //     cap is FULL OF ADMITTED ANCHORS — which is the same set as "admit them
    //     all, then keep the 20 newest", at the cost of only the enumerations it
    //     actually needs. What it is emphatically NOT is "take the 20 newest,
    //     then admit": that hands a run of identity-only creates the power to
    //     evict the one anchor with evidence in it.
    //
    //     The candidates as a set, because admission below asks "does this anchor
    //     hold any of them?" once per member of every anchor. Built here rather
    //     than beside the list so the two branches above still pay nothing.
    const candidateSet = new Set(candidates);
    const admitted: { readonly groupId: string; readonly members: ReadonlySet<string> }[] = [];
    let notConsulted = 0;
    for (const [index, groupId] of anchorGroupIds.entries()) {
      if (admitted.length >= MAX_ADMITTED_ANCHORS) {
        notConsulted = anchorGroupIds.length - index;
        break;
      }

      const chainMembers = yield* enumerateAnchorMembers(deps, groupId);

      // The membership this anchor is worth, with the key-scope rows of the
      // creates that made these anchors struck out (see `anchorCreators`). Done
      // here, once, so admission, the intersection at 2f and the role probe at 2h
      // all read the same set and cannot drift apart about what a member is.
      const members = new Set(chainMembers.filter((member) => !anchorCreators.has(member)));

      // 2d. ADMISSION — the anchor must hold at least one CANDIDATE, which is
      //     precisely "this anchor can contribute a member to the roster". A
      //     group holding nothing beyond the owner pin, this signing key, the
      //     manager and the key that created it is a bootstrap bucket: a
      //     perfectly valid group, but every address in it is one the
      //     intersection at 2f discards anyway, so it can contribute exactly
      //     nothing while occupying a slot and a role probe.
      //
      //     THE TEST IS NOT `member_count > 0`, AND THAT IS THE WHOLE TRAP. A
      //     bootstrap group's member count is near THREE, not zero — the owner,
      //     the signer and the manager are all in it — so a count test admits
      //     every empty anchor and leaves the ratchet completely intact.
      //
      //     NOR IS IT `|members \ {owner, signer, manager}| > 0`, which is what it
      //     used to be. That set is not the candidate set, and where they differ
      //     the answer was wrong: on a host with NO `keyAdminAddress` pin there is
      //     no manager to subtract, so the space's Key-Admin — a member of every
      //     group — counted as "an address beyond the three", admitted an
      //     identity-only anchor on the strength of it, and reported
      //     `chain_verified` with zero members for a space that is plainly
      //     `no_admitted_anchor`. Two of the four reasons stop being
      //     distinguishable at that point, which is the one thing they exist for.
      //     Testing against the candidates removes the dependence on which pins
      //     this host happens to hold, and it is strictly narrower than the old
      //     test — `candidates` is what is left after `excluded` — so it admits
      //     nothing the old one did not.
      if (![...members].some((member) => candidateSet.has(member))) continue;

      admitted.push({ groupId, members });
    }

    // 2e. NO ADMITTED ANCHOR — anchors on file, candidates on the list, and not
    //     one anchor holding any of those candidates.
    //
    //     It authors `[]` like `bootstrap` does, and it is NOT `bootstrap`: that
    //     one means "no anchor at all" and self-heals the moment any create
    //     authors members, while this one persists until somebody is granted a
    //     role on one of this space's buckets. Nor is it `chain_verified`, which
    //     is what it used to be reported as — every anchor here was enumerated
    //     and every one was rejected, so no membership backed anything and there
    //     is nothing to be verified against.
    //
    //     `anchorsNotConsulted` is deliberately absent rather than zero, and it
    //     cannot be anything else: the cap only bites once MAX_ADMITTED_ANCHORS
    //     anchors have been ADMITTED, so an empty admitted set means the loop ran
    //     to the end of the list.
    //
    //     Every candidate is dropped, and each is named for the same reason the
    //     other arms name theirs: the key will not be able to read this bucket.
    if (admitted.length === 0) {
      return {
        members: [],
        reason: "no_admitted_anchor",
        droppedCandidates: [...candidates].sort(),
        anchorGroupIds: [],
      } as const;
    }

    // 2f. UNION, THEN INTERSECT. Chain is the gate; the candidate list only
    //     narrows. Every admitted group was created and validated by this
    //     client, so membership in any one of them is the same evidence — and
    //     widening the chain side cannot over-permission, because nothing
    //     survives that the candidate list does not also name. A candidate in no
    //     admitted anchor is DROPPED rather than refused: that is the disclosed
    //     never-anchored residual (a freshly minted key whose backfill has not
    //     landed) and it is the same mechanism by which an injected address is
    //     discarded.
    const verified: string[] = [];
    const dropped: string[] = [];
    for (const candidate of candidates) {
      if (admitted.some((anchor) => anchor.members.has(candidate))) verified.push(candidate);
      else dropped.push(candidate);
    }

    // 2g. The size invariant, checked BEFORE the role read: a roster this large
    //     means something upstream is wrong, and truncating it to fit would
    //     under-permission the bucket silently.
    if (verified.length > MAX_ROSTER_MEMBERS) {
      return yield* new RosterUnavailableError({
        stage: "invariant",
        message:
          `Refusing to create the bucket: ${verified.length} chain-verified service accounts ` +
          `were found for this space, more than the ${MAX_ROSTER_MEMBERS} this client will ` +
          `author. Truncating the roster would leave some keys unable to read the bucket, so ` +
          `nothing was reserved. Revoke unused API keys for this space, or report this — a ` +
          `space cannot normally hold this many signers.`,
      });
    }

    // 2h. ROLES FROM CHAIN, READ OFF THE NEWEST ANCHOR THAT HOLDS THE ADDRESS.
    //     `admitted` is in the order the anchors were recorded — newest first,
    //     which `anchorStore` guarantees and the cap above already relies on — so
    //     the first anchor holding an address is the most recent bucket this
    //     client created that granted it anything. That is the closest thing to
    //     the CURRENT state of the space that chain can be asked for here.
    //
    //     IT USED TO TAKE THE MAXIMUM ACROSS THE ANCHORS, and the argument for
    //     that was entirely about GRANTS: an api-key's scope is fixed at mint and
    //     the API grants `BucketViewer + BucketEditor` atomically in one
    //     transaction, so a `readwrite` key seen viewer-only somewhere is a
    //     PARTIAL GRANT there rather than a downgrade of the key. That much is
    //     still true, and it says nothing about REVOCATIONS, which are neither
    //     atomic nor tied to the key's scope: `revoke_permission` takes one
    //     permission off one group. So an operator who revokes `BucketEditor`
    //     across this space's recent buckets would have the maximum quietly
    //     restore it from the oldest surviving anchor — the client authoring
    //     `editor` again by its own hand, and the validator dutifully enforcing
    //     it. The newest sighting can only ever be as stale as the last bucket
    //     this client created.
    //
    //     AN ADDRESS THE NEWEST ANCHOR HOLDS BUT REPORTS NO BUCKET ROLE FOR IS
    //     SETTLED TOO, and settles as "no role" — that is a revocation that took
    //     both permissions, and falling through to an older anchor for "a role,
    //     any role" is the maximum wearing a different shape. It lands in
    //     `droppedCandidates` at 2i, disclosed like every other omission.
    //
    //     Each anchor is therefore probed only for the verified addresses it
    //     holds that no NEWER anchor has settled. Skipping non-members changes no
    //     outcome (`has_permission` would answer `false` for them anyway);
    //     skipping the settled ones is load-bearing, because an older answer must
    //     not be able to override a newer one — so it is not even asked for.
    const roleOnChain = new Map<string, RosterMember["role"]>();
    const settled = new Set<string>();
    for (const anchor of admitted) {
      const onThisAnchor = verified.filter(
        (address) => anchor.members.has(address) && !settled.has(address),
      );
      if (onThisAnchor.length === 0) continue;

      const roles = yield* resolveRosterRoles(deps, {
        anchorGroupId: anchor.groupId,
        addresses: onThisAnchor,
      });
      // Everything asked about is settled by this anchor, INCLUDING the addresses
      // it returned no row for: `resolveRosterRoles` omits an address holding
      // neither permission, and that omission is this anchor's answer.
      for (const address of onThisAnchor) settled.add(address);
      for (const member of roles) roleOnChain.set(member.address, member.role);
    }

    // 2i. ASSEMBLE, DROPPING THE TWO ROLE FAILURES.
    const members: RosterMember[] = [];
    for (const address of verified) {
      const role = roleOnChain.get(address);

      // A verified member the newest anchor holding it grants neither bucket
      // permission on gets no roster row, so it is disclosed alongside the
      // never-anchored ones: same consequence for the key, different cause.
      if (role === undefined) {
        dropped.push(address);
        continue;
      }

      // A ROLE THE API WILL REJECT IS DROPPED, NOT AUTHORED. `validateAuthoredMembers`
      // refuses any authored role that contradicts the key's own
      // `expectedPermission` — a wrong role would leave that key's expected-grant
      // row unmatchable and strand it in `registering` — so sending one turns the
      // whole create into a 400 rather than a quiet under-grant. Compared here,
      // before anything is reserved, and resolved by dropping the member: a rare
      // partial grant degrades to under-permissioned instead of a hard failure.
      //
      // This does NOT let the claimed scope choose a role. It is a filter, so it
      // can only narrow — the role we author is always the one chain reported,
      // and a hostile relabel gains nothing but the removal of a member it could
      // have suppressed from the candidate list anyway.
      if (role !== requiredRole.get(address)) {
        dropped.push(address);
        continue;
      }

      members.push({ address, role });
    }

    // Sorted so the same space produces the same roster bytes every time — the
    // reserve request, the validator's multiset check and any disclosure all read
    // the same order.
    members.sort((a, b) => (a.address === b.address ? 0 : a.address < b.address ? -1 : 1));

    return {
      members,
      reason: "chain_verified",
      droppedCandidates: dropped.sort(),
      anchorGroupIds: admitted.map((anchor) => anchor.groupId),
      ...(notConsulted > 0 ? { anchorsNotConsulted: notConsulted } : {}),
    } as const;
  });
}

// === Default implementation ==============================================

/**
 * The real chain reads, over gRPC against the fullnode for the network the
 * Console base URL implies.
 *
 * gRPC rather than JSON-RPC: JSON-RPC is retired on public Sui fullnodes and
 * answers `sui_getObject` with "Method not found", so a JSON-RPC roster read
 * would refuse every create. This mirrors `SealCryptoService`, which already
 * builds a `SuiGrpcClient` for the same reason — but builds its OWN client
 * rather than sharing that one, which is private to that service.
 *
 * The client is a stateless config holder (no I/O until a call is made), so
 * constructing it is free.
 */
export function makeRosterChainDeps(baseUrl: string): RosterChainDeps {
  const network = resolveSuiNetwork(baseUrl);
  const client = new SuiGrpcClient({ baseUrl: resolveFullnodeUrl(network), network });

  return {
    config: resolvePackageConfigForBaseUrl(baseUrl),
    getGroupObject: async (objectId) => {
      const { object } = await client.getObject({ objectId, include: { content: true } });
      return { type: object.type, content: object.content };
    },
    listMemberFields: async (parentId, cursor) => {
      const page = await client.listDynamicFields({ parentId, cursor });
      return {
        dynamicFields: page.dynamicFields.map((field) => ({ name: field.name })),
        hasNextPage: page.hasNextPage,
        cursor: page.cursor,
      };
    },
    simulate: async (transaction) => {
      const result = await client.simulateTransaction({
        transaction,
        include: { commandResults: true },
      });
      return { commandResults: result.commandResults };
    },
  };
}
