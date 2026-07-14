import { Effect } from "effect";
import { ConsoleConfigLive, ConsoleConfigTag, hasAdminCredential } from "../config";
import type { ApiKeyPermission } from "./ConsoleApiClient";
import { ConsoleApiClient } from "./ConsoleApiClient";
import { AdminCredentialMissingError, KeyActivationError, SpaceMismatchError } from "./errors";
import { SealCryptoService } from "./SealCryptoService";

/**
 * KeyAdminService — headless minting of Console working keys (Approach B).
 *
 * Minting power lives in the isolated Key-Admin credential (CONSOLE_ADMIN_KEY +
 * CONSOLE_ADMIN_SERVICE_PRIVATE_KEY). An ordinary working key cannot mint.
 *
 * End-to-end flow (modeled on ConsoleStorageService.createBucket's reserve→sign→finalize
 * and uploadFileToBucket's poll loop):
 *   generate child keypair → createApiKey → (if private buckets) sponsor grant_bucket_access
 *   → sign with the ADMIN seed → executeSponsored → poll until "active" → return child credential.
 *
 * The admin seed never leaves the host; all four secrets stay Redacted.
 */

const ADMIN_MISSING_MESSAGE =
  "generate_api_key requires a Key-Admin credential. " +
  "Set CONSOLE_ADMIN_KEY (hbradm_…) and CONSOLE_ADMIN_SERVICE_PRIVATE_KEY. " +
  "A working key cannot mint.";

// Poll cadence for child-key activation: ~30s budget at a 2s interval.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;

export interface GenerateApiKeyResult {
  readonly apiKey: string; // hbr_… — shown once
  readonly privateKey: string; // suiprivkey1… — shown once
  readonly permission: ApiKeyPermission;
  readonly spaceId: string;
  readonly keyId: string;
  readonly privateBuckets: readonly { bucketId: string; groupId: string }[];
}

export class KeyAdminService extends Effect.Service<KeyAdminService>()("KeyAdminService", {
  effect: Effect.gen(function* () {
    const api = yield* ConsoleApiClient;
    const seal = yield* SealCryptoService;
    const config = yield* ConsoleConfigTag;

    const generateApiKey = Effect.fn("KeyAdminService.generateApiKey")(function* (args: {
      spaceId: string;
      permission: ApiKeyPermission;
      label?: string | undefined;
    }) {
      // Guard first — no network mutation happens without the Key-Admin credential.
      if (!hasAdminCredential(config)) {
        return yield* Effect.fail(
          new AdminCredentialMissingError({ message: ADMIN_MISSING_MESSAGE }),
        );
      }

      // 1. Generate a fresh child keypair locally; its address is the mint's signer.
      const child = yield* seal.generateChildKeypair();

      // 2. Ask Console to mint the child hbr_ key under the admin's key_admin scope.
      // The space is derived server-side from the admin credential — args.spaceId is
      // validated below, not used to select the space.
      const minted = yield* api.createApiKey({
        permissions: args.permission,
        serviceSignerAddress: child.address,
        name: args.label,
      });

      // Guard: the admin credential scopes the mint to one space. If it doesn't match
      // what the caller asked for, surface it rather than silently returning a key for
      // a different space.
      if (minted.space_id !== args.spaceId) {
        return yield* Effect.fail(
          new SpaceMismatchError({ requested: args.spaceId, minted: minted.space_id }),
        );
      }

      // 3–5. If the space has private buckets, run ONE sponsored grant_bucket_access PTB
      // covering every group, signed with the ADMIN seed (never the working key).
      if (minted.private_buckets.length > 0) {
        const scope = args.permission === "read_write" ? "readwrite" : "read";
        const sponsor = yield* api.sponsorGrantBucketAccess({
          groupIds: minted.private_buckets.map((b) => b.group_id),
          recipientAddress: child.address,
          scope,
        });
        const signature = yield* seal.signTransactionBytes(sponsor.bytes, "admin");
        yield* api.executeSponsored(sponsor.digest, signature);
      }

      // 6. Poll until the key is active (skips quickly when grants already landed /
      // there were no private buckets). Surface a readable timeout — no silent hang.
      let status: string = minted.status;
      let progress: { granted: number; total: number } | undefined;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS && status !== "active"; attempt++) {
        yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
        const res = yield* api.getApiKeyStatus(minted.id);
        status = res.data.status;
        progress = res.data.registration_progress;
      }

      if (status !== "active") {
        return yield* Effect.fail(
          new KeyActivationError({
            keyId: minted.id,
            status,
            ...(progress ? { progress } : {}),
          }),
        );
      }

      const result: GenerateApiKeyResult = {
        apiKey: minted.key,
        privateKey: child.privateKey,
        permission: minted.permissions,
        spaceId: minted.space_id,
        keyId: minted.id,
        privateBuckets: minted.private_buckets.map((b) => ({
          bucketId: b.bucket_id,
          groupId: b.group_id,
        })),
      };
      return result;
    });

    return { generateApiKey } as const;
  }),

  dependencies: [ConsoleApiClient.Default, SealCryptoService.Default, ConsoleConfigLive],
}) {}
