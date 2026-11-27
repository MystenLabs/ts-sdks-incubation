import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { STARTUP_CHECK_IN, dropStartupCheckIn } from "./helpers/startupCheckIn";

// COMG-1200. `delete_bucket`, `delete_file` and `download_file` with `overwrite: true` ask a human
// through the client's own UI, the way `generate_api_key` does, on top of the `confirm: true` a
// model can compose itself. Drives the REAL registered handlers over real stdio (bin/console-mcp.ts
// cannot be imported: it starts the server as a side effect), against a loopback Console stand-in
// that records every request and always answers 500, so a request reaching it proves the handler
// went on to act.
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

type ElicitAnswer = { action: string; content?: Record<string, unknown> };

type ProbeOptions = {
  readonly tool: string;
  readonly args: (allowedDir: string) => Record<string, unknown>;
  readonly capabilities: Record<string, unknown>;
  readonly onElicit?: (message: string) => Promise<ElicitAnswer>;
};

type ProbeResult = {
  readonly requests: readonly string[];
  readonly prompts: readonly string[];
  readonly result: CallToolResult;
  readonly allowedDir: string;
};

async function probe(options: ProbeOptions): Promise<ProbeResult> {
  const requests: string[] = [];
  const stub = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "test stub: nothing should actually happen" }));
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

  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-destructive-config-"));
  const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-destructive-dir-"));
  cleanup.push(async () => {
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(allowedDir, { recursive: true, force: true });
  });

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
      CONSOLE_MCP_ALLOWED_DIRS: allowedDir,
    },
    stderr: "ignore",
  });
  cleanup.push(() => transport.close());

  const client = new Client(
    { name: "destructive-tools-probe", version: "0.0.0" },
    { capabilities: options.capabilities },
  );
  const prompts: string[] = [];
  if (options.capabilities["elicitation"] !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      if (options.onElicit === undefined) throw new Error("unexpected elicitation request");
      return await options.onElicit(request.params.message);
    });
  }
  await client.connect(transport);
  await dropStartupCheckIn(requests, (request) => request === STARTUP_CHECK_IN);

  const result = await client.callTool({
    name: options.tool,
    arguments: options.args(allowedDir),
  });
  return { requests, prompts, result: result as CallToolResult, allowedDir };
}

const ELICIT = { elicitation: {} };
const decline = async (): Promise<ElicitAnswer> => ({ action: "decline" });
const accept = async (): Promise<ElicitAnswer> => ({
  action: "accept",
  content: { confirm: true },
});
const acceptUnticked = async (): Promise<ElicitAnswer> => ({
  action: "accept",
  content: { confirm: false },
});

const BUCKET_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

describe.each([
  {
    tool: "delete_bucket",
    method: "DELETE",
    args: () => ({ bucketId: BUCKET_ID, confirm: true }),
    subject: "deletion",
  },
  {
    tool: "delete_file",
    method: "DELETE",
    args: () => ({ bucketId: BUCKET_ID, fileId: FILE_ID, confirm: true }),
    subject: "deletion",
  },
])("$tool asks a human before it acts", { timeout: 30_000 }, ({ tool, method, args, subject }) => {
  it("a decline reaches zero Console requests and says nothing was deleted", async () => {
    const { requests, prompts, result } = await probe({
      tool,
      args,
      capabilities: ELICIT,
      onElicit: decline,
    });

    expect(requests).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({
      ok: false,
      stage: "declined",
      reason: expect.stringContaining(`confirm the ${subject}`),
    });
    expect(textOf(result)).toContain("Nothing was deleted.");
  }, 20_000);

  it("an accept that leaves the box unticked is not a confirmation", async () => {
    const { requests, result } = await probe({
      tool,
      args,
      capabilities: ELICIT,
      onElicit: acceptUnticked,
    });

    expect(requests).toEqual([]);
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, stage: "declined" });
  }, 20_000);

  it("a confirmed accept reaches Console", async () => {
    const { requests, prompts } = await probe({
      tool,
      args,
      capabilities: ELICIT,
      onElicit: accept,
    });

    expect(prompts).toHaveLength(1);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toMatch(new RegExp(`^${method} `));
  }, 20_000);

  it("a client with no elicitation capability falls back to the confirm: true schema gate", async () => {
    const { requests, prompts } = await probe({ tool, args, capabilities: {} });

    expect(prompts).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  }, 20_000);

  it("names the target in the prompt as data, not markup", async () => {
    const hostile = `x"><b>boom</b>`;
    const { prompts } = await probe({
      tool,
      args: () => ({ bucketId: hostile, fileId: hostile, confirm: true }),
      capabilities: ELICIT,
      onElicit: decline,
    });

    expect(prompts[0]).toContain(JSON.stringify(hostile));
  }, 20_000);
});

