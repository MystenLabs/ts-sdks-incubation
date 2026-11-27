import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { dropStartupCheckIn } from "./helpers/startupCheckIn";

/**
 * COMG-1120. The harness's `clientInfo.name` reaches Console as `X-Console-Client-Name`
 * only if the server's initialize hook records it. The unit tests cover the header
 * function, not this wiring, so this drives the real server over stdio.
 */

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function startStub(received: Record<string, string | string[] | undefined>[]): Promise<Server> {
  const stub = createServer((req, res) => {
    if (req.url?.startsWith("/api/v1/spaces")) received.push({ ...req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => resolve(stub));
  });
}

describe("X-Console-Client-Name from the initialize handshake", () => {
  it("sends the harness's clientInfo.name on a Console call", async () => {
    const received: Record<string, string | string[] | undefined>[] = [];
    const stub = await startStub(received);
    cleanup.push(() => new Promise<void>((resolve) => stub.close(() => resolve())));
    const { port } = stub.address() as { port: number };

    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "comg1120-name-config-"));
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "comg1120-name-allowed-"));
    cleanup.push(() => {
      fs.rmSync(configHome, { recursive: true, force: true });
      fs.rmSync(allowed, { recursive: true, force: true });
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
        CONSOLE_API_KEY: "hbr_name_fake_key_value",
        CONSOLE_API_BASE_URL: `http://127.0.0.1:${port}`,
        CONSOLE_MCP_ALLOWED_DIRS: allowed,
      },
      stderr: "ignore",
    });
    const client = new Client(
      { name: "attribution-probe", version: "0.0.0" },
      { capabilities: {} },
    );
    cleanup.push(() => client.close());
    await client.connect(transport);
    // The startup check-in is a Console call too; set it aside so this
    // test still pins the header on a tool's own call.
    await dropStartupCheckIn(received, () => true);

    await client.callTool({ name: "list_spaces", arguments: {} });

    expect(received).toHaveLength(1);
    expect(received[0]?.["x-console-client-name"]).toBe("attribution-probe");
    expect(received[0]?.["x-console-client-runtime"]).toBe("1");
  }, 60_000);
});
