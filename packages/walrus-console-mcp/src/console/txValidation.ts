import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { BucketGroupPackageConfig } from "./packageConfig";

/**
 * Validate a sponsored transaction before signing it.
 *
 * Console returns transaction bytes and we sign them. Without this, that makes
 * the working key and the Key-Admin key arbitrary signing ORACLES: any endpoint
 * that passes the base-URL allowlist — a staging host, or simply whatever is
 * listening on localhost when CONSOLE_API_BASE_URL points there for development —
 * can return a PTB that transfers the signer's coins or uses its capabilities,
 * and receive a valid signature for it.
 *
 * Reconstructing these transactions locally is not possible: they are sponsored
 * (Console supplies gas), and the create-bucket PTB's command count depends on
 * server-side space membership. So they are DECODED and checked against what each
 * flow is allowed to contain.
 *
 * The allowlists below were derived from real transactions captured from live
 * testnet Console, not from the shape of the API — see
 * scripts/capture-tx-fixtures.mts, and the fixtures the tests replay. That
 * distinction mattered: the create-bucket PTB calls THREE packages, one of which
 * (`permissioned_group`) is not the bucket-policy package, and it ends with
 * `0x2::transfer::public_share_object`. None of that was guessable.
 *
 * THE ARM IS CHOSEN BY CLIENT-SIDE INTENT, NEVER BY THE RESPONSE. `expectation`
 * says which flow the caller asked for; the bytes only ever supply material to
 * CHECK, never a hint about which check to apply. That is why there is exactly one
 * create-bucket arm here and the pre-`add_owner` one was DELETED rather than left
 * behind for "old" responses: dispatching on response shape would hand a hostile
 * endpoint a downgrade switch back to the weaker arm, and unreachable code that
 * still accepts a forgeable shape is one refactor away from reachable.
 */

/**
 * One membership the create-bucket PTB grants — both as the caller's verified
 * expectation and as what the PTB was found to contain.
 *
 * `editor` and `viewer` are the only roles this flow deals in. Ownership is not a
 * role here: it is granted by a separate `add_owner` call and pinned separately.
 */
export interface RosterMember {
  /** The 32-byte address the membership call names as recipient. */
  readonly address: string;
  /**
   * `editor` when the PTB makes BOTH `add_editor` and `add_viewer` calls for the
   * address (the builder convention), `viewer` when it makes `add_viewer` alone.
   */
  readonly role: "viewer" | "editor";
}

/** What a validated create-bucket-identity PTB was found to do, for disclosure. */
export interface CreateBucketIdentitySummary {
  /** The `add_owner` recipient, equal to the caller's pinned owner. */
  readonly owner: string;
  /** The roster it grants, equal (as a multiset) to the caller's expectation. */
  readonly members: readonly RosterMember[];
  /** The key scope the signing key keeps after demoting itself. */
  readonly signerRole: "viewer" | "editor";
  /** The `grant_permission` recipient, absent when the PTB makes no grant. */
  readonly manager?: string;
  /**
   * The BCS bytes of `create_bucket_group`'s `bucket_id` argument, verbatim from
   * the transaction that was just validated.
   *
   * Surfaced because it is one half of the derivation key for the group this PTB
   * creates: `derived_object::claim(&mut registry.id, BucketDerivationKey {
   * bucket_id, creator })`. With the registry and the package root coming from
   * local configuration and `creator` being the sender this file already pinned,
   * a caller can compute the new group's object id WITHOUT asking the server for
   * it — see `deriveBucketGroupId` in `ConsoleStorageService`.
   *
   * Handed over as raw bytes rather than a decoded string on purpose: the bytes
   * in the transaction are the bytes that will execute, so deriving from them is
   * self-consistent, while a decode-and-re-encode could differ from them (a
   * non-minimal length prefix, say) and derive an address the chain never claims.
   */
  readonly bucketIdArg: Uint8Array;
}

/**
 * What the caller asked Console for. Deliberately does NOT carry the sender: the
 * address that must appear in the transaction is the one about to sign it, read
 * from the keypair at the call site rather than described here, so it cannot be
 * made to agree with a forged transaction.
 */
export type SponsoredTxExpectation =
  | {
      readonly kind: "createBucketIdentity";
      /**
       * The human web account the bucket is being created FOR, from local
       * configuration (`CONSOLE_WEB_ACCOUNT_ADDRESS`). Required: it is the only
       * thing covering `add_owner`, which — unlike `grant_permission` — carries no
       * type argument to bound what a substituted recipient could do with it.
       */
      readonly ownerAddress: string;
      /**
       * The Key-Admin address pinned in configuration
       * (`CONSOLE_KEY_ADMIN_ADDRESS`), when one is set. Takes precedence over the
       * locally-derived admin-keypair address; see `resolveManager`.
       */
      readonly managerAddress?: string;
      /**
       * The roster the caller verified against chain state before asking for this
       * transaction. Enforced as an EXACT multiset, in both directions — an extra
       * member, a missing member and a changed role are each a refusal.
       *
       * EXCLUDES the signing key and the owner. Those are separate rows of the PTB
       * with their own pins (`signerRole` in the summary, `ownerAddress` above);
       * listing either here would leave its membership calls consumed by the
       * dedicated check and then reported as a missing roster entry.
       */
      readonly expectedMembers: readonly RosterMember[];
    }
  | {
      readonly kind: "grantBucketAccess";
      /** The child address we generated and asked Console to grant access to. */
      readonly recipientAddress: string;
      /** The bucket groups we asked for; the PTB may not touch any other. */
      readonly groupIds: readonly string[];
      readonly scope: "read" | "readwrite";
    };