describe("delete_bucket says when the files go too", { timeout: 30_000 }, () => {
  it("mentions the files in the prompt when deleteContents is set", async () => {
    const { prompts } = await probe({
      tool: "delete_bucket",
      args: () => ({ bucketId: BUCKET_ID, confirm: true, deleteContents: true }),
      capabilities: ELICIT,
      onElicit: decline,
    });

    expect(prompts[0]).toMatch(/every file/i);
  }, 20_000);
});

describe("download_file with overwrite: true", { timeout: 30_000 }, () => {
  const dest = (dir: string, name = "out.txt") => path.join(dir, name);
  const args = (overrides: Record<string, unknown>) => (dir: string) => ({
    bucketId: BUCKET_ID,
    fileId: FILE_ID,
    destPath: dest(dir),
    ...overrides,
  });

  it("is refused without confirm: true, before any prompt or Console request", async () => {
    const { requests, prompts, result } = await probe({
      tool: "download_file",
      args: args({ overwrite: true }),
      capabilities: ELICIT,
      onElicit: accept,
    });

    expect(prompts).toEqual([]);
    expect(requests).toEqual([]);
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("confirm: true");
  }, 20_000);

  it("a decline reaches zero Console requests and names the file it would replace", async () => {
    const { requests, prompts, result, allowedDir } = await probe({
      tool: "download_file",
      args: args({ overwrite: true, confirm: true }),
      capabilities: ELICIT,
      onElicit: decline,
    });

    expect(requests).toEqual([]);
    expect(prompts[0]).toContain(
      JSON.stringify(fs.realpathSync(allowedDir) + path.sep + "out.txt"),
    );
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, stage: "declined" });
    expect(textOf(result)).toContain("Nothing was overwritten.");
  }, 20_000);

  it("a confirmed accept reaches Console", async () => {
    const { requests, prompts } = await probe({
      tool: "download_file",
      args: args({ overwrite: true, confirm: true }),
      capabilities: ELICIT,
      onElicit: accept,
    });

    expect(prompts).toHaveLength(1);
    expect(requests.length).toBeGreaterThan(0);
  }, 20_000);

  it("a client with no elicitation capability falls back to confirm: true", async () => {
    const { requests, prompts } = await probe({
      tool: "download_file",
      args: args({ overwrite: true, confirm: true }),
      capabilities: {},
    });

    expect(prompts).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  }, 20_000);

  it("is refused for a dotfile destination without ever prompting", async () => {
    const { requests, prompts, result } = await probe({
      tool: "download_file",
      args: (dir) => ({
        bucketId: BUCKET_ID,
        fileId: FILE_ID,
        destPath: dest(dir, ".env"),
        overwrite: true,
        confirm: true,
      }),
      capabilities: ELICIT,
      onElicit: accept,
    });

    expect(prompts).toEqual([]);
    expect(requests).toEqual([]);
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain('".env" starts with a dot');
  }, 20_000);
});

describe("download_file without overwrite", { timeout: 30_000 }, () => {
  it("is not prompted and still reaches Console", async () => {
    const { requests, prompts } = await probe({
      tool: "download_file",
      args: (dir) => ({
        bucketId: BUCKET_ID,
        fileId: FILE_ID,
        destPath: path.join(dir, "out.txt"),
      }),
      capabilities: ELICIT,
      onElicit: accept,
    });

    expect(prompts).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  }, 20_000);
});
