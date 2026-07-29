import { EncryptedObject, SealClient, SessionKey } from "@mysten/seal";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, fromHex } from "@mysten/sui/utils";
import { Effect } from "effect";

import {
  ConsoleConfigLive,
  ConsoleConfigTag,
  getRawAdminServiceKey,
  getRawServiceKey,
} from "../config";
import {
  CONSOLE_LATEST_PACKAGE_ID,
  CONSOLE_ORIGINAL_PACKAGE_ID,
  SEAL_KEY_SERVER_OBJECT_IDS,
  SealIdentity,
  type SealIdentityInput,
  SUI_TESTNET_FULLNODE,
} from "./constants";
import { SealCryptoError } from "./errors";

/**
 * SealCryptoService — the heart of private (encrypted) Console operations.
 *
 * All client-side Seal encryption, decryption, and Sui signing happens here.
 * This service **must** run locally (never on a remote server) because it
 * holds the user's service private key.
 *
 * Pattern: exact match to console/api Effect v3 services (CLAUDE.md).
 */

/** A cached SessionKey together with the signer address it was created for. */
interface CachedSessionKey {
  readonly address: string;
  readonly sessionKey: { isExpired(): boolean };
}

/**
 * True when a cached Seal SessionKey may be reused for `address`: it exists, was
 * created for the same signer, and has not expired (the SDK's `isExpired()`
 * already applies a ~10s safety margin). Pure, so it is unit-tested directly.
 */
export function canReuseSessionKey(cached: CachedSessionKey | undefined, address: string): boolean {
  return cached !== undefined && cached.address === address && !cached.sessionKey.isExpired();
}

