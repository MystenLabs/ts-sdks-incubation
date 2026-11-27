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

/** The result a tool returns when the human did not confirm, in place of acting. */
export interface ConfirmationDeclined {
  readonly ok: false;
  readonly stage: "declined";
  readonly reason: string;
}

/**
 * Turn an elicitation outcome into the refusal a tool returns, or `undefined` when the action may
 * go ahead (confirmed, or the client cannot prompt and the schema `confirm: true` stands alone).
 * `subject` names the action ("mint", "deletion") and `done` what did not happen ("minted").
 */
export function declinedOutcome(
  outcome: ElicitationOutcome,
  subject: string,
  done: string,
): ConfirmationDeclined | undefined {
  if (!outcome.gated || outcome.confirmed) return undefined;
  const nothing = `Nothing was ${done}.`;
  const reason =
    outcome.action === "timeout"
      ? `The user did not answer the ${subject} confirmation prompt before it timed out. ${nothing}`
      : outcome.action === "unavailable"
        ? `The ${subject} confirmation prompt did not complete. ${nothing}`
        : outcome.action === "accept"
          ? `The user accepted the prompt without checking its confirmation box. ${nothing}`
          : `The user did not confirm the ${subject} through the client's elicitation UI (answered "${outcome.action}"). ${nothing}`;
  return { ok: false, stage: "declined", reason };
}

/** The prompt for delete_bucket. Model-controlled values are rendered as JSON strings. */
export function deleteBucketConfirmationMessage(args: {
  readonly bucketId: string;
  readonly deleteContents: boolean;
}): string {
  return (
    `Permanently delete bucket ${JSON.stringify(args.bucketId)}` +
    (args.deleteContents ? " and every file in it" : "") +
    "? Console has no undelete."
  );
}

/** The prompt for delete_file. */
export function deleteFileConfirmationMessage(args: {
  readonly bucketId: string;
  readonly fileId: string;
}): string {
  return (
    `Permanently delete file ${JSON.stringify(args.fileId)} from bucket ` +
    `${JSON.stringify(args.bucketId)}? Console has no undelete.`
  );
}

/** The prompt for download_file with overwrite: true. `destPath` is the resolved path. */
export function overwriteConfirmationMessage(args: { readonly destPath: string }): string {
  return (
    `Replace ${JSON.stringify(args.destPath)} with a downloaded file? If a file is already ` +
    "there, its contents are lost."
  );
}
