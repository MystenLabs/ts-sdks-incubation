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

      try {
        const parsed = EncryptedObject.parse(ciphertext);
        const idHex = parsed.id.startsWith("0x") ? parsed.id : `0x${parsed.id}`;
        const idBytes = fromHex(idHex);

        // Build the access-check transaction kind (never broadcast)
        const tx = new Transaction();
        tx.moveCall({
          target: `${CONSOLE_LATEST_PACKAGE_ID}::bucket_policy::seal_approve`,
          arguments: [tx.pure.vector("u8", Array.from(idBytes)), tx.object(sealPolicyId)],
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

        // SessionKey lets Seal key servers verify the caller
        const sessionKey = yield* Effect.tryPromise({
          try: () =>
            SessionKey.create({
              address: keypair.toSuiAddress(),
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
      } catch (cause) {
        return yield* Effect.fail(
          new SealCryptoError({
            message: "Decryption pipeline failed",
            cause,
            step: "decrypt",
          }),
        );
      }
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
