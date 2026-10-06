import { bcs } from "@mysten/sui/bcs";

/**
 * The v1 file-AAD codec, mirrored from Console's
 * `ts-sdks/packages/bucket-groups/src/file-aad.ts`.
 *
 * A mirror rather than an import: `@walrus-console/bucket-groups` is not
 * published (npm 404), and the web app reaches it through a workspace `file:`
 * link that a separate repository cannot follow. `deriveBucketGroupId` in
 * `ConsoleStorageService` is mirrored for the same reason, so this is the
 * established shape here rather than a new exception.
 *
 * What keeps a mirror honest is not the comment above but
 * `tests/fileAad.test.ts`: its vectors are hex the CANONICAL implementation
 * produced, so a drift in THIS copy fails here. A change to the canonical
 * encoder still passes both repositories' tests until the same vectors live
 * in the Console package too; without that, the other direction first shows
 * at a user's download, where the only symptom is a file that no longer opens.
 *
 * Why the codec exists at all: AES-256-GCM authenticates a private file's
 * *content*, and nothing authenticated the record around it, so
 * `UPDATE files SET oyster_object_id = <Y> WHERE id = X` made the user open X
 * and receive Y with GCM perfectly happy, because Y is a genuine ciphertext
 * carrying its own AAD. `SealClient.decrypt` takes no *expected* AAD, so the
 * control is an application-level compare, in every client, before a key is
 * fetched. `classifyFileAad` is that compare, and it fails closed.
 */

/** Only version this build writes, and the only one it accepts on decrypt. */
export const FILE_AAD_VERSION = 1;

/**
 * The bound fields, in the order they are serialised.
 *
 * `bucketId` is the bucket the CALLER addressed (the `bucketId` tool argument),
 * never the one the record reports: comparing the record against itself would
 * authenticate nothing, and the cross-bucket swap works precisely because that
 * column is rewritable.
 *
 * Deliberately absent: the file id (records are re-pointed, not renamed), the
 * display `name` (renaming is allowed), and the recorded `mime_type` (the server
 * derives it from the name, so no client can predict it). Both inputs of that
 * derivation, `originalName` and `declaredType`, are bound instead.
 */
export interface FileAadV1 {
  /** Console bucket uuid (`buckets.id`), canonical lowercase. NOT the group id. */
  readonly bucketId: string;
  /** Requested name, trimmed and NFC-normalised, before any collision suffix. */
  readonly originalName: string;
  /** The client's MIME string, verbatim. `""` when it declared none. */
  readonly declaredType: string;
  /** Plaintext byte count. */
  readonly contentSize: number | bigint;
}

const FileAadV1Bcs = bcs.struct("WalrusConsoleFileAadV1", {
  version: bcs.u8(),
  bucketId: bcs.string(),
  originalName: bcs.string(),
  declaredType: bcs.string(),
  contentSize: bcs.u64(),
});

/**
 * Normalise a requested filename the way the binding requires.
 *
 * Must match the API's `toNfcName` (`api/src/lib/name-schemas.ts`) byte for
 * byte: this client binds the string and the server stores it, so one code point
 * of difference makes every later download of that file refuse. NFC because
 * macOS hands out NFD, so the same file read from a Finder-created path and from
 * an archive would otherwise bind differently.
 */
export function canonicalOriginalName(name: string): string {
  return name.trim().normalize("NFC");
}

/**
 * Canonical form of a bucket id for the binding.
 *
 * Applied on both sides, because here the bucket id arrives as a tool argument
 * where the casing is whatever the agent typed. Without it, an agent that types
 * capitals uploads a file it can never download.
 */
export function canonicalBucketId(bucketId: string): string {
  return bucketId.trim().toLowerCase();
}

/** Encode the AAD to pass to `SealClient.encrypt({ aad })`. */
export function encodeFileAad(input: FileAadV1): Uint8Array {
  return FileAadV1Bcs.serialize({
    version: FILE_AAD_VERSION,
    bucketId: canonicalBucketId(input.bucketId),
    originalName: input.originalName,
    declaredType: input.declaredType,
    contentSize: BigInt(input.contentSize),
  }).toBytes();
}

