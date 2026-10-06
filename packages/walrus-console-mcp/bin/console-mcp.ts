#!/usr/bin/env node

// The Node floor, refused before anything else runs. This must stay the first
// statement in the file: both verbs below reach their code through a dynamic
// `import()`, and on an unsupported Node that import fails at link time with a
// SyntaxError naming `styleText` rather than the version. Static imports do
// still link ahead of this line, which is why src/nodeVersion.ts imports
// nothing at all and never colours its own message.
//
// `styleText` is the instance, not the class. Anything the old runtime refuses
// while linking or parsing this file defeats the gate the same way, and
// tsdown.config.ts sets `target: "node22"`, which is an explicit licence to emit
// syntax Node 18 cannot parse. The `node-floor` CI job is what notices either.
//
// One case this cannot cover, measured rather than assumed. The .mcpb build
// sets `inlineDynamicImports` (see tsdown.mcpb.config.ts), which folds the
// install chunk in and turns its `import { styleText } from "node:util"` into a
// static import of this file. ESM links the whole graph before evaluating any
// of it, so on a Node without that export the bundle dies at link time and this
// line never runs. `styleText` arrived in 20.12, so the boundary is exactly:
// the .mcpb bundle below Node 20.12 still shows the SyntaxError. Verified on
// 18.20.4 (SyntaxError) and 20.20.1 (this message). The npm channel, which is
// code-split, is covered on both. The .mcpb channel has its own declared gate,
// `compatibility.runtimes.node` in manifest.json, which an MCPB host checks
// before installing; npm's own gate is `engines.node`. Closing the gap here
// would mean no file reachable from this one may name `styleText` in an import
// specifier, which is a bigger change than the case is worth.
assertSupportedNode();

// `walrus-console-mcp --help`, with no verb. Without this it falls through to
// the server below and sits on stdio waiting for JSON-RPC, which is the least
// useful answer this CLI can give someone asking what it does.
// `isHelpFlag` rather than a second copy of the spellings, plus the bare word,
// which reads naturally with no verb in front of it.
if (isHelpFlag(process.argv[2] ?? "") || process.argv[2] === "help") {
  process.stdout.write(`${ROOT_USAGE}\n`);
  process.exit(0);
}

