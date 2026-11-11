# @mysten-incubation/walrus-console-mcp

## 0.1.2

### Patch Changes

- e50701a: Upgrade `zod` to 4.6.7 (fixes GHSA-mrhx-c7xc-m3w5) and refresh the shipped `npm-shrinkwrap.json` with patched `body-parser` 2.4.0, `fast-uri` 3.1.9, and `ip-address` 10.7.5. A `generate_api_key` response missing `permissions`, `status`, or `private_buckets` still parses to the documented fallbacks, and `update_file`'s nullable `description`/`tags` inputs keep their descriptions in the JSON schema agents see.

## 0.1.1

### Patch Changes

- 17b3ed9: Refuse known-vulnerable Node versions at startup. The server now requires stable Node 22.23.4+, 24.22.1+, or 26.12.1+ within those major lines, per the October 2026 Node.js security releases; odd-numbered majors, unreviewed future majors, prereleases, and malformed version strings are refused with exit status 1 and a message naming the detected version. The check runs from a dependency-free bootstrap before any application module loads, in both the npm bin and the `.mcpb` bundle. Update the Node executable your MCP host actually launches and restart the host.

## 0.1.0

### Minor Changes

- cd3fdc6: General release. Highlights since the closed beta:

  - **File integrity binding**: uploads now cryptographically bind each encrypted file to its
    bucket and file identity, and downloads verify that binding before decrypting — a file served
    under the wrong identity is refused. Files uploaded during the beta still download and are
    flagged as legacy-encrypted in the tool output.
  - **Confirmation gates on destructive tools**: `delete_bucket`, `delete_file`, and
    `generate_api_key` now require explicit confirmation (interactive approval where the MCP
    client supports elicitation, `confirm: true` otherwise) instead of only being described as
    destructive.
  - **Download overwrite protection**: `download_file` never replaces an existing file unless the
    call passes `overwrite: true`, and refuses a destination whose final component is a symlink.
  - **Credential handling**: the Management (Key-Admin) credential is stored in its own file
    separate from the everyday config; a revoked or rotated API key now fails with a message that
    says what happened and what to do.
  - **Upload robustness**: uploads are accepted then polled with clearer terminal statuses;
    failures report an actionable condition (daily limit, funding paused, storage cap, transient,
    permanent) instead of a raw error.
  - **Installer and CLI**: Node 22+ is checked up front with a plain message (the floor dropped
    from 24 to 22); `install --help` / `config --help` print usage; config steps offer Back;
    Antigravity is supported alongside Claude Code, Cursor, Codex, and Gemini CLI.
  - **Pinned crypto dependencies**: `@mysten/sui` 2.29.0 and `@mysten/seal` 1.4.0, exact, with the
    shipped dependency graph locked by the package's shrinkwrap.
  - **Claude Desktop extension**: the `.mcpb` bundle now ships inside the npm package; the latest
    build is always at
    `https://cdn.jsdelivr.net/npm/@mysten-incubation/walrus-console-mcp@latest/walrus-console-mcp.mcpb`.
  - List tools gained cursor-based pagination; analytics attribution header on Console requests;
    assorted security and robustness hardening across redirects, path handling, and the seal
    client.

## 0.1.0-beta.0

### Minor Changes

- 3b48e5d: Initial release of the Walrus Console MCP server: bucket and file management
  against the Walrus Console API with Seal-encrypted private files, client-side
  transaction validation (owner/manager/roster pins on sponsored create-bucket
  PTBs), a path-sandboxed filesystem surface, and a guided credential installer.
  Runs against Walrus Console on mainnet by default; testnet is available via
  `CONSOLE_API_BASE_URL=https://api.testnet.console.walrus.xyz`.
