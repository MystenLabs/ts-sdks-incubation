import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
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
 */

/**
 * What the caller asked Console for. Deliberately does NOT carry the sender: the
 * address that must appear in the transaction is the one about to sign it, read
 * from the keypair at the call site rather than described here, so it cannot be
 * made to agree with a forged transaction.
 */
export type SponsoredTxExpectation =
  | { readonly kind: "createBucket" }
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

  if (expectation.kind === "createBucket") {
    return new Set([
      `${pkg}::bucket_policy::create_bucket_group`,
      // The membership calls repeat once per member of the space, so the COUNT is
      // not fixed — only the set of things that may appear.
      `${pkg}::bucket_policy::add_admin`,
      `${pkg}::bucket_policy::add_editor`,
      `${pkg}::bucket_policy::add_viewer`,
      `${group}::permissioned_group::grant_permission`,
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
  if (expectation.kind === "createBucket") return new Set([registry]);
  return new Set([registry, ...expectation.groupIds.map((id) => normalizeSuiAddress(id))]);
}

export function assertExpectedTransaction(
  bytesBase64: string,
  /** The address whose key is about to sign these bytes. */
  signerAddress: string,
  expectation: SponsoredTxExpectation,
  config: BucketGroupPackageConfig,
): void {
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

  // 6. For a grant, every address it carries must be the recipient we generated.
  //    This is what stops access being handed to a third party while the response
  //    still looks like the grant we asked for.
  if (expectation.kind === "grantBucketAccess") {
    const recipient = normalizeSuiAddress(expectation.recipientAddress);
    for (const input of data.inputs) {
      const address = pureAddress(input);
      if (address && address !== recipient) {
        throw new UnexpectedTransactionError(
          `it grants access to ${address}, not the requested recipient ${expectation.recipientAddress}`,
        );
      }
    }
  }
}

interface MoveCallLike {
  package: string;
  module: string;
  function: string;
}

function commandKind(command: unknown): string {
  const c = command as { $kind?: string };
  if (typeof c.$kind === "string") return c.$kind;
  return Object.keys(command as object)[0] ?? "unknown";
}

function sharedOrOwnedObjectId(input: unknown): string | undefined {
  const object = (input as { Object?: Record<string, { objectId?: string }> }).Object;
  if (!object) return undefined;
  for (const value of Object.values(object)) {
    if (value && typeof value === "object" && typeof value.objectId === "string") {
      return value.objectId;
    }
  }
  return undefined;
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
  const pure = (input as { Pure?: { bytes?: string } }).Pure;
  if (!pure?.bytes) return undefined;
  const raw = fromBase64(pure.bytes);
  if (raw.length !== 32) return undefined;
  return normalizeSuiAddress(
    `0x${Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("")}`,
  );
}
