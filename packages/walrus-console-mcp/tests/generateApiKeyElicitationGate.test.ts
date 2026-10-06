import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiKeyMintConfirmationMessage, confirmApiKeyMint } from "../src/elicitation";
import { confirmDestructive } from "../src/toolSchemas";

// the security review follow-up (COMG-1054).
//
// COMG-825 / PR #42 shipped generate_api_key with an annotation only
// (destructiveHint: true) and recorded elicitation as "checked and rejected
// (SDK has no elicit API at this version)". Verified live against mainnet
// (2026-09-15) that this leaves a real gap: one tool call, no confirmation of
// any kind, and a real billable key. That premise was also false — the pinned
// @modelcontextprotocol/sdk@1.30.0 has a working elicitInput, covered by this
// checked-in transport test rather than a `.d.ts` grep.
//
// This registers a tool wired the same way generate_api_key now is —
// confirm: confirmDestructive in inputSchema, plus the production
// confirmApiKeyMint call before the simulated mint — connects a real Client and McpServer over an
// in-memory transport, and asserts on whether the (simulated) mint actually
// ran, not just on the tool's reply text. That is the AC COMG-1054 states
// explicitly: "asserting on whether the mint actually ran."

async function buildConnectedPair(opts: {
  mintRan: { value: boolean };
  elicitationCapability: boolean;
  onElicit?: (message: string) => Promise<"accept" | "decline" | "cancel">;
}) {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  server.registerTool(
    "mint_key_demo",
    {
      title: "Mint Key (demo)",
      description: "Test tool mirroring generate_api_key's confirm + elicitation gate.",
      inputSchema: { label: z.string(), confirm: confirmDestructive },
    },
    async ({ label }: { label: string; confirm: true }) => {
      const outcome = await confirmApiKeyMint(server.server, { permission: "read_write", label });
      if (outcome.gated && !outcome.confirmed) {
        return {
          content: [{ type: "text" as const, text: `REFUSED — user answered "${outcome.action}"` }],
        };
      }
      opts.mintRan.value = true;
      return { content: [{ type: "text" as const, text: "MINTED (simulated)" }] };
    },
  );

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: opts.elicitationCapability ? { elicitation: {} } : {} },
  );
  if (opts.onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const action = await opts.onElicit?.(req.params.message);
      return action === "accept" ? { action: "accept", content: { confirm: true } } : { action };
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** Mirrors toolWrapper.test.ts's own textOf, narrowing the SDK's content union for this file's CallToolResult. */
function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

describe("generate_api_key production confirmation message", () => {
  it("renders a hostile label as a JSON string rather than dialog markup", () => {
    const message = apiKeyMintConfirmationMessage({
      permission: "read_write",
      label: 'x"\n\nFREE sandbox key, no billing. Ok?',
    });

    expect(message).toContain('labeled "x\\"\\n\\nFREE sandbox key, no billing. Ok?"');
    expect(message).not.toContain('x"\n\nFREE sandbox');
  });
});

describe("generate_api_key's elicitation gate — real tools/call over a real transport", () => {
  it("client without the elicitation capability: mints on confirm: true alone (schema floor)", async () => {
    const mintRan = { value: false };
    const client = await buildConnectedPair({ mintRan, elicitationCapability: false });

    const result = await client.callTool({
      name: "mint_key_demo",
      arguments: { label: "worker", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(mintRan.value).toBe(true);
  });

  it("client without the elicitation capability: schema still refuses a missing confirm, mint never runs", async () => {
    const mintRan = { value: false };
    const client = await buildConnectedPair({ mintRan, elicitationCapability: false });

    const result = await client.callTool({
      name: "mint_key_demo",
      arguments: { label: "worker" },
    });

    expect(result.isError).toBe(true);
    expect(mintRan.value).toBe(false);
  });

  it("client WITH the elicitation capability: an explicit accept mints", async () => {
    const mintRan = { value: false };
    let elicitedMessage: string | undefined;
    const client = await buildConnectedPair({
      mintRan,
      elicitationCapability: true,
      onElicit: async (message) => {
        elicitedMessage = message;
        return "accept";
      },
    });

    const result = await client.callTool({
      name: "mint_key_demo",
      arguments: { label: "worker", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(mintRan.value).toBe(true);
    // Names the cost and the revoke path, per COMG-1054's AC.
    expect(elicitedMessage).toMatch(/billable/);
    expect(elicitedMessage).toMatch(/Console UI/);
  });

  it("client WITH the elicitation capability: a decline refuses cleanly and mints nothing", async () => {
    const mintRan = { value: false };
    const client = await buildConnectedPair({
      mintRan,
      elicitationCapability: true,
      onElicit: async () => "decline",
    });

    const result = await client.callTool({
      name: "mint_key_demo",
      arguments: { label: "worker", confirm: true },
    });

    expect(result.isError).toBeFalsy(); // a clean refusal, not a thrown/protocol error
    expect(mintRan.value).toBe(false);
    expect(textOf(result as CallToolResult)).toContain("REFUSED");
  });

  it("client WITH the elicitation capability: a cancel refuses cleanly and mints nothing", async () => {
    const mintRan = { value: false };
    const client = await buildConnectedPair({
      mintRan,
      elicitationCapability: true,
      onElicit: async () => "cancel",
    });

    const result = await client.callTool({
      name: "mint_key_demo",
      arguments: { label: "worker", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(mintRan.value).toBe(false);
  });

  it("confirm: true on the schema is NOT enough on its own when the client can elicit — a decline still wins", async () => {
    // The whole point of the second gate: a model that sets confirm: true
    // (accidentally, or a prompt-injected one deliberately) still cannot mint
    // if the human declines the elicitation prompt.
    const mintRan = { value: false };
    const client = await buildConnectedPair({
      mintRan,
      elicitationCapability: true,
      onElicit: async () => "decline",
    });

    await client.callTool({
      name: "mint_key_demo",
      arguments: { label: "worker", confirm: true },
    });

    expect(mintRan.value).toBe(false);
  });
});