export type FileAadRefusal =
  /** The record is missing a bound column, so there is nothing to compare against. */
  | "record_not_bound"
  /** AAD bytes present but not a v1 struct, or a version this build does not know. */
  | "unreadable"
  /** Decoded cleanly and disagrees with the record. */
  | "mismatch";

export type FileAadClassification =
  /** No AAD on the ciphertext: encrypted before the cutover. Accepted forever. */
  | { readonly kind: "legacy" }
  /** Bound, and the bytes match the record. */
  | { readonly kind: "bound"; readonly aad: FileAadV1 & { readonly version: number } }
  /** Bound, and something did not line up. Never decrypt. */
  | { readonly kind: "refused"; readonly reason: FileAadRefusal; readonly detail: string };

/** The three columns the comparison needs. `null` on any of them refuses. */
export interface BoundFileRecord {
  readonly original_name?: string | null;
  readonly declared_mime_type?: string | null;
  readonly content_size?: number | bigint | null;
}

/**
 * Decide what to do with a ciphertext's AAD, before fetching a key.
 *
 * `aad` is `ciphertext.Aes256Gcm.aad ?? []`. Empty means legacy. Anything else
 * must decode as v1 and equal the record, or this refuses.
 *
 * The record is adversary input, so a NULL column is a refusal rather than a
 * skipped check: "we cannot verify this" and "this is fine" are not the same
 * answer, and treating them as one is how the original attack survives.
 */
export function classifyFileAad(
  aad: Uint8Array | readonly number[] | null | undefined,
  expected: { readonly bucketId: string; readonly record: BoundFileRecord },
): FileAadClassification {
  const bytes = aad instanceof Uint8Array ? aad : Uint8Array.from(aad ?? []);
  if (bytes.length === 0) return { kind: "legacy" };

  let parsed: FileAadV1 & { version: number };
  try {
    const decoded = FileAadV1Bcs.parse(bytes);
    parsed = {
      version: decoded.version,
      bucketId: decoded.bucketId,
      originalName: decoded.originalName,
      declaredType: decoded.declaredType,
      contentSize: BigInt(decoded.contentSize),
    };
  } catch (cause) {
    return {
      kind: "refused",
      reason: "unreadable",
      detail: `AAD is present but did not decode as v1: ${String(cause)}`,
    };
  }

  if (parsed.version !== FILE_AAD_VERSION) {
    return {
      kind: "refused",
      reason: "unreadable",
      detail: `AAD version ${parsed.version} is not supported by this client.`,
    };
  }

  const { original_name, declared_mime_type, content_size } = expected.record;
  if (original_name == null || declared_mime_type == null || content_size == null) {
    return {
      kind: "refused",
      reason: "record_not_bound",
      detail: "This file carries a binding but its record does not, so the two cannot be compared.",
    };
  }

  // The column has no CHECK, so a rewrite can store a size no file has.
  if (!isU64(content_size)) {
    return {
      kind: "refused",
      reason: "record_not_bound",
      detail: "This file's record carries a size that cannot describe any file.",
    };
  }

  // Re-encode rather than compare field by field: one comparison that cannot
  // forget a field when the struct grows a v2.
  let rebuilt: Uint8Array;
  try {
    rebuilt = encodeFileAad({
      bucketId: expected.bucketId,
      originalName: original_name,
      declaredType: declared_mime_type,
      contentSize: content_size,
    });
  } catch {
    // Anything else the record makes the encoder reject (a name that is not a
    // string, say) still refuses: this is the check that has to fail closed.
    return {
      kind: "refused",
      reason: "record_not_bound",
      detail: "This file's record could not be read as a binding.",
    };
  }
  if (!equalBytes(rebuilt, bytes)) {
    return {
      kind: "refused",
      reason: "mismatch",
      detail: "This file does not belong to the record that points at it.",
    };
  }

  return { kind: "bound", aad: parsed };
}

const U64_MAX = (1n << 64n) - 1n;

function isU64(value: number | bigint): boolean {
  if (typeof value === "bigint") return value >= 0n && value <= U64_MAX;
  return Number.isSafeInteger(value) && value >= 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
