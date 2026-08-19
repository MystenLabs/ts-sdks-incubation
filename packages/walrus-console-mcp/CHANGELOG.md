# walrus-console-mcp

## Unreleased

### Changed

- **Breaking:** Seal encryption now targets the **decentralized committee key
  server** for the resolved network, replacing the three independent testnet key
  servers at threshold 2. The key server's on-chain identity is embedded in every
  ciphertext, so **files encrypted by earlier versions cannot be decrypted after
  this upgrade** — re-encrypt anything you still need before deleting the
  originals. This brings the MCP in line with the Console web app (COMG-511), so
  files encrypted by one now decrypt in the other.
- Seal `fetch_key` requests go through the Console API's proxy
  (`/api/v1/seal/aggregator`) rather than Seal's aggregator directly, authenticated
  with the `CONSOLE_API_KEY` you already configure. The proxy holds the
  Enoki-issued aggregator key server-side (COMG-580), so **no new configuration is
  required** — the endpoint follows `CONSOLE_API_BASE_URL`, and mainnet needs no
  Seal credential on this side.

### Fixed

- **Breaking:** `generate_api_key` now returns `{ ok, credential }` rather than the
  credential directly. A mint is irreversible from the moment Console accepts it,
  but the space check, the bucket grant and the activation poll all run *after*
  that — and each used to fail by throwing away the only copy of the new key's
  secrets, leaving a live key nobody could use. Those steps now return
  `ok: false` with the credential intact, plus `stage` and `recovery`. They stay
  on the success channel deliberately: an `isError` result invites a retry, and a
  retry here mints a *second* key while orphaning the first. This matters more
  than it looks, because `/api/v1/api-keys` answers 403 to both credential types
  ("requires session authentication"), so an orphaned key cannot be listed or
  revoked programmatically at all — only by hand in the Console UI.

- Tool failures are now flagged with the MCP `isError` field. Without it a client
  saw a *successful* tool call whose text happened to describe a failure, so it
  could not branch on the outcome and an agent read the error prose as a result.
  `ping_console` also goes through the shared error boundary now.
- Cancelling a tool call now interrupts the work it started. The request's
  `AbortSignal` was dropped at the handler boundary, so uploads, downloads,
  decryption, status polling and destination writes all continued after the caller
  disconnected.
- `install` and `config` resolve the Console base URL as env → saved config →
  default, matching the server's own resolution. Rotating a credential for a saved
  staging or local deployment previously validated it against testnet while
  leaving the old URL in place.
- Replacing an API key no longer keeps the previous key's service signer. The two
  are a matched pair, and a mismatched pair does not fail at configure time — it
  fails later inside Seal, with a message that points nowhere near the cause. The
  interactive flow asks (default: remove); `--silent` removes it.
- The id of an accepted upload is logged as soon as Console accepts the bytes and
  attached to any error raised while polling, so a crash or a failing status check
  leaves a recoverable id instead of prompting a duplicate re-upload.

### Added

- A failed private download now says whether the Console proxy was the problem.
  `SealProxyError` carries a `condition` (`disabled`, `rate_limited`,
  `unavailable`, `misconfigured`, `credential`, `request`, `unknown`) plus the raw
  Console `code`, so an agent can tell "that deployment has the proxy switched off"
  from "your service key is not the one registered for this API key" from a genuine
  access denial — which stays Seal's own `NoAccessError` and is deliberately left
  alone. `misconfigured` is the one that will not clear on retry: it means the
  Console's own aggregator credential was rejected upstream.

### Security

- **Breaking:** the MCP server is no longer launched through `npx`. The installer
  now installs the package into its own directory
  (`$XDG_DATA_HOME/walrus-console-mcp`, `%LOCALAPPDATA%` on Windows) and registers
  the **absolute path** of the resulting launcher. `npx -y <package>` resolves the
  name against the current working directory first, so an agent started inside a
  project that ships a package of the same name would launch *that* package under
  this server's identity, with read access to the credentials in
  `~/.config/walrus-console-mcp`. **Re-run `install` to update existing
  registrations** — an entry still pointing at `npx` keeps the old behaviour. The
  `.mcpb` bundle was never affected.
- Sponsored transaction bytes returned by Console are now decoded and validated
  before either key signs them. Previously they were signed as-is, which made the
  working key and the Key-Admin key arbitrary signing oracles for any endpoint
  that passed the base-URL allowlist — including whatever happens to be listening
  on `localhost` when `CONSOLE_API_BASE_URL` points there. Sender, sponsorship,
  command kinds, package **and** function targets, referenced objects, the grant
  recipient, and the grant scope are all checked; a `read` grant that comes back
  as `add_editor` is refused rather than silently upgraded to write access.
- Uploads now open the source file with `O_NOFOLLOW`, so a symlink planted
  between path validation and the read cannot redirect it, and take the size from
  the open descriptor rather than a separate `stat()`. Downloads write through a
  same-directory temp file renamed over the destination, so a symlink planted at
  the destination is replaced rather than followed, and a failed write can no
  longer truncate an existing file. Decrypted downloads are written `0600`.
- Both transfer directions are now bounded: uploads reject before buffering,
  downloads reject on `Content-Length` and again on a running byte count while
  reading, and one transfer runs at a time. Each transfer holds two full copies
  of the payload (plaintext and Seal ciphertext), so an unbounded or concurrent
  transfer could end a long-lived MCP session. Override the 256 MiB default with
  `CONSOLE_MCP_MAX_TRANSFER_BYTES`.
- Registering with a client whose config cannot be read or parsed now **fails
  instead of replacing it**. Only a missing file counts as empty; previously any
  error produced an empty config, so one unreadable byte erased every setting
  that client had. The write itself is atomic.

### Security

- **Breaking:** path sandboxing for `upload_file` / `download_file` now **fails
  closed**. Previously, when an MCP client advertised no filesystem roots, any
  absolute path was allowed. Now such clients (e.g. Claude Desktop) must set
  `CONSOLE_MCP_ALLOWED_DIRS` (a `PATH`-style list of directories) or the file
  tools return an error. Clients that advertise roots are unaffected. Symlinks
  are resolved before the containment check, so a symlink inside an allowed root
  that escapes it is rejected.
- `CONSOLE_API_BASE_URL` is now validated: it must be `https` to a `*.walrus.xyz`
  host, or `http(s)` to localhost. This prevents the API key (sent as a Bearer
  token on every request) from being redirected to an arbitrary host.

## 0.1.0

### Patch Changes

- 47370e4: Initial release