import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_IN_DELAY_MS } from "../src/startupCheckIn";

/**
 * A harness starting the server is enough for Console to record the key:
 * one authenticated call shortly after initialize, with the attribution headers,
 * and no tool call. A health check that closes stdin first sends nothing. Drives
 * the real server over stdio against a stub Console.
 */

/** `hang-first` leaves only the first request (the check-in) unanswered. */
type Mode = "ok" | "error" | "hang" | "hang-first";

interface Stub {
  readonly port: number;
  readonly received: IncomingHttpHeaders[];
  /** Times at which a request left unanswered had its socket dropped by the server. */
  readonly dropped: number[];
  /** TCP connections opened, including any dropped before a request was written. */
  readonly connections: { count: number };
}

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function startStub(mode: { current: Mode }): Promise<Stub> {
  const received: IncomingHttpHeaders[] = [];
  const dropped: number[] = [];
  const stub: Server = createServer((req, res) => {
    if (!req.url?.startsWith("/api/v1/spaces")) {
      res.writeHead(404).end();
      return;
    }
    received.push({ ...req.headers });
    if (mode.current === "hang" || (mode.current === "hang-first" && received.length === 1)) {
      res.on("close", () => dropped.push(Date.now()));
      return;
    }
    if (mode.current === "error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal_error", message: "down" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  const connections = { count: 0 };
  stub.on("connection", () => connections.count++);
  await new Promise<void>((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        stub.closeAllConnections();
        stub.close(() => resolve());
      }),
  );
  return { port: (stub.address() as { port: number }).port, received, dropped, connections };
}

interface ServerOptions {
  /** Env overrides; `undefined` removes the variable. */
  readonly env?: Record<string, string | undefined>;
}

async function startServer(port: number, options: ServerOptions = {}) {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "startup-checkin-config-"));
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "startup-checkin-allowed-"));
  cleanup.push(() => {
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(allowed, { recursive: true, force: true });
  });
  const env: Record<string, string> = {};
  const merged: Record<string, string | undefined> = {
    PATH: process.env["PATH"] ?? "",
    XDG_CONFIG_HOME: configHome,
    APPDATA: configHome,
    LOCALAPPDATA: configHome,
    CONSOLE_API_KEY: "hbr_checkin_fake_key_value",
    CONSOLE_API_BASE_URL: `http://127.0.0.1:${port}`,
    CONSOLE_MCP_ALLOWED_DIRS: allowed,
    WALRUS_MCP_CLIENT: "cursor",
    ...options.env,
  };
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) env[key] = value;

  const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entry],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "checkin-probe", version: "0.0.0" }, { capabilities: {} });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, configHome, stderr: () => stderr };
}

async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toolJson = (result: unknown) =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");

describe("startup check-in", () => {
  it("records the key on start, with no tool call, carrying the attribution headers", async () => {
    const stub = await startStub({ current: "ok" });

    await startServer(stub.port);
    await waitFor(() => stub.received.length > 0);
    await sleep(300);

    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]?.["authorization"]).toBe("Bearer hbr_checkin_fake_key_value");
    expect(stub.received[0]?.["x-console-client-runtime"]).toBe("1");
    expect(stub.received[0]?.["x-console-client-target"]).toBe("cursor");
    expect(stub.received[0]?.["x-console-client-name"]).toBe("checkin-probe");
  }, 60_000);

  it("sends nothing for a health check that closes stdin right after tools/list", async () => {
    const stub = await startStub({ current: "ok" });

    // What `claude mcp list` does: initialize, tools/list, then close stdin.
    const { client } = await startServer(stub.port);
    await client.listTools();
    await client.close();
    await sleep(4_000);

    // Connections, not requests: closing stdin can cancel a call before its request
    // is written, so an empty `received` alone would not show the delay held it back.
    expect(stub.connections.count).toBe(0);
    expect(stub.received).toHaveLength(0);
  }, 60_000);

  it("makes no request without an API key", async () => {
    const stub = await startStub({ current: "ok" });

    const { client } = await startServer(stub.port, { env: { CONSOLE_API_KEY: "" } });
    await client.listTools();
    await sleep(CHECK_IN_DELAY_MS + 500);

    expect(stub.received).toHaveLength(0);
  }, 60_000);

  it("keeps serving when Console fails the check-in, and ping_console still checks the key", async () => {
    const mode = { current: "error" as Mode };
    const stub = await startStub(mode);

    const { client } = await startServer(stub.port);
    await waitFor(() => stub.received.length > 0);
    mode.current = "ok";

    const ping = await client.callTool({ name: "ping_console", arguments: {} });
    expect(toolJson(ping).ok).toBe(true);
    expect(stub.received).toHaveLength(2);
  }, 60_000);

  it("does not hold up a tool that calls Console while the check-in hangs", async () => {
    const stub = await startStub({ current: "hang-first" });

    const { client } = await startServer(stub.port);
    await waitFor(() => stub.received.length > 0);

    const started = Date.now();
    const spaces = await client.callTool({ name: "list_spaces", arguments: {} });
    expect(spaces.isError).not.toBe(true);
    expect(stub.received).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 60_000);

  it("gives up on a Console that never answers after 10 seconds, and says so", async () => {
    const stub = await startStub({ current: "hang" });

    const server = await startServer(stub.port);
    await waitFor(() => stub.received.length > 0);
    await waitFor(() => server.stderr().includes("no answer within 10 seconds"), 15_000);

    expect(stub.dropped).toHaveLength(1);
  }, 60_000);

  it("drops a hanging check-in as soon as stdin closes", async () => {
    const stub = await startStub({ current: "hang" });

    const { client } = await startServer(stub.port);
    await waitFor(() => stub.received.length > 0);
    const closedAt = Date.now();
    // Do not await: close() waits for the process, which is what is measured.
    void client.close();
    await waitFor(() => stub.dropped.length > 0, 5_000);

    // Well under the 2 s after which the SDK's close() falls back to SIGTERM.
    expect((stub.dropped[0] ?? Infinity) - closedAt).toBeLessThan(1_000);
  }, 60_000);

  it("reads a key saved after the server started", async () => {
    const stub = await startStub({ current: "ok" });

    const { client, configHome } = await startServer(stub.port, {
      env: { CONSOLE_API_KEY: undefined },
    });
    await sleep(CHECK_IN_DELAY_MS + 500);
    expect(stub.received).toHaveLength(0);

    const dir = path.join(configHome, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_saved_later_key_value" }),
    );
    const ping = await client.callTool({ name: "ping_console", arguments: {} });

    expect(toolJson(ping).has_api_key).toBe(true);
    expect(toolJson(ping).ok).toBe(true);
    expect(stub.received.at(-1)?.["authorization"]).toBe("Bearer hbr_saved_later_key_value");
  }, 60_000);
});
