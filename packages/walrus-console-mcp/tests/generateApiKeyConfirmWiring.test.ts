import { describe, expect, it } from "vitest";
import { CONSOLE_MCP_SRC, inputSchemaBlockOf, toolRegistrationBlock } from "./toolRegistrationText";

// the security review follow-up (COMG-1054) — generate_api_key mints a live,
// billable credential with no revoke path this client holds (COMG-849's
// out-of-scope note). Two gates are wired into bin/console-mcp.ts:
//
//   1. A schema-level floor (confirmDestructive), matching delete_bucket /
//      delete_file — this is the check below.
//   2. An elicitation gate calling confirmIrreversibleAction before the mint
//      runs, whenever the connected client supports it — covered end-to-end
//      in tests/generateApiKeyElicitationGate.test.ts, since it is a runtime
//      behavior a text scan can't observe.
//
// This file only pins call ORDER by text scan, which review found insufficient
// on its own (a mutant that computes the declined outcome but drops the early
// `return` in front of it survives here and in generateApiKeyElicitationGate's
// demo-tool test, since neither touches the real registered handler's control
// flow). tests/generateApiKeyRegisteredHandler.test.ts closes that gap by
// driving the real handler from source over real stdio and asserting on
// Console request counts across the decline / accept / no-capability /
// no-credential cases.
describe("generate_api_key wires confirmDestructive into its input schema", () => {
  it("requires confirm: confirmDestructive", () => {
    expect(inputSchemaBlockOf(CONSOLE_MCP_SRC, "generate_api_key")).toMatch(
      /confirm:\s*confirmDestructive/,
    );
  });

  it("rejects control characters in a label before it can reach Console or the prompt", () => {
    expect(inputSchemaBlockOf(CONSOLE_MCP_SRC, "generate_api_key")).toMatch(
      /\.regex\(\/\^\\P\{Cc\}\*\$\/u, "label must not contain control characters"\)/,
    );
  });

  it("calls the production confirmation helper before the service mint", () => {
    // Text-only because importing bin/console-mcp.ts starts stdio, but strip
    // comments before checking so documentation cannot satisfy the assertion.
    const handler = toolRegistrationBlock(CONSOLE_MCP_SRC, "generate_api_key").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    const preflightIndex = handler.indexOf("hasAdminCredential(");
    const confirmationIndex = handler.indexOf("confirmApiKeyMint(");
    const mintIndex = handler.indexOf("keyAdmin.generateApiKey(");

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(confirmationIndex).toBeGreaterThan(preflightIndex);
    expect(mintIndex).toBeGreaterThan(confirmationIndex);
  });
});
