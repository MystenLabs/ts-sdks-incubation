import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { KEY_ADMIN_PIN_REMEDY, WEB_ACCOUNT_PIN_REMEDY } from "../src/console/pinRemedy";

// COMG-851 follow-up on PR #54: create_bucket's description is what the model
// reads before it calls the tool, so it has to name the same remedies the
// refusals do — the extension's form field first. Before this, it named only
// CONSOLE_WEB_ACCOUNT_ADDRESS and `config` (neither of which a Claude Desktop
// user can act on), and said nothing of the Key-Admin pin at all.

describe("create_bucket's description", () => {
  it("names the form fields that fix both pin refusals, as registered", async () => {
    // bin/console-mcp.ts starts stdio as a module-level side effect, so it is
    // launched rather than imported (as in pingConsoleAllowedDirs.test.ts).
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-create-bucket-desc-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url))],
      env: {
        PATH: process.env["PATH"] ?? "",
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        LOCALAPPDATA: configHome,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "create-bucket-description", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const description = tools.find((t) => t.name === "create_bucket")?.description ?? "";
      expect(description).toContain(WEB_ACCOUNT_PIN_REMEDY);
      expect(description).toContain(KEY_ADMIN_PIN_REMEDY);
    } finally {
      await transport.close();
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  }, 20_000);

  // The .mcpb listing text. Desktop users set both pins only in the form, so
  // that is all it should point at.
  it("points the .mcpb listing at the form fields, not env vars or the config file", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf-8"),
    ) as { tools: { name: string; description: string }[] };
    const description = manifest.tools.find((t) => t.name === "create_bucket")?.description ?? "";
    expect(description).toMatch(/Web Account Address/);
    expect(description).toMatch(/Key Admin Address/);
    expect(description).not.toMatch(/CONSOLE_WEB_ACCOUNT_ADDRESS|config file/);
  });
});