/** `0x2`, the Sui framework. */
const SUI_FRAMEWORK = normalizeSuiAddress("0x2");

export class UnexpectedTransactionError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to sign: the transaction returned by Console is not the one this flow asked ` +
        `for (${reason}). This is what protects the signing key from an endpoint that returns ` +
        `unrelated transaction bytes.`,
    );
    this.name = "UnexpectedTransactionError";
  }
}

/** `package::module::function` triples each flow may contain, and nothing else. */
function allowedTargets(
  expectation: SponsoredTxExpectation,
  config: BucketGroupPackageConfig,
): Set<string> {
  const pkg = normalizeSuiAddress(config.packageId);
  const group = normalizeSuiAddress(config.permissionedGroupPackageId);

  if (expectation.kind === "createBucketIdentity") {
    return new Set([
      `${pkg}::bucket_policy::create_bucket_group`,
      `${pkg}::bucket_policy::add_owner`,
      // The membership calls repeat once per member of the space, so the COUNT is
      // not fixed — only the set of things that may appear.
      `${pkg}::bucket_policy::add_editor`,
      `${pkg}::bucket_policy::add_viewer`,
      // `add_admin` is deliberately ABSENT. The identity PTB grants ownership with
      // add_owner and hands nobody group-admin rights, so an add_admin call is a
      // shape this client has never verified and refuses on sight.
      `${group}::permissioned_group::grant_permission`,
      `${group}::permissioned_group::revoke_permission`,
      `${SUI_FRAMEWORK}::transfer::public_share_object`,
    ]);
  }

  // A grant is exactly the membership call for its scope. Pinning `read` to
  // add_viewer alone is the point of asking for `read`: accepting add_editor here
  // would let the server quietly upgrade a read grant into a write one.
  return new Set([
    expectation.scope === "readwrite"
      ? `${pkg}::bucket_policy::add_editor`
      : `${pkg}::bucket_policy::add_viewer`,
  ]);
}

/** Object ids each flow may reference, beyond nothing. */
function allowedObjects(
  expectation: SponsoredTxExpectation,
  config: BucketGroupPackageConfig,
): Set<string> {
  const registry = normalizeSuiAddress(config.bucketRegistryId);
  if (expectation.kind === "createBucketIdentity") return new Set([registry]);
  return new Set([registry, ...expectation.groupIds.map((id) => normalizeSuiAddress(id))]);
}

export function assertExpectedTransaction(
  bytesBase64: string,
  /** The address whose key is about to sign these bytes. */
  signerAddress: string,
  expectation: SponsoredTxExpectation,
  config: BucketGroupPackageConfig,
  /**
   * The locally-DERIVED Key-Admin (manager) address — the address this host's
   * admin keypair produces — or `undefined` when no admin key is configured.
   *
   * This is the FALLBACK beneath `expectation.managerAddress`, not a competitor to
   * it: a config pin wins, a derived address is used when there is no pin, and the
   * two disagreeing is a refusal. Only consulted for `createBucketIdentity`, where
   * the PTB's optional `grant_permission` hands management to this address.
   */
  managerAddress?: string,
): { create?: CreateBucketIdentitySummary } {
  let data: ReturnType<Transaction["getData"]>;
  try {
    data = Transaction.from(fromBase64(bytesBase64)).getData();
  } catch (cause) {
    throw new UnexpectedTransactionError(
      `the bytes do not decode as a transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const sender = normalizeSuiAddress(signerAddress);

  // 1. We must be the declared sender. Signing for anyone else means these bytes
  //    were not built for this credential.
  if (!data.sender || normalizeSuiAddress(data.sender) !== sender) {
    throw new UnexpectedTransactionError(
      `it is sent by ${data.sender ?? "nobody"}, not ${signerAddress}`,
    );
  }

  // 2. Both flows are sponsored — Console pays. A PTB drawing on our own gas coins
  //    is not the flow we asked for, and gas coins are spendable value.
  const gasOwner = data.gasData?.owner;
  if (!gasOwner || normalizeSuiAddress(gasOwner) === sender) {
    throw new UnexpectedTransactionError(
      `it is not sponsored — gas would be paid by ${gasOwner ?? "the sender"}`,
    );
  }

  // 3. Only move calls. This alone stops the headline attack: TransferObjects,
  //    SplitCoins, MergeCoins, Publish and Upgrade are how a forged PTB moves
  //    value or installs code, and none of them belongs in either flow.
  const targets = allowedTargets(expectation, config);
  for (const command of data.commands) {
    const kind = commandKind(command);
    if (kind !== "MoveCall") {
      throw new UnexpectedTransactionError(
        `it contains a ${kind} command; only move calls are permitted`,
      );
    }
    const call = (command as { MoveCall?: MoveCallLike }).MoveCall;
    if (!call) throw new UnexpectedTransactionError("a move call could not be read");

    // 4. Package AND function. Package-level allowlisting is not enough on its
    //    own — our own package has functions these flows have no business calling.
    const target = `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}`;
    if (!targets.has(target)) {
      throw new UnexpectedTransactionError(`it calls ${target}, which this flow does not use`);
    }
  }

  // 5. Every object it touches must be one we already know about: the shared
  //    registry, or (for a grant) one of the groups we asked for. Without this a
  //    correctly-shaped add_editor could be pointed at somebody else's group.
  const objects = allowedObjects(expectation, config);
  for (const input of data.inputs) {
    const objectId = sharedOrOwnedObjectId(input);
    if (objectId && !objects.has(normalizeSuiAddress(objectId))) {
      throw new UnexpectedTransactionError(
        `it references object ${objectId}, which is not the bucket registry or a requested group`,
      );
    }
  }

  // 6. Each flow's own structural checks. Steps 1-5 already pinned the sender,
  //    sponsorship, call targets and objects; this pins the WIRING and the
  //    IDENTITIES for whichever flow this is — who the grant's group/registry/
  //    recipient are pinned to, or (for create-bucket) who becomes owner, who
  //    is on the roster, who gets management, and that the signing key demotes
  //    itself on the way out.
  if (expectation.kind === "grantBucketAccess") {
    assertGrantBucketAccessStructure(data, config, expectation);
    return {};
  }
  return {
    create: assertCreateBucketIdentityStructure(data, config, sender, expectation, managerAddress),
  };
}

