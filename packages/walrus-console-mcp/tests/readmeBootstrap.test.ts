import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// The bootstrap one-liner runs BEFORE any protected launcher exists (see
// "Why the launcher is an absolute path" in README.md), so it is the one
// command in this README that cannot be pointed at an absolute path. `npx`
// (and a bare `npm install`) perform an ambient UPWARD resolution step before
// they run anything, which a poisoned ancestor directory can hijack; a scoped
// `npm install --prefix <dir> <spec>` has no such step. This guards against a
// future edit reintroducing a bare `npx -y @mysten-incubation/...` bootstrap.

const ROOT = path.join(__dirname, "..");
const BARE_NPX_BOOTSTRAP = /npx\s+-y\s+@mysten-incubation\/walrus-console-mcp/;

function readText(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

describe("bootstrap commands do not resolve through npx", () => {
  it("README.md contains no bare npx bootstrap line", () => {
    expect(readText("README.md")).not.toMatch(BARE_NPX_BOOTSTRAP);
  });

  it(".env.example contains no bare npx bootstrap line", () => {
    expect(readText(".env.example")).not.toMatch(BARE_NPX_BOOTSTRAP);
  });

  it("bin/install.ts contains no bare npx bootstrap line", () => {
    expect(readText("bin/install.ts")).not.toMatch(BARE_NPX_BOOTSTRAP);
  });

  it("README.md's bootstrap one-liner pins npm to a fresh --prefix with scripts disabled", () => {
    expect(readText("README.md")).toMatch(/npm install --prefix \S+ .*--ignore-scripts/);
  });
});

// MCP clients spawn `command` directly (no shell in between), so a literal
// `~` in a JSON server-entry example is never expanded — it would launch
// `~/.local/share/...` as a literal, nonexistent path. The shell one-liners
// (`claude mcp add ...`, `codex mcp add ...`) are unaffected: the shell
// expands `~` for them before the MCP client ever sees the argument. Guards
// against a future JSON example reintroducing an unexpanded `~`.
describe("README's JSON server-entry examples use a real path, not a literal ~", () => {
  it('README.md contains no "command": "~ in a JSON block', () => {
    expect(readText("README.md")).not.toMatch(/"command":\s*"~/);
  });
});

// generate_api_key no longer returns the raw apiKey/privateKey secrets in its
// result — persistMintedCredential (src/console/mintedCredentialStore.ts),
// called from KeyAdminService.generateApiKey, writes them to a private 0600
// file and returns credentialFile as a pointer instead. The docs must point readers at that file, not at fields the tool
// no longer returns.
describe("README documents generate_api_key's credentialFile pointer", () => {
  it("README.md mentions credential.credentialFile", () => {
    expect(readText("README.md")).toMatch(/credential\.credentialFile/);
  });
});

// The role rule is "newest anchor that holds the member", not "highest role
// across anchors" (see rosterVerification.ts's `settled` short-circuit and
// README.md's "Who gets access to a new bucket" section). An old anchor
// taking the maximum would let it silently restore an editor grant an
// operator had revoked on more recent buckets.
describe("CHANGELOG's role-authoring rule matches the newest-anchor implementation", () => {
  it('CHANGELOG.md no longer says "highest it holds across"', () => {
    expect(readText("CHANGELOG.md")).not.toMatch(/highest it holds across/);
  });
});
