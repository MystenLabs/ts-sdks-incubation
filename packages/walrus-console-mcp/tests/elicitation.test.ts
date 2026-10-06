import { describe, expect, it } from "vitest";
import { confirmIrreversibleAction, type ElicitCapableServer } from "../src/elicitation";

// the security review follow-up (COMG-1054) — confirmIrreversibleAction is the piece
// that actually moves an irreversible-action confirmation outside the calling
// model's control, by routing it through the MCP client's own elicitation UI
// rather than a field in the same tool call the model composes.

type ElicitCall = Parameters<ElicitCapableServer["elicitInput"]>;

function fakeServer(opts: {
  capabilities?: { elicitation?: unknown };
  respond?: (...args: ElicitCall) => Promise<{
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  }>;
  calls?: ElicitCall[];
}): ElicitCapableServer {
  return {
    getClientCapabilities: () => opts.capabilities as never,
    elicitInput: (async (...args: ElicitCall) => {
      opts.calls?.push(args);
      if (!opts.respond) throw new Error("elicitInput should not have been called");
      return opts.respond(...args);
    }) as ElicitCapableServer["elicitInput"],
  };
}

describe("confirmIrreversibleAction — no elicitation capability", () => {
  it("returns {gated: false} without calling elicitInput", async () => {
    const calls: ElicitCall[] = [];
    const server = fakeServer({ capabilities: {}, calls });

    const outcome = await confirmIrreversibleAction(server, "Mint a key?");

    expect(outcome).toEqual({ gated: false });
    expect(calls).toHaveLength(0);
  });

  it("also returns {gated: false} when capabilities are entirely absent", async () => {
    const calls: ElicitCall[] = [];
    const server = fakeServer({ calls });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({ gated: false });
    expect(calls).toHaveLength(0);
  });
});

describe("confirmIrreversibleAction — client supports elicitation", () => {
  it("confirms only on an explicit accept carrying confirm: true", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "accept", content: { confirm: true } }),
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: true,
    });
  });

  it("does not confirm on decline", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "decline" }),
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: false,
      action: "decline",
    });
  });

  it("does not confirm on cancel", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "cancel" }),
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: false,
      action: "cancel",
    });
  });

  it("does not confirm an accept with no content", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "accept" }),
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: false,
      action: "accept",
    });
  });

  it("does not confirm an accept whose form carries confirm: false", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "accept", content: { confirm: false } }),
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: false,
      action: "accept",
    });
  });

  it("falls back to the schema gate for a URL-only elicitation client", async () => {
    const calls: ElicitCall[] = [];
    const server = fakeServer({ capabilities: { elicitation: { url: {} } }, calls });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({ gated: false });
    expect(calls).toHaveLength(0);
  });

  it("fails closed as a declined timeout when form elicitation times out", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => {
        throw new Error("Request timed out");
      },
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: false,
      action: "timeout",
    });
  });

  it("fails closed as unavailable when the SDK rejects an elicitation response", async () => {
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => {
        throw new Error("content does not match the requested schema");
      },
    });

    expect(await confirmIrreversibleAction(server, "Mint a key?")).toEqual({
      gated: true,
      confirmed: false,
      action: "unavailable",
    });
  });

  it("sends the caller's message, required boolean schema, signal, and a ten-minute timeout", async () => {
    const calls: ElicitCall[] = [];
    const controller = new AbortController();
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "accept", content: { confirm: true } }),
      calls,
    });

    await confirmIrreversibleAction(server, "Mint a live, billable key?", controller.signal);

    expect(calls).toHaveLength(1);
    const [params, options] = calls[0] ?? [];
    expect(params?.message).toBe("Mint a live, billable key?");
    if (!params || !("requestedSchema" in params)) throw new Error("expected form-mode params");
    expect(params.requestedSchema.required).toContain("confirm");
    expect(params.requestedSchema.properties["confirm"]).toMatchObject({ type: "boolean" });
    expect(options?.signal).toBe(controller.signal);
    expect(options?.timeout).toBe(10 * 60_000);
  });

  it("passes the timeout option even when no abort signal is given", async () => {
    const calls: ElicitCall[] = [];
    const server = fakeServer({
      capabilities: { elicitation: { form: {} } },
      respond: async () => ({ action: "accept", content: { confirm: true } }),
      calls,
    });

    await confirmIrreversibleAction(server, "Mint a key?");

    const [, options] = calls[0] ?? [];
    expect(options).toMatchObject({ timeout: 10 * 60_000 });
    expect(options?.signal).toBeUndefined();
  });
});