/** Function name of a `MoveCall` command, or `undefined` for anything else. */
function moveCallOf(command: unknown): MoveCallLike | undefined {
  return (command as { MoveCall?: MoveCallLike }).MoveCall;
}

/** The `Input` index an argument refers to, or `undefined` if it is not an input. */
function inputIndexOf(arg: unknown): number | undefined {
  const a = arg as { $kind?: string; Input?: number };
  return a?.$kind === "Input" && typeof a.Input === "number" ? a.Input : undefined;
}

/**
 * True when an argument is the result of the FIRST command — the group
 * `create_bucket_group` produces. `Result:0` is the whole result; a single-value
 * result destructured as `NestedResult:[0,0]` is the same value, so both are
 * accepted. `GasCoin`, any other command's result, or a different nested index is
 * not the group and is rejected by the caller.
 */
function isCreateBucketGroupResult(arg: unknown): boolean {
  const a = arg as { $kind?: string; Result?: number; NestedResult?: [number, number] };
  if (a?.$kind === "Result") return a.Result === 0;
  if (a?.$kind === "NestedResult") {
    return Array.isArray(a.NestedResult) && a.NestedResult[0] === 0 && a.NestedResult[1] === 0;
  }
  return false;
}

/**
 * Resolve the one Key-Admin address the `grant_permission` recipient is pinned to.
 *
 * Two sources exist and they are ranked, not merged: a config pin
 * (`CONSOLE_KEY_ADMIN_ADDRESS` / the config file's `keyAdminAddress`) is a trust
 * anchor a human wrote down and the server cannot touch, so it wins; the address
 * derived from this host's admin keypair is the fallback for hosts that hold the
 * credential but never wrote the pin down.
 *
 * A DISAGREEMENT between the two is refused rather than resolved. One of them is
 * stale, we cannot tell which, and "prefer the pin" would silently paper over a
 * host whose admin credential has been swapped — precisely the situation the pin
 * exists to make visible.
 */
function resolveManager(
  pinned: string | undefined,
  derived: string | undefined,
): string | undefined {
  const pin = pinned === undefined ? undefined : normalizeSuiAddress(pinned);
  const local = derived === undefined ? undefined : normalizeSuiAddress(derived);
  if (pin !== undefined && local !== undefined && pin !== local) {
    // Phrased so it does not assert anything about the transaction: this refusal
    // fires before the command walk, so the PTB may well contain no management
    // grant at all. The defect is purely local, and the message has to say so —
    // it is the only thing standing between the operator and a hunt through
    // Console for a problem that lives in their own configuration.
    throw new UnexpectedTransactionError(
      `this flow cannot resolve a Key-Admin address to check a management grant against: the ` +
        `Key-Admin address pinned in configuration (${pin}) is not the address this host's admin ` +
        `key derives (${local}). One of the two is stale — correct CONSOLE_KEY_ADMIN_ADDRESS (or ` +
        `\`keyAdminAddress\` in the config file), re-provision the admin credential bundle, or ` +
        `re-run \`walrus-console-mcp config\``,
    );
  }
  return pin ?? local;
}

/**
 * Validate the exact per-call wiring of a grant-bucket-access PTB, and that every
 * requested group is covered exactly once.
 *
 * The PTB the API builds is N calls to the SAME function — `add_editor` for a
 * readwrite grant, `add_viewer` for a read grant, already pinned by
 * `allowedTargets`/step 4 above — one per group: `add_editor(group, registry,
 * recipient)`. This walks those calls and pins all THREE arguments TOGETHER, per
 * call, the same shape `membershipRecipient` below uses for create-bucket's
 * membership calls, rather than checking "is the object allowed", "is argument 1
 * the registry" and "is the recipient present anywhere in the PTB" as three
 * separate, looser passes over the whole transaction (which is what the code this
 * replaces did, and how it missed a duplicate call and an uncredited recipient).
 *
 * WHY PER-CALL, NOT PER-CHECK:
 * - Checking the group and the registry SEPARATELY lets a call whose argument 0 is
 *   a real, requested group be paired with an argument 1 that is anything else the
 *   step-5 allowlist happens to accept — such as another requested group's object,
 *   standing in for the registry. Argument 0 is checked FIRST against
 *   `expectation.groupIds` specifically, not merely against "is this object
 *   allowed at all": the registry itself is also in the step-5 allowlist (every
 *   grant references it), so "is it allowed" alone would let the registry sit
 *   undetected in the group slot.
 * - Checking the recipient only via the whole-PTB sweep (below) lets a call be
 *   credited toward a group's coverage without that SAME call naming the
 *   recipient anywhere — the sweep only proves the recipient's address appears
 *   somewhere in the transaction, not that it appears in THIS call's third
 *   argument. `grantedGroup` requires argument 2 to decode as an address and
 *   equal the recipient before the call counts toward anything.
 *
 * GROUP IDENTITY IS BY OBJECT ID, NOT PTB `Result` POSITION. This is the one place
 * the create-bucket pattern below does NOT transfer: `membershipRecipient` checks
 * `isCreateBucketGroupResult(args[0])` because create-bucket's OWN PTB PRODUCES
 * the group as `Result:0` of its first command — there is a PTB-local position to
 * check the argument against. A grant never creates its group: the group is
 * always a pre-existing object the caller already verified against chain state
 * and passed in as an `Input`. There is no position to pin it to; the only thing
 * to check the id against is `expectation.groupIds`. Do not "fix" this to call
 * `isCreateBucketGroupResult` — it would reject every legitimate grant.
 *
 * EXACTLY-ONCE COVERAGE uses a `Map<groupId, count>`, not a `Set`: a `Set` cannot
 * tell one correctly-wired call for a group from two, so a duplicate `add_editor`
 * for the same group — a shape this client has never verified — would pass
 * silently. `count === 0` reproduces the pre-extraction refusal message verbatim
 * (existing tests assert against its exact wording); `count > 1` is new, and
 * closes the duplicate-call hole a `Set` could not see.
 *
 * THE CLOSING PURE-ADDRESS SWEEP runs LAST, over every input, not only the ones
 * the per-call pins read. The per-call pin above checks exactly one argument
 * position (argument 2) on calls this flow's own target allowlist already
 * narrowed to `add_editor`/`add_viewer`. The sweep is what catches an address
 * parked anywhere else — an argument position no check reads, or an input no
 * command references at all. Dropping it in favor of the per-call pin is NOT
 * equivalent, and would be a real regression, not a simplification.
 */
