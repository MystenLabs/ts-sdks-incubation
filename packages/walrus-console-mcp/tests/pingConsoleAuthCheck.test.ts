import { createServer, type Server, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { isApiKeySet } from "../src/config";
import { STARTUP_CHECK_IN, dropStartupCheckIn } from "./helpers/startupCheckIn";

// COMG-1095: `ping_console` must prove the key with one authenticated Console
// call, not just report that CONSOLE_API_KEY is set. `ok` is true only when
// Console accepts the key; a refusal names the code the real call would return.
//
// Drives the REAL registered handler over real stdio (bin/console-mcp.ts starts
// stdio as a module-level side effect, so it cannot be imported). The fake
// Console is a loopback HTTP server, reached through CONSOLE_API_BASE_URL.
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

const VALID_KEY = "hbr_pingcheck_valid_key_0001";

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

type FakeConsole = {
  readonly baseUrl: string;
  /** Every request the fake received, as "METHOD path". */
  readonly requests: string[];
};

/**
 * A Console that accepts only VALID_KEY on GET /api/v1/spaces. `spaces` is the
 * list it returns to that key; `refuse` replaces the 401 body's code.
 */
async function startFakeConsole(options: {
  readonly spaces: readonly unknown[];
  readonly refuse?: { readonly status: number; readonly code: string };
  /** Replaces the spaces answer entirely: a 500, a dropped socket, a hang, a bad body. */
  readonly spacesAnswer?: (res: ServerResponse) => void;
}): Promise<FakeConsole & { close: () => Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/api/v1/spaces" && options.spacesAnswer !== undefined) {
      options.spacesAnswer(res);
      return;
    }
    const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (req.url !== "/api/v1/spaces") {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (options.refuse !== undefined || bearer !== VALID_KEY) {
      const refusal = options.refuse ?? { status: 401, code: "invalid_api_key" };
      res
        .writeHead(refusal.status, { "content-type": "application/json" })
        .end(JSON.stringify({ code: refusal.code, message: "refused" }));
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: options.spaces }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function pingWith(options: {
  readonly apiKey?: string;
  readonly serviceKey?: string;
  readonly baseUrl: string;
  /** The fake's request log, so the startup check-in can be set aside first. */
  readonly requests?: string[];
}): Promise<Record<string, unknown>> {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-ping-auth-"));
  cleanup.push(async () => fs.rmSync(configHome, { recursive: true, force: true }));

  const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    XDG_CONFIG_HOME: configHome,
    APPDATA: configHome,
    LOCALAPPDATA: configHome,
    CONSOLE_API_BASE_URL: options.baseUrl,
  };
  if (options.apiKey !== undefined) env["CONSOLE_API_KEY"] = options.apiKey;
  if (options.serviceKey !== undefined) env["CONSOLE_SERVICE_PRIVATE_KEY"] = options.serviceKey;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entry],
    env,
    stderr: "ignore",
  });
  cleanup.push(() => transport.close());
  const client = new Client(
    { name: "ping-auth-check-probe", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  // Only a key ping_console would check makes the server check in at startup.
  if (options.requests !== undefined && isApiKeySet(options.apiKey ?? "")) {
    await dropStartupCheckIn(options.requests, (request) => request === STARTUP_CHECK_IN);
  }

  const result = (await client.callTool({
    name: "ping_console",
    arguments: {},
  })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe(
  "ping_console makes one authenticated Console call (COMG-1095)",
  { timeout: 30_000 },
  () => {
    it("reports ok: false with api_error for a Console 500 on the check", async () => {
      const fake = await startFakeConsole({
        spaces: [],
        spacesAnswer: (res) => res.writeHead(500, { "content-type": "text/plain" }).end("boom"),
      });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(false);
      expect(body["api_key_check"]).toMatchObject({ ok: false, error_code: "api_error" });
      expect(body["hint"]).toContain("the key was not checked");
      expect(body["hint"]).not.toContain("Enter a working key");
    });

    it("reports ok: false with request_failed when the connection drops", async () => {
      const fake = await startFakeConsole({
        spaces: [],
        spacesAnswer: (res) => res.socket?.destroy(),
      });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(false);
      expect(body["api_key_check"]).toMatchObject({ ok: false, error_code: "request_failed" });
    }, 20_000);

    it("reports ok: false with invalid_response_shape for a 200 without a data array", async () => {
      const fake = await startFakeConsole({
        spaces: [],
        spacesAnswer: (res) =>
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({})),
      });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(false);
      expect(body["api_key_check"]).toMatchObject({
        ok: false,
        error_code: "invalid_response_shape",
      });
    });

    it("reports ok: false with timeout when Console never answers", async () => {
      const fake = await startFakeConsole({
        spaces: [],
        spacesAnswer: () => {},
      });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(false);
      expect(body["api_key_check"]).toMatchObject({ ok: false, error_code: "timeout" });
      expect(body["hint"]).toContain("the key was not checked");
      expect(body["hint"]).not.toContain("Enter a working key");
    }, 30_000);

    it("reports ok: false with the refusal code for an invalid key", async () => {
      const fake = await startFakeConsole({ spaces: [] });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: "hbr_pingcheck_wrong_key_9999",
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(false);
      expect(body["hint"]).toContain("invalid_api_key");
      expect(body["hint"]).toContain("Enter a working key");
      expect(body["api_key_check"]).toMatchObject({
        ok: false,
        endpoint: "GET /api/v1/spaces",
        error_code: "invalid_api_key",
      });
      expect(fake.requests).toEqual(["GET /api/v1/spaces"]);
    });

    it("reports ok: false with the revoked code Console sends, not invalid_api_key", async () => {
      const fake = await startFakeConsole({
        spaces: [],
        refuse: { status: 401, code: "api_key_revoked" },
      });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(false);
      expect(body["api_key_check"]).toMatchObject({ ok: false, error_code: "api_key_revoked" });
    });

    it("reports ok: true and the spaces it resolved for a valid key", async () => {
      const fake = await startFakeConsole({
        spaces: [{ id: "0xspace-a", name: "Personal", type: "personal" }],
      });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(true);
      expect(body["hint"]).toBe("Ready for Console API calls");
      expect(body["api_key_check"]).toEqual({
        ok: true,
        endpoint: "GET /api/v1/spaces",
        spaces_visible: 1,
        space_ids: ["0xspace-a"],
      });
    });

    it("still reports ok: true for a valid key with no visible resources", async () => {
      const fake = await startFakeConsole({ spaces: [] });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(true);
      expect(body["api_key_check"]).toMatchObject({ ok: true, spaces_visible: 0, space_ids: [] });
    });

    it("names the operations that need a service key when it is missing", async () => {
      const fake = await startFakeConsole({ spaces: [] });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(true);
      expect(body["has_service_key"]).toBe(false);
      expect(body["operations_needing_service_key"]).toEqual([
        "create_bucket",
        "upload_file",
        "download_file",
      ]);
      expect(String(body["service_key_warning"])).toContain("upload_file");
    });

    it("omits the service-key warning once the service key is set", async () => {
      const fake = await startFakeConsole({ spaces: [] });
      cleanup.push(fake.close);

      const body = await pingWith({
        apiKey: VALID_KEY,
        serviceKey: "suiprivkey1qpingcheckfixturenotarealkey000000000000000000",
        baseUrl: fake.baseUrl,
        requests: fake.requests,
      });

      expect(body["ok"]).toBe(true);
      expect(body["has_service_key"]).toBe(true);
      expect(body).not.toHaveProperty("operations_needing_service_key");
      expect(body).not.toHaveProperty("service_key_warning");
    });

    it("makes no Console call and reports ok: false when no key is set", async () => {
      const fake = await startFakeConsole({ spaces: [] });
      cleanup.push(fake.close);

      const body = await pingWith({ baseUrl: fake.baseUrl, requests: fake.requests });

      expect(body["ok"]).toBe(false);
      expect(body["has_api_key"]).toBe(false);
      expect(body).not.toHaveProperty("api_key_check");
      expect(fake.requests).toEqual([]);
    });
  },
);
