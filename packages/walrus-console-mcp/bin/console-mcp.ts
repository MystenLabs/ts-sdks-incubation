#!/usr/bin/env node

// Route `walrus-console-mcp install` to the interactive installer.
// Must run before any Effect/MCP imports (they are heavy and unneeded for the CLI).
if (process.argv[2] === "install") {
  const { runInstall } = await import("./install.js");
  try {
    await runInstall();
    process.exit(0);
  } catch (err) {
    console.error(err);
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
import { BucketId, FileId, SpaceId } from "../src/console/types";
import { resolvePathWithinRoots } from "../src/pathSandbox";
import {
  formatToolError,
  installLogRedaction,
  redactString,
  registerSecret,
  registerSecretsFromEnv,
} from "../src/redaction";
import { AppRuntime, runPromise } from "../src/runtime";

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
registerSecret(savedConfig.apiKey);
registerSecret(savedConfig.servicePrivateKey);
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
  async () => {
    const result = await runPromise(
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
    );

    return {
      content: [{ type: "text", text: redactString(JSON.stringify(result, null, 2)) }],
    };
  },
);

/**
 * Safe wrapper for all tool handlers.
 * This ensures that any error (including Effect failures, missing keys, API errors, etc.)
 * is turned into a readable message instead of a silent "Result" in Claude Desktop.
 */
function safeTool<Args, T>(toolName: string, handler: (args: Args) => Promise<T>) {
  return async (args: Args) => {
    try {
      const result = await handler(args);
      const raw = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text: redactString(raw) }] };
    } catch (error) {
      // Tagged errors carry their data in fields, not `message` (e.g. KeyActivationError,
      // FileStatusError, SpaceMismatchError all have an empty `.message`). Fall back to a
      // JSON dump of the fields so timeouts/failures stay readable instead of blank.
      let message: string;
      if (error instanceof Error && error.message) {
        message = error.message;
      } else {
        try {
          message = JSON.stringify(error);
        } catch {
          message = String(error);
        }
      }
      const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";

      console.error(`[console-mcp ERROR] Tool "${toolName}" failed:`);
      console.error(error);

      return {
        content: [
          {
            type: "text" as const,
            text: formatToolError(toolName, error),
          },
        ],
      };
    }
  };
}

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
  safeTool("list_spaces", async ({ type }: { type?: "personal" | "team" | undefined }) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.listSpaces({ type });
      }),
    );
  }),
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
  safeTool("get_storage_usage", async () => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getStorageUsage();
      }),
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
    async ({
      spaceId,
      limit,
      q,
    }: {
      spaceId: string;
      limit?: number | undefined;
      q?: string | undefined;
    }) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.listBuckets({ spaceId: SpaceId.make(spaceId), limit, q });
        }),
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
  safeTool("create_bucket", async ({ spaceId, name }: { spaceId: string; name: string }) => {
    return await runPromise(
      Effect.gen(function* () {
        const storage = yield* ConsoleStorageService;
        return yield* storage.createBucket(SpaceId.make(spaceId), name);
      }),
    );
  }),
);

server.registerTool(
  "generate_api_key",
  {
    title: "Generate Console Working API Key (Key-Admin)",
    description:
      "Mint a new Console working API key headlessly using the isolated Key-Admin credential. " +
      "Generates a fresh child keypair locally, mints a scoped hbr_ key, grants it access to the " +
      "space's private buckets, and polls until active. Returns the child apiKey (hbr_…) and " +
      "privateKey (suiprivkey1…) — both shown ONCE; store them securely and never echo them back. " +
      "Requires CONSOLE_ADMIN_KEY + CONSOLE_ADMIN_SERVICE_PRIVATE_KEY; a working key cannot mint. " +
      "The space is fixed by the Key-Admin credential; spaceId is validated against it (mismatch " +
      "fails) rather than selecting the space.",
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
    async ({
      spaceId,
      permission,
      label,
    }: {
      spaceId: string;
      permission: "read_only" | "read_write";
      label?: string | undefined;
    }) => {
      return await runPromise(
        Effect.gen(function* () {
          const keyAdmin = yield* KeyAdminService;
          return yield* keyAdmin.generateApiKey({ spaceId, permission, label });
        }),
      );
    },
  ),
);

server.registerTool(
  "upload_file",
  {
    title: "Upload & Encrypt File",
    description: "Reads a local file, encrypts it with Seal, and uploads it.",
    inputSchema: {
      bucketId: z.string(),
      sealPolicyId: z.string(),
      localPath: z.string(),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  safeTool(
    "upload_file",
    async ({
      bucketId,
      sealPolicyId,
      localPath,
      name,
    }: {
      bucketId: string;
      sealPolicyId: string;
      localPath: string;
      name?: string | undefined;
    }) => {
      const resolvedPath = await resolvePathWithinRoots(server.server, localPath, "Source");
      return await runPromise(
        Effect.gen(function* () {
          const storage = yield* ConsoleStorageService;
          return yield* storage.uploadFileToBucket(
            BucketId.make(bucketId),
            sealPolicyId,
            resolvedPath,
            name,
          );
        }),
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
    async ({
      bucketId,
      fileId,
      sealPolicyId,
      destPath,
    }: {
      bucketId: string;
      fileId: string;
      sealPolicyId: string;
      destPath: string;
    }) => {
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
    async ({
      bucketId,
      limit,
      q,
    }: {
      bucketId: string;
      limit?: number | undefined;
      q?: string | undefined;
    }) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.listBucketFiles(BucketId.make(bucketId), limit, undefined, q);
        }),
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
    async ({ bucketId, fileId }: { bucketId: string; fileId: string }) => {
      return await runPromise(
        Effect.gen(function* () {
          const api = yield* ConsoleApiClient;
          return yield* api.getFileUploadStatus(BucketId.make(bucketId), FileId.make(fileId));
        }),
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
  safeTool("get_bucket", async ({ bucketId }: { bucketId: string }) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getBucketById(BucketId.make(bucketId));
      }),
    );
  }),
);

server.registerTool(
  "rename_bucket",
  {
    title: "Rename Bucket",
    description:
      "Renames a bucket. Preserves the bucket's visibility and Seal policy. " +
      "Does NOT rename files (Console has no file-rename API).",
    inputSchema: {
      bucketId: z.string(),
      name: z.string().min(1).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeTool("rename_bucket", async ({ bucketId, name }: { bucketId: string; name: string }) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.renameBucket(BucketId.make(bucketId), name);
      }),
    );
  }),
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
  safeTool("delete_bucket", async ({ bucketId }: { bucketId: string }) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.deleteBucket(BucketId.make(bucketId));
      }),
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
  safeTool("delete_file", async ({ bucketId, fileId }: { bucketId: string; fileId: string }) => {
    return await runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.deleteBucketFile(BucketId.make(bucketId), FileId.make(fileId));
      }),
    );
  }),
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
