# @mysten-incubation/walrus-console-mcp

Manage [Walrus Console](https://console.walrus.xyz/) files directly from Claude.

Create buckets, upload files, retrieve documents, and manage data stored on Walrus using natural language. Files remain encrypted client-side and under your control.

> **Closed beta.** Install with the `@beta` tag — every command below already
> includes it. To update during the beta, re-run the install command; installs
> are pinned to the version they fetched and never update themselves.

## Paste it to your agent and let it set it up for you

Using a coding agent like **Claude Code**, **Codex**, **Cursor**, or **Gemini CLI**? Copy the block below verbatim into the agent and it will install, configure, and verify `@mysten-incubation/walrus-console-mcp` for you. (Have your two Console keys ready — see [Get your Console credentials](#1-get-your-walrus-console-credentials).)

```text
Set up the @mysten-incubation/walrus-console-mcp MCP server for me by running these steps in order. Stop and ask me only if a step actually fails.

1. Run the interactive installer from an empty directory (so it can't launch a same-named package the current project happens to ship): `cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp@beta && ./node_modules/.bin/walrus-console-mcp install`. At the first prompt choose **Credential bundle** and paste the CONSOLE_CREDENTIAL_BUNDLE value from the Console key-mint screen — one paste carries the API key, the service key and the two addresses `create_bucket` needs pinned. If I only kept the individual values, choose **API key** instead: it asks for CONSOLE_API_KEY (starts with `hbr_`) and CONSOLE_SERVICE_PRIVATE_KEY (starts with `suiprivkey1`), then for the two addresses. Either way it validates and saves to a user-only config file. Don't print my keys back to me; the addresses are not secret and it will show them for me to confirm.
2. Let the same installer register the server — it offers a checklist of the agents it detects. That step installs the package into its own directory and writes the **absolute** path of the launcher into each config. Prefer it over registering by hand.
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
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp@beta && ./node_modules/.bin/walrus-console-mcp install
```

This interactive CLI will:

1. Ask for your credential bundle — one paste carrying the API key, the service private key
   and the two address pins — or for those values one at a time
2. Validate your credentials against the Console API, show you the addresses it is about to
   pin, and save nothing until you confirm them
3. Ask which folders `upload_file` / `download_file` may use when your agent does not share
   workspace folders (Grok, Claude Desktop). Skip this if your agent advertises MCP roots.
4. Install the server into its own directory and register it with the agents you tick
   (Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI)

After setup, restart your agent and try the `ping_console` tool.

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
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp@beta && ./node_modules/.bin/walrus-console-mcp install
```

The installer saves credentials to `~/.config/walrus-console-mcp/config.json` (`%APPDATA%\walrus-console-mcp\config.json` on Windows) with user-only file permissions. MCP client config files only need to launch the server; they do not need to contain your API key or service private key.

### 3. Run with Claude Desktop / Claude Code / Codex

Claude Desktop, Claude Code, Cursor, Codex, and Gemini CLI are all configured by
the installer's Register step. The generated server entry looks like this — the
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
| `list_buckets`           | List buckets in a space                                          | Read       |
| `create_bucket`          | Create a private encrypted bucket (needs a pinned owner address) | Write      |
| `generate_api_key`       | Mint a scoped child working key (Key-Admin)                      | Write      |
| `upload_file`            | Encrypt + upload a local file                                    | Write      |
| `download_file`          | Download + decrypt a file to disk                                | Read       |
| `list_files`             | List files in a bucket (with search)                             | Read       |
| `get_file_status`        | Check upload progress                                            | Read       |
| `get_bucket`             | Fetch a single bucket's metadata                                 | Read       |
| `rename_bucket`          | Rename a bucket                                                  | Write      |
| `delete_bucket`          | Permanently delete a bucket and its files                        | Write      |
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
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp@beta && ./node_modules/.bin/walrus-console-mcp install   # choose "API key"

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

### What it does

Given a `permission` (`read_only` | `read_write`) and an optional `label`, the tool:

1. generates a fresh child Ed25519 keypair locally,
2. mints a child `hbr_` key under the Key-Admin's scope,
3. runs one sponsored `grant_bucket_access` PTB (signed with the admin seed) granting the child
   access to the space's private buckets,
4. polls until the key is **active**, then returns the child credential pair **once**:

The **space is determined by the Key-Admin credential**, not by you — `spaceId` is a required
input only so the tool can _verify_ the minted key landed in the space you expected. That check
necessarily runs **after** the mint: the Key-Admin credential has no data-plane access
(`GET /api/v1/spaces` answers `403 key_admin has no data-plane access`), so the space cannot be
read beforehand. This mint-time PTB back-fills access to the private buckets that **already
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
    "privateBuckets": [{ "bucketId": "…", "groupId": "0x…" }],
    "credentialFile": "/home/you/.config/walrus-console-mcp/minted-keys/<hash of keyId>.json"
  }
}
```

`credential` no longer carries the raw secrets. Read `apiKey` (`hbr_…`) and `privateKey`
(`suiprivkey1…`) from `credential.credentialFile` — a private `0600` file written once, whose
contents are shown nowhere else, including this tool's own output — and hand them to the new
worker as its `CONSOLE_API_KEY` + `CONSOLE_SERVICE_PRIVATE_KEY`.

### When a step after the mint fails

The mint is the point of no return: once Console accepts it the key exists, and its `hbr_` value
has been shown for the only time it ever will be. The space check, the bucket grant and the
activation poll all run after that, so each can fail with a **live key already created**.

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

Read `ok` before using the result — **`ok: false` usually still contains a real, usable
credential**, reachable through `credential.credentialFile`. `stage` is one of `space-check`,
`grant`, `activation`, or `persist`; `detail` carries the machine-readable form of the failure so
you can tell a permanent problem (a `403 insufficient_scope` will never succeed) from a transient
one.

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

**Do not call the tool again to "retry" an `ok: false` result.** The mint already succeeded, so a
second call mints a _second_ key and orphans the first. This matters more than it sounds: Console
has no API to list or revoke keys — `/api/v1/api-keys` requires a browser session — so an orphaned
key can only be cleaned up by hand in the Console UI.

If the tool call is **cancelled** while polling, the credential cannot be delivered at all. The
server writes the orphaned key's id to stderr so it can still be found and removed; the secrets are
deliberately not logged.

If no Key-Admin credential is configured, the tool returns an actionable error and performs **no**
network call:

> `generate_api_key requires a Key-Admin credential. Set CONSOLE_ADMIN_KEY (hbradm_…) and CONSOLE_ADMIN_SERVICE_PRIVATE_KEY. A working key cannot mint.`

Configure it with the installed launcher — `"${XDG_DATA_HOME:-$HOME/.local/share}/walrus-console-mcp/node_modules/.bin/walrus-console-mcp" config` (choose **Management key**) — or export both env vars.

> **Security:** The management credential is read-capable on-chain (a grant implies read). Keep it on
> the provisioning host only — it is stored in `~/.config/walrus-console-mcp/config.json` with
> user-only (0600) permissions, so do **not** copy that file to worker hosts. A leaked working key can
> never mint or escalate; a leaked management key can, so it is separately revocable with a contained
> blast radius.

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
  Enter declines and the config file is not rewritten at all. An address the bundle carries as
  `null` **clears** any pin already saved — the bundle is the account's own answer for that key —
  and a bundle with no owner address warns that `create_bucket` will refuse until one is pinned.
- **API key** (or **Both**) — for keys minted before the bundle format existed. After the key
  prompts it asks for each address separately, re-prompts on an invalid one (never echoing what you
  typed), and confirms the exact value before saving it. Enter skips, keeping whatever is already
  saved; this path never clears a pin.
- **Management key** is not asked for the pins at all: a provisioning-only host never calls
  `create_bucket`.

Scripted / CI:

```bash
# One paste. A null address in the bundle CLEARS that pin; passing the bundle on the command line
# is itself the explicit act, so there is no confirmation prompt.
… config --credential-bundle '{"v":1,"apiKey":"hbr_…","servicePrivateKey":"suiprivkey1…","webAccountAddress":"0x…","keyAdminAddress":null}'

# Or the pins alone — validated locally, no Console probe, and neither flag touches the other pin.
… config --owner-address 0x… --key-admin-address 0x…
```

`CONSOLE_CREDENTIAL_BUNDLE` is read from the environment only under an explicit `--silent`.
Combining `--credential-bundle` with `--api-key`, `--service-key`, `--owner-address` or
`--key-admin-address` is an error — the bundle already carries those — while `--admin-key` /
`--admin-signer` compose with it, since they are a different credential.

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
  "sealPolicyId": "0x…", // also the bucket group id, derived locally — save it
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
route. Register by hand only if it could not detect your agent.

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
cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp@beta && ./node_modules/.bin/walrus-console-mcp <verb>
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

**Cursor, Gemini CLI, Claude Desktop, or any hand-written config:** point
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

After registering, restart the agent (or reload the window if using it inside VS Code / Cursor), run `/mcp`, and **approve** `walrus-console-mcp` when prompted. Then try:

- `ping_console`
- `list_spaces`
- `create_bucket` (with a space ID)

**About file paths in `upload_file` / `download_file`:** relative paths (and `~`) are resolved against **your current workspace**, not the server's install location — so "upload `report.pdf`" and "download to `~/Downloads/x.pdf`" do what you'd expect from whatever project you're working in. Paths are sandboxed to your allowed roots (see [Security Model](#security-model)).

> **Note for clients that don't advertise MCP roots** (e.g. Grok, Claude Desktop): file access **fails closed**. The installer asks for folders during setup; to change them later:
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

## Security Model

- Console never has access to your plaintext files or decryption keys.
- Your `CONSOLE_SERVICE_PRIVATE_KEY` never leaves your machine
- Encryption, decryption, and signing happen locally
- The server only communicates with Console using your API key
- Every sponsored transaction Console returns is decoded and checked before either key signs it — sender, sponsorship, command kinds, package **and** function targets, and referenced objects. For a bucket create that extends to the whole command graph: who becomes the owner, exactly which addresses are granted which role, who receives group management, and that the signing key demotes itself on the way out. Anything else is refused, unsigned.
- `create_bucket` will not run at all without a bucket-owner address pinned locally, and it authors the rest of the bucket's roster from chain state instead of trusting the endpoint's list. See [Who gets access to a new bucket](#who-gets-access-to-a-new-bucket-create_bucket), which also names the two disclosed gaps — both leave a bucket under-permissioned and neither can over-permission one.
- File access is restricted to your allowed roots
- Path sandboxing **fails closed**. `upload_file` (localPath) and `download_file` (destPath) are confined to the allowed roots — the filesystem roots your MCP client advertises, or `CONSOLE_MCP_ALLOWED_DIRS` when the client advertises none, or `allowedDirs` saved by `install` / `config`. If none of those is available the path is **rejected**, so a model-chosen path (e.g. from prompt injection) can't reach an arbitrary file. Relative paths (and a leading `~`) are resolved against the first allowed root rather than the MCP server directory.
- Symlinks are resolved before the containment check: a symlink inside an allowed root that points outside it is rejected, not followed.
- **Accepted limitation (ancestor-directory TOCTOU):** the _final_ path component is protected against a symlink swapped in after validation (reads open with `O_NOFOLLOW`; downloads write a sibling temp then `rename`), but a swap of an _ancestor_ directory between the check and the open is not closed — Node exposes no `openat2`/descriptor-relative traversal on any platform. Exploiting it requires a local process that already holds write access inside an allowed root and wins a race — a strictly weaker position than reading the credential file directly. Prefer per-user allowed roots, and avoid pointing `CONSOLE_MCP_ALLOWED_DIRS` at a directory that other local users can write — or whose ancestor directories they can write.
- Contract identity is resolved by **network** (one Console deployment per network: testnet, mainnet); a loopback host gets the testnet package set. A wrong package set cannot over-permission anything — the validator allowlists exact packages and refuses to sign, anchors recorded under other ids go stale, and `seal_approve` targets a package the key servers will not honour.

## MCPB bundle (one-file distribution)

The server can be packaged as a single `.mcpb` file for drag-and-drop install into Claude Desktop. The bundle inlines all dependencies (Seal/Sui are pure JS, no WASM), so it runs standalone with `node` — no `node_modules` needed.

```bash
pnpm mcpb:validate   # validate manifest.json against the v0.3 schema
pnpm mcpb:pack       # build the self-contained bundle, then pack -> walrus-console-mcp.mcpb
```

On install, the client prompts for the `CONSOLE_API_KEY` (required), `CONSOLE_SERVICE_PRIVATE_KEY` (optional, sensitive), the optional Key-Admin pair `CONSOLE_ADMIN_KEY` / `CONSOLE_ADMIN_SERVICE_PRIVATE_KEY` (sensitive — provisioning host only; see [Headless key minting](#headless-key-minting-generate_api_key)), and an optional `CONSOLE_API_BASE_URL` override, wired in via `user_config` in `manifest.json`.

`user_config` does **not** carry the two `create_bucket` address pins, so a bundle install cannot prompt for them. A `.mcpb` server reads the same `~/.config/walrus-console-mcp/config.json` as the CLI, so provision them once with `cd "$(mktemp -d)" && npm install --prefix . --no-audit --no-fund --ignore-scripts @mysten-incubation/walrus-console-mcp@beta && ./node_modules/.bin/walrus-console-mcp config` — see [Who gets access to a new bucket](#who-gets-access-to-a-new-bucket-create_bucket). Until then `create_bucket` refuses; every other tool is unaffected.

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
