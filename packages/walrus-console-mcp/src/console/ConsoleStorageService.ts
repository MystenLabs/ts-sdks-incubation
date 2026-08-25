import * as path from "node:path";
import { bcs } from "@mysten/sui/bcs";
import { deriveObjectID, normalizeSuiAddress } from "@mysten/sui/utils";
import { Context, Effect, Layer } from "effect";
import { removeAtomicTemp, writeFileAtomicAsync } from "../atomicWrite";
import {
  ConsoleConfigLive,
  ConsoleConfigTag,
  getKeyAdminAddress,
  getWebAccountAddress,
} from "../config";
import { readFileWithinRootAsync } from "../pathSandbox";
import { maxTransferBytes } from "../transferLimits";
import { type AnchorEntry, readAnchors, recordAnchor } from "./anchorStore";
import type { CreateBucketReserveResponse, FileUploadResponse } from "./ConsoleApiClient";
import { ConsoleApiClient } from "./ConsoleApiClient";
import {
  BucketCreatePinError,
  ConsoleApiError,
  FileStatusError,
  LocalFsError,
  MirrorGrantMissingError,
  PayloadTooLargeError,
  SealCryptoError,
  UnsupportedFileTypeError,
} from "./errors";
import { buildUploadMetadata, type FileUserMetadata } from "./fileMetadata";
import { type BucketGroupPackageConfig, resolvePackageConfigForBaseUrl } from "./packageConfig";
import {
  type AuthoredRoster,
  authorVerifiedRoster,
  makeRosterChainDeps,
  MAX_ADMITTED_ANCHORS,
  type RosterChainDeps,
} from "./rosterVerification";
import { SealCryptoService } from "./SealCryptoService";
import { describeUploadResult, pollUntilTerminal } from "./uploadPolling";
import { type FileId, type SpaceId, BucketId } from "./types";

/**
 * High-level "ggdrive" style operations.
 * Combines ConsoleApiClient + SealCryptoService into user-friendly flows.
 *
 * All heavy crypto + signing + retry logic lives here.
 */

/**
 * The chain reads the roster verifier needs, as a service.
 *
 * `makeRosterChainDeps` would be a plain call in the service effect below — it is
 * behind a Tag so a test can hand this flow a stubbed chain the same way it hands
 * it a stubbed `ConsoleApiClient`, without standing up a fullnode. The Tag lives
 * here rather than beside `makeRosterChainDeps` because this is its only consumer.
 */
export class RosterChainDepsTag extends Context.Tag("RosterChainDeps")<
  RosterChainDepsTag,
  RosterChainDeps
>() {}

/**
 * The real reads, aimed at the network the Console base URL implies. The gRPC
 * client inside is a stateless config holder (no I/O until a call), so building
 * this at layer-construction time costs nothing.
 */
export const RosterChainDepsLive = Layer.effect(
  RosterChainDepsTag,
  Effect.map(ConsoleConfigTag, (config) => makeRosterChainDeps(config.baseUrl)),
);

/**
 * The object id `create_bucket_group` will derive for the bucket this
 * transaction creates, computed from LOCAL inputs alone.
 *
 * This is the trust root of the whole roster scheme, and it is why it is
 * computed rather than read. The group id is what a later create enumerates to
 * decide who may be granted access to a new bucket, so an id supplied by the
 * server is an id the server chooses — and a server that names a group it
 * controls gets its own addresses enumerated as "chain-verified" members, which
 * this client then authors onto the next bucket by its own hand. That bucket
 * becomes the next anchor, so the substitution is self-propagating and every
 * later create inherits it looking correctly verified. No server-side check can
 * close that, because the server is the adversary in the scenario.
 *
 * Mirrors `derived_object::claim(&mut registry.id, BucketDerivationKey {
 * bucket_id, creator })` — see harbor's `deriveBucketGroupId`. `claim` aborts if
 * the slot is taken, so the mapping from (registry, bucket_id, creator) to an
 * address is one-to-one and permanent.
 *
 * Every input is local or already pinned: the registry and the package root are
 * bundled configuration, `creator` is the address about to sign (which
 * `txValidation` has pinned as the transaction's sender), and `bucketIdArg` is
 * lifted verbatim out of the bytes that were just validated.
 *
 * The type tag roots at `originalPackageId`, NOT `packageId`: Move type
 * identities carry the DEFINING package address, so using the upgraded id would
 * derive a different, wrong address.
 *
 * BCS encodes a struct as its fields concatenated in order, so the derivation key
 * is the PTB's own `bucket_id` argument (already BCS — a length-prefixed UTF-8
 * string) followed by the creator's address. Concatenated rather than decoded and
 * re-encoded on purpose: the bytes in the transaction are the bytes that will
 * execute.
 *
 * Exported for tests. On testnet `packageId` and `originalPackageId` hold the
 * same value, so nothing that runs the real flow can tell the two roots apart —
 * only a direct test with a config where they differ pins that, and getting it
 * wrong would derive a plausible-looking address that no group ever occupies.
 */
