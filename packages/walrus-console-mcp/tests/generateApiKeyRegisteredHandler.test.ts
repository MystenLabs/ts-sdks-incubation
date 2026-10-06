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

// the security review follow-up (COMG-1054), PR #66 review.
//
// generateApiKeyConfirmWiring.test.ts pins call ORDER (preflight → confirm →
// mint) via a text scan; generateApiKeyElicitationGate.test.ts proves the gate
// LOGIC works, but against a demo tool that mirrors the real gate rather than
// the registered generate_api_key handler (bin/console-mcp.ts can't be
// imported directly in a test — it starts stdio as a module-level side
// effect). Neither catches a mutant that keeps a gate, keeps the ordering,
// computes an outcome for it to return — and then falls through past that
// `return` to the mint anyway.
//
// This drives the REAL registered handler over real stdio: it spawns the
// server straight from source with `tsx` (the same loader `pnpm dev` uses),
// not `dist/console-mcp.js`, so a local run always reflects current source
// with no `pnpm build` step first and no way for a stale build to go green
// against a broken handler.
//
// Four cases exercise every branch the handler's two gates (the Key-Admin
// pre-flight, then the elicitation confirm) can take:
//   - decline:        confirmed prompt says no  → 0 Console requests
//   - accept:          confirmed prompt says yes → 1 Console request
//   - no capability:  client can't be prompted   → schema gate alone lets the
//                      mint through              → 1 Console request
//   - no credential:  pre-flight fails first     → 0 elicitation requests,
//                      0 Console requests
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

/** Mirrors toolWrapper.test.ts's own textOf, narrowing the SDK's content union for this file's CallToolResult. */
function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

type ProbeOptions = {
  /** Omit to test a host with no Key-Admin pair at all. */
  readonly credentials: { readonly key: string; readonly servicePrivateKey: string } | null;
  readonly capabilities: Record<string, unknown>;
  readonly onElicit: () => Promise<{ action: string; content?: Record<string, unknown> }>;
};

type ProbeResult = {
  readonly requests: readonly string[];
  readonly elicitCalls: number;
  readonly result: CallToolResult;
};

/**
 * Spawns the real registered generate_api_key handler over real stdio against
 * a loopback Console stand-in, and drives one call through it.
 *
 * The stub always answers 500, so a request reaching it proves the handler
 * tried to mint, without any real key material or billable resource ever
 * being at risk: `createApiKey`'s first call is reachable with garbage
 * Key-Admin credentials (nothing upstream decodes or verifies their format),
 * and the child signer minted under them is a freshly generated keypair
 * unrelated to the admin pair's format.
 */
async function probeGenerateApiKey(options: ProbeOptions): Promise<ProbeResult> {
  const requests: string[] = [];
  const stub = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "test stub: nothing should actually be minted" }));
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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // A throwaway, empty config dir on every platform this can run on: keeps
  // this test from ever reading (or being influenced by) whatever real
  // config.json/admin.json happen to be installed on the machine running it.
  // XDG_CONFIG_HOME covers macOS/Linux; getConfigDir() (src/configFile.ts)
  // reads APPDATA instead on Windows and ignores XDG_CONFIG_HOME there, and
  // the SDK forwards the host's real APPDATA/LOCALAPPDATA by default unless
  // overridden here — so both are pointed at the same throwaway dir too.
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-generate-api-key-handler-"));
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
      ...(options.credentials
        ? {
            CONSOLE_ADMIN_KEY: options.credentials.key,
            CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: options.credentials.servicePrivateKey,
          }
        : {}),
      CONSOLE_API_BASE_URL: baseUrl,
    },
    stderr: "ignore",
  });
  cleanup.push(() => transport.close());

  const client = new Client(
    { name: "generate-api-key-handler-probe", version: "0.0.0" },
    { capabilities: options.capabilities },
  );
  let elicitCalls = 0;
  // The SDK refuses to register a handler for a capability the client didn't
  // declare (assertRequestHandlerCapability) — matching the "no capability"
  // case exactly. If the server sends elicitation/create anyway despite the
  // client not advertising it, the SDK answers "Method not found" on its own,
  // which confirmIrreversibleAction's catch turns into an "unavailable"
  // decline: still a real, assertable regression (requests would come back
  // empty instead of holding a mint attempt), just not a thrown error here.
  if (options.capabilities["elicitation"] !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitCalls++;
      return await options.onElicit();
    });
  }
  await client.connect(transport);

  const result = await client.callTool({
    name: "generate_api_key",
    arguments: { permission: "read_write", label: "generate-api-key-handler-probe", confirm: true },
  });

  return { requests, elicitCalls, result: result as CallToolResult };
}