export class SealCryptoService extends Effect.Service<SealCryptoService>()("SealCryptoService", {
  effect: Effect.gen(function* () {
    const config = yield* ConsoleConfigTag;

    // --- Internal resources (created once per runtime) ---

    // Which seed source to load: the working signer (uploads/downloads/buckets) or the
    // isolated Key-Admin signer (sponsored grant_bucket_access for newly minted child keys).
    // Mints MUST sign with "admin" — never the working key — to keep the roles isolated.
    type SeedSource = "working" | "admin";

    const getKeypair = Effect.fn("SealCryptoService.getKeypair")(function* (
      source: SeedSource = "working",
    ) {
      const raw = source === "admin" ? getRawAdminServiceKey(config) : getRawServiceKey(config);
      const envName =
        source === "admin" ? "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY" : "CONSOLE_SERVICE_PRIVATE_KEY";
      if (!raw || raw.length < 20) {
        return yield* Effect.fail(
          new SealCryptoError({
            message: `${envName} is missing or invalid`,
            step: "load_keypair",
          }),
        );
      }
      try {
        const { secretKey } = decodeSuiPrivateKey(raw);
        return Ed25519Keypair.fromSecretKey(secretKey);
      } catch (cause) {
        return yield* Effect.fail(
          new SealCryptoError({
            message: `Failed to decode ${envName}`,
            cause,
            step: "load_keypair",
          }),
        );
      }
    });

    /**
     * Generate a fresh child Ed25519 keypair locally for a new working key.
     * Returns the Sui address (= serviceSignerAddress for the mint) and the
     * suiprivkey1… secret that is handed back to the caller exactly once.
     */
    const generateChildKeypair = Effect.fn("SealCryptoService.generateChildKeypair")(function* () {
      try {
        const keypair = new Ed25519Keypair();
        return {
          address: keypair.getPublicKey().toSuiAddress(),
          privateKey: keypair.getSecretKey(), // suiprivkey1…
        };
      } catch (cause) {
        return yield* Effect.fail(
          new SealCryptoError({
            message: "Failed to generate child keypair",
            cause,
            step: "generate_keypair",
          }),
        );
      }
    });

    // SuiGrpcClient + SealClient are stateless config holders (no network I/O until a
    // call is made), so build them once per runtime instead of per encrypt/decrypt. The
    // keypair stays lazy (getKeypair) so a missing service key never fails runtime startup.
    // gRPC is the recommended transport (JSON-RPC is deprecated); the fullnode serves both
    // over the same host:port, so SUI_TESTNET_FULLNODE doubles as the gRPC baseUrl.
    const suiClient = new SuiGrpcClient({
      baseUrl: SUI_TESTNET_FULLNODE,
      network: "testnet",
    });

    const sealClient = new SealClient({
      suiClient,
      serverConfigs: SEAL_KEY_SERVER_OBJECT_IDS.map((objectId) => ({
        objectId,
        weight: 1,
      })),
      verifyKeyServers: false, // testnet convenience (matches quickstart)
    });

    // SessionKey.create performs a network round-trip (a getObject RPC to assert
    // the package version) plus a signature every call. It is valid for its full
    // ttlMin window, so cache it per signer address and recreate only on expiry —
    // downloading N files no longer means N redundant session registrations. A
    // rare concurrent-decrypt race may create two keys; harmless (both valid).
    let cachedSessionKey: { address: string; sessionKey: SessionKey } | undefined;

    const getSessionKey = Effect.fn("SealCryptoService.getSessionKey")(function* (
      keypair: Ed25519Keypair,
    ) {
      const address = keypair.toSuiAddress();
      if (canReuseSessionKey(cachedSessionKey, address)) {
        return (cachedSessionKey as { address: string; sessionKey: SessionKey }).sessionKey;
      }
      const sessionKey = yield* Effect.tryPromise({
        try: () =>
          SessionKey.create({
            address,
            packageId: CONSOLE_ORIGINAL_PACKAGE_ID,
            ttlMin: 10,
            suiClient,
            signer: keypair,
          }),
        catch: (cause) =>
          new SealCryptoError({
            message: "Failed to create Seal SessionKey",
            cause,
            step: "session_key",
          }),
      });
      cachedSessionKey = { address, sessionKey };
      return sessionKey;
    });

    // --- Public API ---

    /**
     * Encrypt plaintext for a private bucket.
     * Returns the full encrypted object bytes ready for multipart upload.
     */
    const encrypt = Effect.fn("SealCryptoService.encrypt")(function* (
      plaintext: Uint8Array,
      sealPolicyId: string,
    ) {
      // Each file gets a fresh 32-byte nonce
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)));

      const idInput: SealIdentityInput = {
        policyObjectId: sealPolicyId,
        nonce,
      };
      const id = SealIdentity.serialize(idInput).toHex();

      const { encryptedObject } = yield* Effect.tryPromise({
        try: () =>
          sealClient.encrypt({
            threshold: 2,
            packageId: CONSOLE_ORIGINAL_PACKAGE_ID,
            id,
            data: plaintext,
          }),
        catch: (cause) =>
          new SealCryptoError({
            message: "Seal encryption failed",
            cause,
            step: "encrypt",
          }),
      });
      return encryptedObject;
    });

    /**
     * Decrypt a downloaded ciphertext using the bucket's sealPolicyId.
     */
    const decrypt = Effect.fn("SealCryptoService.decrypt")(function* (
      ciphertext: Uint8Array,
      sealPolicyId: string,
    ) {
      const keypair = yield* getKeypair();

      // Parse the ciphertext + derive the Seal identity. These are synchronous and
      // can throw (malformed ciphertext / bad hex), so wrap them in a typed step —
      // an outer try/catch would NOT catch a failing `yield*` (Effect unwinds past
      // the generator) and mislabeled these as the decrypt step.
      const idBytes = yield* Effect.try({
        try: () => {
          const parsed = EncryptedObject.parse(ciphertext);
          const idHex = parsed.id.startsWith("0x") ? parsed.id : `0x${parsed.id}`;
          return fromHex(idHex);
        },
        catch: (cause) =>
          new SealCryptoError({
            message: "Failed to parse Seal encrypted object",
            cause,
            step: "parse",
          }),
      });

      // Build the access-check transaction kind (never broadcast). Construction is
      // synchronous and can throw; the build itself is async.
      const tx = yield* Effect.try({
        try: () => {
          const t = new Transaction();
          t.moveCall({
            target: `${CONSOLE_LATEST_PACKAGE_ID}::bucket_policy::seal_approve`,
            arguments: [t.pure.vector("u8", Array.from(idBytes)), t.object(sealPolicyId)],
          });
          return t;
        },
        catch: (cause) =>
          new SealCryptoError({
            message: "Failed to build seal_approve PTB",
            cause,
            step: "build_ptb",
          }),
      });

      const txBytes = yield* Effect.tryPromise({
        try: () => tx.build({ client: suiClient, onlyTransactionKind: true }),
        catch: (cause) =>
          new SealCryptoError({
            message: "Failed to build seal_approve PTB",
            cause,
            step: "build_ptb",
          }),
      });

      // SessionKey lets Seal key servers verify the caller (cached per address).
      const sessionKey = yield* getSessionKey(keypair);

      const plaintext = yield* Effect.tryPromise({
        try: () => sealClient.decrypt({ data: ciphertext, sessionKey, txBytes }),
        catch: (cause) =>
          new SealCryptoError({
            message: "Seal decryption failed",
            cause,
            step: "decrypt",
          }),
      });

      return plaintext;
    });

    /**
     * Sign the base64-encoded sponsored transaction bytes returned by
     * POST /api/v1/spaces/{id}/buckets (reserve step).
     * Returns the signature in the format Console expects for /finalize.
     */
    const signTransactionBytes = Effect.fn("SealCryptoService.signTransactionBytes")(function* (
      bytesBase64: string,
      source: SeedSource = "working",
    ) {
      const keypair = yield* getKeypair(source);
      const { signature } = yield* Effect.tryPromise({
        try: () => keypair.signTransaction(fromBase64(bytesBase64)),
        catch: (cause) =>
          new SealCryptoError({
            message: "Failed to sign sponsored transaction bytes",
            cause,
            step: "sign",
          }),
      });
      return signature; // base64 string ready for /finalize
    });

    return {
      encrypt,
      decrypt,
      signTransactionBytes,
      generateChildKeypair,
      // Low-level access if tools ever need it directly
      getKeypair,
    } as const;
  }),

  // ConsoleConfigTag is provided higher up; we list it for clarity in this service
  dependencies: [ConsoleConfigLive],
}) {}
