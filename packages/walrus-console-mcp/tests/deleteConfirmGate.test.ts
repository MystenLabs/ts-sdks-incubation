import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { confirmDestructive } from "../src/toolSchemas";

// the security review — follow-up to the review of PR #44.
//
// tests/toolSchemas.test.ts proves `confirmDestructive.safeParse(...)` behaves
// correctly in isolation, and tests/deleteConfirmWiring.test.ts proves the
// string "confirm: confirmDestructive" appears in each delete tool's
// registration. Neither ever drives a real `tools/call`, so neither would
// catch the schema silently becoming unreachable — wrapped in `.partial()` or
// `.catch()`, or an SDK upgrade that stops validating raw-shape input
// schemas — while both of those tests stayed green.
//
// This registers a tool wired the same way `delete_bucket`/`delete_file` are
// (a plain string field plus `confirm: confirmDestructive` in `inputSchema`),
// connects a real Client and McpServer over an in-memory transport, and
// drives an actual `tools/call` for every invalid shape reviewers or a
// prompt-injected agent might try. It asserts both that the call is refused
// AND that the handler never ran — the thing the two narrower tests can't see.

const INVALID_CONFIRM_SHAPES: Array<[label: string, value: unknown]> = [
  ["omitted", undefined],
  ["false", false],
  ['the string "true"', "true"],
  ["the number 1", 1],
  ["null", null],
  ["an empty object", {}],
];

async function buildConnectedPair(handlerRan: { value: boolean }) {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  server.registerTool(
    "delete_thing",
    {
      title: "Delete Thing",
      description: "Test tool mirroring delete_bucket/delete_file's confirm gate.",
      inputSchema: { id: z.string(), confirm: confirmDestructive },
    },
    async ({ id }: { id: string; confirm: true }) => {
      handlerRan.value = true;
      return { content: [{ type: "text" as const, text: `deleted ${id}` }] };
    },
  );

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("confirmDestructive gate — real tools/call over a real transport", () => {
  it.each(INVALID_CONFIRM_SHAPES)(
    "refuses %s without running the handler",
    async (_label, value) => {
      const handlerRan = { value: false };
      const client = await buildConnectedPair(handlerRan);

      const args: Record<string, unknown> = { id: "bucket-1" };
      if (value !== undefined) args["confirm"] = value;

      const result = await client.callTool({ name: "delete_thing", arguments: args });

      expect(result.isError).toBe(true);
      expect(handlerRan.value).toBe(false);
    },
  );

  it("runs the handler when confirm: true", async () => {
    const handlerRan = { value: false };
    const client = await buildConnectedPair(handlerRan);

    const result = await client.callTool({
      name: "delete_thing",
      arguments: { id: "bucket-1", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(handlerRan.value).toBe(true);
  });
});
