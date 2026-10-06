import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Ten minutes gives a human enough time to read a billing/revocation prompt. */
export const ELICITATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Human-in-the-loop confirmation via MCP elicitation. `confirmDestructive` is a schema-level floor, but a calling
 * model can compose `confirm: true` itself. Elicitation routes the decision to
 * the client's UI, outside that request.
 */

/**
 * The slice of the MCP `Server` this module depends on. `Pick` preserves the
 * SDK's exact request types while keeping this module unit-testable without a
 * real transport.
 */
export type ElicitCapableServer = Pick<Server, "getClientCapabilities" | "elicitInput">;

type ElicitationAction = "accept" | "decline" | "cancel" | "timeout" | "unavailable";

export type ElicitationOutcome =
  // This helper deliberately chooses the schema-gate fallback for a client
  // that cannot render form elicitation. The SDK would throw if we called it.
  | { readonly gated: false }
  | { readonly gated: true; readonly confirmed: true }
  | {
      readonly gated: true;
      readonly confirmed: false;
      readonly action: ElicitationAction;
    };

/** True only when the client advertises the form mode this helper sends. */
function supportsFormElicitation(server: ElicitCapableServer): boolean {
  const elicitation = server.getClientCapabilities()?.elicitation as { form?: unknown } | undefined;
  return elicitation?.form !== undefined;
}

/**
 * Ask a human to confirm an irreversible action through the MCP client's UI.
 * A client without form elicitation receives the existing `confirm: true`
 * schema-gate fallback. A timeout or other elicitation failure is fail-closed:
 * it returns a declined outcome and cannot run the irreversible action.
 *
 * `confirmed` is true only for an explicit `accept` whose content contains
 * `confirm: true`. An accept with no content, `confirm: false`, a decline, or
 * a cancel is not confirmation. A client response with invalid form content is
 * rejected by the SDK before this helper receives it and is reported as
 * `unavailable` here.
 */
export async function confirmIrreversibleAction(
  server: ElicitCapableServer,
  message: string,
  signal?: AbortSignal,
): Promise<ElicitationOutcome> {
  if (!supportsFormElicitation(server)) return { gated: false };

  try {
    const result = await server.elicitInput(
      {
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title: "Confirm",
              description: "Yes, go ahead — I understand this cannot be undone.",
            },
          },
          required: ["confirm"],
        },
      },
      { ...(signal ? { signal } : {}), timeout: ELICITATION_TIMEOUT_MS },
    );

    if (result.action === "accept" && result.content?.["confirm"] === true) {
      return { gated: true, confirmed: true };
    }
    return { gated: true, confirmed: false, action: result.action };
  } catch (error) {
    return {
      gated: true,
      confirmed: false,
      action:
        error instanceof Error && /timed out/i.test(error.message) ? "timeout" : "unavailable",
    };
  }
}

/** The production prompt for generate_api_key, rendered without model-controlled markup. */
export function apiKeyMintConfirmationMessage(args: {
  readonly permission: "read_only" | "read_write";
  readonly label?: string | undefined;
}): string {
  return (
    "Mint a live, billable Console API key" +
    (args.label ? ` labeled ${JSON.stringify(args.label)}` : "") +
    ` (${args.permission})? This cannot be undone by this client — only a human, by ` +
    `hand in the Console UI's Integrations table, can revoke it.`
  );
}

/** Production generate_api_key confirmation path, exported for behavior tests. */
export function confirmApiKeyMint(
  server: ElicitCapableServer,
  args: { readonly permission: "read_only" | "read_write"; readonly label?: string | undefined },
  signal?: AbortSignal,
): Promise<ElicitationOutcome> {
  return confirmIrreversibleAction(server, apiKeyMintConfirmationMessage(args), signal);
}
