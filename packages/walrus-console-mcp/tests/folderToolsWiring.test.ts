import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { STARTUP_CHECK_IN, dropStartupCheckIn } from "./helpers/startupCheckIn";
import { toolRegistrationBlock } from "./toolSource";

// The folder fields between each tool's schema and the Console client. The client methods and
// `moveFile` have their own tests (folders.test.ts); these drive the REAL registered handlers over
// stdio (bin/console-mcp.ts starts the server when imported) against a loopback Console stand-in
// that records each request with its body, so a field the handler drops shows up as a request
// that lacks it.
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

const BUCKET_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_ID = "22222222-2222-4222-8222-222222222222";
const SUB_ID = "33333333-3333-4333-8333-333333333333";
const LEAF_ID = "44444444-4444-4444-8444-444444444444";

interface Seen {
  readonly line: string;
  readonly body: unknown;
}

const folderRecord = (id: string) => ({
  data: {
    id,
    bucket_id: BUCKET_ID,
    parent_folder_id: ROOT_ID,
    name: "reports",
    is_root: false,
    depth: 1,
    status: "active",
    description: null,
    created_at: "2026-11-27T00:00:00.000Z",
    updated_at: "2026-11-27T00:00:00.000Z",
  },
});

function reply(method: string, url: string, rootFolderId: string | null) {
  const bucketPath = `/api/v1/buckets/${BUCKET_ID}`;
  if (method === "GET" && url === bucketPath) {
    return { status: 200, body: { data: { id: BUCKET_ID, root_folder_id: rootFolderId } } };
  }
  if (method === "POST" && url === `${bucketPath}/folders`) {
    return { status: 201, body: folderRecord(LEAF_ID) };
  }
  if (method === "PATCH" && url.startsWith(`${bucketPath}/folders/`)) {
    return { status: 200, body: folderRecord(SUB_ID) };
  }
  if (method === "GET" && url.startsWith(`${bucketPath}/folders/`)) {
    return { status: 200, body: { folders: [], next_cursor: null } };
  }
  return { status: 500, body: { error: "test stub: unexpected request" } };
}

async function call(
  tool: string,
  args: Record<string, unknown>,
  rootFolderId: string | null = ROOT_ID,
): Promise<{ seen: Seen[]; result: CallToolResult }> {
  const seen: Seen[] = [];
  const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf-8")));
    req.on("end", () => {
      const line = `${req.method} ${req.url}`;
      seen.push({ line, body: raw === "" ? undefined : (JSON.parse(raw) as unknown) });
      const { status, body } = reply(req.method ?? "", req.url ?? "", rootFolderId);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(() => new Promise<void>((resolve) => stub.close(() => resolve())));
  const address = stub.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub server did not bind to a TCP port");
  }

  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-folders-config-"));
  cleanup.push(async () => fs.rmSync(configHome, { recursive: true, force: true }));

  const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entry],
    env: {
      PATH: process.env["PATH"] ?? "",
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      LOCALAPPDATA: configHome,
      CONSOLE_API_KEY: "hbr_probe_fake_key_value",
      CONSOLE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    stderr: "ignore",
  });
  cleanup.push(() => transport.close());

  const client = new Client({ name: "folder-tools-probe", version: "0.0.0" });
  await client.connect(transport);
  await dropStartupCheckIn(seen, (s) => s.line === STARTUP_CHECK_IN);

  const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  return { seen, result };
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

describe("folder tools send their folder fields to Console", { timeout: 30_000 }, () => {
  it("create_folder without a parent creates the subfolder under the bucket's root", async () => {
    const { seen, result } = await call("create_folder", { bucketId: BUCKET_ID, name: "reports" });

    expect(result.isError).not.toBe(true);
    expect(seen.find((s) => s.line.startsWith("POST"))?.body).toEqual({
      parentFolderId: ROOT_ID,
      name: "reports",
    });
  });

  it("create_folder with a parent creates the subfolder under it", async () => {
    const { seen, result } = await call("create_folder", {
      bucketId: BUCKET_ID,
      parentFolderId: SUB_ID,
      name: "reports",
    });

    expect(result.isError).not.toBe(true);
    expect(seen.find((s) => s.line.startsWith("POST"))?.body).toEqual({
      parentFolderId: SUB_ID,
      name: "reports",
    });
  });

  it("update_folder sends the root's id when parentFolderId is the bucket id", async () => {
    const { seen, result } = await call("update_folder", {
      bucketId: BUCKET_ID,
      folderId: SUB_ID,
      parentFolderId: BUCKET_ID,
    });

    expect(result.isError).not.toBe(true);
    const patch = seen.find((s) => s.line.startsWith("PATCH"));
    expect(patch?.line).toBe(`PATCH /api/v1/buckets/${BUCKET_ID}/folders/${SUB_ID}`);
    expect(patch?.body).toEqual({ parentFolderId: ROOT_ID });
  });

  it("update_folder with no field to change refuses without a request", async () => {
    const { seen, result } = await call("update_folder", {
      bucketId: BUCKET_ID,
      folderId: SUB_ID,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Provide at least one of");
    expect(seen).toEqual([]);
  });

  it("list_folders on a bucket with no root yet answers empty without a children request", async () => {
    const { seen, result } = await call("list_folders", { bucketId: BUCKET_ID }, null);

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ folder_id: null, folders: [] });
    expect(seen.map((s) => s.line)).toEqual([`GET /api/v1/buckets/${BUCKET_ID}`]);
  });
});

describe("upload_file forwards folderId", () => {
  // An upload over stdio needs Seal key servers and a signing key, so this reads the handler's
  // source instead: the storage call is positional, and a dropped folderId is not a type error,
  // only a file that lands in the root with nothing reporting it.
  it("passes the subfolder as the storage call's last argument", () => {
    const block = toolRegistrationBlock("upload_file");

    expect(block).toMatch(
      /uploadFileToBucket\([^;]*,\s*folderId !== undefined \? FolderId\.make\(folderId\) : undefined,?\s*\)/,
    );
  });
});