// Route `walrus-console-mcp install` to the interactive installer.
// (This branch does NOT run before the imports below — ESM hoists all `import`
// statements above it — but it does short-circuit before the server-path
// redaction wiring, so we install redaction here too.)
if (process.argv[2] === "install") {
  // Wire secret redaction before running the installer: an error thrown mid-install
  // (e.g. a failed validation fetch that embeds the Authorization header) must not
  // print a credential. Register env + any already-saved file secrets; the installer
  // registers the freshly-typed keys as they are entered.
  registerSecretsFromEnv();
  // registerConfigFileSecrets, not two registerSecret calls: it also covers the
  // management pair (adminKey / adminServicePrivateKey), which this path can now
  // read back out of the config file.
  registerConfigFileSecrets(loadConfigFileOrEmpty());
  installLogRedaction();

  const { runInstall } = await import("./install.js");
  try {
    await runInstall(process.argv.slice(3));
    // Mirror the `config` branch below (`process.exit(await runConfigure(...))`):
    // runInstall signals "credentials saved but nothing was registered" by
    // setting process.exitCode, which a bare `process.exit(0)` would clobber.
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    // Print the message only (redacted), never the raw error object/stack.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Route `walrus-console-mcp config` to the credential-change CLI. Same reasoning
// as `install` above: must run before the heavy Effect/MCP imports below.
if (process.argv[2] === "config") {
  // Same redaction wiring as `install` above — this path handles the very same
  // credentials, so a mid-run throw must not print one either.
  registerSecretsFromEnv();
  registerConfigFileSecrets(loadConfigFileOrEmpty());
  installLogRedaction();

  const { runConfigure } = await import("./configure.js");
  try {
    process.exit(await runConfigure(process.argv.slice(3)));
  } catch (err) {
    // Message only (redacted), never the raw error object/stack — matching `install`.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// An Add to Cursor first start: save the bundle the link carried, take it back
// out of ~/.cursor/mcp.json, then fall through and serve. It has to finish
// before the credential read below, which happens once per process. That is
// also why src/config.ts reads the file lazily: it is imported statically, so
// a module-load read would already have happened by this line.
if (
  process.argv
    .slice(2)
    .some((arg) => arg === "--import-bundle" || arg.startsWith("--import-bundle="))
) {
  // Before the import, which registers the bundle as a secret as its first
  // step: anything it logs goes through the redactor.
  installLogRedaction();
  const { runImportBundle } = await import("./importBundle.js");
  await runImportBundle(process.argv.slice(2));
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, Redacted } from "effect";
import { z } from "zod";
import {
  ConsoleConfigTag,
  getRawAdminKey,
  getRawAdminServiceKey,
  getRawServiceKey,
  hasAdminCredential,
} from "../src/config";
import { loadConfigFileOrEmpty } from "../src/configFile";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService } from "../src/console/ConsoleStorageService";
import { AdminCredentialMissingError } from "../src/console/errors";
import {
  ADMIN_MISSING_MESSAGE,
  type GenerateApiKeyToolOutcome,
  KeyAdminService,
  MAX_API_KEY_LABEL_LENGTH,
} from "../src/console/KeyAdminService";
import {
  bucketDescriptionSchema,
  bucketTagsSchema,
  buildBucketMetadataPatch,
  buildFilePatch,
  fileDescriptionSchema,
  fileTagsSchema,
} from "../src/console/fileMetadata";
import { KEY_ADMIN_PIN_REMEDY, WEB_ACCOUNT_PIN_REMEDY } from "../src/console/pinRemedy";
import { BucketId, FileId, SpaceId, withDisplaySize } from "../src/console/types";
import { confirmApiKeyMint } from "../src/elicitation";
import { assertSupportedNode } from "../src/nodeVersion";
import {
  resolveDownloadDestWithinRoots,
  resolvePathWithinRoots,
  selectAllowedDirs,
} from "../src/pathSandbox";
import {
  installLogRedaction,
  registerConfigFileSecrets,
  registerSecretsFromEnv,
} from "../src/redaction";
import { AppRuntime, runPromise } from "../src/runtime";
import { confirmDestructive, deleteBucketContents } from "../src/toolSchemas";
import { safeTool } from "../src/toolWrapper";
import { ROOT_USAGE, isHelpFlag } from "../src/usage";

/**
 * The slice of the MCP SDK's per-request context these handlers need.
 *
 * Every handler takes it and every runPromise forwards its signal, so cancelling
 * a tool call actually interrupts the work — uploads, decryption, polling and
 * file writes all stop — instead of only disconnecting the caller.
 */
type ToolExtra = { signal: AbortSignal };

/**
 * Console MCP Server — stdio entrypoint.
 * Claude Code / Desktop launches this process.
 * All heavy logic lives in Effect services behind the runtime.
 */

// Credential-safety guardrail (CONSOLE-148): register the configured secrets and
// scrub them from every log line, BEFORE anything can run a tool or log an error.
registerSecretsFromEnv();
// Credentials can also come from the installer-saved config file (not env). Register those
// too, or a file-backed key could leak unredacted into stderr / tool error output.
const savedConfig = loadConfigFileOrEmpty();
registerConfigFileSecrets(savedConfig);
installLogRedaction();

const server = new McpServer(
  {
    name: "console-mcp",
    version: "0.1.0",
  },
  {
    instructions:
      "Console is ggdrive-style decentralized storage (Walrus + Seal encryption). " +
      "Use list_spaces / list_buckets / list_files (pass q to search) before mutating. " +
      "Uploads and downloads require the user's local service private key (never sent to remote).",
  },
);

// Simple diagnostic tool (works even with partial config)
server.registerTool(
  "ping_console",
  {
    title: "Ping Console Config",
    description:
      "Returns whether the required CONSOLE_API_KEY (and optional service key) are present in the environment. Safe to call first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool("ping_console", async (_args: unknown, extra: ToolExtra) => {
    return await runPromise(
      Effect.gen(function* () {
        const cfg = yield* ConsoleConfigTag;
        const apiKeyVal = Redacted.value(cfg.apiKey);
        const hasKey = !!apiKeyVal && apiKeyVal.length > 8;
        const hasSvc = !!getRawServiceKey(cfg);
        const hasAdminKey = !!getRawAdminKey(cfg);
        const hasAdminSigner = !!getRawAdminServiceKey(cfg);
        const hasWebAccountAddress = cfg.webAccountAddress !== "";
        const hasKeyAdminAddress = cfg.keyAdminAddress !== "";
        // The sandbox's own selection (see selectAllowedDirs), so this can't
        // drift from what upload_file / download_file enforce.
        const { source: allowedDirsSource, rootDirs: allowedDirs } = yield* Effect.tryPromise({
          try: () => selectAllowedDirs(server.server, "ping_console"),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });
        return {
          ok: hasKey,
          has_api_key: hasKey,
          has_service_key: hasSvc,
          // Key-Admin presence (booleans only — never leak the secret values).
          has_admin_key: hasAdminKey,
          has_admin_signer: hasAdminSigner,
          has_web_account_address: hasWebAccountAddress,
          has_key_admin_address: hasKeyAdminAddress,
          // Not secret — local paths: the folders the sandbox uses right now.
          allowed_dirs: allowedDirs,
          allowed_dirs_source: allowedDirsSource,
          base_url: cfg.baseUrl,
          hint: hasKey
            ? "Ready for Console API calls"
            : "Set CONSOLE_API_KEY (and optionally CONSOLE_SERVICE_PRIVATE_KEY) in your environment or ~/.config/walrus-console-mcp/config.json",
        };
      }),
      extra.signal,
    );
  }),
);

// ======================
// Core ggdrive-style tools
// ======================

server.registerTool(
  "list_spaces",
  {
    title: "List Spaces",
    description:
      "List your Personal and Team spaces in Console. With an API key, storage_used and bucket_count count only the buckets the key can read (zero for any space other than the key's own).",
    inputSchema: {
      type: z
        .enum(["personal", "team"])
        .optional()
        .describe(
          "Filter to only Personal (your own default space) or Team (shared, has members) " +
            "spaces. Omit to list both.",
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "list_spaces",
    async ({ type }: { type?: "personal" | "team" | undefined }, extra: ToolExtra) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.listSpaces({ type });
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "get_storage_usage",
  {
    title: "Get Storage Usage",
    description:
      "Get aggregated storage usage (bytes used, cap, available, and percent used) for your active Console space. " +
      'With an API key, scope is "api_key": bytes used count only the buckets the key can read, and available is an upper bound, because uploads are checked against the whole space.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool("get_storage_usage", async (_args: unknown, extra: ToolExtra) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getStorageUsage();
      }),
      extra.signal,
    );
  }),
);

server.registerTool(
  "list_buckets",
  {
    title: "List Buckets",
    description:
      "List buckets in a space. One call returns one page: read `next_cursor` from the " +
      "response and call again with `cursor` set to it, repeating until `next_cursor` is null. " +
      "A space with more buckets than `limit` cannot be enumerated any other way.",
    inputSchema: {
      spaceId: z.string().describe("The space's id, from list_spaces."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max buckets to return. Default 100."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Optional. The `next_cursor` returned by a previous list_buckets call, to fetch the " +
            "page after it. Omit for the first page.",
        ),
      q: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring match against the bucket name only — not its " +
            "description or tags.",
        ),
      visibility: z
        .enum(["public", "private"])
        .optional()
        .describe("Optional. Return only public or only private buckets. Omit for both."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "list_buckets",
    async (
      {
        spaceId,
        limit,
        cursor,
        q,
        visibility,
      }: {
        spaceId: string;
        limit?: number | undefined;
        cursor?: string | undefined;
        q?: string | undefined;
        visibility?: "public" | "private" | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.listBuckets({
            spaceId: SpaceId.make(spaceId),
            limit,
            cursor,
            q,
            visibility,
          });
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "create_bucket",
  {
    title: "Create Private Encrypted Bucket",
    description:
      "Creates a new Seal-encrypted bucket. Returns sealPolicyId (download_file does not " +
      "need it; upload_file only needs it to confirm a bucket created by another key), " +
      "`identity` — what the signed transaction was found to DO, with " +
      "`identity.owner` (the account that ends up owning the bucket) and `identity.members` (the " +
      "exact addresses it grants access to) — and `disclosure`, one sentence saying who can read " +
      "the bucket and on what evidence. Before uploading sensitive data, show `disclosure` and " +
      "`identity.members` to the user and confirm the roster is expected. `disclosure` is not " +
      "optional colour: an empty roster can mean 'this space has only this key' or 'nothing " +
      "could be verified, so nobody else was granted access', and those write identical " +
      "transactions — `disclosure` and `roster.reason` are the only place the difference " +
      "surfaces. `roster.droppedCandidates` lists this space's keys that will NOT be able to " +
      "read the bucket. There is NO top-level `members` field: `roster.members` is what this " +
      "client demanded and `identity.members` is what the bytes it signed grant. " +
      "This tool REFUSES rather than creating a bucket whose access it cannot account for. Two " +
      "refusals need the user to fix configuration, so retrying will not help. With no " +
      "bucket-owner address pinned it fails with reason `missing_owner_pin` before any network " +
      `call; the fix is to set ${WEB_ACCOUNT_PIN_REMEDY}. On a space that hands group ` +
      "management to a Key-Admin, it refuses before signing when this host has no Key-Admin " +
      `address to check that against; the fix is to set ${KEY_ADMIN_PIN_REMEDY}. A ` +
      "RosterUnavailableError means a read failed before anything was reserved: no bucket, no " +
      "gas, retry is safe.",
    inputSchema: {
      spaceId: z.string().describe("The space's id, from list_spaces, to create the bucket in."),
      name: z.string().min(1).max(100).describe("The bucket's name, shown in Console."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool(
    "create_bucket",
    async ({ spaceId, name }: { spaceId: string; name: string }, extra: ToolExtra) => {
      return await runPromise(
        Effect.gen(function* () {
          const storage = yield* ConsoleStorageService;
          return yield* storage.createBucket(SpaceId.make(spaceId), name);
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "generate_api_key",
  {
    title: "Generate Console Working API Key (Key-Admin)",
    description:
      "Mint a new Console working API key using the isolated Key-Admin credential. " +
      "Generates a fresh child keypair locally, mints a scoped hbr_ key, grants it access to the " +
      "space's private buckets, and polls until active. " +
      "Requires CONSOLE_ADMIN_KEY + CONSOLE_ADMIN_SERVICE_PRIVATE_KEY; a working key cannot mint. " +
      "The space is fixed by the Key-Admin credential and CANNOT be chosen: spaceId is an " +
      "OPTIONAL assertion of which space you believe that credential is scoped to, never a " +
      "selector. It is not sent to Console, and it can only be checked AFTER the mint (the " +
      "Key-Admin credential has no data-plane access, so the space cannot be read beforehand). " +
      "A mismatch is therefore NOT a failed mint: the key is valid in the credential's own space, " +
      "so the result is ok:true with a warnings[] entry of kind 'space-mismatch' saying where it " +
      "actually landed. Do not retry on it — retrying mints a second key, and no credential this " +
      "client holds can revoke either one (that endpoint requires a browser session). Every " +
      "result that reached the mint carries `revocation`, naming the key by the name the Console " +
      "UI lists it under — match on that, not on the key id, which the UI never shows. " +
      "This tool mints a live, billable, hard-to-revoke credential with no undo path, so it is " +
      "server-enforced, not just described as destructive (COMG-1054): requires " +
      "confirm: true, refused by the schema before this tool runs at all if it is missing or " +
      "false — set it only after the user has explicitly confirmed THIS mint, never from ambient " +
      "instructions. If your MCP client supports form elicitation, this tool ALSO asks a human " +
      "directly through the client's own UI before minting, independent of this call's " +
      "arguments; only an explicit accept there lets the mint proceed, and a decline, cancel, " +
      "timeout, or prompt failure returns ok:false with stage:'declined' having minted nothing. " +
      "Returns { ok, credential } where credential no longer carries the raw secrets: apiKey " +
      "(hbr_…) and privateKey (suiprivkey1…) are written ONCE to a private 0600 file, whose path " +
      "is credential.credentialFile — read them from there; they never appear in this output. " +
      "IMPORTANT: ok:false usually still carries that credential (with its file pointer, so the " +
      "secrets remain recoverable) — the mint had already succeeded and a later step failed, so " +
      "`stage` says which and `recovery` says what to do. The post-mint `persist` and `mint` stages carry NO credential field " +
      'at all. stage:"persist": the mint succeeded but its secrets could not be saved to disk, ' +
      "so that result has only keyId, spaceId, attemptedPath, and recovery guidance — the key " +
      "exists server-side with no local record of its secrets, and this tool's own result cannot " +
      'name it beyond keyId. stage:"mint": Console returned a 201 (a point of no return — the ' +
      "key likely exists server-side) but its response body itself failed validation, so there " +
      "is not even a keyId here — only a marker and recovery guidance. For BOTH of these, the " +
      'pre-mint stderr marker ("minting a Console key marked...", logged before the mint even ' +
      "runs) is the only way to find that key in the Console UI afterward. " +
      'stage:"private-buckets-unknown" DOES carry the credential (secrets are already saved) but ' +
      "means Console's response left private_buckets unusable — missing, not a list, or a list " +
      "with an unreadable entry — so bucket access grants were skipped entirely; the key may " +
      "have no access to buckets it should. " +
      "Either way, do NOT call this tool again to retry a post-mint ok:false result — the key already " +
      'exists, and retrying mints a second one while orphaning the first. `stage:"declined"` is the ' +
      "exception: nothing was minted, so it is safe to call again only after a user provides a fresh " +
      "confirmation.",
    inputSchema: {
      // Optional, and an assertion rather than a selector (COMG-849). Required +
      // "validated" read as "this picks the space", so a wrong value looked like
      // a failed mint worth retrying — when the mint had in fact succeeded in the
      // credential's own space, and each retry minted another unrevokable key.
      spaceId: z
        .string()
        // Reject "" rather than accept it as an assertion: the description
        // invites omission, and a caller that reaches for the field anyway and
        // leaves it blank would otherwise get a mismatch warning about a
        // perfectly correct key.
        .min(1)
        .optional()
        .describe(
          "Optional. The space you believe the Key-Admin credential is scoped to. It does NOT " +
            "choose the space and is never sent to Console; it is only compared with where the " +
            "key actually landed, after the fact. A mismatch still returns ok:true, with a " +
            "'space-mismatch' warning. Omit it to assert nothing.",
        ),
      permission: z
        .enum(["read_only", "read_write"])
        .describe(
          "read_only can list and download. read_write can also upload, create, rename, " +
            "delete, and edit descriptions and tags.",
        ),
      // The real ceiling, not 64: Console caps the stored `name` at 64 and the
      // mint appends " [mcp-mint-…]", so a longer label would be rejected with a
      // bare 400. Advertising a maximum the server refuses is worse than a
      // smaller honest one.
      label: z
        .string()
        .max(MAX_API_KEY_LABEL_LENGTH)
        .regex(/^\P{Cc}*$/u, "label must not contain control characters")
        .optional()
        .describe(
          "Shown in the Console UI's key list, alongside an auto-generated mint marker. Omit " +
            "for the marker alone.",
        ),
      // COMG-1054: the schema-level floor every client gets,
      // matching delete_bucket/delete_file. Closes the accident case
      // only — see confirmDestructive's own docstring — which is why the
      // elicitation gate below runs in addition, not instead, whenever the
      // client can show it.
      confirm: confirmDestructive,
    },
    // destructiveHint: true — this mints a live, billable credential
    // with no undo path; MCP clients (including Claude Code) key their own
    // tool-approval UX on this annotation, and `false` was a mislabel.
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "generate_api_key",
    async (
      {
        spaceId,
        permission,
        label,
      }: {
        spaceId?: string | undefined;
        permission: "read_only" | "read_write";
        label?: string | undefined;
        confirm: true;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          // Check local credentials before asking a human to approve a mint that
          // cannot run. This is the same no-network guard generateApiKey keeps
          // as defense in depth; it runs first here only to improve the UX.
          // Reuses the exact check, message, and error type KeyAdminService
          // enforces (PR #66 review, 2026-09-18), rather than a second
          // copy of both free to drift, and so the two refusals read identically.
          const config = yield* ConsoleConfigTag;
          if (!hasAdminCredential(config)) {
            return yield* Effect.fail(
              new AdminCredentialMissingError({ message: ADMIN_MISSING_MESSAGE }),
            );
          }
          const keyAdmin = yield* KeyAdminService;

          // A second, independent gate on top of schema-level confirm:true.
          // The prompt is answered in the client's own UI, outside the model's
          // tool arguments. Clients without form elicitation use the schema
          // floor; timeout or elicitation errors fail closed as a decline.
          const elicited = yield* Effect.tryPromise({
            try: (signal) => confirmApiKeyMint(server.server, { permission, label }, signal),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          });
          if (elicited.gated && !elicited.confirmed) {
            const reason =
              elicited.action === "timeout"
                ? "The user did not answer the mint confirmation prompt before it timed out. Nothing was minted."
                : elicited.action === "unavailable"
                  ? "The mint confirmation prompt did not complete. Nothing was minted."
                  : elicited.action === "accept"
                    ? "The user accepted the prompt without checking its confirmation box. Nothing was minted."
                    : `The user did not confirm the mint through the client's elicitation UI (answered "${elicited.action}"). Nothing was minted.`;
            return {
              ok: false as const,
              stage: "declined" as const,
              reason,
            } satisfies GenerateApiKeyToolOutcome;
          }
          return yield* keyAdmin.generateApiKey({ spaceId, permission, label });
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "upload_file",
  {
    title: "Upload & Encrypt File",
    description:
      "Reads a local file, encrypts it with Seal, and uploads it. Returns as soon as " +
      "Console accepts the upload: fileId plus a non-terminal state (queued), pending: " +
      "true, and a note — it does NOT wait for processing to finish, even for a large " +
      "file that takes minutes. Poll get_file_status with the returned fileId until it " +
      "reports completed or failed; do not call upload_file again for the same file " +
      "while waiting, even if the response feels fast — the file has already been " +
      "accepted and a second call creates a second, duplicate file. The read+encrypt+" +
      "upload step itself (before accept) can still take longer than a client's own " +
      "request timeout on a slow connection or a very large file; a timeout there does " +
      "not necessarily mean the upload failed — check list_files before retrying. " +
      "Optionally attaches a description and tags. list_files' q matches the file name " +
      "only, not these. " +
      "sealPolicyId is optional: the policy is derived from the bucket and verified locally. " +
      "For a bucket created by a key this host cannot verify (e.g. another agent's), pass " +
      "the bucket's sealPolicyId to confirm it. " +
      "Once get_file_status has reported a `daily_limit` failure, upload_file refuses without " +
      "an API call until that failure's `retry_at`.",
    inputSchema: {
      bucketId: z
        .string()
        .describe("The bucket's id, from list_buckets, get_bucket, or create_bucket."),
      sealPolicyId: z
        .string()
        .optional()
        .describe(
          "Optional. Not needed when the bucket's policy verifies locally (buckets created " +
            "in the web UI or by this host). For a bucket created by another key, pass its " +
            "policy id from create_bucket to confirm it: the upload proceeds only if it " +
            "matches the policy Console reports. A value that does not match the bucket's " +
            "policy is refused.",
        ),
      localPath: z
        .string()
        .describe(
          "Local filesystem path to the file to encrypt and upload. Must be inside a folder " +
            "this server may read; a relative path resolves against the first of them.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Name to store the file under in Console. Defaults to the file's own name; for a " +
            "symlink, the target's.",
        ),
      // Limits mirror the Console API (src/console/fileMetadata.ts) so an
      // over-limit value is refused here with a field-level message instead of
      // costing an upload round-trip to learn it (COMG-662).
      description: fileDescriptionSchema.optional(),
      tags: fileTagsSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "upload_file",
    async (
      {
        bucketId,
        sealPolicyId,
        localPath,
        name,
        description,
        tags,
      }: {
        bucketId: string;
        sealPolicyId?: string | undefined;
        localPath: string;
        name?: string | undefined;
        description?: string | undefined;
        tags?: string[] | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          // M9: canonicalize the path INSIDE the fiber `runPromise` drives, not
          // before it. `resolvePathWithinRoots` calls `toRealPathAsync`, which
          // can block on a stalled network mount's `realpath()`; done here the
          // walk is part of the request's own effect, so it no longer stalls
          // the whole event loop (every other in-flight request, the
          // transport, cancellation itself) while it waits. It is NOT
          // cancellable, though: `try` below declares zero parameters, so
          // `Effect.tryPromise` never manufactures an `AbortSignal` for it
          // (arity must be >= 1 — see `effectPromise.ts`), and `fs/promises`
          // `realpath`/`lstat`/`readlink` take no signal to pass anyway.
          // Interrupting this request abandons the promise; the underlying
          // `realpath(2)` keeps running in the libuv threadpool until the
          // filesystem answers. Plain-Error passthrough (not a tagged error)
          // so `safeTool`'s output stays byte-identical: `unwrapFiberFailure`
          // recovers this same `Error`, and `describeError` renders a plain
          // `Error` by its `.message` either way — precedent
          // `ConsoleStorageService.ts:902` (`catch: (cause) => cause`).
          const resolvedPath = yield* Effect.tryPromise({
            try: () => resolvePathWithinRoots(server.server, localPath, "Source"),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          });
          const storage = yield* ConsoleStorageService;
          return yield* storage.uploadFileToBucket(
            BucketId.make(bucketId),
            sealPolicyId,
            resolvedPath,
            name,
            { description, tags },
          );
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "download_file",
  {
    title: "Download & Decrypt File",
    description:
      "Downloads a file, decrypts it, and saves it to the path you specify. " +
      "Refuses to replace a file that is already at destPath unless you pass overwrite: true. " +
      "Verifies the file against its own record before decrypting: a ciphertext that does not " +
      "belong to the record, or to this folder, is refused and nothing is written. " +
      "The result reports bound: false for a file uploaded before that binding existed, and " +
      "uploadedAs when the name it was encrypted under differs from the one listed. " +
      "A destPath that is a symlink is refused; give a real file path. " +
      "A destPath whose file name is a Windows-reserved device name (NUL, CON, COM1, ...) is " +
      "refused on every OS; use a different name.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      fileId: z.string().describe("The file's id, from list_files."),
      destPath: z
        .string()
        .describe(
          "Local filesystem path to save the decrypted file to. Must be inside a folder this " +
            "server is allowed to write to.",
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          "Replace the file already at destPath. Off by default, so a download cannot clobber " +
            "something the user has there. Ask the user before setting it: the file being " +
            "replaced is theirs, not this tool's. A replaced file keeps its own permissions " +
            "when they are stricter than owner-only, and is tightened to owner-only when they " +
            "are looser, because what lands is decrypted content. " +
            "A dest that is a symlink is always refused, even with this flag.",
        ),
    },
    // destructiveHint: true — the hint is a claim about what the
    // tool *may* do, not about its default: `false` means "additive updates
    // only" and `overwrite: true` replaces a file the user owns. Same reading
    // that settled the security review for `generate_api_key`, and `upload_file` above.
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "download_file",
    async (
      {
        bucketId,
        fileId,
        destPath,
        overwrite,
      }: {
        bucketId: string;
        fileId: string;
        destPath: string;
        overwrite?: boolean | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          // M9: same reasoning as upload_file above — canonicalize inside the
          // fiber so the walk no longer stalls the event loop (it is NOT
          // cancellable: see upload_file's comment for why), plain-Error
          // passthrough so the tool's output text is unaffected by the move.
          const resolvedPath = yield* Effect.tryPromise({
            try: () => resolveDownloadDestWithinRoots(server.server, destPath, "Destination"),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          });
          const storage = yield* ConsoleStorageService;
          return yield* storage.downloadFile(
            BucketId.make(bucketId),
            FileId.make(fileId),
            resolvedPath,
            overwrite ?? false,
          );
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "list_files",
  {
    title: "List Files in Bucket",
    description:
      "List files inside a specific bucket (supports search). One call returns one page: while " +
      "`pagination.has_more` is true, call again with `cursor` set to the " +
      "`pagination.next_cursor` the previous call returned, until `has_more` is false. A bucket " +
      "holding more files than `limit` cannot be enumerated any other way.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max files to return. Default 20."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Optional. The `pagination.next_cursor` returned by a previous list_files call, to " +
            "fetch the page after it. Omit for the first page.",
        ),
      q: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring match against the file name only — not its " +
            "description or tags.",
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "list_files",
    async (
      {
        bucketId,
        limit,
        cursor,
        q,
      }: {
        bucketId: string;
        limit?: number | undefined;
        cursor?: string | undefined;
        q?: string | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          const res = yield* api.listBucketFiles(BucketId.make(bucketId), limit, cursor, q);
          // Resolve the size a caller should show — plaintext for private files,
          // stored length for anything without a declared one. `size` and
          // `content_size` stay on each item untouched (COMG-603).
          return { ...res, data: res.data.map(withDisplaySize) };
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "get_file_status",
  {
    title: "Get File Upload Status",
    description:
      "Check the processing state of an in-flight upload. `state` is queued, active, " +
      "completed, or failed. `progress` is 1 once the state is completed, a 0..1 fraction " +
      "while queued or active (absent until the worker reports one), and absent when the " +
      "state is failed, where `error`, when the server reports one, carries the outcome. " +
      "Treat completed and failed as terminal and stop polling; never wait for `progress` " +
      "to reach 1 on its own, and do not assume it only increases: a retried upload reports " +
      "the previous attempt's value until the retry reports its own. A status lookup " +
      "can also stop resolving: Console retains finished upload jobs for a bounded " +
      "window, so a lookup made long after the upload, or on a busy queue, can answer " +
      "not-found. That means the job record aged out, not that the file is gone; " +
      "confirm the file with list_files rather than uploading it again. " +
      "A failed status also carries `condition` and `guidance` (what to do next): " +
      "`daily_limit` means this account's daily funding limit is closed until `error.retry_at`; " +
      "stop uploading to it, and stop any batch, until then (upload_file refuses until that " +
      "time). A `daily_limit` with no `retry_at` means this file alone needs more than the " +
      "whole daily limit: do not retry it, smaller files may still fit. `funding_paused` is service-wide: stop the batch. `storage_cap` needs space " +
      "freed first; `transient` may be retried once; `permanent` must not be retried.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      fileId: z.string().describe("The file's id, from list_files or upload_file."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "get_file_status",
    async ({ bucketId, fileId }: { bucketId: string; fileId: string }, extra: ToolExtra) => {
      return await runPromise(
        Effect.gen(function* () {
          const storage = yield* ConsoleStorageService;
          return yield* storage.getFileStatus(BucketId.make(bucketId), FileId.make(fileId));
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "get_bucket",
  {
    title: "Get Bucket by ID",
    description: "Fetch a single bucket's metadata (name, visibility, sealPolicyId, storage used).",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or create_bucket."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool("get_bucket", async ({ bucketId }: { bucketId: string }, extra: ToolExtra) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getBucketById(BucketId.make(bucketId));
      }),
      extra.signal,
    );
  }),
);

server.registerTool(
  "rename_bucket",
  {
    title: "Rename Bucket",
    description:
      "Renames a bucket. Preserves the bucket's visibility and Seal policy. " +
      "Does NOT rename the files inside it — rename a file individually instead.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      name: z.string().min(1).max(100).describe("The bucket's new name, shown in Console."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool(
    "rename_bucket",
    async ({ bucketId, name }: { bucketId: string; name: string }, extra: ToolExtra) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.renameBucket(BucketId.make(bucketId), name);
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "delete_bucket",
  {
    title: "Delete Bucket",
    description:
      "Permanently deletes a bucket. Irreversible — Console has no undelete. Call " +
      "list_files first, get explicit user confirmation for THIS bucket, then pass " +
      "confirm: true. Refuses the call otherwise.\n\n" +
      "A bucket that still holds files is refused again, with the file count, unless you " +
      "also pass deleteContents: true. Put that count to the user and get a second, " +
      "explicit yes before retrying — do not set deleteContents on your own initiative.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      confirm: confirmDestructive,
      deleteContents: deleteBucketContents,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "delete_bucket",
    async (
      {
        bucketId,
        confirm,
        deleteContents,
      }: { bucketId: string; confirm: true; deleteContents?: true | undefined },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.deleteBucket(BucketId.make(bucketId), {
            confirm,
            deleteContents: deleteContents === true,
          });
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "delete_file",
  {
    title: "Delete File from Bucket",
    description:
      "Permanently deletes a single file from a bucket. Irreversible — Console has no " +
      "undelete. Call list_files first to confirm the fileId, get explicit user confirmation " +
      "for THIS file, then pass confirm: true. Refuses the call otherwise. To delete an " +
      "entire bucket and all its files at once, use delete_bucket instead.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      fileId: z.string().describe("The file's id, from list_files."),
      confirm: confirmDestructive,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "delete_file",
    async (
      { bucketId, fileId }: { bucketId: string; fileId: string; confirm: true },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.deleteBucketFile(BucketId.make(bucketId), FileId.make(fileId));
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "update_file",
  {
    title: "Rename File or Edit Its Description & Tags",
    description:
      "Renames a file and/or edits its description and tags. Supply only the fields you " +
      "want to change — anything omitted is left alone. Pass null to clear a description " +
      "or tags. At least one field is required. A rename can change the file's name but " +
      "not its extension — the extension is fixed at upload and Console refuses a `name` " +
      "whose extension differs from the current one (code: extension_change_not_allowed).",
    inputSchema: {
      fileId: z.string().describe("The file's id, from list_files."),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          "New file name, keeping the current extension. Omit to leave the name unchanged.",
        ),
      description: fileDescriptionSchema.nullable().optional(),
      tags: fileTagsSchema.nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool(
    "update_file",
    async (
      {
        fileId,
        name,
        description,
        tags,
      }: {
        fileId: string;
        name?: string | undefined;
        description?: string | null | undefined;
        tags?: string[] | null | undefined;
      },
      extra: ToolExtra,
    ) => {
      const patch = buildFilePatch({ name, description, tags });
      if (!patch) {
        // Refused here rather than spending a round-trip to be told the same
        // thing — Console rejects a body with none of the three fields.
        throw new Error("Provide at least one of: name, description, tags.");
      }
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.updateFile(FileId.make(fileId), patch);
        }),
        extra.signal,
      );
    },
  ),
);

server.registerTool(
  "get_bucket_metadata",
  {
    title: "Read Bucket Description & Tags",
    description:
      "Reads a bucket's description and tags. These live on a separate endpoint from " +
      "get_bucket, so a bucket read does not include them.",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool("get_bucket_metadata", async ({ bucketId }: { bucketId: string }, extra: ToolExtra) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getBucketMetadata(BucketId.make(bucketId));
      }),
      extra.signal,
    );
  }),
);

server.registerTool(
  "update_bucket_metadata",
  {
    title: "Edit Bucket Description & Tags",
    description:
      "Edits a bucket's description and tags. Supply only what you want to change. " +
      "Unlike update_file, null is not accepted here — send an empty string or an " +
      "empty array to clear. Tags are capped shorter than file tags (24 characters).",
    inputSchema: {
      bucketId: z.string().describe("The bucket's id, from list_buckets or get_bucket."),
      description: bucketDescriptionSchema.optional(),
      tags: bucketTagsSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool(
    "update_bucket_metadata",
    async (
      {
        bucketId,
        description,
        tags,
      }: {
        bucketId: string;
        description?: string | undefined;
        tags?: string[] | undefined;
      },
      extra: ToolExtra,
    ) => {
      const patch = buildBucketMetadataPatch({ description, tags });
      if (!patch) {
        throw new Error("Provide a description and/or tags.");
      }
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.updateBucketMetadata(BucketId.make(bucketId), patch);
        }),
        extra.signal,
      );
    },
  ),
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => {
  void AppRuntime.dispose().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(
  "console-mcp ready (stdio mode) — all tool errors will now be shown clearly in Claude",
);
