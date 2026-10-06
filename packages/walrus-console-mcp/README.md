# @mysten-incubation/walrus-console-mcp

Manage [Walrus Console](https://console.walrus.xyz/) files directly from Claude.

Create buckets, upload files, retrieve documents, and manage data stored on Walrus using natural language. Files remain encrypted client-side and under your control.

> **Updating:** installs are pinned to the version they fetched and never update
> themselves — to update, re-run the install command.

## Paste it to your agent and let it set it up for you

Using a coding agent like **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, or **Antigravity**? Copy the block below verbatim into the agent and it will install, configure, and verify `@mysten-incubation/walrus-console-mcp` for you. (Have your two Console keys ready — see [Get your Console credentials](#1-get-your-walrus-console-credentials).)

```text
Set up the @mysten-incubation/walrus-console-mcp MCP server for me by running these steps in order. Stop and ask me only if a step actually fails.

1. Run the interactive installer from an empty directory (so it can't launch a same-named package the current project happens to ship): `cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp && ./node_modules/.bin/walrus-console-mcp install`. At the first prompt choose **Credential bundle** and paste the CONSOLE_CREDENTIAL_BUNDLE value from the Console key-mint screen — one paste carries the API key, the service key and the two addresses `create_bucket` needs pinned. If I only kept the individual values, choose **API key** instead: it asks for CONSOLE_API_KEY (starts with `hbr_`) and CONSOLE_SERVICE_PRIVATE_KEY (starts with `suiprivkey1`), then for the two addresses. Either way it validates and saves to a user-only config file. Don't print my keys back to me; the addresses are not secret and it will show them for me to confirm.
2. Let the same installer register the server — it offers a checklist of the agents it detects. That step installs the package into its own directory and writes the **absolute** path of the launcher into each config. Prefer it over registering by hand.
3. Then tell me: restart the agent (or run `/mcp`), approve walrus-console-mcp when prompted, and test with the `ping_console` tool. For Antigravity (the desktop app, the IDE or `agy`), reload its MCP servers instead, since it does not pick up the new entry on its own (in `agy`, open `/mcp` and reload; in the app, press refresh under Settings → Customizations → Installed MCP Servers).

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

**Requires Node 22 or newer.** Check with `node --version`. On anything older
the CLI stops at the first line and says which version it found: the npm
`EBADENGINE` warning scrolls past during the install, and the failure that
follows it names a missing `styleText` export rather than the Node version.

```bash
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp && ./node_modules/.bin/walrus-console-mcp install
```

This interactive CLI will:

1. Ask for your credential bundle — one paste carrying the API key, the service private key
   and the two address pins — or for those values one at a time
2. Validate your credentials against the Console API, show you the addresses it is about to
   pin, and save nothing until you confirm them
3. Ask which folders `upload_file` / `download_file` may use when your agent does not share
   workspace folders (Grok, Claude Desktop, Cursor). Skip this if your agent advertises MCP roots.
4. Install the server into its own directory and register it with the agents you tick
   (Claude Code, Cursor, Codex, Gemini CLI, Antigravity). Claude Desktop is not on this list — see
   [Claude Desktop](#claude-desktop).

**Restart your agent when it finishes.** The tools do not appear in a session
that was already running, even though `claude mcp list` reports the server as
Connected as soon as it is registered. After the restart, run `ping_console` to
confirm. Antigravity is the exception: it does not reload its config on its own, so
follow [Antigravity](#antigravity) instead of restarting.

Both commands take `--help`:

```bash
walrus-console-mcp install --help
walrus-console-mcp config --help
```

If you would rather register by hand, see
[Adding to an agent (npm)](#adding-to-an-agent-npm) — and note that the launch
command is an absolute path, not `npx`, for
[a reason that matters](#why-the-launcher-is-an-absolute-path).

### 1. Get your Walrus Console credentials

1. Go to https://console.walrus.xyz/
2. Sign in with Google
3. Go to **Integrations → New API key**
4. Choose **read_write** and tick **"Create"**
5. Copy the values shown **once**:
   - `hbr_...` → `CONSOLE_API_KEY`
   - `suiprivkey1...` → `CONSOLE_SERVICE_PRIVATE_KEY`
   - the JSON blob labelled `CONSOLE_CREDENTIAL_BUNDLE` → paste this one into the installer if
     you can. It carries the two keys **and** the two Sui addresses this server pins before it
     will create a bucket (see
     [Who gets access to a new bucket](#who-gets-access-to-a-new-bucket-create_bucket)). Keys
     minted before the bundle existed still work — you enter the addresses by hand instead.

### 2. Configure the server

```bash
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp && ./node_modules/.bin/walrus-console-mcp install
```

The installer saves your everyday credentials to `~/.config/walrus-console-mcp/config.json` (`%APPDATA%\walrus-console-mcp\config.json` on Windows) with user-only file permissions. If you also configure a Management key, it is saved separately, in a sibling `admin.json` — see the Security note under [Headless key minting](#headless-key-minting-generate_api_key) below. MCP client config files only need to launch the server; they do not need to contain your API key or service private key.

### 3. Run with Claude Code / Cursor / Codex / Gemini CLI / Antigravity

Claude Code, Cursor, Codex, Gemini CLI, and Antigravity are all configured by the installer's
Register step. The generated server entry looks like this — the
path shown is illustrative; if you are pointing a client at this by hand, paste
the path printed by the `echo` command in
[Adding to an agent (npm)](#adding-to-an-agent-npm) below instead of typing `~`
— MCP clients spawn `command` without a shell, so `~` is not expanded:

```json
{
  "mcpServers": {
    "walrus-console-mcp": {
      "command": "/home/you/.local/share/walrus-console-mcp/node_modules/.bin/walrus-console-mcp",
      "args": []
    }
  }
}
```

The command is an absolute path, not `npx`. See
[Why the launcher is an absolute path](#why-the-launcher-is-an-absolute-path).

## Available Tools

| Tool                     | Description                                                      | Read/Write |
| ------------------------ | ---------------------------------------------------------------- | ---------- |
| `ping_console`           | Check that your keys are configured                              | Read       |
| `list_spaces`            | List your Personal + Team spaces                                 | Read       |
| `get_storage_usage`      | Aggregated storage usage for your space                          | Read       |
| `list_buckets`           | List buckets in a space (paged, filter by visibility)            | Read       |
| `create_bucket`          | Create a private encrypted bucket (needs a pinned owner address) | Write      |
| `generate_api_key`       | Mint a scoped child working key (Key-Admin)                      | Write      |
| `upload_file`            | Encrypt + upload a local file                                    | Write      |
| `download_file`          | Download + decrypt a file to disk                                | Read       |
| `list_files`             | List files in a bucket (paged, with search)                      | Read       |
| `get_file_status`        | Check upload progress                                            | Read       |
| `get_bucket`             | Fetch a single bucket's metadata                                 | Read       |
| `rename_bucket`          | Rename a bucket                                                  | Write      |
| `delete_bucket`          | Permanently delete a bucket; `deleteContents` to take its files  | Write      |
| `delete_file`            | Permanently delete a single file                                 | Write      |
| `update_file`            | Update a file's name, description, or tags                       | Write      |
| `get_bucket_metadata`    | Fetch a bucket's custom metadata                                 | Read       |
| `update_bucket_metadata` | Set a bucket's custom metadata                                   | Write      |

## Example Prompts for Claude

- "Create a private bucket called 'agent-scratch' in my Personal Space"
- "Upload ~/Documents/Q3-report.pdf to the finance bucket"
- "List all files in my 'client-deliverables' bucket modified this month"
- "Download the latest PDF from the legal bucket and save it to ~/Downloads"
- "Show me the upload status of the file I just uploaded"

### Uploading a file

`upload_file` requires `bucketId` and `localPath`. The server derives and verifies the
bucket's Seal policy before reading, encrypting, or uploading the file. For example,
pass these tool arguments using the bucket ID returned by `create_bucket` or `list_buckets`:

```json
{
  "bucketId": "<bucket-id>",
  "localPath": "~/Documents/Q3-report.pdf"
}
```

The file must be inside an allowed folder. `name`, `description`, and `tags` are
optional. After the upload is accepted, poll `get_file_status` with the returned
`fileId` until processing reports `completed` or `failed`.

## Key minting (`generate_api_key`)

`generate_api_key` lets a provisioning agent mint fresh, scoped **working** keys for worker
agents or CI without copying a credential out of Console's "shown once" dialog. Every mint still
requires an operator-controlled confirmation: an interactive human answer in a supporting MCP
client, or an explicit client-side elicitation hook for unattended automation. This is the
**GitHub-App pattern**: a separate, rarely-loaded **Key-Admin** identity does the minting, and the
working keys it mints can never escalate or mint anything themselves.

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
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp && ./node_modules/.bin/walrus-console-mcp install   # choose "API key"

# Provisioning host — additionally loads the management key
"${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp" config   # choose "Management key"
```

Scripted / CI equivalents:

```bash
"${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp" config --admin-key hbradm_2c… --admin-signer suiprivkey1…
CONSOLE_ADMIN_KEY=… CONSOLE_ADMIN_SERVICE_PRIVATE_KEY=… "${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp" config --silent
```

Environment variables still work and still win over the saved file.

Call `ping_console` to confirm what's loaded — it reports `has_admin_key` and `has_admin_signer`
(booleans only; the secret values are never echoed).

### Confirming the mint

Every mint is a live, billable credential that no credential this client holds can revoke — only a
human, by hand in the Console UI (see below) — so it is gated, not just described as destructive:

- **Every client**: the call needs `confirm: true`. A missing or `false` value is refused before
  the tool runs at all. This closes the accident case — a model firing the call without meaning
  to — but not a deliberate one: an agent composing the call sets `confirm: true` exactly as
  easily as any other field.
- **A client that supports MCP form elicitation** (Claude Code and others): the tool additionally
  asks a human directly, through the client's own UI, naming the cost and the revoke path —
  independent of what the calling model put in the request. Only an explicit accept there lets the
  mint proceed; a decline, cancel, timeout, or prompt failure returns
  `{ ok: false, stage: "declined" }` having minted nothing. This is the gate that actually moves
  the decision outside the model's control, since the prompt never passes back through the tool
  call it is confirming.
  An unattended Claude Code client advertises this capability but cancels the dialog unless an
  operator configures its **Elicitation** hook to provide the answer; that hook is the supported
  unattended path because its policy lives in operator-controlled client configuration, not the
  model's tool arguments.
- **A client without form elicitation** (including URL-only elicitation clients) relies on the
  `confirm: true` floor alone.

### What it does

Given a `permission` (`read_only` | `read_write`) and an optional `label`, the tool:

1. generates a fresh child Ed25519 keypair locally,
2. mints a child `hbr_` key under the Key-Admin's scope,
3. runs one sponsored `grant_bucket_access` PTB (signed with the admin seed) granting the child
   access to the space's private buckets,
4. polls until the key is **active**, then returns the child credential pair **once**:

The **space is determined by the Key-Admin credential**, not by you. `spaceId` is an **optional
assertion**, never a selector: it is not sent to Console at all (the mint body carries only
`permissions`, `serviceSignerAddress` and `name`), so passing it cannot steer the mint anywhere.
All it does is let the tool tell you when the key landed somewhere other than you expected — which
means the admin bundle configured on this host belongs to a different space than you assumed.

That comparison necessarily runs **after** the mint: the Key-Admin credential has no data-plane
access (`GET /api/v1/spaces` answers `403 key_admin has no data-plane access`), so the space cannot
be read beforehand. Because the mint has already succeeded by then — and the key is perfectly valid
in the credential's own space — a mismatch is reported as a **warning on an `ok: true` result**, not
as a failure. See [When the spaceId does not match](#when-the-spaceid-does-not-match).

This mint-time PTB back-fills access to the private buckets that **already
exist** in the space. Later buckets this client creates do **not** grant every active key
automatically — that was Console's memberless-reserve path, which this client refuses. A child
key is included on a later create only if it is still active and already a member of one of the
locally recorded anchor groups (the mint-time grant is what puts it there, once an anchor exists). A key
that missed that back-fill is left off and named in `roster.droppedCandidates`; repair it with a
key-admin grant, not a re-mint. See
[Who gets access to a new bucket](#who-gets-access-to-a-new-bucket-create_bucket).

```json
{
  "ok": true,
  "credential": {
    "permission": "read_write",
    "spaceId": "…",
    "keyId": "…",
    "name": "worker-01 [mcp-mint-9f2c1a4b7e30]",
    "privateBuckets": [{ "bucketId": "…", "groupId": "0x…" }],
    "credentialFile": "/home/you/.config/walrus-console-mcp/minted-keys/<hash of keyId>.json"
  },
  "revocation": "To revoke this key, open the Console UI → Integrations and delete the key named …"
}
```

`revocation` rides on every result that got as far as minting — the clean one above and the
`ok: false` ones below — because nothing else in the response says how to undo a mint, and it
cannot be done from here. A revoke endpoint does exist (`DELETE /api/v1/api-keys/:id`), but it, the
key list, and the revocation-plan pre-check are all session-only, answering
`403 This endpoint requires session authentication` to the working key and the Key-Admin key
alike. That gate is deliberate: revoking runs an on-chain unshare over the key's buckets, which
needs a wallet.

So deleting a key is a human in the Console UI, under **Integrations** — matching on
`credential.name`, **not** on `keyId`. The Integrations table lists keys by name and never renders
the id, which is exactly why the mint marker is embedded in the name.

`credential` no longer carries the raw secrets. Read `apiKey` (`hbr_…`) and `privateKey`
(`suiprivkey1…`) from `credential.credentialFile` — a private `0600` file written once, whose
contents are shown nowhere else, including this tool's own output — and hand them to the new
worker as its `CONSOLE_API_KEY` + `CONSOLE_SERVICE_PRIVATE_KEY`.

### When the spaceId does not match

If you pass a `spaceId` and the key lands elsewhere, the mint still **succeeded** — you get
`ok: true`, a fully granted and activated key, and a warning:

```json
{
  "ok": true,
  "credential": { "spaceId": "sp_real", "keyId": "…", "credentialFile": "…" },
  "warnings": [
    {
      "kind": "space-mismatch",
      "expected": "sp_you_asked_for",
      "actual": "sp_real",
      "message": "…the CONSOLE_ADMIN_KEY configured on this host belongs to a different space…"
    }
  ],
  "revocation": "…"
}
```

**Do not retry on this.** `spaceId` does not choose the space, so calling again with a different
value changes nothing about where the key is minted — it just mints a second key, and neither can
be revoked from here. What a mismatch actually tells you is that `CONSOLE_ADMIN_KEY` on this host
is scoped to `actual`, not to what you expected. If you need a key for a different space, configure
that space's admin bundle first, then mint, then revoke the one you already made.

This is deliberately not an `ok: false`: the mint has already succeeded, so a failure
label would invite a retry that mints another orphan against the 25-keys-per-user cap.

### When a step after the mint fails

The mint is the point of no return: once Console accepts it the key exists, and its `hbr_` value
has been shown for the only time it ever will be. The bucket grant and the activation poll both run
after that, so each can fail with a **live key already created**.

Those failures come back as `ok: false` **usually still carrying the credential** (via the same
`credentialFile` pointer), not as an error:

```json
{
  "ok": false,
  "stage": "grant",
  "reason": "…the original error message…",
  "detail": { "tag": "ConsoleApiError", "code": "insufficient_scope", "status": 403 },
  "credential": {
    "permission": "read_write",
    "spaceId": "…",
    "keyId": "…",
    "privateBuckets": [{ "bucketId": "…", "groupId": "0x…" }],
    "credentialFile": "/home/you/.config/walrus-console-mcp/minted-keys/<hash of keyId>.json"
  },
  "recovery": "…what to do, and what not to…"
}
```

Read `ok` before using the result — **`ok: false` after the mint usually still contains a real,
usable credential**, reachable through `credential.credentialFile`. `stage` is one of `declined`,
`grant`, `activation`, `private-buckets-unknown`, `space-check`, `mint`, or `persist`; `declined`
means the human confirmation did not complete and **no key was minted**, while the other stages
are reported after the mint point of no return. `detail` carries the machine-readable form of a
post-mint failure so you can tell a permanent problem (a `403 insufficient_scope` will never
succeed) from a transient one. A failing step does not discard a `space-mismatch` warning raised
before it: `warnings` rides along on `ok: false` results too.

`stage: "space-check"` no longer means the spaceId did not match — that is a warning on a
successful mint now (above). It survives as the name of the step, so it is what an unexpected
failure _during_ that step is attributed to; the mismatch comparison itself cannot produce it.

The exception is `stage: "persist"`: the mint succeeded, but its secrets could not be saved to
disk at all, so there is no `credentialFile` to point at and the result carries **no `credential`
field**:

```json
{
  "ok": false,
  "stage": "persist",
  "reason": "…the write error…",
  "keyId": "…",
  "spaceId": "…",
  "attemptedPath": "/home/you/.config/walrus-console-mcp/minted-keys/<hash of keyId>.json",
  "recovery": "…what to do, and what not to…"
}
```

`keyId` + `spaceId` name the key that was minted and `attemptedPath` is where its credential file
should have been written, so an operator can still locate it in the Console UI even though this
process never got to save its secrets.

**Do not call the tool again to "retry" a post-mint `ok: false` result.** The mint already
succeeded, so a second call mints a _second_ key and orphans the first. `stage: "declined"` is
the exception: no key was minted, so you may call again after the user provides a fresh
confirmation.

If the tool call is **cancelled** while polling, the credential cannot be delivered at all. The
server writes the orphaned key's id to stderr so it can still be found and removed; the secrets are
deliberately not logged.

If no Key-Admin credential is configured, the tool returns an actionable error and performs **no**
network call:

> `generate_api_key requires a Key-Admin credential. Set CONSOLE_ADMIN_KEY (hbradm_…) and CONSOLE_ADMIN_SERVICE_PRIVATE_KEY. A working key cannot mint.`

Configure it with the installed launcher — `"${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp" config` (choose **Management key**) — or export both env vars.

> **Security:** The management credential is read-capable on-chain (a grant implies read). Keep it on
> the provisioning host only — it is stored separately from your everyday key, in
> `~/.config/walrus-console-mcp/admin.json`, with the same user-only (0600) permissions, so do
> **not** copy that file to worker hosts. A leaked working key can never mint or escalate; a leaked
> management key can, so it is separately revocable with a contained blast radius.

## Who gets access to a new bucket (`create_bucket`)

Creating a private bucket is one sponsored transaction: Console builds it, this server signs it
with your service key, and the addresses inside those bytes decide — permanently — who can
decrypt that bucket's files. So the server never signs a create it cannot account for address by
address. It pins the bucket's owner and the Key-Admin against **local** configuration, authors the
rest of the roster itself, and **refuses** rather than signing bytes it cannot check.

### The two address pins

| Config file key     | Environment variable          | What it decides                                                                                 |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `webAccountAddress` | `CONSOLE_WEB_ACCOUNT_ADDRESS` | The Console web account the bucket is created **for** — the transaction's `add_owner` recipient |
| `keyAdminAddress`   | `CONSOLE_KEY_ADMIN_ADDRESS`   | The Key-Admin the transaction hands group management to (`grant_permission`)                    |

Neither is a secret — they are plain Sui addresses, and the server prints them back in the
`create_bucket` result on purpose. What matters is where they come from: the 0600 config file or
the environment, never an API response. An address the endpoint supplied is an address the
endpoint chose, and there would be nothing left to check it against.

**With no owner pin, `create_bucket` refuses — before any network call.** `add_owner` carries no
type argument, so nothing bounds what a substituted recipient receives: a forged owner, plus the
demotion the transaction performs on the way out (the signing key gives up its admin rights over
the new group), leaves that address as the group's sole owner and disarms the only key that could
have undone it. Local config is the only thing that can catch that, so without it the tool fails
with `missing_owner_pin` and creates nothing. An operator has to fix it; retrying will not.

**With no manager pin, only a transaction that carries a management grant is refused.** A space
holding no Key-Admin key builds no `grant_permission` command at all, and that transaction is
perfectly legal — such hosts need nothing. Where a grant _is_ present, its recipient is checked
against the pin, or against the address this host's own admin key derives if it holds the
Key-Admin credential. A **worker host holds no admin credential and can derive nothing**, so on a
space that has a Key-Admin key it needs `keyAdminAddress` pinned or every create is refused. If a
pin and a derived address both exist and disagree, the create is refused rather than resolved: one
of the two is stale, and quietly preferring the pin would hide a swapped admin credential.

### Provisioning the pins

Interactively, with the installed launcher (`install` offers the same choices):

```bash
"${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp" config
```

- **Credential bundle** (the first choice) — paste the `CONSOLE_CREDENTIAL_BUNDLE` value from the
  Console key-mint screen. The paste is masked, the API key is validated against Console first, and
  then both addresses are printed **in full** and nothing is written until you answer `y`; a bare
  Enter declines and the config file is not rewritten at all. In a **working-key** bundle an
  address carried as `null` **clears** any pin already saved — that bundle is the account's own
  answer for both pins — and a bundle with no owner address warns that `create_bucket` will refuse
  until one is pinned. A **management** bundle clears neither: it never calls `create_bucket`, so
  it says nothing about the owner and leaves a saved owner pin alone, and its own signer derives
  the Key-Admin, so `null` there means "not supplied" and the derived address is saved.
- **API key** (or **Both**) — for keys minted before the bundle format existed. After the key
  prompts it asks for each address separately, re-prompts on an invalid one (never echoing what you
  typed), and confirms the exact value before saving it. Enter skips, keeping whatever is already
  saved; this path never clears a pin.
- **Management key** is not _asked_ for the pins: there is nothing to ask a provisioning-only
  host, which never calls `create_bucket`. That is about the prompts only — an address you pass
  explicitly on the command line is still saved (see the seeded form below), because a host
  provisioned with a management key may later gain a working one. Its Key-Admin pin is not a
  question either: it is derived from the signer you paste, printed in full, and saved.
- **Seeded from the command line.** `install --owner-address 0x… --key-admin-address 0x…` — the
  command the Console's **Connect MCP** panel hands you — does not skip the prompts; it answers the
  address ones. Each seeded pin is printed in full and the set is confirmed with one `[y/N]`;
  declining writes nothing, not even the key you just verified. A seed that disagrees with a pasted
  bundle, or with the address a management signer derives, refuses and names both addresses.
  Unlike the prompts, the seeds are not restricted by which credential you chose: a flag is an
  explicit instruction, and dropping one silently would be worse than saving a pin the host has
  no immediate use for.

Scripted / CI:

```bash
# One paste. A null address in the bundle CLEARS that pin; passing the bundle on the command line
# is itself the explicit act, so there is no confirmation prompt.
… config --credential-bundle '{"v":1,"apiKey":"hbr_…","servicePrivateKey":"suiprivkey1…","webAccountAddress":"0x…","keyAdminAddress":null}'

# Or the pins alone — validated locally, no Console probe, and neither flag touches the other pin.
# `--silent` is required here: without it the address flags seed the interactive prompts instead.
… config --silent --owner-address 0x… --key-admin-address 0x…
```

`CONSOLE_CREDENTIAL_BUNDLE` is read from the environment only under an explicit `--silent`.
Combining `--credential-bundle` with the flags of its own pair is an error — the bundle already
carries those. A working bundle refuses `--api-key` / `--service-key`, a management bundle refuses
`--admin-key` / `--admin-signer`, and each composes with the other pair, since that is a different
credential. The two address flags are not a conflict but a second statement of the same pin: one
that matches the bundle proceeds, and one that differs refuses and names both addresses. Against a
**working** bundle, `null` is an answer too — "this key has no such address" — so a flag naming one
is a disagreement and is refused. A **management** bundle's `null` `keyAdminAddress` is not: it
means "not supplied", the bundle's own signer derives the address, and `--key-admin-address` is
checked against that derivation instead — equal proceeds, different refuses naming both.

`CONSOLE_WEB_ACCOUNT_ADDRESS` and `CONSOLE_KEY_ADMIN_ADDRESS` are read by the **server** at
runtime and win over the saved file there, but the CLI deliberately does not persist them: exporting
one and running `config --silent` writes no pin, because a per-shell override should not turn into a
saved one nobody chose to write down. Use the flags or the bundle for that.

### Who else gets access: the anchor group and the verified roster

Beyond the owner and the signing key, a new bucket usually grants access to the space's **other**
service accounts, so a key minted for another agent can read what this one uploads. That list is
exactly what a hostile or compromised endpoint would like to choose, so this client authors it
rather than accepting one:

1. It asks Console for the space's active signers. That answer is **untrusted**, and is used only
   as a list of candidates.
2. It reads the on-chain membership of the space's **anchor groups**: bucket groups this MCP
   created and validated on earlier runs, remembered in
   `~/.config/walrus-console-mcp/anchors.json` and identified by object ids **derived locally**
   from the transactions this client validated — never taken from Console's response. (Each
   reported id is cross-checked against the derived one; a disagreement refuses and names both.)
   Membership in **any** of them counts, because each one is evidence this client established
   itself — with one row struck out: the key that **created** a group is a member of it, from the
   transaction that made it. That is this client's own footprint rather than evidence about
   anybody, so a working key this host has rotated away from is not vouched for by the anchors it
   left behind. An anchor that holds none of the candidates can contribute nothing and is skipped;
   at most 20 of the rest are consulted per create, newest first, and the result says so when
   older ones went unread.
3. The roster is the **intersection** of the two, and each member's role is read from chain, not
   from the scope the API claims for it — the role it holds on the **newest** anchor that holds it
   at all. Not the highest across them: an api-key's scope is fixed at mint and both bucket
   permissions are granted in one transaction, so a viewer-only sighting on some old anchor is a
   partial grant — but revocations are neither atomic nor tied to the scope, so taking the maximum
   would let an old anchor quietly restore an `editor` an operator had revoked on this space's
   recent buckets.
4. That roster is sent with the reserve, and the transaction that comes back is refused unless it
   grants exactly it — no extra address, no dropped member, no viewer promoted to editor.

Neither source is safe alone, and neither is trusted. An anchor group's membership is a _superset_
of the space's service accounts (a person can share a bucket with any collaborator wallet), so
authoring from chain alone would hand bucket #1's collaborator access to bucket #2. The API's list
can name anyone at all, so authoring from it alone is injection. What the intersection buys is a
**bound, not a proof**: the endpoint still makes the selection, and it makes it only from addresses
that already hold a bucket role on one of this space's admitted anchor groups. It cannot name one
that does not, and the scope it claims for a key can only ever drop that key from the roster, never
raise its role. Unioning the anchors widens the set it selects from — from one bucket's membership
to that of at most twenty — and nothing enters the roster without a chain answer of its own.

One case is dropped for a different reason: if the role chain reports contradicts the scope Console
claims for that key, the member is left off. The API rejects an authored role that does not match
the key's own scope, so sending it would fail the whole create instead of quietly granting less.

If any of those reads fails, the create is **refused, not degraded**. Every read happens before
anything is reserved, so a refusal costs one retry — no gas, no orphaned bucket, no partial state.
Creating the bucket anyway with an empty roster would leave it permanently under-permissioned in a
way neither Console nor this client can enumerate afterwards.

`anchors.json` is pure cache: losing it, or deleting it, only sends the next create in that space
down the bootstrap path below. It keeps a **list** per space, newest first, up to 32 — a create adds
an anchor and never replaces one, so a bucket whose roster came out identity-only cannot cost the
space an anchor that carried evidence. A stored entry is re-derived before it is used, from the bucket id,
creator and bucket-policy package ids recorded beside it. Those package ids separate the two ways a
re-derivation can fail. If they are no longer the ones this build resolves — a contract republish,
or a switch between Console deployments — the entry is **stale**: the create degrades to the
bootstrap path with a note on stderr and re-anchors the space as it goes, so it self-heals with no
operator action. If they _are_ the current ones and the id still does not reproduce, the create is
**refused** rather than letting the entry become the next roster's chain source. Entries written
before this client stored a `creator` are dropped at load (same as no anchor); entries written
before it stored the package ids are stale, never treated as tampered.

### Two disclosed gaps, both in the safe direction

**Bootstrap.** The first bucket a given MCP host creates in a space has no anchor to check
anything against, so its verified roster is empty and no other service account is granted access
at create time (`roster.reason: "bootstrap"`). That bucket joins the space's anchors — the result's
`anchorRecorded` says whether the write succeeded — but on its own
it holds only the owner and this signing key, so the next create can author a real roster once some
anchor holds one of the space's other service accounts — which mint-time back-fill supplies as soon
as another key is minted. Repair the first bucket with a key-admin grant if other keys need it —
nothing repairs it automatically.

**Never-anchored keys.** A key that exists in the space but has never been granted on a bucket
this MCP created cannot be verified against any anchor, so it is left off the roster and named in
`roster.droppedCandidates`. Mint-time back-fill grants a newly minted key access to the private
buckets that already exist, so in practice this narrows to keys minted while this MCP had created
nothing.

Both leave a bucket **under**-permissioned, and neither can over-permission one. What no endpoint
can do is put an **arbitrary** address into the transaction this server signs: every address on the
roster already holds a bucket role on one of this space's admitted anchor groups, read from chain
at create time. Inside that set it can still choose — the untrusted candidate list is the selection
— and an anchor group's membership is a superset of the space's service accounts, so a compromised
endpoint could suppress a name, or single out a collaborator wallet somebody once shared an
anchored bucket with. That is a large and real reduction from "any address". It is not zero.

### What the tool reports back

```jsonc
{
  "bucketId": "…", // the reserved id, cross-checked against the PTB and finalize
  "sealPolicyId": "0x…", // also the bucket group id, derived locally
  "provisioningState": "active", // the wire field is `provisioning_state`; there is no `state`
  "identity": {
    // what the SIGNED transaction was found to do
    "owner": "0x…",
    "members": [{ "address": "0x…", "role": "editor" }],
    "signerRole": "editor", // the scope this signing key keeps after demoting itself
    "manager": "0x…", // absent when the transaction grants no management
  },
  "roster": {
    // what this client demanded; equal to identity.members
    "members": [{ "address": "0x…", "role": "editor" }],
    "reason": "chain_verified", // or "bootstrap" | "no_other_signers" | "no_admitted_anchor"
    "droppedCandidates": ["0x…"], // space keys that will NOT be able to read this bucket
    "anchorGroupIds": ["0x…"], // the anchors that backed it; empty unless "chain_verified"
    "anchorsNotConsulted": 3, // only when the 20-anchor cap left older ones unread
    "anchorsStale": 1, // only when an anchor was skipped: derived under other package ids
  },
  "anchorRecorded": true,
  "disclosure": "…", // the sentence to show a user
}
```

There is **no top-level `members` field** any more: `identity.members` is what the signed bytes
grant and `roster.members` is what this client demanded, and they agree because the validator
refuses to sign a transaction where they do not.

**`disclosure` is the field to surface.** Three of the four reasons produce an empty `members`
list, write identical transaction bytes and leave identical state on Console — the reason and that
sentence are the only place where "this space has one key, nobody was left out" is distinguishable
from "nothing could be verified, so nobody else can read this bucket". They also differ in what
fixes them:

| `reason`             | what happened                                                    | what clears it                                          |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `bootstrap`          | no anchor group on file for this space (or all of them stale)    | the next create that authors members                    |
| `no_other_signers`   | Console lists no signer beyond owner, this key and the Key-Admin | nothing to clear — the empty roster is the whole roster |
| `no_admitted_anchor` | anchors exist, none holds an address this client did not know    | a grant on one of this space's buckets                  |
| `chain_verified`     | membership was read from at least one anchor group               | —                                                       |

`chain_verified` is the only reason that means a membership was actually read; it is never
reported for a create that read nothing.

## Adding to an agent (npm)

The installer's Register step does all of this for you, and is the recommended
route. Register by hand only if it could not detect your agent, or if your agent
is Claude Desktop, which the installer does not register.

### Why the launcher is an absolute path

Every command below points at an absolute path rather than `npx`. That is a
security property, not a style choice.

`npx -y <package>` resolves the package name against the **current working
directory** first. An agent started inside a project that happens to ship a
package of the same name would launch _that_ package instead — under this
server's identity, with read access to the Console credentials in
`~/.config/walrus-console-mcp`. It does not take a hostile project to trigger:
this was first noticed when a local checkout shadowed the published package.

So the installer resolves the package once, into a directory it owns, and
records where it landed. Nothing is resolved at launch time, so there is nothing
left to shadow. Upgrading means re-running the installer — which was already true,
since the registered spec was version-pinned.

**The bootstrap step no longer runs through `npx` either.** Every bootstrap
command in this README now reads:

```bash
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp && ./node_modules/.bin/walrus-console-mcp <verb>
```

`npx` and a bare `npm install` (no `--prefix`) both perform an ambient
**upward** resolution step before they run anything: `npx` walks up looking
for a same-named package to launch instead of fetching one, and a bare
`npm install` walks up looking for the nearest `package.json` to treat as the
project root. `cd "$(mktemp -d)"` alone defeats only the first of those — it
stops a project's own `node_modules` from shadowing the install, which is
what the original mitigation here covered. It does **not** stop the second:
`mktemp -d` directories are typically created under `/tmp` or `$TMPDIR`, a
shared, sometimes multi-tenant directory, and if any ancestor **above** the
fresh directory carries a `node_modules` (or a `package.json`) planted by
another process on that machine, the upward walk can still find and use it —
reaching outside the fresh directory entirely.

`npm install --prefix <dir> <spec>` has no such walk: it fetches `<spec>`
from the registry and installs it into `<dir>/node_modules`, full stop —
there is no ambient resolve-and-run step for a planted ancestor directory to
hijack. `mktemp -d` is kept in the command above because it is still good
hygiene (an isolated, disposable directory), but it is no longer
load-bearing for this attack; `--prefix .` is what actually closes it, by
construction, wherever the directory happens to sit. `--ignore-scripts`
additionally stops the fetched package's own `preinstall`/`postinstall`
(or that of any of its dependencies) from running arbitrary code during this
one-time bootstrap.

The installer installs the launcher only when it registers at least one agent.
If you ticked none (Claude Desktop, for example, is not on its list), install it
yourself into the same private directory:

```bash
npm install --prefix "${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp" --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp
```

The installer pins the package to its own version; to match it, append
`@<version>`, since a bare name installs whatever npm's `latest` tag points at.
To upgrade, re-run it with the new version. On Windows, in PowerShell:

```powershell
npm install --prefix "$env:LOCALAPPDATA\walrus-console-mcp" --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp
```

The launcher is then `node_modules\.bin\walrus-console-mcp.cmd` under that folder.

Get the path with:

```bash
echo "${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp"
```

**Claude Code:**

```bash
claude mcp add --scope user walrus-console-mcp -- ~/.local/share/walrus-console-mcp/node_modules/.bin/walrus-console-mcp
```

`--scope user` makes it available in every project. Use `--scope local` to scope it to the current project only.

**Codex:**

```bash
codex mcp add walrus-console-mcp -- ~/.local/share/walrus-console-mcp/node_modules/.bin/walrus-console-mcp
```

**Cursor, Gemini CLI, or any hand-written config:** point
`command` at the same absolute path, with no arguments. For example, in a Claude
config file (usually `~/.claude.json`, `~/.claude/config.json`, or `~/.config/claude/config.json`) —
paste the path printed by the `echo` above — MCP clients spawn `command` without
a shell, so `~` is not expanded:

```json
{
  "mcpServers": {
    "walrus-console-mcp": {
      "command": "/home/you/.local/share/walrus-console-mcp/node_modules/.bin/walrus-console-mcp",
      "args": [],
      "description": "Walrus Console decentralized storage"
    }
  }
}
```

After registering, restart the agent (or reload the window if using it inside VS Code / Cursor), run `/mcp`, and **approve** `walrus-console-mcp` when prompted. Then try (for Antigravity, reload as described in [Antigravity](#antigravity) below instead of restarting):

- `ping_console`
- `list_spaces`
- `create_bucket` (with a space ID)

**About file paths in `upload_file` / `download_file`:** relative paths (and `~`) are resolved against **your current workspace**, not the server's install location — so "upload `report.pdf`" and "download to `~/Downloads/x.pdf`" do what you'd expect from whatever project you're working in. Paths are sandboxed to your allowed roots (see [Security Model](#security-model)).

**About `upload_file`'s accept-then-poll pattern:** it returns as soon as Console accepts the upload — `fileId`, a non-terminal `state`, and a note — not once the file finishes processing, even for a large file that takes minutes. Poll `get_file_status` with the returned `fileId` until it reports `completed` or `failed`; do not call `upload_file` again for the same file while waiting, even if the response feels fast. The read/encrypt/upload step itself (before accept) is bounded at 4 minutes server-side as a hang guard, but it can still take **longer than your MCP client's own default request timeout** (commonly 60s) on a slow connection or a very large file — that limit is spent transferring the file, which nothing server-side can shorten. If your client disconnects before this call returns, that is not necessarily a failed upload: Console may have already accepted enough of the transfer to create the file before the disconnect. Check `list_files` for a file with that name before uploading again, to avoid creating a duplicate. If your client lets you configure its own request timeout, raising it is the more reliable fix for large uploads over a slow connection.

> **Note for clients that don't advertise MCP roots** (e.g. Grok, Claude Desktop, Cursor): file access **fails closed**. A refused `upload_file` / `download_file` names the path it refused and the folders that ARE allowed today, and points at the `config` command below — not just the env var. The installer asks for folders during setup — or you can name them on the command line, including alongside the address pins the Console's **Connect MCP** panel copies, and the **File access** step is skipped:
>
> ```bash
> walrus-console-mcp install --allowed-dirs ~/Documents --owner-address 0x…
> ```
>
> Run that one at a terminal: carrying a pin keeps the run interactive, so it goes on to prompt for the credentials, and outside a TTY it cancels and writes nothing. A folder that does not exist is refused before anything is written, naming every bad path. To change the folders later:
>
> ```bash
> walrus-console-mcp config --allowed-dirs ~/Documents --allowed-dirs ~/Downloads
> ```
>
> PowerShell:
>
> ```powershell
> walrus-console-mcp config --allowed-dirs $HOME\Documents --allowed-dirs $HOME\Downloads
> ```
>
> You can also set `CONSOLE_MCP_ALLOWED_DIRS` to a `PATH`-style list separated by `:` (`;` on Windows), with `~` expansion — that env var still beats the saved list. Example: `CONSOLE_MCP_ALLOWED_DIRS="$HOME/Documents:$HOME/Downloads"`. Clients that advertise roots (your open workspace folders) need no extra configuration.

### Antigravity

One entry covers the Antigravity desktop app, the Antigravity IDE and the `agy`
CLI: all three read `~/.gemini/config/mcp_config.json` (the same path under your
home directory on macOS, Linux and Windows, where it is
`%USERPROFILE%\.gemini\config\mcp_config.json`). Some guides cite
`~/.gemini/antigravity/mcp_config.json`; that is the old, pre-migration per-app
path, so do not use it. The installer registers it as the **Antigravity** row,
after Gemini; the Gemini row is unchanged, for Gemini CLI installs that still
exist.

By hand, merge this into `mcpServers`, with the absolute launcher path from the
`echo` above (the path shown is illustrative):

```json
{
  "mcpServers": {
    "walrus-console-mcp": {
      "command": "/home/you/.local/share/walrus-console-mcp/node_modules/.bin/walrus-console-mcp",
      "args": []
    }
  }
}
```

Keep any servers already in the file. The installer does the same merge, leaves
every other server and key alone, and refuses, touching nothing, if the file is
not strict JSON (comments or trailing commas), its top-level value is not an
object (`null`, arrays, strings, numbers, or booleans), or `mcpServers` is not an
object. Repair an existing invalid file before registering; only a missing file
is initialized as an empty config. Put no credentials in this entry:
they stay in the server's own config file. Antigravity does not expand `$VAR` in
`env`, so a reference to a shell variable would arrive as literal text, and a
literal value would sit in plain text in Antigravity's shared config file.

The same rules hold for Cursor's `~/.cursor/mcp.json`. If the file is a symlink
(a dotfiles manager), the installer writes through it to the linked file and
keeps the link; a link that does not resolve, or a path that is not a regular
file, is refused. If the app saves the file while the installer is merging, the
merge is redone from the app's version; after three changes in a row it stops and
writes nothing. Once every agent is registered the installer reads each file
back, and if the app has saved older settings over the entry it says so instead
of counting it as configured: re-run the installer.

The installer also refuses while `~/.gemini/config/.migrated` is missing. That
means Antigravity has not finished its first start, and its first-launch
migration would replace the file and drop the entry. Open the Antigravity app or
run `agy` once, then re-run the installer. If you edit the file by hand, do it
after that first start for the same reason.

Neither the app nor `agy` reloads the file on its own, so reload it explicitly.
In `agy`, open `/mcp` and reload; in the Antigravity app, press
refresh under **Settings → Customizations → Installed MCP Servers**. MCP tools
run in Ask mode until you allow them.

### Claude Desktop

The installer does not register Claude Desktop. Install the launcher as above,
then add the `mcpServers` entry to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on
Windows, `~/.config/Claude/` on Linux). Save your credentials with the `config` command; Claude Desktop does
not advertise MCP roots, so name your folders there too (see the note above).
Once the [`.mcpb` desktop extension](#mcpb-bundle-one-file-distribution) is
published, installing that replaces these steps.

### Add to Cursor links

Console's **Add to Cursor** button sets this server up without a terminal. A
Cursor install link can only add a `{command, args}` entry to
`~/.cursor/mcp.json`, and Console cannot know an absolute launcher path on your
machine, so this is the one place the package is still started through `npx`,
and only in this form:

```json
{
  "command": "npx",
  "args": [
    "--prefix=${userHome}",
    "-y",
    "@mysten-incubation/walrus-console-mcp@<version>",
    "--import-bundle",
    "<base64url credential bundle>"
  ]
}
```

- `--prefix=${userHome}` is what makes that `npx` safe. Without it, `npx`
  prefers a same-named package in the open project or any parent directory, and
  reads a project `.npmrc` that can point its registry and cache elsewhere. With
  an explicit prefix it does neither. Cursor expands `${userHome}`, and the
  prefix has to name a directory that exists.
- On the first start, `--import-bundle` saves the bundle with the same checks
  as `walrus-console-mcp config --credential-bundle`, then replaces it in
  `mcp.json` with `-`. Cursor restarts the server from the cleaned entry, so no
  later start carries the secret. Cleanup follows config symlinks and keeps the
  links and backing file's permissions; it refuses dangling links and non-regular
  files. An entry without `--prefix` gains it in the same rewrite. If the config
  changes during cleanup, no replacement is published: restart the server to
  retry. The final check reduces concurrent-write races but cannot eliminate the
  small gap before rename. Cleanup does not erase arguments from an already
  running process; reload Cursor to start from the cleaned entry.
- A link never replaces a saved key. If `config.json` or `admin.json` already
  holds a different key, the bundle is removed without being imported; switch
  keys with `walrus-console-mcp config`. A config with no key yet (folders only,
  or empty) is filled in, keeping what it had. A `config.json` that cannot be
  parsed is reported and the bundle kept until the file is repaired.
- If Console cannot be reached, nothing is saved and the bundle stays for the
  next start: turn the server off and on in Cursor's MCP settings to retry. A
  malformed bundle, or a key Console refuses, is removed.
- Each outcome is one line in the server's log in Cursor.
- Name the entry `walrus-console-mcp`, the name the installer registers. A
  later `install` that ticks Cursor then replaces this entry with its absolute
  launcher instead of adding a second copy of the server.
- The bundle carries keys and address pins, not folders, and Cursor advertises
  no MCP roots, so after a link install `upload_file` and `download_file` refuse
  every path until folders are set. Save them once with
  `walrus-console-mcp config --allowed-dirs <dir>`. Setting
  `CONSOLE_MCP_ALLOWED_DIRS` in the entry's `env` also works, but the variable
  beats the saved list: while the entry carries it, folders saved with `config`
  are ignored, and changing them means editing `mcp.json`.

The bundle still travels in the link itself: in the page, in Cursor's install
dialog, and on the command line of the process tree that first start launched
(the server, and under `npx` its npm parent too). Removing it from `mcp.json`
does not change the command line of a process already running; it is gone once
Cursor restarts the server from the cleaned entry, which it does when it sees
the file change.

## Security Model

- Console never has access to your plaintext files or decryption keys.
- Your `CONSOLE_SERVICE_PRIVATE_KEY` never leaves your machine
- Encryption, decryption, and signing happen locally
- The server only communicates with Console using your API key
- Every sponsored transaction Console returns is decoded and checked before either key signs it — sender, sponsorship, command kinds, package **and** function targets, and referenced objects. For a bucket create that extends to the whole command graph: who becomes the owner, exactly which addresses are granted which role, who receives group management, and that the signing key demotes itself on the way out. Anything else is refused, unsigned.
- `create_bucket` will not run at all without a bucket-owner address pinned locally, and it authors the rest of the bucket's roster from chain state instead of trusting the endpoint's list. See [Who gets access to a new bucket](#who-gets-access-to-a-new-bucket-create_bucket), which also names the two disclosed gaps — both leave a bucket under-permissioned and neither can over-permission one.
- File access is restricted to your allowed roots
- `download_file` **never replaces a file that is already at `destPath`** unless the call passes
  `overwrite: true`. An opted-in replacement keeps the old file's permissions where they are
  tighter than `0o600` and clamps them to `0o600` where they are looser, so decrypted content
  never lands readable by more people than a download to a fresh path would be. A dest whose
  **final component is a symlink is refused even with `overwrite: true`**; give a
  real file path. The sandbox decides where a download may land; this decides what happens when
  something is already there, so a prompt-injected agent cannot overwrite a dotfile or a
  credential file with content it chose.
- Path sandboxing **fails closed**. `upload_file` (localPath) and `download_file` (destPath) are confined to the allowed roots — the filesystem roots your MCP client advertises, or `CONSOLE_MCP_ALLOWED_DIRS` when the client advertises none, or `allowedDirs` saved by `install` / `config`. If none of those is available the path is **rejected**, so a model-chosen path (e.g. from prompt injection) can't reach an arbitrary file. Relative paths (and a leading `~`) are resolved against the first allowed root rather than the MCP server directory.
- Symlinks are resolved before the containment check: a symlink inside an allowed root that points outside it is rejected, not followed. `upload_file` still follows live in-root links (macOS `/tmp` → `/private/tmp`). `download_file` additionally refuses a dest whose **final component** is a symlink, even when the target is inside the roots. A new file under an in-root **directory** symlink (`link-dir/new.txt`) is still allowed; the link is resolved before the write, so the file lands in the real directory it points at — refusing parent links would break `/tmp`.
- **Accepted limitation (ancestor-directory TOCTOU):** the _final_ path component is protected against a symlink swapped in after validation (reads open with `O_NOFOLLOW`; downloads write a sibling temp then `rename`), but a swap of an _ancestor_ directory between the check and the open is not closed — Node exposes no `openat2`/descriptor-relative traversal on any platform. Exploiting it requires a local process that already holds write access inside an allowed root and wins a race — a strictly weaker position than reading the credential file directly. Prefer per-user allowed roots, and avoid pointing `CONSOLE_MCP_ALLOWED_DIRS` at a directory that other local users can write — or whose ancestor directories they can write.
- Contract identity is resolved by **network** (one Console deployment per network: testnet, mainnet); a loopback host gets the testnet package set. A wrong package set cannot over-permission anything — the validator allowlists exact packages and refuses to sign, anchors recorded under other ids go stale, and `seal_approve` targets a package the key servers will not honour.

## MCPB bundle (no-terminal install for Claude Desktop)

The server can be packaged as a single `.mcpb` file — a Claude Desktop Extension — for drag-and-drop / double-click install, no terminal required. The bundle inlines all dependencies (Seal/Sui are pure JS, no WASM), so it runs standalone with `node` — no `node_modules` needed.

**Download:** the packed bundle ships inside the npm package, so the latest release is always at
`https://cdn.jsdelivr.net/npm/@mysten-incubation/walrus-console-mcp@latest/walrus-console-mcp.mcpb`
(pin a version by replacing `@latest` with e.g. `@0.1.0`). To build it locally instead:

```bash
pnpm mcpb:validate   # validate manifest.json against the v0.3 schema
pnpm mcpb:pack       # build the self-contained bundle, then pack -> walrus-console-mcp.mcpb
```

Double-clicking the packed file opens Claude Desktop's extension install form, which asks for seven discrete fields, in the order below. The form blocks Install until the four **Required** fields are filled; the three **Optional** fields have no such gate:

| Group        | Field                    | Env var                             | Needed for                                                    |
| ------------ | ------------------------ | ----------------------------------- | ------------------------------------------------------------- |
| **Required** | Web Account Address      | `CONSOLE_WEB_ACCOUNT_ADDRESS`       | `create_bucket`'s owner pin                                   |
| **Optional** | Key Admin Address        | `CONSOLE_KEY_ADMIN_ADDRESS`         | `create_bucket`'s manager pin, if the space has a Key-Admin   |
| **Required** | Console API Key          | `CONSOLE_API_KEY`                   | every Console API call                                        |
| **Required** | Service Private Key      | `CONSOLE_SERVICE_PRIVATE_KEY`       | upload/download (Seal encrypt/decrypt + signing)              |
| **Required** | Allowed Directories      | `CONSOLE_MCP_ALLOWED_DIRS`          | upload/download, since Claude Desktop advertises no MCP roots |
| **Optional** | Key Admin Credential     | `CONSOLE_ADMIN_KEY`                 | `generate_api_key` (provisioning host only)                   |
| **Optional** | Admin Signer Private Key | `CONSOLE_ADMIN_SERVICE_PRIVATE_KEY` | `generate_api_key` (provisioning host only)                   |

Key Admin Address depends on the space, not on whether this host holds the admin pair. Console adds a management grant to a new bucket only while the space has an active Key-Admin key, and `create_bucket` refuses to sign a grant it can't check. So on such a space a host with only a working key needs the address, which the Connect MCP panel shows as **Management Service Account**; a host holding the admin pair derives it from the admin signer. A space with no active Key-Admin key builds no grant and needs no address, and the panel shows none, which is why the field can't be Required. Left blank on a space that does have one, `create_bucket` refuses and names this field.

Allowed Directories is a native folder picker (`type: "directory"`, `multiple: false`) that takes one folder; to cover several, pick a folder that contains them. It can't take more than one because Claude Desktop saves a `multiple: true` answer as an array and won't substitute an array into an env string: it logs `Cannot replace user_config.console_mcp_allowed_dirs with array value in string context` and passes the literal `${user_config.console_mcp_allowed_dirs}`, which the server reads as a relative folder, so every upload and download is refused.

The three Optional fields carry `"default": ""` in `manifest.json`. Claude Desktop substitutes `${user_config.X}` only for a field that has a saved value or a manifest `default` ([modelcontextprotocol/mcpb#250](https://github.com/modelcontextprotocol/mcpb/issues/250)), and a field the user never clicks into isn't saved. Without the default, a blank Optional field reaches the server as the literal string `${user_config.console_admin_key}`. That isn't empty, so the server would treat it as a configured admin credential and let it override a valid pair saved in `config.json`; `""` counts as unset. `tests/manifestSync.test.ts` fails if a field wired into `env` is optional without a `default`, or has `multiple: true`.

Two rendering quirks worth knowing before editing `user_config` titles/descriptions: Claude Desktop appends its own `(required)` badge next to a `required: true` field's title, so a title that also spells out "(required)" shows it twice — the four Required fields above have no such suffix in `manifest.json`, only the Optional ones do, since nothing auto-labels those. Separately, Claude Desktop reuses each field's `description` string as the empty input's placeholder text too, not just as help text below it — the same string renders in both places, unavoidably, since there is no separate `placeholder` property (checked against the official manifest schema and reference examples). Given the repeat is unavoidable, the credential fields' `description` is a bare format hint (`hbr_…`, `suiprivkey1…`, `0x…`) rather than a restatement of the title — useful as placeholder text, not just redundant with it.

Each value the Console's **Connect MCP** panel shows can be pasted straight into its matching field — no `CONSOLE_CREDENTIAL_BUNDLE` JSON to assemble and no `config`/terminal step afterward. `manifest.json`'s `user_config` passes each field straight through as its own env var (see the table above); the server resolves them exactly as it does the same discrete env vars set by hand (`src/config.ts`, `src/pathSandbox.ts`). There is no Console API Base URL field — the extension always targets the public mainnet endpoint (`DEFAULT_CONSOLE_API_BASE_URL`, `src/baseUrl.ts`); a testnet server needs `CONSOLE_API_BASE_URL` set directly in the environment the server runs in, outside the extension form.

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

## License

MIT

## Acknowledgments

Built on [Walrus Console](https://github.com/MystenLabs/console), powered by [Walrus](https://github.com/MystenLabs/walrus) and [Seal](https://github.com/MystenLabs/seal).