function assertGrantBucketAccessStructure(
  data: ReturnType<Transaction["getData"]>,
  config: BucketGroupPackageConfig,
  expectation: Extract<SponsoredTxExpectation, { kind: "grantBucketAccess" }>,
): void {
  const { commands, inputs } = data;
  const registryId = normalizeSuiAddress(config.bucketRegistryId);
  const recipient = normalizeSuiAddress(expectation.recipientAddress);
  const requestedGroupIds = new Set(expectation.groupIds.map((id) => normalizeSuiAddress(id)));

  /**
   * The group id of a `(group, registry, address)` membership call, after pinning
   * all three arguments together. Throws immediately — rather than silently
   * declining to credit the call — on the first pin that fails, so a malformed
   * call is reported for what it is instead of surfacing later as a missing
   * group.
   */
  const grantedGroup = (fn: string, args: readonly unknown[]): string => {
    // Pin 1: argument 0 must be a group we actually asked for.
    const groupIndex = inputIndexOf(args[0]);
    const groupId =
      groupIndex === undefined ? undefined : sharedOrOwnedObjectId(inputs[groupIndex]);
    if (!groupId || !requestedGroupIds.has(normalizeSuiAddress(groupId))) {
      throw new UnexpectedTransactionError(
        `${fn}'s first argument is not one of the groups this flow asked for`,
      );
    }
    // Pin 2: argument 1 must really be the shared bucket registry.
    const registryIndex = inputIndexOf(args[1]);
    const registryArgId =
      registryIndex === undefined ? undefined : sharedOrOwnedObjectId(inputs[registryIndex]);
    if (!registryArgId || normalizeSuiAddress(registryArgId) !== registryId) {
      throw new UnexpectedTransactionError(
        `${fn} uses a different registry than the bucket registry`,
      );
    }
    // Pin 3: argument 2 must decode as an address and be the recipient we
    // generated — not merely present somewhere else in the PTB.
    const recipientIndex = inputIndexOf(args[2]);
    const argRecipient =
      recipientIndex === undefined ? undefined : pureAddress(inputs[recipientIndex]);
    if (!argRecipient || argRecipient !== recipient) {
      throw new UnexpectedTransactionError(
        `${fn}'s recipient is not the requested recipient ${expectation.recipientAddress}`,
      );
    }
    return normalizeSuiAddress(groupId);
  };

  const coverage = new Map<string, number>();
  for (const command of commands) {
    const call = moveCallOf(command);
    const fn = call?.function ?? "the call";
    const groupId = grantedGroup(fn, call?.arguments ?? []);
    coverage.set(groupId, (coverage.get(groupId) ?? 0) + 1);
  }

  // Every group the caller asked for must be covered EXACTLY once. Zero
  // reproduces the pre-extraction "silently dropped" refusal verbatim, so the
  // existing F1 tests keep passing unchanged; more than one is new, closing the
  // duplicate-call hole a Set-based accumulator could not see.
  for (const groupId of expectation.groupIds) {
    const normalized = normalizeSuiAddress(groupId);
    const count = coverage.get(normalized) ?? 0;
    if (count === 0) {
      throw new UnexpectedTransactionError(
        `it does not grant access to group ${groupId}, one of the groups this flow asked for`,
      );
    }
    if (count > 1) {
      throw new UnexpectedTransactionError(
        `it grants access to group ${groupId} more than once (${count} calls), which this flow ` +
          `does not expect`,
      );
    }
  }

  // Closing sweep: every address the PTB carries must be the recipient we
  // generated. This is what stops access being handed to a third party while the
  // response still looks like the grant we asked for — and, unlike the per-call
  // pin above, it is not limited to argument 2 of an already-narrowed call: it
  // walks every input, so an address parked anywhere else is still caught.
  for (const input of inputs) {
    const address = pureAddress(input);
    if (address && address !== recipient) {
      throw new UnexpectedTransactionError(
        `it grants access to ${address}, not the requested recipient ${expectation.recipientAddress}`,
      );
    }
  }
}

