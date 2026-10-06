---
"@mysten-incubation/walrus-console-mcp": minor
---

General release. Highlights since the closed beta:

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
