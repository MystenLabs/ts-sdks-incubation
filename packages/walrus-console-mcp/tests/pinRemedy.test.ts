import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEY_ADMIN_PIN,
  KEY_ADMIN_PIN_REMEDY,
  WEB_ACCOUNT_PIN,
  WEB_ACCOUNT_PIN_REMEDY,
} from "../src/console/pinRemedy";

// The refusal tests assert these constants appear in each message; this file
// pins what the constants say. COMG-851 review on PR #54: a Claude Desktop user
// can act only on the extension's form field, so it has to come first, ahead of
// the env var and the `config` command every other host uses.

interface Manifest {
  display_name: string;
  server: { mcp_config: { env: Record<string, string> } };
  user_config: Record<string, { title: string }>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf-8"),
) as Manifest;

describe("pin remedies", () => {
  it.each([
    [
      WEB_ACCOUNT_PIN_REMEDY,
      /^Web Account Address in the Walrus Console extension's settings .*CONSOLE_WEB_ACCOUNT_ADDRESS.*`walrus-console-mcp config`$/,
    ],
    [
      KEY_ADMIN_PIN_REMEDY,
      /^Key Admin Address in the Walrus Console extension's settings .*CONSOLE_KEY_ADMIN_ADDRESS.*`walrus-console-mcp config`$/,
    ],
  ])("names the extension field first, then the env var, then `config`: %s", (remedy, shape) => {
    expect(remedy).toMatch(shape);
    // `config` covers the bundle; offering it separately only confused Desktop users.
    expect(remedy).not.toMatch(/credential bundle/);
  });

  it("names the extension as manifest.json does", () => {
    expect(manifest.display_name).toBe("Walrus Console");
  });

  // A renamed form field would otherwise leave every refusal pointing at a field
  // that no longer exists. Prefix, not equality: a title may carry a qualifier.
  it.each([WEB_ACCOUNT_PIN, KEY_ADMIN_PIN])(
    "names the form field that sets $envVar",
    ({ field, envVar }) => {
      const key = /^\$\{user_config\.(\w+)\}$/.exec(manifest.server.mcp_config.env[envVar] ?? "");
      expect(key, `${envVar} is not wired to a user_config field`).not.toBeNull();
      expect(manifest.user_config[key![1]!]?.title.startsWith(field)).toBe(true);
    },
  );
});