/**
 * Validate the exact command graph of a create-bucket-identity reserve, and return
 * a summary of the identities it grants.
 *
 * The PTB the API builds is, in order:
 *   1. `create_bucket_group(registry, bucket_id)` → `Result:0`, the group
 *   2. `add_owner(group, registry, A)` — the human web account
 *   3. `add_viewer` / `add_editor(group, registry, other)` × N — the roster
 *   4. `add_viewer(group, registry, B)` [+ `add_editor`] — the signing key's scope
 *   5. `grant_permission<Witness, ExtensionPermissionsAdmin>(group, manager)` —
 *      OPTIONAL, and absent whenever the space holds no key_admin key
 *   6-8. `revoke_permission<Witness, {BucketAdmin, ExtensionPermissionsAdmin,
 *        PermissionsAdmin}>(group, B)` — the signing key demoting itself
 *   9. `public_share_object<PermissionedGroup<Witness>>(group)`
 *
 * Rows 3 and 4 call the SAME functions and are told apart only by recipient, which
 * is why the split below is by address rather than by position.
 *
 * What this pins, and why:
 *
 * - THE OWNER RECIPIENT is the most security-critical check in this file. Unlike
 *   `grant_permission`, `add_owner` takes NO type argument, so nothing else bounds
 *   what a substituted recipient receives. A forged `add_owner(attacker)` plus the
 *   demotion executing exactly as designed leaves the ATTACKER as the group's sole
 *   owner while the PTB disarms the only key that could undo it — strictly worse
 *   than an unverifiable roster, which is why this arm exists at all.
 * - THE ROSTER is exact equality against the expectation the caller authored,
 *   checked in both directions: an unconfirmed extra address, a missing member and
 *   a viewer quietly promoted to editor are each refusals. What this file
 *   establishes is the EQUALITY; that the expectation was authored from chain
 *   state rather than copied out of the response is `rosterVerification.ts`'s
 *   half, and neither half is worth anything without the other.
 * - THE DEMOTION is the one assertion here that rejects an OMISSION rather than a
 *   commission. Every other pin refuses something the endpoint ADDED; this one
 *   refuses something it left out. The chain fails closed on a missing `add_owner`
 *   (revoking the signer's `PermissionsAdmin` aborts on sui-groups' last-admin
 *   guard) but NOT on a SUBSTITUTED one — the substituted PTB is perfectly valid
 *   on-chain. Only the owner pin covers substitution; only this covers omission.
 * - THREADING every call through `Result:0` and the same registry input stops a
 *   correctly-named call being pointed at somebody else's group.
 * - `grant_permission`'s TYPE ARGUMENTS shut the raw-grant route to the destruction
 *   path (`pause()` + `unpause_cap::burn()` → permanent `EGroupPaused`, all Seal
 *   content undecryptable) that needs no admin role at all; its RECIPIENT is pinned
 *   to the Key-Admin so management is not handed elsewhere.
 * - EXACTLY ONE create/share, correctly placed and typed, stops extra shares or
 *   grants being smuggled in; requiring every input to be USED, plus the closing
 *   sweep over every Pure address, stops an address riding along unnoticed.
 *
 * Move type identities are rooted at the ORIGINAL (v1) package id, so the type
 * pins survive a `bucket_policy` upgrade; call-target allowlisting stays on
 * `packageId` (in `allowedTargets`). Note the roots differ per family: the
 * `WalrusConsole` witness and `BucketAdmin` are `bucket_policy` types, while
 * `ExtensionPermissionsAdmin` and `PermissionsAdmin` belong to the
 * `permissioned_group` framework package.
 *
 * RESIDUALS, AS THEY STAND NOW. The roster residual the deleted arm disclosed — a
 * substituted membership recipient — is CLOSED: the caller supplies
 * `expectedMembers` and this walks the PTB against it as an exact multiset, so an
 * address this client did not author cannot reach the signed bytes. Read that
 * claim precisely, because the wording is the whole difference between a check and
 * a reassurance: what is proved HERE is equality with the list this function was
 * handed, and nothing whatever about where that list came from. Its provenance is
 * `rosterVerification.ts`'s half of the job — an intersection of an anchor group's
 * on-chain membership with the space's claimed signers — and an expectation copied
 * out of the response would be enforced here every bit as strictly.
 *
 * Note also which direction stays open. A roster that is too NARROW is enforced as
 * faithfully as a complete one: the bootstrap create (no anchor yet) authors `[]`,
 * and a key the anchor group has never seen is dropped before it gets here. Those
 * buckets are under-permissioned and nothing in this file can tell. That is where
 * both disclosed residuals live, and both cost a key its access rather than
 * granting access to anyone.
 *
 * The manager residual is closed wherever an address is available — the config pin
 * closes it even on hosts holding no admin credential, which is the case the
 * derived address could never cover. Where NEITHER is available and the PTB does
 * contain a `grant_permission`, this FAILS CLOSED rather than skipping the check (a
 * deliberate change from the deleted arm): the refusal names the three ways to
 * supply the address. A PTB with no `grant_permission` at all is always legal, so a
 * worker host on a space with no key_admin key is unaffected.
 */