export function deriveBucketGroupId(
  packageConfig: BucketGroupPackageConfig,
  bucketIdArg: Uint8Array,
  creator: string,
): string {
  const creatorBytes = bcs.Address.serialize(creator).toBytes();
  const key = new Uint8Array(bucketIdArg.length + creatorBytes.length);
  key.set(bucketIdArg, 0);
  key.set(creatorBytes, bucketIdArg.length);

  return normalizeSuiAddress(
    deriveObjectID(
      packageConfig.bucketRegistryId,
      `${normalizeSuiAddress(packageConfig.originalPackageId)}::bucket_policy::BucketDerivationKey`,
      key,
    ),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** What a stored anchor is worth against the package config in force NOW. */
export type StoredAnchorCheck =
  /** Re-derived from its own recorded inputs. Safe to enumerate. */
  | { readonly status: "usable"; readonly groupId: string }
  /** Derived under a package config this build no longer uses. Benign. */
  | { readonly status: "stale"; readonly detail: string }
  /** Current inputs, and the id still does not come back. Suspicious. */
  | { readonly status: "unreproducible"; readonly detail: string };

/**
 * Re-derive a stored anchor against the CURRENT package configuration.
 *
 * A pre-derivation `anchors.json` (no `creator`) never reaches here: `loadAnchors`
 * drops those entries, so the next create bootstraps. Everything else splits two
 * ways, and the split is the point — the two failures look identical (the id does
 * not come back) and need opposite handling:
 *
 *  - STALE. The group id derives from `bucketRegistryId` + `originalPackageId`,
 *    which are build configuration and DO change: `packageConfig.ts` schedules
 *    the staging entry's deletion ("when the republish merges … this entry is
 *    deleted"), and switching between the two allowed testnet Console
 *    deployments does the same to a re-used space id. On that day every stored
 *    anchor stops reproducing at once with no adversary anywhere. Refusing there
 *    would brick `create_bucket` for every affected space until each operator
 *    deleted the file by hand, which contradicts `anchorStore`'s own contract:
 *    an anchor is recoverable cache, and the recovery is the bootstrap path.
 *    An entry that records no inputs at all — written before this check existed —
 *    is stale for the same reason: nothing says which ids produced it, and a file
 *    this client itself wrote must not be called a tamper.
 *  - UNREPRODUCIBLE. The inputs it names ARE the ones in force, and the id still
 *    does not reproduce (or the entry does not even encode). Nothing benign
 *    explains that, so it keeps the hard refusal: using such an anchor is how a
 *    hostile finalize poisons every later roster in the space.
 */
export function checkStoredAnchor(
  packageConfig: BucketGroupPackageConfig,
  entry: AnchorEntry,
): StoredAnchorCheck {
  const recordedRegistry = entry.bucketRegistryId;
  const recordedPackage = entry.originalPackageId;
  if (recordedRegistry === undefined || recordedPackage === undefined) {
    return {
      status: "stale",
      detail:
        "it records no bucket-policy ids, so it predates this check and nothing says which " +
        "package configuration produced it",
    };
  }

  // Normalized on both sides: config ids are raw strings from a hand-maintained
  // table and the recorded ones are whatever was in force then, so `0x0…28d1` and
  // `0x28d1` for the same registry must not read as a package change and throw a
  // perfectly good anchor away on every create.
  if (
    normalizeSuiAddress(recordedRegistry) !== normalizeSuiAddress(packageConfig.bucketRegistryId) ||
    normalizeSuiAddress(recordedPackage) !== normalizeSuiAddress(packageConfig.originalPackageId)
  ) {
    return {
      status: "stale",
      detail:
        `it was derived under registry ${recordedRegistry} and package ${recordedPackage}, and ` +
        `this client now resolves registry ${packageConfig.bucketRegistryId} and package ` +
        `${packageConfig.originalPackageId}`,
    };
  }

  let derived: string;
  try {
    derived = deriveBucketGroupId(
      packageConfig,
      bcs.string().serialize(entry.bucketId).toBytes(),
      entry.creator,
    );
  } catch (cause) {
    // `bcs.string()` and `bcs.Address` THROW on input they cannot encode — a
    // hand-edited `creator` of `not-an-address` raises "Invalid Sui address".
    // `loadAnchors` only checks `typeof === "string"`, so that value reaches
    // here, and a throw inside the caller's generator is an Effect DEFECT: no
    // `BucketCreatePinError`, so the remedy below never prints and a file the
    // operator can simply delete surfaces as an unexplained internal failure.
    // Same class of bug, and the same fix, as the throwing normalizers in
    // `rosterVerification`. It answers UNREPRODUCIBLE rather than stale because
    // the recorded ids are the current ones and an entry this client wrote
    // always encodes.
    return {
      status: "unreproducible",
      detail: `its bucket id and creator do not encode: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  return normalizeSuiAddress(entry.groupId) === derived
    ? { status: "usable", groupId: derived }
    : { status: "unreproducible", detail: `those inputs derive ${derived} instead` };
}

/**
 * Cross-check the reserve's echo fields against the pins that were sent.
 *
 * DIAGNOSTICS ONLY, and the distinction matters: the security boundary is
 * `txValidation`'s walk of the bytes about to be signed, which never reads these
 * fields — a hostile endpoint can echo anything it likes and still cannot get a
 * substituted `add_owner` signed. What this buys is legibility. Without it, a
 * server that ignored `expectedOwnerAddress` surfaces one step later as an
 * unexplained "refusing to sign", and the operator hunts through Console for a
 * problem the reserve response already announced.
 *
 * Absent echoes are FINE: older deployments omit both fields, and a null
 * `admin_signer_address` is the honest answer for a space that holds no key_admin
 * key (the PTB then carries no `grant_permission` at all, which the validator
 * accepts). Only a field that is PRESENT and contradicts a pin refuses.
 *
 * "Present" is decided by `typeof`, not by the declared type. `CreateBucketReserveResponse`
 * is an unchecked cast over a JSON body, so `owner_address` can arrive as a
 * number or an object no matter what the interface says — and `normalizeSuiAddress`
 * is `value.toLowerCase()`, which would throw a bare TypeError inside the caller's
 * generator. That is an Effect DEFECT: no `catchTag` recovers it and none of the
 * remedy text below ever prints, so a hostile endpoint would get to choose the
 * shape of our failure and suppress the explanation. A present-but-unreadable
 * echo is therefore treated as a CONTRADICTING one.
 *
 * Returns the refusal rather than raising it, so the caller keeps the ordering of
 * this check visible in the flow.
 */
function checkReserveEcho(
  reserve: CreateBucketReserveResponse,
  ownerAddress: string,
  managerAddress: string | undefined,
): BucketCreatePinError | undefined {
  // NULL IS TOLERATED BELOW AND REFUSED HERE, and the two branches must not be
  // made "consistent": Console's OpenAPI lists `owner_address` in the reserve
  // response's `required` set as a plain `string`, while `admin_signer_address`
  // is optional and typed `["string", "null"]` — "null when the space has none".
  // So a null admin signer is the schema's own way of saying absent, and a null
  // owner is a body that contradicts its own contract, which is the malformed
  // case the paragraph above sends down the contradicting path.
  const ownerEcho: unknown = reserve.owner_address;
  if (
    ownerEcho !== undefined &&
    (typeof ownerEcho !== "string" ||
      normalizeSuiAddress(ownerEcho) !== normalizeSuiAddress(ownerAddress))
  ) {
    return new BucketCreatePinError({
      reason: "owner_echo_mismatch",
      message:
        `Refusing to create the bucket: the reserve was asked to make ${normalizeSuiAddress(ownerAddress)} ` +
        `the bucket's owner, and Console echoed back ${describeEcho(ownerEcho)}. Nothing was ` +
        `signed. Either CONSOLE_WEB_ACCOUNT_ADDRESS names a different account than the one this ` +
        `API key belongs to, or the endpoint is not honouring the owner this client sends.`,
    });
  }

  const adminEcho: unknown = reserve.admin_signer_address;
  if (
    adminEcho !== undefined &&
    adminEcho !== null &&
    managerAddress !== undefined &&
    (typeof adminEcho !== "string" ||
      normalizeSuiAddress(adminEcho) !== normalizeSuiAddress(managerAddress))
  ) {
    return new BucketCreatePinError({
      reason: "admin_echo_mismatch",
      message:
        `Refusing to create the bucket: this host pins the Key-Admin at ` +
        `${normalizeSuiAddress(managerAddress)}, and Console says this space's admin signer is ` +
        `${describeEcho(adminEcho)} — so the reserve would hand group management to an ` +
        `address this host does not recognise. Nothing was signed. Correct ` +
        `CONSOLE_KEY_ADMIN_ADDRESS (or \`keyAdminAddress\` in the config file), or re-provision ` +
        `the admin credential bundle.`,
    });
  }

  return undefined;
}

/**
 * Render an echoed value for a refusal message.
 *
 * Normalized when it is an address-shaped string so the two sides of the
 * comparison print in the same spelling; otherwise quoted as-is, because "Console
 * echoed back 42" is the whole diagnosis for a malformed body and rewriting it
 * into an address would hide that.
 */
function describeEcho(value: unknown): string {
  return typeof value === "string" ? normalizeSuiAddress(value) : JSON.stringify(value);
}

/**
 * The human-readable half of a create result.
 *
 * `bootstrap`, `no_other_signers`, `no_admitted_anchor` and `chain_verified`
 * produce IDENTICAL transaction bytes and identical server state when the roster
 * comes out empty, so the returned text is the ONLY thing that tells a benign
 * empty roster ("this space has one key") from a consequential one ("no anchor
 * carried any evidence, so nothing could be authored"). That is why there is no
 * bare success message here and why the four arms are worded differently rather
 * than sharing a template.
 *
 * `staleAnchors` is the one input that is NOT on the roster: the verifier is free
 * of filesystem I/O and never sees the recorded entries this create skipped
 * because the bucket-policy ids moved under them, so the count is threaded in
 * from the caller that did the skipping.
 *
 * `anchorRecorded` is threaded in for the same reason and closes the same class
 * of gap: whether THIS create's own group got cached as the space's next anchor
 * is decided by the caller, after this function has already been asked to
 * describe the result, and that write is deliberately fault-tolerant (see
 * `createBucket`'s step 8 — a create whose bucket already exists on-chain must
 * not fail over a local cache write). Every arm below that claims a later
 * create_bucket here builds on this one is therefore worded conditionally on
 * it: the claim is true when the write landed and false when it did not (an
 * unwritable config directory, for instance), and asserting it unconditionally
 * would say more than the code delivered exactly in the case this whole
 * function exists to get right.
 */
function describeCreateBucketRoster(
  roster: AuthoredRoster,
  staleAnchors: number,
  anchorRecorded: boolean,
): string {
  const dropped =
    roster.droppedCandidates.length === 0
      ? ""
      : ` These of this space's service accounts were NOT granted access and cannot read this ` +
        `bucket: ${roster.droppedCandidates.join(", ")} — each is either absent from every anchor ` +
        `group's membership (which never counts the key that CREATED that group, a row this ` +
        `client wrote for itself), holds no bucket role on the newest anchor group that does ` +
        `hold it, or holds one that contradicts the scope Console claims for its key. Grant them ` +
        `access explicitly if they need it.`;

  // Said only when the cap actually bit. A truncated anchor set can only
  // under-permission — an unread anchor cannot add a member the candidate list
  // does not also name — but "some keys may be missing, and here is why" is
  // exactly the kind of thing this result exists to say out loud.
  const truncated =
    roster.anchorsNotConsulted === undefined
      ? ""
      : ` ${roster.anchorsNotConsulted} older recorded anchor group(s) for this space were not ` +
        `consulted: this client reads at most ${MAX_ADMITTED_ANCHORS} of them per create. A key ` +
        `whose only membership is on one of those was not granted access.`;

  // The OTHER way an anchor goes unread, and it needs its own sentence for the
  // same reason `truncated` does. Until the anchor set became a union, one stale
  // entry meant the `bootstrap` arm, whose text names staleness itself; now
  // some-stale-some-reproducing lands on `chain_verified`, where nothing else in
  // the sentence would mention the ones that were skipped — and stderr, where
  // this is also logged, is not what an agent shows a human.
  //
  // Deliberately NOT folded into `anchorsNotConsulted`. The two counts have
  // different causes and different remedies: that one is this client's own
  // per-create cap and is fixed by consulting fewer, older anchors, while this
  // one is a config change that heals on its own as later creates re-anchor the
  // space under the ids in force now. One number standing for both would say
  // neither.
  const stale =
    staleAnchors === 0
      ? ""
      : ` ${staleAnchors} recorded anchor group(s) for this space were SKIPPED as STALE: they ` +
        `were derived under bucket-policy ids other than the ones in force here, so their ` +
        `membership was not read. A key whose only membership is on one of those was not ` +
        `granted access. ` +
        (anchorRecorded
          ? `This heals by itself — the group this bucket creates is anchored under the ids in ` +
            `force now.`
          : // The healing step is EXACTLY the write that did not happen — see
            // `anchorRecorded`'s own comment above. Saying "this heals by itself" here
            // would be describing a cache entry that does not exist.
            `This would normally heal by itself as the group this bucket creates re-anchors the ` +
            `space under the ids in force now, but that write did not land this time (see the ` +
            `warning already logged for why), so it does not yet — the next create_bucket here ` +
            `starts from this same stale position rather than an improved one.`);

  switch (roster.reason) {
    case "bootstrap":
      return (
        // Covers BOTH bootstrap paths without a fourth `roster.reason`: no anchor
        // on file, and every anchor on file derived under different
        // bucket-policy ids and therefore stale. Saying "no recorded anchor
        // group" would be literally false in the second case — the disclosure is
        // the one thing a user reads to know what happened, so it does not get to
        // be approximately true.
        `This space had no anchor group this client could use — either none was recorded yet, or ` +
        `the ones on file were derived under different bucket-policy ids and are stale — so there ` +
        `was no chain state to check a roster against and NOBODY beyond the bucket's owner and ` +
        `this signing key was granted access. ` +
        `Any other Console key in this space will not be able to read this bucket. ` +
        (anchorRecorded
          ? `This bucket joins the space's anchors — its group id was DERIVED locally from the ` +
            `transaction this client validated, not taken from Console's response. Whether the ` +
            `next create_bucket here can author a verified roster depends on this space having an ` +
            `anchor that holds one of this space's OTHER service accounts: an ` +
            `anchor is added, never replaced, so no earlier one is lost.`
          : // The write is fault-tolerant on purpose (step 8 above), so this is not an
            // error — the create above still succeeded and the bucket is exactly as
            // permissioned. What it does NOT get to say is the claim the TRUE branch
            // makes: with nothing cached, the next create_bucket here bootstraps again
            // exactly as this one did, rather than starting from an improved position.
            `This bucket's group was derived the same way — locally, from the transaction this ` +
            `client validated, not taken from Console's response — but it was NOT cached as this ` +
            `space's anchor: the write failed after the bucket itself was created (see the ` +
            `warning already logged for why). The bucket exists and is exactly as permissioned ` +
            `above; only the local cache is missing, so the next create_bucket here starts from ` +
            `this same bootstrap position rather than an improved one.`) +
        stale +
        dropped
      );
    case "no_other_signers":
      return (
        `Console listed no service signers for this space besides the bucket's owner, this ` +
        `signing key, and this host's pinned Key-Admin if it has one — the three addresses the ` +
        `transaction carries in dedicated rows of its own, each pinned separately. So an empty ` +
        `roster is the whole roster and no chain read was needed. What ` +
        `that does and does not establish: the signer list is Console's, so nobody was left out ` +
        `ACCORDING TO CONSOLE. A name suppressed there could only ever cost a key access, never ` +
        `grant one.` +
        stale +
        dropped
      );
    case "no_admitted_anchor":
      return (
        // NOT a variant of `bootstrap`, and saying so is the point of the arm.
        // Anchors exist here and every one of them was read; what none of them
        // held was any of this space's other service accounts, so there was
        // nothing to verify a roster against. The remedies differ too, which is
        // why the last sentences do not read like bootstrap's: bootstrap ends the
        // moment any create authors members, while this state persists until a
        // grant lands on one of the space's buckets.
        //
        // Worded against the CANDIDATES rather than against "an address beyond
        // the three this client already knows", because that is the test the
        // verifier actually applies — and the older wording quietly depended on
        // whether this host pins a Key-Admin, which is not something the reader
        // of a disclosure should have to know to interpret it.
        `This space's recorded anchor groups were all read, and NOT ONE of them holds any of the ` +
        `service accounts Console lists for this space (beyond the bucket's owner, this signing ` +
        `key, this host's pinned Key-Admin if it has one, and the keys that created those anchor ` +
        `groups themselves). Each is a real bucket group this ` +
        `client created and validated; they are simply all identity-only, which is what a run of ` +
        `creates that granted nobody leaves behind. So there was no chain evidence to verify a ` +
        `roster against, nothing was read FROM any of them, and NOBODY beyond the bucket's owner ` +
        `and this signing key was granted access. Any other Console key in this space will not ` +
        `be able to read this bucket. Unlike a space with no anchors at all, this does not clear ` +
        `itself: it lasts until one of those service accounts holds a bucket role on one of ` +
        `this space's buckets, after which the next create_bucket here can author a verified ` +
        `roster again. ` +
        (anchorRecorded
          ? `This bucket joins the space's anchors either way.`
          : // Same fault-tolerant write, same honest exception — see `anchorRecorded`'s
            // comment above. "Either way" stops being true when this bucket's own group
            // never made it into the cache at all.
            `This bucket's group was NOT cached as one of the space's anchors, though: the write ` +
            `failed after the bucket itself was created (see the warning already logged for ` +
            `why). The bucket exists and is exactly as permissioned above; only the local cache ` +
            `is missing, so the next create_bucket here starts from the same position as this ` +
            `one did, rather than an improved one.`) +
        stale +
        dropped
      );
    case "chain_verified":
      return (
        // `anchorGroupIds` is non-empty on this arm by construction — the
        // all-read-none-admitted case has its own reason above, precisely so this
        // sentence can never claim a membership read of zero groups. The `none`
        // fallback stays as a tripwire: if it ever renders, that invariant broke.
        `${roster.members.length} service account(s) were granted access after being read from the ` +
        `on-chain membership of ${roster.anchorGroupIds.length} anchor group(s) of this space ` +
        `(${roster.anchorGroupIds.join(", ") || "none"}) — bucket groups this client created ` +
        `earlier, whose object ids it DERIVED locally from the transactions it validated rather ` +
        `than accepting from Console. An address counts as verified if it is a member of ANY of ` +
        `them, and its role is the one it holds on the NEWEST of them that holds it — the current ` +
        `state of this space rather than the best it was ever granted. Those roles come from ` +
        `chain, not from Console's claimed scope. ` +
        // The honest bound, and it is not "Console chose nothing". Console's
        // signer list decided WHICH of the anchors' members were asked about, and
        // that membership is a superset of the space's service signers — a
        // session user may share any bucket with an arbitrary collaborator
        // wallet. So the endpoint still makes a selection; what it cannot do is
        // name an address that holds no bucket role on any of these groups.
        // Saying otherwise here would be the claim this whole flow cannot make.
        `What this does and does not establish: every address above already held a bucket role on ` +
        `one of these anchor groups, so Console could not introduce one that did not. Which of ` +
        `them ended up here was still decided by Console's signer list, and an anchor group's ` +
        `membership can include an address a person shared an earlier bucket with, so a ` +
        `compromised endpoint could suppress a name or single such an address out. ` +
        `What this also rests on: the Sui fullnode that served that ` +
        `membership. Show the roster to the user before uploading sensitive data.` +
        stale +
        truncated +
        dropped
      );
  }
}

export class ConsoleStorageService extends Effect.Service<ConsoleStorageService>()(
  "ConsoleStorageService",
  {
    effect: Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      const seal = yield* SealCryptoService;
      const config = yield* ConsoleConfigTag;
      const rosterDeps = yield* RosterChainDepsTag;

      // The bucket-policy identifiers for the network the Console API implies —
      // resolved the same way `SealCryptoService` resolves its own, so the ids the
      // group derivation uses can never disagree with the ones the validator pins.
      const packageConfig = resolvePackageConfigForBaseUrl(config.baseUrl);

      /**
       * One transfer at a time, across BOTH directions.
       *
       * Size-capping each transfer bounds one payload; it does nothing about N of
       * them at once. Every transfer holds two full copies — an upload has the
       * plaintext and the Seal ciphertext, a download has the ciphertext and the
       * decrypted plaintext — so peak memory is (permits x 2 x cap). The cap and
       * this limit are the same guard from two directions, and they only work
       * together.
       *
       * One permit rather than a few: the two directions share one heap, so
       * splitting the budget between them just makes the worst case a multiple of
       * itself. Created here, in the service effect, so it is per-layer and shared
       * by every call — a semaphore built per invocation would gate nothing.
       */
      const transferLock = yield* Effect.makeSemaphore(1);

      /**
       * Full create bucket flow (private + Seal): pin gate → chain-verified
       * roster → reserve → echo diagnostics → validate + sign → finalize →
       * anchor.
       *
       * The result deliberately never reports a bare success. An empty roster is
       * produced by three different situations that write IDENTICAL transaction
       * bytes and identical server state — no anchor at all, no other signer, and
       * anchors that carry no evidence — and only `roster.reason` and
       * `disclosure` tell them apart, so the caller can say out loud whether
       * "nobody else was granted access" is benign or consequential.
       */
      const createBucket = Effect.fn("ConsoleStorageService.createBucket")(function* (
        spaceId: SpaceId,
        name: string,
      ) {
        // The owner pin. The reserve PTB's `add_owner` call is what decides who ends
        // up owning the bucket, and `add_owner` carries no type argument to bound a
        // substituted recipient — so the validator can only check it against an
        // address supplied from OUTSIDE the response. That address is local
        // configuration, and without it there is nothing to check against, so this
        // fails closed rather than signing an unverifiable ownership grant.
        const ownerAddress = getWebAccountAddress(config);
        if (ownerAddress === undefined) {
          return yield* new BucketCreatePinError({
            reason: "missing_owner_pin",
            message:
              "Cannot create a bucket without knowing which account will own it. Set " +
              "CONSOLE_WEB_ACCOUNT_ADDRESS to your Console web-account Sui address, or run " +
              "`walrus-console-mcp config` to write it into the config file.",
          });
        }

        // The manager pin, on the same footing as the owner: a trust anchor the
        // server cannot write. It matters most on the population that has no admin
        // credential at all — a worker host on a space that DOES hold a key_admin
        // key gets a `grant_permission` it can check against nothing else, and the
        // validator fails closed there. Omitted (never set to `undefined`) when
        // unpinned, so the validator falls back to the derived admin address.
        const managerAddress = getKeyAdminAddress(config);

        // 1. AUTHOR THE ROSTER, before anything is reserved. Every read this makes
        //    happens pre-reserve on purpose: a refusal here costs one retry with no
        //    gas, no orphaned bucket and no partial state, which is what lets it
        //    refuse instead of degrading to an empty roster (a permanently
        //    under-permissioned bucket neither side can enumerate). The signer's
        //    own address comes from the keypair rather than from configuration —
        //    it is one of the three addresses with a dedicated row in the PTB, so
        //    listing it on the roster too would double-count it.
        const signerAddress = (yield* seal.getKeypair("working")).toSuiAddress();
        // EVERY recorded anchor, not the most recent one. Each is a group this
        // client created and validated, so each is equally good evidence, and
        // the verifier unions them — which is what stops an identity-only create
        // from shrinking the roster the next create can author (see
        // `authorVerifiedRoster`). Most recent first, an order the verifier's cap
        // relies on.
        const storedAnchors = readAnchors(spaceId);
        // The RE-DERIVED anchor ids, not the ones read off disk: below, an entry
        // either re-derives to the same address, is dropped as stale, or refuses
        // the create — so passing the derived values costs nothing and keeps a
        // stored string from ever being what the roster reads.
        const reproducedAnchors: string[] = [];
        // The working key that created each of those anchors, as recorded beside
        // it. The verifier strikes these from every anchor's membership: a group
        // always holds the key that made it, from the key-scope row of that
        // create, and that row is this client's own footprint rather than
        // evidence about anybody — which matters most for a key this host has
        // since rotated away from. Collected only for anchors that survive the
        // check below, because a stale or refused entry contributes no membership
        // for its creator to be struck from.
        const reproducedCreators: string[] = [];
        const staleDetails: string[] = [];
        for (const storedAnchor of storedAnchors) {
          const check = checkStoredAnchor(packageConfig, storedAnchor);
          if (check.status === "unreproducible") {
            // ONE tampered entry refuses the whole create, and it is not enough
            // that other entries look fine: the file is written only by this
            // client, so an entry that does not reproduce under the ids in force
            // is evidence about the FILE, and quietly using its neighbours would
            // be trusting the same source that just failed.
            return yield* new BucketCreatePinError({
              reason: "anchor_id_mismatch",
              message:
                `Refusing to create a bucket: a recorded anchor for this space does not ` +
                `reproduce from its stored bucket id and creator (recorded group ` +
                `${storedAnchor.groupId}, bucket ${storedAnchor.bucketId}; ${check.detail}). The ` +
                `bucket-policy ids it was derived under are the ones in force here, so this is ` +
                `not a stale cache. Remove THAT ONE ENTRY — the one recording group ` +
                `${storedAnchor.groupId} — from ~/.config/walrus-console-mcp/anchors.json, or ` +
                `restore a file this client wrote. Deleting the whole file also clears it, but ` +
                `that file now holds every space's accumulated anchors and each one it discards ` +
                `costs that space a create on the bootstrap path. Nothing was reserved.`,
            });
          }
          if (check.status === "stale") staleDetails.push(check.detail);
          else {
            reproducedAnchors.push(check.groupId);
            // The stored `creator` is safe to forward: `checkStoredAnchor` just
            // re-derived this group id FROM it, which fails the create outright
            // if it is not an encodable address.
            reproducedCreators.push(storedAnchor.creator);
          }
        }
        if (staleDetails.length > 0) {
          // NOT a refusal, and the difference is the whole point of recording
          // the derivation inputs: the config moved under these anchors, which is
          // a scheduled event (see `checkStoredAnchor`), not evidence of
          // anything. Skipping them costs this create only what they would have
          // added — it under-permissions, never over-permissions — and the bucket
          // it creates re-anchors the space under the ids in force now, so the
          // next create verifies again with no operator action at all. Said on
          // stderr AND counted into the tool result (`anchorsStale`), because the
          // disclosure has to name every reason a key went ungranted and stderr
          // is not what an agent shows a human.
          //
          // EVERY distinct reason, not just the first: a count of N beside one
          // reason hides the rest, and a file can carry both kinds of stale entry
          // at once — one written before the derivation inputs were recorded, and
          // one recorded under a registry that has since moved. De-duplicated
          // because a single config change stamps every anchor it invalidates
          // with the identical sentence, and thirty-two copies of it would bury
          // the rest of the line; the count already says how many there were.
          console.error(
            `[console-mcp] ${staleDetails.length} of the ${storedAnchors.length} recorded anchor ` +
              `group(s) for space ${spaceId} are STALE — ${[...new Set(staleDetails)].join("; ")}. ` +
              (reproducedAnchors.length > 0
                ? `Skipping them; the remaining ${reproducedAnchors.length} still back a verified ` +
                  `roster for this create.`
                : // Future tense on purpose. This is logged BEFORE the bucket is
                  // reserved, so the anchor write has not happened and may yet
                  // fail (`anchorRecorded: false`) — the same over-claim the
                  // disclosure arms were corrected for. The tool result is where
                  // the settled answer lives; this line must not pre-announce it.
                  `Falling back to the bootstrap path: this bucket will grant nobody beyond its ` +
                  `owner and this signing key, and should join the space's anchors under the ids ` +
                  `in force now — the create_bucket result reports whether it actually did. ` +
                  `Verification resumes once an anchor holds one of this space's other service ` +
                  `accounts.`),
          );
        }
        const roster = yield* authorVerifiedRoster(rosterDeps, {
          // The anchors are a local cache, so they are read here rather than inside
          // the verifier, which stays free of filesystem I/O. Each group id is the
          // locally derived value, re-checked against its stored (bucketId, creator)
          // pair above so a pre-derivation or tampered file cannot become the next
          // roster's chain source.
          anchorGroupIds: reproducedAnchors,
          anchorCreators: reproducedCreators,
          ownerAddress,
          signerAddress,
          ...(managerAddress === undefined ? {} : { managerAddress }),
          listCandidates: () => api.listSpaceSigners(),
        });

        // 2. Reserve. `members` is authored explicitly, never omitted: the server
        //    treats an absent `members` key as "fall back to my own derived
        //    roster", which this client's validator then refuses. An EMPTY authored
        //    roster is a real answer (see the disclosure), not an absent one.
        const reserve = yield* api.createBucket(spaceId, name, ownerAddress, roster.members);

        // 3. Echo diagnostics. Not the security boundary — see `checkReserveEcho`.
        const echoProblem = checkReserveEcho(reserve, ownerAddress, managerAddress);
        if (echoProblem !== undefined) return yield* echoProblem;

        // 4. Validate, then sign locally. The expectation is what stops these bytes
        //    being anything other than the bucket-group PTB we just asked for —
        //    without it the working key signs whatever the endpoint returns.
        //    `expectedMembers` is the roster object that was just SENT, passed
        //    through unmodified and never loosened to a subset: the validator
        //    enforces it as an exact multiset in both directions, so a reserve that
        //    adds a stranger and one that silently drops a verified member are both
        //    refused.
        const { signature, create } = yield* seal.signTransactionBytes(reserve.bytes, {
          kind: "createBucketIdentity",
          ownerAddress,
          expectedMembers: roster.members,
          ...(managerAddress === undefined ? {} : { managerAddress }),
        });

        // The validator always returns a summary for this arm; `create` is optional
        // only because the grant arm has none. Refuse rather than finalize a bucket
        // whose identities cannot be disclosed — the disclosure is the point of the
        // result, and this refusal still lands before the transaction is submitted.
        if (create === undefined) {
          return yield* new SealCryptoError({
            message:
              "Refusing to finalize: the transaction validator returned no summary of the " +
              "identities this bucket grants, so the roster and owner could not be reported back " +
              "for confirmation. Nothing was submitted on-chain.",
            step: "sign",
          });
        }

        // 5. DERIVE the new group's object id from LOCAL inputs — before anything
        //    is submitted, so a derivation this build cannot perform refuses
        //    instead of landing a bucket whose anchor we would have to guess at.
        //    See `deriveBucketGroupId` for why this is computed and never read.
        const derivedGroupId = yield* Effect.try({
          try: () => deriveBucketGroupId(packageConfig, create.bucketIdArg, signerAddress),
          catch: (cause) =>
            new BucketCreatePinError({
              reason: "group_id_underivable",
              message:
                `Refusing to finalize: the object id of the bucket group this transaction ` +
                `creates could not be derived locally ` +
                `(${cause instanceof Error ? cause.message : String(cause)}), and this client ` +
                `will not fall back to the id the server reports — that id decides who may be ` +
                `granted access to every later bucket in this space. Nothing was submitted ` +
                `on-chain.`,
            }),
        });

        // The bucket id whose bytes were just validated must be the reserve's id.
        // Without this, a reserve for bucket A plus a PTB that creates the group
        // for bucket B would derive an honest-looking anchor bound to B while
        // `result.bucketId` reported A. Raised before finalize: nothing submitted.
        const reservedId: unknown = reserve.bucket_id;
        if (
          typeof reservedId !== "string" ||
          reservedId.length === 0 ||
          !sameBytes(create.bucketIdArg, bcs.string().serialize(reservedId).toBytes())
        ) {
          return yield* new BucketCreatePinError({
            reason: "bucket_id_arg_mismatch",
            message:
              `Refusing to finalize: the bucket id in the transaction this client validated ` +
              `does not match the id the reserve returned (${describeEcho(reservedId)}). ` +
              `Nothing was submitted on-chain.`,
          });
        }

        // 6. Finalize — this is the call that submits the transaction.
        const finalized = yield* api.finalizeBucket(BucketId.make(reservedId), signature);

        // The reserved id is what the validated PTB bound the group to. Finalize
        // reporting a different one would make `result.bucketId` a server-chosen
        // value — the same class of hole `sealPolicyId` used to be. The bucket
        // exists; name both ids so it is findable via `list_buckets`.
        const reportedBucketId: unknown = finalized.bucket_id;
        if (typeof reportedBucketId !== "string" || reportedBucketId !== reservedId) {
          return yield* new BucketCreatePinError({
            reason: "bucket_id_mismatch",
            message:
              `The bucket was created, but this client will not trust the id Console reported: ` +
              `the reserved id is ${reservedId}, and Console reports ` +
              `${describeEcho(reportedBucketId)}. Find the bucket via list_buckets if you need ` +
              `it; nothing was cached as an anchor.`,
          });
        }

        // 7. CROSS-CHECK the id the server reports against the one we derived.
        //
        //    THE DERIVED VALUE IS AUTHORITATIVE. `finalized.seal_policy_id` is
        //    DIAGNOSTIC ONLY, exactly like the reserve echoes above, and it must
        //    stay that way: these two ids sit side by side here, which is precisely
        //    the shape that invites a later "fix" to prefer the server's value when
        //    they disagree — and that single edit silently restores the whole hole
        //    this derivation exists to close. Console's finalize does not constrain
        //    this field to its own reserve-derived value either; on a disagreement
        //    it logs and then persists what the chain event asserted.
        //
        //    A disagreement is NOT necessarily an attack, and the message must not
        //    say it is. Sui changing the `derived_object::claim` scheme, or a
        //    package/registry id going stale in this build, makes our derivation
        //    diverge with no adversary anywhere — and that is the API team's to fix,
        //    while a substituted id is ours. Both are named.
        //
        //    `typeof` rather than the declared type, for the reason `checkReserveEcho`
        //    spells out: the response is an unchecked cast, so an unreadable value
        //    is treated as a contradicting one rather than thrown on.
        const reportedGroupId: unknown = finalized.seal_policy_id;
        if (reportedGroupId !== null && reportedGroupId !== undefined) {
          if (
            typeof reportedGroupId !== "string" ||
            normalizeSuiAddress(reportedGroupId) !== derivedGroupId
          ) {
            return yield* new BucketCreatePinError({
              reason: "group_id_mismatch",
              message:
                `The bucket was created, but this client will not record it as this space's ` +
                `trust anchor: the bucket group id derived locally from the transaction it ` +
                `validated is ${derivedGroupId}, and Console reports ` +
                `${describeEcho(reportedGroupId)}. Two things produce that, and they need ` +
                `different fixes. Either the derivation in this build no longer matches the ` +
                `chain — a Sui protocol change to derived-object addressing, or stale ` +
                `bucket-policy package/registry ids here — which is a build/API problem to ` +
                `report; or the endpoint is naming a group of its own choosing, which would let ` +
                `it seed the roster of every later bucket in this space. The on-chain bucket is ` +
                `${reservedId}. Nothing was cached, so the next create_bucket here starts from ` +
                `the bootstrap path.`,
            });
          }
        }

        // 8. RECORD THE ANCHOR — the DERIVED id, never the reported one. This is
        //    what makes the scheme inductive: the group just created has a
        //    membership this client validated command-by-command, so the NEXT
        //    create in this space can verify its roster against it instead of
        //    bootstrapping empty again.
        //
        //    A failed write must NOT fail the call: the bucket exists on-chain by
        //    now, and the anchor is pure cache whose loss only sends the next create
        //    down the bootstrap path — exactly what `anchorStore` is built to
        //    tolerate. Reported honestly rather than swallowed.
        const anchorRecorded = yield* Effect.try({
          try: () => {
            recordAnchor(spaceId, {
              groupId: derivedGroupId,
              bucketId: reservedId,
              creator: signerAddress,
              // The other two derivation inputs, recorded beside the id they
              // produced. Without them a later config change is indistinguishable
              // from a tampered file, and the benign case gets the tamper
              // treatment — see `checkStoredAnchor`.
              bucketRegistryId: packageConfig.bucketRegistryId,
              originalPackageId: packageConfig.originalPackageId,
              recordedAt: new Date().toISOString(),
            });
            return true;
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.sync(() => {
              console.error(
                `[console-mcp] Bucket ${reservedId} was created, but its anchor ` +
                  `group could not be cached (${cause instanceof Error ? cause.message : String(cause)}). ` +
                  `The next create_bucket in this space will fall back to the bootstrap path.`,
              );
              return false;
            }),
          ),
        );

        return {
          bucketId: reservedId,
          // The LOCALLY DERIVED group id, cross-checked against what the server
          // reported above. The bucket group and the Seal policy object are the
          // same object — `seal_approve(id, registry, group)` takes this as its
          // group argument — so reporting the derived value is both correct and
          // one less field the server gets to choose. It is always a string,
          // unlike the reported field, which is nullable.
          sealPolicyId: derivedGroupId,
          provisioningState: finalized.provisioning_state,
          // What the signed transaction was found to DO, straight from the
          // validator: who owns the bucket, the exact roster it grants, the scope
          // this signing key keeps, and who (if anyone) got group management.
          // `roster` below is what this client ASKED for. They agree by
          // construction — the validator refuses to sign a PTB whose roster is not
          // exactly `expectedMembers` — so reporting both is disclosure, not
          // corroboration: it shows the roster in the terms of each side rather
          // than proving anything a reader could not already assume.
          //
          // Rebuilt field by field rather than returned whole: the summary also
          // carries `bucketIdArg`, the raw derivation input, and `safeTool`
          // JSON.stringifies this result — so a 36-byte Uint8Array would render as
          // 36 numeric-keyed lines in every create_bucket response. It has already
          // done its work (the group id was derived from it above), so it stays on
          // the validator's summary and out of the result.
          identity: {
            owner: create.owner,
            members: create.members,
            signerRole: create.signerRole,
            ...(create.manager === undefined ? {} : { manager: create.manager }),
          },
          roster: {
            members: roster.members,
            reason: roster.reason,
            droppedCandidates: roster.droppedCandidates,
            // The anchors that actually backed this roster, and — only when the
            // cap bit — how many older ones went unread. Both are disclosure: a
            // caller can say how much independent evidence the roster rests on,
            // and whether any was left on the table.
            anchorGroupIds: roster.anchorGroupIds,
            ...(roster.anchorsNotConsulted === undefined
              ? {}
              : { anchorsNotConsulted: roster.anchorsNotConsulted }),
            // The anchors this create never handed the verifier at all, because
            // the bucket-policy ids moved under them. A SEPARATE count from
            // `anchorsNotConsulted` on purpose: same visible effect (a key whose
            // only membership was there went ungranted), different cause and
            // different remedy — see the two clauses in
            // `describeCreateBucketRoster`. Present only when it actually
            // happened, like its neighbour.
            ...(staleDetails.length === 0 ? {} : { anchorsStale: staleDetails.length }),
          },
          anchorRecorded,
          disclosure: describeCreateBucketRoster(roster, staleDetails.length, anchorRecorded),
        };
      });

      /**
       * Upload a local file: read, encrypt with Seal, upload with retry + polling.
       * Caller provides sealPolicyId (returned from createBucket).
       */
      const uploadFileToBucket = Effect.fn("ConsoleStorageService.uploadFileToBucket")(function* (
        bucketId: BucketId,
        sealPolicyId: string,
        localPath: string,
        targetName?: string,
        userMetadata?: FileUserMetadata,
      ) {
        // readFileWithinRoot, not fs.readFile: it opens with O_NOFOLLOW so a
        // symlink planted between the path's validation and this read cannot
        // redirect it, and it takes the size from the OPEN descriptor to reject an
        // oversized file BEFORE the bytes are buffered. That ordering is the whole
        // point — this process then holds the plaintext and the Seal ciphertext at
        // once, so learning the size after the read is too late to protect it.
        // Returns a Buffer, which IS a Uint8Array, so it goes straight to
        // seal.encrypt with no second copy.
        // `Effect.tryPromise` hands the callback the running fiber's AbortSignal,
        // so a cancelled MCP request stops the read rather than buffering a file
        // nobody is waiting for. The O_NOFOLLOW open + fstat-from-descriptor size
        // check are the async read's, unchanged from the sync one.
        const fileBytes = yield* Effect.tryPromise({
          try: (signal) =>
            readFileWithinRootAsync(localPath, {
              maxBytes: maxTransferBytes(),
              label: "Source",
              signal,
            }),
          catch: (cause) =>
            new LocalFsError({
              message: cause instanceof Error ? cause.message : "Failed to read local file",
              path: localPath,
              operation: "read",
            }),
        });

        const fileName = targetName ?? path.basename(localPath);

        // Undefined when the caller supplied neither field, so the multipart form
        // omits `metadata` rather than sending `{}` (COMG-662).
        const metadata = buildUploadMetadata(userMetadata ?? {});

        // Encrypt
        const encrypted = yield* seal.encrypt(fileBytes, sealPolicyId);

        // Upload with simple retry loop on mirror_missing_grant (pragmatic & type-safe).
        // uploadBucketFile now surfaces deny-list (415) and size-cap (413) as
        // dedicated tagged errors — those fall straight through the
        // `mirror_missing_grant` gate and abort the loop instead of retrying a
        // rejection that will never change.
        let uploadResult: FileUploadResponse | undefined;
        let lastErr: ConsoleApiError | UnsupportedFileTypeError | PayloadTooLargeError | undefined;
        for (let attempt = 0; attempt < 12; attempt++) {
          const res = yield* api
            .uploadBucketFile(bucketId, encrypted, fileName, metadata, fileBytes.length)
            .pipe(Effect.either);

          if (res._tag === "Right") {
            uploadResult = res.right;
            break;
          }

          lastErr = res.left;
          if (lastErr instanceof ConsoleApiError && lastErr.code === "mirror_missing_grant") {
            yield* Effect.sleep("3 seconds");
            continue;
          }
          return yield* Effect.fail(lastErr);
        }

        if (!uploadResult) {
          return yield* Effect.fail(new MirrorGrantMissingError({ bucketId, attempt: 12 }));
        }

        const fileId = uploadResult.data.id;

        // The upload is ACCEPTED at this point: the bytes are stored and the server
        // has an id for them. Everything after this is observation. Emit the id
        // immediately so a crash, a disconnect, or a killed session still leaves it
        // somewhere recoverable — otherwise the only way back is to upload again,
        // which re-encrypts and duplicates a file that already exists.
        console.error(`[console-mcp] upload accepted — fileId=${fileId} (bucket ${bucketId})`);

        // Wait for the async worker. Only a server-reported `failed` is an
        // error here: running out of polling budget means the upload landed and
        // is still being processed, and reporting that as a failure made agents
        // re-upload a file that already existed (COMG-662 verification).
        const outcome = yield* pollUntilTerminal(() =>
          api.getFileUploadStatus(bucketId, fileId),
        ).pipe(
          // Anything that goes wrong from here on is a status-check problem, not an
          // upload problem, and the caller needs the id to act on it rather than
          // re-uploading. Re-tagged rather than swallowed: the original message is
          // kept as a prefix.
          Effect.mapError((error) =>
            error instanceof ConsoleApiError
              ? new ConsoleApiError({
                  message:
                    `${error.message} — the upload itself was accepted as fileId=${fileId}; ` +
                    `check it with get_file_status instead of uploading again.`,
                  ...(error.code !== undefined ? { code: error.code } : {}),
                  ...(error.status !== undefined ? { status: error.status } : {}),
                  ...(error.endpoint !== undefined ? { endpoint: error.endpoint } : {}),
                })
              : error,
          ),
        );

        if (outcome.kind === "failed") {
          return yield* Effect.fail(
            new FileStatusError({
              fileId,
              state: outcome.status.data.state,
              error: outcome.status.data.error ?? { code: "unknown", message: "Upload failed" },
            }),
          );
        }

        return describeUploadResult(outcome, fileId, fileName);
      }, transferLock.withPermits(1));

      /**
       * Download + decrypt to a local path.
       */
      const downloadFile = Effect.fn("ConsoleStorageService.downloadFile")(function* (
        bucketId: BucketId,
        fileId: FileId,
        sealPolicyId: string,
        destPath: string,
      ) {
        const ciphertext = yield* api.downloadBucketFile(bucketId, fileId);

        const plaintext = yield* seal.decrypt(ciphertext, sealPolicyId);

        // Atomic replacement rather than a direct write, for two reasons that
        // happen to share one fix. A direct write can truncate an existing file and
        // then fail — on a full disk, on termination, against a competing download
        // — destroying data that was fine. And it writes THROUGH a symlink, so one
        // planted at the destination after the path was validated would land the
        // decrypted plaintext outside the sandbox. Writing a sibling temp with
        // O_EXCL (unhijackable) and renaming over the target replaces the symlink
        // itself instead of following it.
        //
        // 0o600: this is plaintext that was private enough to be Seal-encrypted at
        // rest; it should not land world-readable under a loose umask.
        //
        // Async + signal-aware: the fiber's AbortSignal reaches the writer, which
        // checks it right before the rename, so a cancelled download never
        // publishes a half-written plaintext over a good file at the destination.
        yield* Effect.tryPromise({
          try: (signal) => writeFileAtomicAsync(destPath, plaintext, { mode: 0o600, signal }),
          catch: (cause) =>
            new LocalFsError({
              message: cause instanceof Error ? cause.message : "Failed to write downloaded file",
              path: destPath,
              operation: "write",
            }),
        }).pipe(
          // Interruption abandons the write's promise before its own signal check
          // can drop the temp, so remove the sibling temp here too — deterministic
          // cleanup that leaves neither a temp nor a partial destination behind.
          Effect.onInterrupt(() => Effect.promise(() => removeAtomicTemp(destPath))),
        );

        return { bytesWritten: plaintext.length, destPath };
      }, transferLock.withPermits(1));

      return {
        createBucket,
        uploadFileToBucket,
        downloadFile,
      } as const;
    }),

    dependencies: [
      ConsoleApiClient.Default,
      SealCryptoService.Default,
      ConsoleConfigLive,
      Layer.provide(RosterChainDepsLive, ConsoleConfigLive),
    ],
  },
) {}
