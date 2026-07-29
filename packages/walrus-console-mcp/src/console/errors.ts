import { Data } from "effect";

/**
 * Console API and Seal crypto domain errors.
 * All extend Data.TaggedError for exhaustive matching (matches console/api conventions).
 */

export class ConsoleApiError extends Data.TaggedError("ConsoleApiError")<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly endpoint?: string;
}> {}

export class ConsoleAuthError extends Data.TaggedError("ConsoleAuthError")<{
  readonly message: string;
  readonly code:
    | "missing_api_key"
    | "invalid_api_key"
    | "read_only_api_key"
    // A 403 from a scope violation (e.g. a working key hitting the Key-Admin mint
    // endpoints). Kept distinct so the fidelity isn't lost to invalid_api_key.
    | "insufficient_scope";
}> {}

export class SealCryptoError extends Data.TaggedError("SealCryptoError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly step:
    | "load_keypair"
    | "parse"
    | "encrypt"
    | "decrypt"
    | "build_ptb"
    | "session_key"
    | "sign"
    | "generate_keypair";
}> {}

/** Raised when a mint is attempted without a configured Key-Admin credential. */
export class AdminCredentialMissingError extends Data.TaggedError("AdminCredentialMissingError")<{
  readonly message: string;
}> {}

/** Raised when a minted child key never reaches "active" within the poll window. */
export class KeyActivationError extends Data.TaggedError("KeyActivationError")<{
  readonly keyId: string;
  readonly status: string;
  readonly progress?: { granted: number; total: number };
}> {}

/**
 * Raised when a mint returns a key in a different space than the caller requested.
 * The mint derives the space from the admin credential's scope, so a mismatch means
 * the admin credential doesn't cover the requested space — surface it, don't hide it.
 */
export class SpaceMismatchError extends Data.TaggedError("SpaceMismatchError")<{
  readonly requested: string;
  readonly minted: string;
}> {}

export class MirrorGrantMissingError extends Data.TaggedError("MirrorGrantMissingError")<{
  readonly bucketId: string;
  readonly fileId?: string;
  readonly attempt: number;
}> {}

export class FileStatusError extends Data.TaggedError("FileStatusError")<{
  readonly fileId: string;
  readonly state: string;
  readonly error?: { code: string; message: string };
}> {}

export class LocalFsError extends Data.TaggedError("LocalFsError")<{
  readonly message: string;
  readonly path: string;
  readonly operation: "read" | "write" | "stat" | "validate";
}> {}