function assertCreateBucketIdentityStructure(
  data: ReturnType<Transaction["getData"]>,
  config: BucketGroupPackageConfig,
  sender: string,
  expectation: Extract<SponsoredTxExpectation, { kind: "createBucketIdentity" }>,
  derivedManagerAddress: string | undefined,
): CreateBucketIdentitySummary {
  const { commands, inputs } = data;
  const registryId = normalizeSuiAddress(config.bucketRegistryId);

  // Type identities come from the v1-rooted id, normalized so a differently-cased
  // or short-form tag from the endpoint still compares equal.
  const originalPkg = normalizeSuiAddress(config.originalPackageId);
  const groupPkg = normalizeSuiAddress(config.permissionedGroupPackageId);
  const witnessType = normalizeStructTag(`${originalPkg}::bucket_policy::WalrusConsole`);
  const permissionedGroupType = normalizeStructTag(
    `${groupPkg}::permissioned_group::PermissionedGroup<${originalPkg}::bucket_policy::WalrusConsole>`,
  );
  const extAdminType = normalizeStructTag(
    `${groupPkg}::permissioned_group::ExtensionPermissionsAdmin`,
  );
  /**
   * The signing key's demotion, in the order the PTB performs it. All three, each
   * aimed at the signer, or the reserve is refused.
   */
  const demotion = [
    {
      label: "BucketAdmin",
      type: normalizeStructTag(`${originalPkg}::bucket_policy::BucketAdmin`),
    },
    { label: "ExtensionPermissionsAdmin", type: extAdminType },
    {
      label: "PermissionsAdmin",
      type: normalizeStructTag(`${groupPkg}::permissioned_group::PermissionsAdmin`),
    },
  ] as const;

  // The caller's pins, normalized once. `isValidSuiAddress` accepts mixed-case hex
  // and a 64-hex value with NO `0x`, and the config layer stores what it was given
  // verbatim, so a raw `===` against a decoded address would false-negative on a
  // perfectly legitimate pin and refuse every create.
  const expectedOwner = normalizeSuiAddress(expectation.ownerAddress);
  const expectedRoles = new Map<string, RosterMember["role"]>();
  for (const member of expectation.expectedMembers) {
    const address = normalizeSuiAddress(member.address);
    if (expectedRoles.has(address)) {
      throw new UnexpectedTransactionError(
        `the verified roster this flow was given names ${address} twice, so there is no single ` +
          `role to check the transaction against`,
      );
    }
    expectedRoles.set(address, member.role);
  }
  const effectiveManager = resolveManager(expectation.managerAddress, derivedManagerAddress);

  // Parse-faithfulness: every input must be used by some command. One the PTB
  // carries but never references has no legitimate purpose and would slip past
  // the per-command checks below.
  const referenced = new Set<number>();
  for (const command of commands) {
    for (const arg of moveCallOf(command)?.arguments ?? []) {
      const idx = inputIndexOf(arg);
      if (idx !== undefined) referenced.add(idx);
    }
  }
  for (let i = 0; i < inputs.length; i++) {
    if (!referenced.has(i)) {
      throw new UnexpectedTransactionError(`input ${i} is carried but never used by any command`);
    }
  }

  // Exactly one create_bucket_group, and it is the first command.
  const createCount = commands.filter(
    (c) => moveCallOf(c)?.function === "create_bucket_group",
  ).length;
  if (createCount !== 1) {
    throw new UnexpectedTransactionError(
      `it makes ${createCount} create_bucket_group calls; exactly one is expected`,
    );
  }
  const firstArgs = moveCallOf(commands[0])?.arguments;
  if (moveCallOf(commands[0])?.function !== "create_bucket_group" || !firstArgs) {
    throw new UnexpectedTransactionError("its first command is not create_bucket_group");
  }
  // Its registry argument fixes the input index every add_* must reuse.
  const registryIndex = inputIndexOf(firstArgs[0]);
  if (registryIndex === undefined) {
    throw new UnexpectedTransactionError("create_bucket_group's registry argument is not an input");
  }
  const registryObjId = sharedOrOwnedObjectId(inputs[registryIndex]);
  if (!registryObjId || normalizeSuiAddress(registryObjId) !== registryId) {
    throw new UnexpectedTransactionError(
      "create_bucket_group's first argument is not the bucket registry",
    );
  }
  // Its bucket-id argument is a Pure that is NOT a 32-byte address (it is the
  // length-prefixed UUID string), so an address cannot be smuggled into it. The
  // bytes are kept: they are half the key the new group's object id derives from.
  const bucketIdIndex = inputIndexOf(firstArgs[1]);
  const bucketIdArg = bucketIdIndex === undefined ? undefined : pureBytes(inputs[bucketIdIndex]);
  if (bucketIdArg === undefined || pureAddress(inputs[bucketIdIndex as number]) !== undefined) {
    throw new UnexpectedTransactionError(
      "create_bucket_group's bucket-id argument is missing, is not a pure value, or looks like " +
        "an address",
    );
  }

  // Exactly one public_share_object, last, sharing the group with the right type.
  const shareCount = commands.filter(
    (c) => moveCallOf(c)?.function === "public_share_object",
  ).length;
  if (shareCount !== 1) {
    throw new UnexpectedTransactionError(
      `it makes ${shareCount} public_share_object calls; exactly one is expected`,
    );
  }
  const lastCall = moveCallOf(commands[commands.length - 1]);
  if (lastCall?.function !== "public_share_object") {
    throw new UnexpectedTransactionError("its last command is not public_share_object");
  }
  if (
    lastCall.typeArguments?.length !== 1 ||
    normalizeStructTag(lastCall.typeArguments[0] as string) !== permissionedGroupType
  ) {
    throw new UnexpectedTransactionError(
      "public_share_object does not share a PermissionedGroup<WalrusConsole>",
    );
  }
  if (!isCreateBucketGroupResult(lastCall.arguments?.[0])) {
    throw new UnexpectedTransactionError(
      "public_share_object shares something other than the new group",
    );
  }

  // Walk the identity commands, pinning each one's wiring as it is collected.
  let ownerCalls = 0;
  let ownerRecipient: string | undefined;
  /** Per recipient, how many add_viewer / add_editor calls name it. */
  const membershipCalls = new Map<string, { viewer: number; editor: number }>();
  let grantCalls = 0;
  let grantedTo: string | undefined;
  const revokes: { type: string; recipient: string }[] = [];

  /** The recipient of a `(group, registry, address)` membership call. */
  const membershipRecipient = (fn: string, args: readonly unknown[]): string => {
    if (!isCreateBucketGroupResult(args[0])) {
      throw new UnexpectedTransactionError(`${fn} is not applied to the new bucket group`);
    }
    if (inputIndexOf(args[1]) !== registryIndex) {
      throw new UnexpectedTransactionError(
        `${fn} uses a different registry than create_bucket_group`,
      );
    }
    const index = inputIndexOf(args[2]);
    const recipient = index === undefined ? undefined : pureAddress(inputs[index]);
    if (!recipient) {
      throw new UnexpectedTransactionError(`${fn}'s recipient is not a 32-byte address`);
    }
    return recipient;
  };

  for (const command of commands) {
    const call = moveCallOf(command);
    const fn = call?.function;
    const args = call?.arguments ?? [];
    const typeArgs = call?.typeArguments ?? [];

    if (fn === "add_owner") {
      ownerCalls += 1;
      // Computed unconditionally, not short-circuited behind `??=`: a second
      // add_owner is refused below on the count, but its wiring is still checked
      // here rather than left to depend on the order the two checks happen to run.
      const recipient = membershipRecipient(fn, args);
      ownerRecipient ??= recipient;
    } else if (fn === "add_editor" || fn === "add_viewer") {
      const recipient = membershipRecipient(fn, args);
      const counts = membershipCalls.get(recipient) ?? { viewer: 0, editor: 0 };
      if (fn === "add_editor") counts.editor += 1;
      else counts.viewer += 1;
      membershipCalls.set(recipient, counts);
    } else if (fn === "grant_permission") {
      grantCalls += 1;
      if (!isCreateBucketGroupResult(args[0])) {
        throw new UnexpectedTransactionError(
          "grant_permission is not applied to the new bucket group",
        );
      }
      if (
        typeArgs.length !== 2 ||
        normalizeStructTag(typeArgs[0] as string) !== witnessType ||
        normalizeStructTag(typeArgs[1] as string) !== extAdminType
      ) {
        throw new UnexpectedTransactionError(
          "grant_permission's type arguments are not [WalrusConsole, ExtensionPermissionsAdmin] — " +
            "this is the pin that shuts the raw-grant route to a permanent group lockout",
        );
      }
      const index = inputIndexOf(args[1]);
      const recipient = index === undefined ? undefined : pureAddress(inputs[index]);
      if (!recipient) {
        throw new UnexpectedTransactionError(
          "grant_permission's recipient is not a 32-byte address",
        );
      }
      grantedTo ??= recipient;
    } else if (fn === "revoke_permission") {
      if (!isCreateBucketGroupResult(args[0])) {
        throw new UnexpectedTransactionError(
          "revoke_permission is not applied to the new bucket group",
        );
      }
      if (typeArgs.length !== 2 || normalizeStructTag(typeArgs[0] as string) !== witnessType) {
        throw new UnexpectedTransactionError(
          "revoke_permission's type arguments are not [WalrusConsole, <permission>]",
        );
      }
      const index = inputIndexOf(args[1]);
      const recipient = index === undefined ? undefined : pureAddress(inputs[index]);
      if (!recipient) {
        throw new UnexpectedTransactionError("revoke_permission's target is not a 32-byte address");
      }
      revokes.push({ type: normalizeStructTag(typeArgs[1] as string), recipient });
    }
    // create_bucket_group and public_share_object are validated above; the target
    // allowlist (step 4) already rejected any other function.
  }

  // THE OWNER PIN. Everything else in this flow is bounded by a type argument or a
  // known object; `add_owner` is bounded by this line alone.
  if (ownerCalls !== 1) {
    throw new UnexpectedTransactionError(
      `it makes ${ownerCalls} add_owner calls; exactly one is expected, naming the account this ` +
        `bucket is being created for`,
    );
  }
  if (ownerRecipient !== expectedOwner) {
    throw new UnexpectedTransactionError(
      `it makes ${ownerRecipient} the bucket's owner, not ${expectedOwner} — the account this ` +
        `flow asked Console to create the bucket for`,
    );
  }

  // Collapse the membership calls into roles, and split the signing key's own key
  // scope out of the roster. Rows 3 and 4 of the PTB use the same functions, so
  // the recipient is the only thing that distinguishes them.
  let signerRole: RosterMember["role"] | undefined;
  const granted: RosterMember[] = [];
  for (const [address, counts] of membershipCalls) {
    // The builder convention is add_viewer alone for a viewer and BOTH calls for an
    // editor. Any other combination — an add_editor with no add_viewer, a repeated
    // call — is a shape this client has never seen the API produce, so it is not a
    // shape whose on-chain effect it can vouch for.
    if (counts.viewer !== 1 || counts.editor > 1) {
      throw new UnexpectedTransactionError(
        `it makes an unexpected combination of membership calls for ${address} ` +
          `(${counts.viewer} add_viewer, ${counts.editor} add_editor)`,
      );
    }
    const role: RosterMember["role"] = counts.editor === 1 ? "editor" : "viewer";
    if (address === sender) signerRole = role;
    else granted.push({ address, role });
  }
  if (signerRole === undefined) {
    throw new UnexpectedTransactionError(
      "it never grants the signing key its own key scope, so the key that is about to sign it " +
        "could not read the bucket it creates",
    );
  }

  // THE ROSTER, as an exact multiset in both directions.
  for (const member of granted) {
    const expectedRole = expectedRoles.get(member.address);
    if (expectedRole === undefined) {
      throw new UnexpectedTransactionError(
        `it grants membership to ${member.address}, which the verified roster does not include`,
      );
    }
    if (expectedRole !== member.role) {
      throw new UnexpectedTransactionError(
        `it grants ${member.address} the ${member.role} role, not the verified ${expectedRole} role`,
      );
    }
  }
  for (const [address, role] of expectedRoles) {
    if (!granted.some((member) => member.address === address)) {
      throw new UnexpectedTransactionError(
        `it does not grant ${address}, a verified ${role} of this space — a reserve that silently ` +
          `drops a member is as wrong as one that adds a stranger`,
      );
    }
  }

  // THE MANAGEMENT GRANT. Absent is always legal (a space with no key_admin key
  // builds no grant at all); present-and-uncheckable is not.
  if (grantCalls > 1) {
    throw new UnexpectedTransactionError(
      `it makes ${grantCalls} grant_permission calls; at most one is expected`,
    );
  }
  if (grantedTo !== undefined) {
    if (effectiveManager === undefined) {
      throw new UnexpectedTransactionError(
        `it hands group management to ${grantedTo} and this host has no Key-Admin address to ` +
          `check that against. Supply one — provision the admin credential via the credential ` +
          `bundle, set CONSOLE_KEY_ADMIN_ADDRESS, or run \`walrus-console-mcp config\``,
      );
    }
    if (grantedTo !== effectiveManager) {
      throw new UnexpectedTransactionError(
        `it hands group management to ${grantedTo}, not the Key-Admin ${effectiveManager}`,
      );
    }
  }

  // THE DEMOTION. All three revokes, in order, each aimed at the signing key.
  const present = new Set(revokes.map((r) => r.type));
  const missing = demotion.filter((d) => !present.has(d.type)).map((d) => d.label);
  if (missing.length > 0) {
    throw new UnexpectedTransactionError(
      `it does not revoke ${missing.join(", ")} from the signing key, which would leave that key ` +
        `holding admin rights over a group it is only meant to bootstrap`,
    );
  }
  if (revokes.length !== demotion.length) {
    throw new UnexpectedTransactionError(
      `it makes ${revokes.length} revoke_permission calls; exactly ${demotion.length} are expected`,
    );
  }
  for (const [i, expected] of demotion.entries()) {
    const revoke = revokes[i];
    if (revoke?.type !== expected.type) {
      throw new UnexpectedTransactionError(
        `its revoke_permission calls are not the signing key's demotion in order; call ${i + 1} ` +
          `revokes ${revoke?.type ?? "nothing"}, not ${expected.label}`,
      );
    }
    if (revoke.recipient !== sender) {
      throw new UnexpectedTransactionError(
        `its revoke_permission of ${expected.label} demotes ${revoke.recipient}, not the signing ` +
          `key ${sender}`,
      );
    }
  }

  // Closing sweep: every Pure 32-byte input must be an address this flow has
  // already accounted for. The per-command pins each check one ARGUMENT POSITION;
  // this catches an address parked anywhere else in the PTB, including argument
  // positions no check reads.
  const allowedAddresses = new Set<string>([expectedOwner, sender, ...expectedRoles.keys()]);
  if (effectiveManager !== undefined) allowedAddresses.add(effectiveManager);
  for (const input of inputs) {
    const address = pureAddress(input);
    if (address && !allowedAddresses.has(address)) {
      throw new UnexpectedTransactionError(
        `it carries the address ${address}, which is neither the bucket's owner, this signing ` +
          `key, the Key-Admin, nor a verified roster member`,
      );
    }
  }

  return {
    owner: expectedOwner,
    members: granted,
    signerRole,
    // `manager` reports what the PTB actually grants, so a summary never claims a
    // management grant the transaction does not contain.
    ...(grantedTo === undefined ? {} : { manager: grantedTo }),
    bucketIdArg,
  };
}

