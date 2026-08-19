#!/usr/bin/env node

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
  registerConfigFileSecrets(loadConfigFile());
  installLogRedaction();

  const { runInstall } = await import("./install.js");
  try {
    await runInstall(process.argv.slice(3));
    process.exit(0);
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
  registerConfigFileSecrets(loadConfigFile());
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, Redacted } from "effect";
import { z } from "zod";
import {
  ConsoleConfigTag,
  getRawAdminKey,
  getRawAdminServiceKey,
  getRawServiceKey,
} from "../src/config";
import { loadConfigFile } from "../src/configFile";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService } from "../src/console/ConsoleStorageService";
import { KeyAdminService } from "../src/console/KeyAdminService";
import {
  bucketDescriptionSchema,
  bucketTagsSchema,
  buildBucketMetadataPatch,
  buildFilePatch,
  fileDescriptionSchema,
  fileTagsSchema,
} from "../src/console/fileMetadata";
import { BucketId, FileId, SpaceId, withDisplaySize } from "../src/console/types";
import { resolvePathWithinRoots } from "../src/pathSandbox";
import {
  installLogRedaction,
  registerConfigFileSecrets,
  registerSecretsFromEnv,
} from "../src/redaction";
import { AppRuntime, runPromise } from "../src/runtime";
import { safeTool } from "../src/toolWrapper";

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
const savedConfig = loadConfigFile();
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
      "Use list_spaces / list_buckets / search_files before mutating. " +
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
        return {
          ok: hasKey,
          has_api_key: hasKey,
          has_service_key: hasSvc,
          // Key-Admin presence (booleans only — never leak the secret values).
          has_admin_key: hasAdminKey,
          has_admin_signer: hasAdminSigner,
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
    description: "List your Personal and Team spaces in Console.",
    inputSchema: { type: z.enum(["personal", "team"]).optional() },
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
      "Get aggregated storage usage (bytes used, cap, available, and percent used) for your active Console space.",
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
    description: "List buckets in a space.",
    inputSchema: {
      spaceId: z.string(),
      limit: z.number().optional(),
      q: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "list_buckets",
    async (
      {
        spaceId,
        limit,
        q,
      }: {
        spaceId: string;
        limit?: number | undefined;
        q?: string | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.listBuckets({ spaceId: SpaceId.make(spaceId), limit, q });
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
    description: "Creates a new Seal-encrypted bucket. Returns sealPolicyId (save it!).",
    inputSchema: {
      spaceId: z.string(),
      name: z.string().min(1).max(100),
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
      "Mint a new Console working API key headlessly using the isolated Key-Admin credential. " +
      "Generates a fresh child keypair locally, mints a scoped hbr_ key, grants it access to the " +
      "space's private buckets, and polls until active. " +
      "Requires CONSOLE_ADMIN_KEY + CONSOLE_ADMIN_SERVICE_PRIVATE_KEY; a working key cannot mint. " +
      "The space is fixed by the Key-Admin credential; spaceId is checked against it, but only " +
      "AFTER the mint — the Key-Admin credential has no data-plane access, so the space cannot be " +
      "read beforehand. " +
      "Returns { ok, credential } where credential holds apiKey (hbr_…) and privateKey " +
      "(suiprivkey1…) — both shown ONCE; store them securely and never echo them back. " +
      "IMPORTANT: ok:false still carries a real, live credential. The mint had already succeeded " +
      "and a later step failed, so `stage` says which and `recovery` says what to do. Do NOT call " +
      "this tool again to retry an ok:false result — the key already exists, and retrying mints a " +
      "second one while orphaning the first.",
    inputSchema: {
      spaceId: z
        .string()
        .describe("Expected space UUID — validated against the Key-Admin credential's scope."),
      permission: z.enum(["read_only", "read_write"]),
      label: z.string().max(64).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool(
    "generate_api_key",
    async (
      {
        spaceId,
        permission,
        label,
      }: {
        spaceId: string;
        permission: "read_only" | "read_write";
        label?: string | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const keyAdmin = yield* KeyAdminService;
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
      "Reads a local file, encrypts it with Seal, and uploads it. " +
      "Optionally attaches a description and tags, which are searchable in Console.",
    inputSchema: {
      bucketId: z.string(),
      sealPolicyId: z.string(),
      localPath: z.string(),
      name: z.string().optional(),
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
        sealPolicyId: string;
        localPath: string;
        name?: string | undefined;
        description?: string | undefined;
        tags?: string[] | undefined;
      },
      extra: ToolExtra,
    ) => {
      const resolvedPath = await resolvePathWithinRoots(server.server, localPath, "Source");
      return await runPromise(
        Effect.gen(function* () {
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
    description: "Downloads a file, decrypts it, and saves it to the path you specify.",
    inputSchema: {
      bucketId: z.string(),
      fileId: z.string(),
      sealPolicyId: z.string(),
      destPath: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool(
    "download_file",
    async (
      {
        bucketId,
        fileId,
        sealPolicyId,
        destPath,
      }: {
        bucketId: string;
        fileId: string;
        sealPolicyId: string;
        destPath: string;
      },
      extra: ToolExtra,
    ) => {
      const resolvedPath = await resolvePathWithinRoots(server.server, destPath, "Destination");
      return await runPromise(
        Effect.gen(function* () {
          const storage = yield* ConsoleStorageService;
          return yield* storage.downloadFile(
            BucketId.make(bucketId),
            FileId.make(fileId),
            sealPolicyId,
            resolvedPath,
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
    description: "List files inside a specific bucket (supports search).",
    inputSchema: {
      bucketId: z.string(),
      limit: z.number().optional(),
      q: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "list_files",
    async (
      {
        bucketId,
        limit,
        q,
      }: {
        bucketId: string;
        limit?: number | undefined;
        q?: string | undefined;
      },
      extra: ToolExtra,
    ) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          const res = yield* api.listBucketFiles(BucketId.make(bucketId), limit, undefined, q);
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
      "Check the processing state of an in-flight upload (queued / active / completed / failed).",
    inputSchema: {
      bucketId: z.string(),
      fileId: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  safeTool(
    "get_file_status",
    async ({ bucketId, fileId }: { bucketId: string; fileId: string }, extra: ToolExtra) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.getFileUploadStatus(BucketId.make(bucketId), FileId.make(fileId));
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
      bucketId: z.string(),
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
      bucketId: z.string(),
      name: z.string().min(1).max(100),
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
      "Permanently deletes a bucket and all of its files. Irreversible. " +
      "Confirm with the user and list_files first.",
    inputSchema: {
      bucketId: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool("delete_bucket", async ({ bucketId }: { bucketId: string }, extra: ToolExtra) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.deleteBucket(BucketId.make(bucketId));
      }),
      extra.signal,
    );
  }),
);

server.registerTool(
  "delete_file",
  {
    title: "Delete File from Bucket",
    description:
      "Permanently deletes a single file from a bucket. Irreversible. " +
      "Call list_files first to confirm the fileId. To delete an entire bucket and all its files at once, use delete_bucket instead.",
    inputSchema: {
      bucketId: z.string(),
      fileId: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "delete_file",
    async ({ bucketId, fileId }: { bucketId: string; fileId: string }, extra: ToolExtra) => {
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
      "or tags. At least one field is required.",
    inputSchema: {
      fileId: z.string(),
      name: z.string().min(1).optional(),
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
    inputSchema: { bucketId: z.string() },
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
      bucketId: z.string(),
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
