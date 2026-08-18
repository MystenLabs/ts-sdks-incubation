# @mysten-incubation/walrus-console-mcp

Manage [Walrus Console](https://testnet.console.walrus.xyz/) files directly from Claude.

Create buckets, upload files, retrieve documents, and manage data stored on Walrus using natural language. Files remain encrypted client-side and under your control.

## Paste it to your agent and let it set it up for you

Using a coding agent like **Claude Code**, **Codex**, **Cursor**, or **Gemini CLI**? Copy the block below verbatim into the agent and it will install, configure, and verify `@mysten-incubation/walrus-console-mcp` for you. (Have your two Console keys ready — see [Get your Console credentials](#1-get-your-walrus-console-credentials).)

```text
Set up the @mysten-incubation/walrus-console-mcp MCP server for me by running these steps in order. Stop and ask me only if a step actually fails.

1. Run the interactive installer: `npx -y @mysten-incubation/walrus-console-mcp install`. It will ask me for my CONSOLE_API_KEY (starts with `hbr_`) and CONSOLE_SERVICE_PRIVATE_KEY (starts with `suiprivkey1`), validate them, and save them to a user-only config file. Don't print my keys back to me.
2. Register the server with my agent (pick the one I'm using):
   - **Claude Code**: `claude mcp add --scope user walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp`. (`--scope user` makes it available in every project.)
   - **Codex**: `codex mcp add walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp`.
   - **Cursor / Gemini CLI / Claude Desktop**: add a stdio MCP server named `walrus-console-mcp` whose `command` is `npx` with args `["-y", "@mysten-incubation/walrus-console-mcp"]` in that tool's MCP config.
3. Then tell me: restart the agent (or run `/mcp`), approve walrus-console-mcp when prompted, and test with the `ping_console` tool.

Never put my keys anywhere except where the installer saves them.
```

That's it — once the agent finishes and you've approved the MCP server, you can manage files in Walrus Console using natural language. The rest of this README explains each step in detail if you'd rather do it manually.

## What you can do

- Create private encrypted buckets
- Store and retrieve files using natural language
- Manage Console data without leaving Claude
- Keep sensitive files private by default
- Use Console as durable storage for apps, agents, and AI workflows

## Quick Start

### Install from npm (recommended)

```bash
npx -y @mysten-incubation/walrus-console-mcp install
```

This interactive CLI will:

1. Ask for your Walrus Console API key and (optional) service private key
2. Validate your credentials against the Console API
3. Auto-configure Claude Desktop (and print instructions for Claude Code, Codex, and other agents)

After setup, restart your agent and try the `ping_console` tool.

For Codex, register the published package as a stdio MCP server:

```bash
codex mcp add walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp
```

Then start a new Codex session, run `/mcp`, approve `walrus-console-mcp` if prompted, and test with `ping_console`.

### 1. Get your Walrus Console credentials

1. Go to https://testnet.console.walrus.xyz/
2. Sign in with Google
3. Go to **Integrations → New API key**
4. Choose **read_write** and tick **"Create"**
5. Copy both values shown **once**:
   - `hbr_...` → `CONSOLE_API_KEY`
   - `suiprivkey1...` → `CONSOLE_SERVICE_PRIVATE_KEY`

### 2. Configure the server

```bash
npx -y @mysten-incubation/walrus-console-mcp install
```

The installer saves credentials to `~/.config/walrus-console-mcp/config.json` (`%APPDATA%\walrus-console-mcp\config.json` on Windows) with user-only file permissions. MCP client config files only need to launch the server; they do not need to contain your API key or service private key.

### 3. Run with Claude Desktop / Claude Code / Codex

Claude Desktop is configured automatically by the installer. The generated server entry looks like this:

```json
{
  "mcpServers": {
    "walrus-console-mcp": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/walrus-console-mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add --scope user walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp
```

Codex:

```bash
codex mcp add walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp
```

## Available Tools

| Tool                | Description                                 | Read/Write |
| ------------------- | ------------------------------------------- | ---------- |
| `ping_console`      | Check that your keys are configured         | Read       |
| `list_spaces`       | List your Personal + Team spaces            | Read       |
| `get_storage_usage` | Aggregated storage usage for your space     | Read       |
| `list_buckets`      | List buckets in a space                     | Read       |
| `create_bucket`     | Create a new private encrypted bucket       | Write      |
| `generate_api_key`  | Mint a scoped child working key (Key-Admin) | Write      |
| `upload_file`       | Encrypt + upload a local file               | Write      |
| `download_file`     | Download + decrypt a file to disk           | Read       |
| `list_files`        | List files in a bucket (with search)        | Read       |
| `get_file_status`   | Check upload progress                       | Read       |
| `get_bucket`        | Fetch a single bucket's metadata            | Read       |
| `rename_bucket`     | Rename a bucket                             | Write      |
| `delete_bucket`     | Permanently delete a bucket and its files   | Write      |
| `delete_file`       | Permanently delete a single file            | Write      |

## Example Prompts for Claude

- "Create a private bucket called 'agent-scratch' in my Personal Space"
- "Upload ~/Documents/Q3-report.pdf to the finance bucket"
- "List all files in my 'client-deliverables' bucket modified this month"
- "Download the latest PDF from the legal bucket and save it to ~/Downloads"
- "Show me the upload status of the file I just uploaded"

## Headless key minting (`generate_api_key`)

`generate_api_key` lets an orchestrator agent mint fresh, scoped **working** keys for worker
agents or CI — without a human visiting the console and copying values out of the "shown once"
dialog. This is the **GitHub-App pattern**: a separate, rarely-loaded **Key-Admin** identity does
the minting, and the working keys it mints can never escalate or mint anything themselves.

### Two credential types

| Credential      | Prefix    | Can do                                                                       |
| --------------- | --------- | ---------------------------------------------------------------------------- |
| **Working key** | `hbr_`    | Data plane: list/create buckets, upload/download files. **Cannot mint.**     |
| **Key-Admin**   | `hbradm_` | Mint child `hbr_` keys + sign their access grants. **No data-plane access.** |

The Key-Admin credential has two halves — the `hbradm_…` bearer (`CONSOLE_ADMIN_KEY`) and its
on-chain signer seed `suiprivkey1…` (`CONSOLE_ADMIN_SERVICE_PRIVATE_KEY`). Mints are signed with the
**admin** signer, never the working signer, so the two roles stay isolated.

### Split-credential config

Keep the working key on **every** host, and the management key on the **provisioning host only**.
Both are configured with the CLI and land in the same 0600 file:

```bash
# Worker / everyday host — working key only, cannot mint
npx -y @mysten-incubation/walrus-console-mcp install          # choose "API key"

# Provisioning host — additionally loads the management key
npx -y @mysten-incubation/walrus-console-mcp config           # choose "Management key"
```

Scripted / CI equivalents:

```bash
npx -y @mysten-incubation/walrus-console-mcp config --admin-key hbradm_2c… --admin-signer suiprivkey1…
CONSOLE_ADMIN_KEY=… CONSOLE_ADMIN_SERVICE_PRIVATE_KEY=… npx -y @mysten-incubation/walrus-console-mcp config --silent
```

Environment variables still work and still win over the saved file.

Call `ping_console` to confirm what's loaded — it reports `has_admin_key` and `has_admin_signer`
(booleans only; the secret values are never echoed).

### What it does

Given a `permission` (`read_only` | `read_write`) and an optional `label`, the tool:

1. generates a fresh child Ed25519 keypair locally,
2. mints a child `hbr_` key under the Key-Admin's scope,
3. runs one sponsored `grant_bucket_access` PTB (signed with the admin seed) granting the child
   access to the space's private buckets,
4. polls until the key is **active**, then returns the child credential pair **once**:

The **space is determined by the Key-Admin credential**, not by you — `spaceId` is a required
input only so the tool can _verify_ the minted key landed in the space you expected (it fails with a
`SpaceMismatchError` if the admin credential covers a different space). This mint-time PTB back-fills
access to the private buckets that **already exist** in the space. Private buckets created **later**
are granted to the child key **automatically** by Console — its bucket-create flow grants every key
that is active in the space at creation time — so you do **not** need to re-mint for future buckets,
as long as the child key stays active (a revoked key is skipped).

```json
{
  "apiKey": "hbr_…",
  "privateKey": "suiprivkey1…",
  "permission": "read_write",
  "spaceId": "…",
  "keyId": "…",
  "privateBuckets": [{ "bucketId": "…", "groupId": "0x…" }]
}
```

Hand `apiKey` + `privateKey` to the new worker as its `CONSOLE_API_KEY` + `CONSOLE_SERVICE_PRIVATE_KEY`.
Both are shown only once — Console never stores them.

If no Key-Admin credential is configured, the tool returns an actionable error and performs **no**
network call:

> `generate_api_key requires a Key-Admin credential. Set CONSOLE_ADMIN_KEY (hbradm_…) and CONSOLE_ADMIN_SERVICE_PRIVATE_KEY. A working key cannot mint.`

Configure it with `npx -y @mysten-incubation/walrus-console-mcp config` (choose **Management key**), or export both env vars.

> **Security:** The management credential is read-capable on-chain (a grant implies read). Keep it on
> the provisioning host only — it is stored in `~/.config/walrus-console-mcp/config.json` with
> user-only (0600) permissions, so do **not** copy that file to worker hosts. A leaked working key can
> never mint or escalate; a leaked management key can, so it is separately revocable with a contained
> blast radius.

## Adding to an agent (npm)

Register a stdio MCP server named `walrus-console-mcp` that launches the published package via `npx`. The server name is just a local label; the package it runs is `@mysten-incubation/walrus-console-mcp`.

**Claude Code:**

```bash
claude mcp add --scope user walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp
```

`--scope user` makes it available in every project. Use `--scope local` to scope it to the current project only.

**Codex:**

```bash
codex mcp add walrus-console-mcp -- npx -y @mysten-incubation/walrus-console-mcp
```

**Cursor, Gemini CLI, Claude Desktop, or any hand-written config:** add the server with `npx` as the command. For example, in a Claude config file (usually `~/.claude.json`, `~/.claude/config.json`, or `~/.config/claude/config.json`):

```json
{
  "mcpServers": {
    "walrus-console-mcp": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/walrus-console-mcp"],
      "description": "Walrus Console decentralized storage"
    }
  }
}
```

After registering, restart the agent (or reload the window if using it inside VS Code / Cursor), run `/mcp`, and **approve** `walrus-console-mcp` when prompted. Then try:

- `ping_console`
- `list_spaces`
- `create_bucket` (with a space ID)

**About file paths in `upload_file` / `download_file`:** relative paths (and `~`) are resolved against **your current workspace**, not the server's install location — so "upload `report.pdf`" and "download to `~/Downloads/x.pdf`" do what you'd expect from whatever project you're working in. Paths are sandboxed to your allowed roots (see [Security Model](#security-model)).

> **Note for clients that don't advertise MCP roots** (e.g. Claude Desktop): file access now **fails closed**. `upload_file` / `download_file` return an error until you set `CONSOLE_MCP_ALLOWED_DIRS` to the directories the server may touch — a `PATH`-style list separated by `:` (`;` on Windows), with `~` expansion. Example: `CONSOLE_MCP_ALLOWED_DIRS="$HOME/Documents:$HOME/Downloads"`. Clients that advertise roots (your open workspace folders) need no extra configuration.

## Security Model

- Console never has access to your plaintext files or decryption keys.
- Your `CONSOLE_SERVICE_PRIVATE_KEY` never leaves your machine
- Encryption, decryption, and signing happen locally
- The server only communicates with Console using your API key
- File access is restricted to your allowed roots
- Path sandboxing **fails closed**. `upload_file` (localPath) and `download_file` (destPath) are confined to the allowed roots — the filesystem roots your MCP client advertises, or `CONSOLE_MCP_ALLOWED_DIRS` when the client advertises none. If neither is available the path is **rejected**, so a model-chosen path (e.g. from prompt injection) can't reach an arbitrary file. Relative paths (and a leading `~`) are resolved against the first allowed root rather than the MCP server directory.
- Symlinks are resolved before the containment check: a symlink inside an allowed root that points outside it is rejected, not followed.

## MCPB bundle (one-file distribution)

The server can be packaged as a single `.mcpb` file for drag-and-drop install into Claude Desktop. The bundle inlines all dependencies (Seal/Sui are pure JS, no WASM), so it runs standalone with `node` — no `node_modules` needed.

```bash
pnpm mcpb:validate   # validate manifest.json against the v0.3 schema
pnpm mcpb:pack       # build the self-contained bundle, then pack -> walrus-console-mcp.mcpb
```

On install, the client prompts for the `CONSOLE_API_KEY` (required), `CONSOLE_SERVICE_PRIVATE_KEY` (optional, sensitive), the optional Key-Admin pair `CONSOLE_ADMIN_KEY` / `CONSOLE_ADMIN_SERVICE_PRIVATE_KEY` (sensitive — provisioning host only; see [Headless key minting](#headless-key-minting-generate_api_key)), and an optional `CONSOLE_API_BASE_URL` override, wired in via `user_config` in `manifest.json`.

## Development

This package lives in the [`ts-sdks-incubation`](https://github.com/MystenLabs/ts-sdks-incubation) monorepo. From the repo root:

```bash
pnpm install
```

Then, from `packages/walrus-console-mcp`:

```bash
pnpm typecheck
pnpm dev          # runs the server with tsx
pnpm build        # compile to dist/
```

To test a local build against an agent before it's published, point the client at the compiled entrypoint:

```bash
pnpm build
node dist/console-mcp.js install
codex mcp add walrus-console-mcp-local -- node "$(pwd)/dist/console-mcp.js"
```

## Roadmap / Future Work

- Team space member management tools
- Mainnet support when Console launches it

## License

MIT

## Acknowledgments

Built on [Walrus Console](https://github.com/MystenLabs/console), powered by [Walrus](https://github.com/MystenLabs/walrus) and [Seal](https://github.com/MystenLabs/seal).