interface MoveCallLike {
  package: string;
  module: string;
  function: string;
  typeArguments?: readonly string[];
  arguments?: readonly unknown[];
}

function commandKind(command: unknown): string {
  const c = command as { $kind?: string };
  if (typeof c.$kind === "string") return c.$kind;
  return Object.keys(command as object)[0] ?? "unknown";
}

function sharedOrOwnedObjectId(input: unknown): string | undefined {
  if (input == null) return undefined; // an arg may index a nonexistent input
  const object = (input as { Object?: Record<string, { objectId?: string }> }).Object;
  if (!object) return undefined;
  for (const value of Object.values(object)) {
    if (value && typeof value === "object" && typeof value.objectId === "string") {
      return value.objectId;
    }
  }
  return undefined;
}

/** The decoded bytes of a Pure input, or `undefined` if it is not one. */
function pureBytes(input: unknown): Uint8Array | undefined {
  if (input == null) return undefined; // an arg may index a nonexistent input
  const pure = (input as { Pure?: { bytes?: string } }).Pure;
  if (!pure?.bytes) return undefined;
  return fromBase64(pure.bytes);
}

/**
 * A Pure input that is exactly a 32-byte Sui address.
 *
 * Length is the discriminator: BCS writes an address as 32 raw bytes with no tag,
 * and the other pure inputs in these flows (a bucket UUID string) are
 * length-prefixed and a different size. Anything that is not 32 bytes is simply
 * not an address, so it is not checked as one.
 */
function pureAddress(input: unknown): string | undefined {
  const raw = pureBytes(input);
  if (!raw || raw.length !== 32) return undefined;
  return normalizeSuiAddress(
    `0x${Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("")}`,
  );
}