const fakeCredentials = { key: "hbradm_probe_fake", servicePrivateKey: "suiprivkey1_probe_fake" };

const refuseElicit = async (): Promise<never> => {
  throw new Error("elicitation must not be requested in this case");
};

describe("generate_api_key's real registered handler", () => {
  it("a decline reaches zero Console requests", async () => {
    const { requests, elicitCalls, result } = await probeGenerateApiKey({
      credentials: fakeCredentials,
      capabilities: { elicitation: {} },
      onElicit: async () => ({ action: "decline" }),
    });

    // The actual point of this case, checked first so a regression's
    // failure message says the real thing ("Console was called") rather
    // than whatever secondary symptom (an isError from the stub's 500,
    // here) that call happened to also produce: with the pre-flight's and
    // the confirm gate's `return`s both in place, nothing reaches Console.
    // Drop either one and this fails with a recorded request instead of an
    // empty array.
    expect(requests).toEqual([]);
    expect(elicitCalls).toBe(1);

    expect(result.isError).toBeFalsy();
    // Pinned on "decline" specifically, not just `stage: "declined"`: a
    // prompt that never got answered (timeout/unavailable) maps to the
    // same stage, so a mutant that stops answering the prompt at all would
    // still pass an assertion that only checked `stage`.
    expect(JSON.parse(textOf(result))).toMatchObject({
      ok: false,
      stage: "declined",
      reason: expect.stringContaining('answered "decline"'),
    });
  }, 20_000);

  it("a confirmed accept reaches exactly one Console request", async () => {
    const { requests, elicitCalls, result } = await probeGenerateApiKey({
      credentials: fakeCredentials,
      capabilities: { elicitation: {} },
      onElicit: async () => ({ action: "accept", content: { confirm: true } }),
    });

    expect(elicitCalls).toBe(1);
    expect(requests).toEqual(["POST /api/v1/api-keys"]);
    // The stub answers 500, so the mint itself fails — but only after
    // reaching Console, which is the thing this case exists to prove.
    expect(result.isError).toBeTruthy();
  }, 20_000);

  it("a client with no elicitation capability falls through to the confirm:true schema gate and still reaches Console", async () => {
    const { requests, elicitCalls, result } = await probeGenerateApiKey({
      credentials: fakeCredentials,
      capabilities: {},
      onElicit: refuseElicit,
    });

    // No form-elicitation capability means the server never sends a
    // prompt at all (confirmIrreversibleAction's own gated:false path) —
    // it relies on the schema-level confirm:true the tool call already
    // carries. probeGenerateApiKey doesn't even register an elicitation
    // handler here, matching what a real client without the capability
    // looks like (the SDK refuses to register one otherwise); if the
    // server ever sent a prompt despite that, the SDK would answer "Method
    // not found" on its own, which confirmIrreversibleAction's catch turns
    // into a declined outcome — so `requests` coming back empty is what
    // that regression would actually look like here, not a thrown error.
    expect(elicitCalls).toBe(0);
    expect(requests).toEqual(["POST /api/v1/api-keys"]);
    expect(result.isError).toBeTruthy();
  }, 20_000);

  it("a host with no Key-Admin pair is refused before any prompt or Console request", async () => {
    const { requests, elicitCalls, result } = await probeGenerateApiKey({
      credentials: null,
      capabilities: { elicitation: {} },
      onElicit: refuseElicit,
    });

    // The pre-flight's early return is what this case pins: drop it and a
    // human gets prompted before the (still-enforced, by KeyAdminService)
    // refusal — bad UX, not a security hole, but exactly the regression
    // the review flagged as untested. refuseElicit would throw if the
    // prompt is ever reached here.
    expect(elicitCalls).toBe(0);
    expect(requests).toEqual([]);
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("Key-Admin credential");
  }, 20_000);
});
