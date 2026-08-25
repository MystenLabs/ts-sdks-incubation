import { EncryptedObject, SealClient, SessionKey } from "@mysten/seal";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, fromHex } from "@mysten/sui/utils";
import { Effect } from "effect";

import {
  ConsoleConfigLive,
  ConsoleConfigTag,
  getRawAdminServiceKey,
  getRawApiKey,
  getRawServiceKey,
} from "../config";
import { SealIdentity, type SealIdentityInput } from "./constants";
import { SealCryptoError } from "./errors";
import {
  resolveFullnodeUrl,
  resolvePackageConfigForBaseUrl,
  resolveSuiNetwork,
} from "./packageConfig";
import { interpretSealProxyFailure, resolveSealConfig } from "./seal-config";
import { buildSealApproveTransaction } from "./sealApprove";
import { assertExpectedTransaction, type SponsoredTxExpectation } from "./txValidation";

/**
 * SealCryptoService — the heart of private (encrypted) Console operations.
 *
 * All client-side Seal encryption, decryption, and Sui signing happens here.
 * This service **must** run locally (never on a remote server) because it
 * holds the user's service private key.
 *
 * Pattern: exact match to console/api Effect v3 services (CLAUDE.md).
 */

/**
 * Lifetime of a Seal SessionKey, in minutes. Long enough that a multi-file
 * download reuses one registration, short enough to bound the window in which a
 * leaked session certificate is usable.
 */
const SESSION_KEY_TTL_MIN = 10;

/**
 * How long a caller will wait for a SessionKey before giving up.
 *
 * `SessionKey.create` performs a getObject RPC against a Sui fullnode, and
 * nothing else on that chain is bounded — no `grpc-timeout` header is sent, so a
 * stalled fullnode is held up only by undici's ~300s backstop.
 *
 * The bound sits around the WHOLE acquisition — the wait for the lock as well as
 * the create — rather than around the create alone. That distinction is the
 * point: with only the create bounded, a queue of N cold callers still fails
 * serially at ~T, ~2T … ~NT, because each waiter re-reads the empty cache and
 * runs its own create. Bounding the whole thing means every caller gives up at
 * its own deadline, so N concurrent decrypts against a stalled node all fail at
 * ~T — the same shape as before single-flighting, which is the behaviour the
 * dedup accidentally traded away.
 *
 * 30s is far above a healthy testnet round-trip and comfortably inside the tool
 * timeouts MCP clients apply, so a stall surfaces as this error rather than as a
 * client-side disconnect with no explanation.
 */
const SESSION_KEY_TIMEOUT = "30 seconds";

/**
 * Every input to `SessionKey.create` that a cached key must agree on to be
 * reusable. Grouped into a record rather than passed as loose arguments so the
 * same literal builds the create call and the cache entry, and so `address` and
 * `packageId` — two adjacent strings — cannot be silently transposed.
 */
interface SessionKeyParams {
  readonly address: string;
  readonly packageId: string;
  readonly ttlMin: number;
}

/** A cached SessionKey together with the parameters it was created for. */
interface CachedSessionKey extends SessionKeyParams {
  readonly sessionKey: { isExpired(): boolean };
}

/**
 * True when a cached Seal SessionKey may be reused for `want`: it exists, every
 * creation parameter matches, and it has not expired (the SDK's `isExpired()`
 * already applies a ~10s safety margin). Pure, so it is unit-tested directly.
 *
 * Comparing the whole of `want` rather than the address alone matters now that
 * `packageId` is resolved per Console base URL (COMG-601) rather than being a
 * module constant: an address-keyed cache would hand a key created against one
 * network's package to a caller asking about another's. The key servers would
 * reject it, so this fails closed either way — but it fails far from its cause.
 */
export function canReuseSessionKey(
  cached: CachedSessionKey | undefined,
  want: SessionKeyParams,
): boolean {
  return (
    cached !== undefined &&
    cached.address === want.address &&
    cached.packageId === want.packageId &&
    cached.ttlMin === want.ttlMin &&
    !cached.sessionKey.isExpired()
  );
}

/**
 * Run `create` at most once across concurrent callers that all miss the cache.
 *
 * A plain read-then-create cache is not enough when the create is asynchronous:
 * every caller arriving before the first one resolves sees an empty cache and
 * starts its own create. Here the miss path takes a one-permit semaphore and
 * **re-reads inside the lock**, so latecomers pick up whatever the winner stored
 * instead of repeating the work. Downloading N encrypted files therefore costs
 * one `SessionKey.create()` (an RPC plus a signature), not N.
 *
 * A failed `create` releases the permit with the cache still empty, so the next
 * caller simply retries — there is no in-flight entry left behind to clear.
 *
 * Extracted and exported so the concurrency behavior is unit-testable without
 * mocking the Seal SDK, gRPC client, and signer (see `tests/sealSessionCache.test.ts`).
 *
 * `read()` signals "no cached value" with `undefined`, so `T` must not itself
 * include `undefined` as a meaningful value — a legitimate `undefined` would be
 * read as a miss and re-run `create` every call.
 */
export function singleFlight<T, E, R>(
  lock: Effect.Semaphore,
  read: () => T | undefined,
  create: Effect.Effect<T, E, R>,
): Effect.Effect<T, E, R> {
  return Effect.suspend(() => {
    const cached = read();
    if (cached !== undefined) return Effect.succeed(cached);
    return lock.withPermits(1)(
      Effect.suspend(() => {
        const fresh = read();
        return fresh !== undefined ? Effect.succeed(fresh) : create;
      }),
    );
  });
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
            message:
              `Failed to decode ${envName} — it must be a suiprivkey1… key. ` +
              "Run `walrus-console-mcp config` to re-enter it.",
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

    // The network follows the Console API the MCP is pointed at, so the on-chain
    // identifiers can never disagree with the backend serving the buckets.
    const network = resolveSuiNetwork(config.baseUrl);
    // By BASE URL, not by network: two Console deploys can share a Sui network
    // and run different contract versions (a republish window), and these ids
    // are compared against bytes that host returned.
    const packageConfig = resolvePackageConfigForBaseUrl(config.baseUrl);

    // SuiGrpcClient + SealClient are stateless config holders (no network I/O until a
    // call is made), so build them once per runtime instead of per encrypt/decrypt. The
    // keypair stays lazy (getKeypair) so a missing service key never fails runtime startup.
    // gRPC is the recommended transport (JSON-RPC is retired on public fullnodes); the
    // fullnode serves both over the same host:port.
    const suiClient = new SuiGrpcClient({
      baseUrl: resolveFullnodeUrl(network),
      network,
    });

    // COMG-604 — the committee key server, reached through the Console API's `fetch_key`
    // proxy. Resolved here rather than inline so the same values feed `encrypt`'s threshold
    // below, and so the shape is unit-testable without standing up the SDK.
    const sealConfig = resolveSealConfig(network, config.baseUrl, getRawApiKey(config));

    const sealClient = new SealClient({
      suiClient,
      serverConfigs: sealConfig.serverConfigs,
      // Left off deliberately, and it is not merely the SDK default (false since 1.3.0):
      // verification GETs `/v1/service` on the key server, and the SDK skips that call
      // entirely for committee servers because their requests go through an aggregator.
      // Turning it on would buy nothing on either network.
      verifyKeyServers: false,
    });

    // SessionKey.create performs a network round-trip (a getObject RPC to assert
    // the package version) plus a signature every call. It is valid for its full
    // ttlMin window, so cache it per creation parameter set and recreate only on
    // expiry — downloading N files no longer means N redundant registrations.
    // The create is single-flighted, so N *concurrent* cold callers also share
    // one registration rather than racing to create one each.
    let cachedSessionKey: (SessionKeyParams & { sessionKey: SessionKey }) | undefined;
    const sessionKeyLock = yield* Effect.makeSemaphore(1);

    const getSessionKey = Effect.fn("SealCryptoService.getSessionKey")(function* (
      keypair: Ed25519Keypair,
    ) {
      // One record drives all three uses — the reuse check, the create call, and
      // the cache entry — so they cannot drift apart.
      const params: SessionKeyParams = {
        address: keypair.toSuiAddress(),
        packageId: packageConfig.originalPackageId,
        ttlMin: SESSION_KEY_TTL_MIN,
      };
      return yield* singleFlight(
        sessionKeyLock,
        () =>
          canReuseSessionKey(cachedSessionKey, params) ? cachedSessionKey?.sessionKey : undefined,
        Effect.gen(function* () {
          const sessionKey = yield* Effect.tryPromise({
            try: () =>
              SessionKey.create({
                ...params,
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
          cachedSessionKey = { ...params, sessionKey };
          return sessionKey;
        }),
      ).pipe(
        Effect.timeoutFail({
          duration: SESSION_KEY_TIMEOUT,
          onTimeout: () =>
            new SealCryptoError({
              message:
                `Timed out after ${SESSION_KEY_TIMEOUT} waiting for a Seal SessionKey. ` +
                "Creating one requires a getObject call to the Sui fullnode to check the " +
                "bucket-policy package version, and that call did not come back. The node " +
                "is likely unreachable or stalled — retry, or point CONSOLE_API_BASE_URL at " +
                "a network whose fullnode is healthy.",
              step: "session_key",
            }),
        }),
      );
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
            // 1, from the single committee entry's weight — not the old 2-of-3 over three
            // independent servers. The real m-of-n now lives inside the committee.
            threshold: sealConfig.threshold,
            packageId: packageConfig.originalPackageId,
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
        try: () => buildSealApproveTransaction(packageConfig, idBytes, sealPolicyId),
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

      // SessionKey lets Seal key servers verify the caller (cached per address,
      // package and ttl; concurrent cold callers share one registration).
      const sessionKey = yield* getSessionKey(keypair);

      const plaintext = yield* Effect.tryPromise({
        try: () => sealClient.decrypt({ data: ciphertext, sessionKey, txBytes }),
        // A failure inside the Console proxy is not a decryption problem and must not be
        // reported as one: an agent told "check your service key" when the proxy is simply
        // switched off will keep retrying the wrong fix. Seal's own denials carry no
        // `console:` prefix, so they fall through to the message below unchanged.
        catch: (cause) =>
          interpretSealProxyFailure(cause) ??
          new SealCryptoError({
            message:
              "Seal decryption failed. Common causes: CONSOLE_SERVICE_PRIVATE_KEY is not " +
              "the signer registered for CONSOLE_API_KEY, or this build's bucket-policy " +
              "package identifiers are stale relative to the deployed contract — the key " +
              "servers evaluate seal_approve, so a version-gate abort surfaces here.",
            cause,
            step: "decrypt",
          }),
      });

      return plaintext;
    });

    /**
     * Sign base64-encoded sponsored transaction bytes returned by Console —
     * POST /api/v1/spaces/{id}/buckets (reserve) or POST /api/v1/seal/sponsor
     * (grant) — after checking they are the transaction this flow asked for.
     *
     * `expectation` is REQUIRED, and that is the whole point. Signing whatever
     * bytes come back turns this keypair into an arbitrary signing oracle for any
     * endpoint that passes the base-URL allowlist, including whatever happens to
     * be listening on localhost when CONSOLE_API_BASE_URL points there for
     * development. See src/console/txValidation.ts for what is checked and why it
     * is checked rather than rebuilt locally.
     */
    const signTransactionBytes = Effect.fn("SealCryptoService.signTransactionBytes")(function* (
      bytesBase64: string,
      expectation: SponsoredTxExpectation,
      source: SeedSource = "working",
    ) {
      const keypair = yield* getKeypair(source);

      // The create-bucket PTB hands management to the Key-Admin (manager) address.
      // Resolve it locally through the SAME generator as the signer, tolerating
      // absence: a host with no admin key configured leaves this undefined.
      //
      // This locally-DERIVED address is the FALLBACK BENEATH the caller's config
      // pin, never a competitor to it: `resolveManager` in txValidation prefers
      // the pin, REFUSES when pin and derived address disagree (one of them is
      // stale and we cannot tell which), and fails closed on a `grant_permission`
      // it can check against neither. `getKeypair` does no I/O, so this is cheap
      // even on the grant flow, where the manager is not consulted at all.
      const managerAddress = yield* getKeypair("admin").pipe(
        Effect.either,
        Effect.map((either) => (either._tag === "Right" ? either.right.toSuiAddress() : undefined)),
      );

      // Validated against the address that is ABOUT TO SIGN, read from the keypair
      // rather than passed in: a caller-supplied sender could be made to agree with
      // a forged transaction, which would check nothing. For a create-bucket
      // reserve the validator returns a summary of the identities the PTB grants
      // (owner, roster, the signing key's remaining scope, the manager) so the
      // caller can disclose them.
      const { create } = yield* Effect.try({
        try: () =>
          assertExpectedTransaction(
            bytesBase64,
            keypair.toSuiAddress(),
            expectation,
            packageConfig,
            managerAddress,
          ),
        catch: (cause) =>
          new SealCryptoError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
            step: "sign",
          }),
      });

      const { signature } = yield* Effect.tryPromise({
        try: () => keypair.signTransaction(fromBase64(bytesBase64)),
        catch: (cause) =>
          new SealCryptoError({
            message: "Failed to sign sponsored transaction bytes",
            cause,
            step: "sign",
          }),
      });
      // `signature` is base64, ready for /finalize. `create` is the validator's
      // WHOLE summary — owner, roster, the signing key's remaining scope and the
      // manager — passed through rather than reduced to its roster half: a caller
      // that can only see `members` cannot disclose who ended up owning the
      // bucket or who was handed group management. It is `undefined` for the
      // grant flow, which validates a PTB that grants none of those.
      return { signature, create };
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
