# walrus-console-mcp

## Unreleased

### Added

- Interactive install now has a **File access** step that saves `allowedDirs` in
  `config.json`, so clients that do not advertise MCP roots (Grok, Claude Desktop)
  can upload/download without exporting `CONSOLE_MCP_ALLOWED_DIRS`. Already
  installed: `walrus-console-mcp config --allowed-dirs <dir>` (repeatable; the
  Windows-safe form) or the **File access folders** chooser in `config`.

### Changed

- **Breaking:** `create_bucket` no longer returns a top-level `members` field.
  What the new bucket grants is now reported from both sides: `identity.members`
  is what the transaction this server signed was found to do, and
  `roster.members` is what this client demanded. They agree because the validator
  refuses to sign a transaction where they do not. Alongside them the result
  carries `identity.owner`, `identity.signerRole`, `roster.reason`,
  `roster.droppedCandidates` and `sealPolicyId` — and **`disclosure` is the field
  to show a user**. An empty roster means either "this space has only this key"
  or "nothing could be verified, so nobody else was granted access", and those
  two write identical transaction bytes and leave identical state on Console, so
  that one sentence (with `roster.reason`) is the only place the difference
  exists.
- **Breaking:** every `create_bucket` now requires a bucket-owner Sui address
  pinned locally — `CONSOLE_WEB_ACCOUNT_ADDRESS`, or `webAccountAddress` in the
  config file. Without one the tool refuses before any network call. The
  transaction's `add_owner` call carries no type argument to bound a substituted
  recipient, so an owner taken from the response is an owner the endpoint chose;
  local config is the only thing that can catch that. Provision it by pasting the
  `CONSOLE_CREDENTIAL_BUNDLE` from the Console key-mint screen into `install` /
  `config`, or by entering the address at the prompt those flows now ask.
  `keyAdminAddress` / `CONSOLE_KEY_ADMIN_ADDRESS` is the second pin: it is needed
  only where the reserve carries a management grant, which is every space that
  holds a Key-Admin key — worker hosts cannot derive that address, so they refuse
  such a create until it is pinned.
- **Breaking:** an updated client cannot create a bucket against a Console
  deployment older than COMG-746. Those reserves build the pre-`add_owner` shape,
  and the one create-bucket arm this client ships rejects it. That is a statement
  of what already happens, not a compatibility mechanism: the arm is chosen by
  client-side intent and the old arm was deleted rather than kept for "old"
  responses, because dispatching on the response's shape would hand a hostile
  endpoint a downgrade switch back to the weaker check.
- If you ran this branch mid-development, `~/.config/walrus-console-mcp/anchors.json`
  (`%APPDATA%\walrus-console-mcp\anchors.json` on Windows) **heals itself — no
  action required.** An anchor recorded before the group id was derived locally
  holds a **server-supplied** id, and nothing in the file distinguishes it from
  a derived one, so this client no longer trusts either shape on sight: entries
  lacking a `creator` are dropped at load, and an entry whose recorded
  derivation inputs are absent or differ from the ids in use is treated as
  **stale** — the next `create_bucket` in that space takes the bootstrap path
  and re-anchors it. A hard refusal is reserved for the case that actually
  warrants suspicion: recorded inputs that match, and a stored group id that
  still does not reproduce from `(bucketId, creator)`. Deleting the file is
  harmless if you prefer, since it is pure cache. This affects no released
  version.
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
- `create_bucket`'s anchor bookkeeping (`recordAnchor`) is now serialized across
  processes with the same file lock the config writer uses. It previously loaded,
  mutated and saved `anchors.json` unlocked, so two concurrent `create_bucket`
  calls on the same host could each report `anchorRecorded: true` while one of
  their anchors — potentially another space's too — silently disappeared. A
  contended lock now surfaces as an honest `anchorRecorded: false` instead of
  losing data.
- Atomic writes generate a per-attempt random nonce for their temp file, instead
  of deriving the temp name from the destination path and pid alone. A retry
  immediately after a cancelled write could previously collide with the
  still-live temp of the prior attempt (`EEXIST`) or have its own temp deleted by
  that attempt's detached cleanup (`ENOENT` at rename). A temp left by a crashed
  process now accumulates instead of colliding with the next attempt.
- Upload/download path canonicalization now runs inside the request's own
  Effect fiber, using async filesystem calls, instead of synchronous
  `realpathSync`/`lstatSync`/`readlinkSync` on the main thread before the
  request's `AbortSignal` was even attached. A stalled NFS/FUSE mount behind a
  user-chosen path previously froze the stdio transport and every other
  in-flight tool call on the very first request; the walk no longer runs
  synchronously on the main thread, so a stalled mount no longer freezes the
  whole server that way. It is not abortable, though: `fs/promises`
  `realpath`/`lstat`/`readlink` take no `AbortSignal`, so a cancelled request
  still abandons the underlying `realpath(2)` call, which keeps running in the
  libuv threadpool; a handful of requests naming paths on the same stalled
  mount can exhaust the default `UV_THREADPOOL_SIZE=4` and stall all `fs` work
  and DNS lookups process-wide. Raise `UV_THREADPOOL_SIZE`, and keep allowed
  roots off unreliable network mounts, to limit the exposure.
- The transfer permit `uploadFileToBucket` holds is released as soon as an
  upload's bytes are accepted, instead of being held through up to 180s of
  status polling afterward. The permit exists to bound peak payload memory, not
  to serialize polling; holding it that long blocked every unrelated upload and
  download for the duration of one upload's activation wait.
- Every write-failure test (`storageCreateBucket.test.ts`,
  `mintedCredentialStore.test.ts`, `keyAdmin.test.ts`) now injects the failure
  through a `vi.mock` spy — on `writeFileAtomic`, or on the
  `persistMintedCredential` spy that suite already installs — instead of
  `chmod 0o500` on the config directory, which a process running as `root`
  ignores. Those tests previously failed spuriously when the suite ran as root,
  because the chmod never actually injected the write failure their assertions
  depended on. No `chmod 0o500` failure injection remains in the suite.

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
- A hostile or compromised Console endpoint can no longer choose who receives
  access to a bucket this server creates. The owner and the Key-Admin are pinned
  against local configuration (see the `create_bucket` notes above), and the rest
  of the roster is **authored by this client**: the intersection of the space's
  anchor groups' on-chain membership — bucket groups this MCP created and
  validated on earlier runs, whose object ids are derived locally from the
  transactions this client validated rather than read out of the responses —
  with the space's active signers, with every role read from chain instead of
  the scope the API claims. Membership in **any** anchor counts, and a member's
  role is the one it holds on the **newest** anchor that holds it — not the
  highest across anchors, so an old anchor cannot restore an `editor` revoked on
  recent buckets; a create adds an anchor and never replaces one, so a bucket
  whose roster came out identity-only cannot shrink what the next create can
  verify.
  The returned transaction is then refused unless it grants exactly that roster,
  makes exactly the pinned address the owner, hands management to nobody but the
  pinned Key-Admin, and contains the three calls demoting the signing key — an
  *omission* none of the other pins could catch. Every read happens before the
  reserve, so a failure refuses at the cost of one retry rather than creating a
  bucket that is permanently under-permissioned. Two gaps are disclosed rather
  than papered over: a space's first bucket has no anchor, so it grants no other
  service account, and a key that has never been granted on a bucket this MCP
  created cannot be verified and is left off the roster (it is named in
  `roster.droppedCandidates`, as is a key whose on-chain role contradicts the
  scope Console claims for it — authoring that role would make the API reject
  the whole create). Both leave a bucket under-permissioned; neither can
  over-permission one.
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
- Cancelling an in-flight Seal encrypt/decrypt (or the local file read/download
  write around it) now holds the transfer permit until the abandoned promise
  actually settles, instead of releasing it immediately on interrupt. Seal's SDK
  accepts no `AbortSignal`, so an interrupted call keeps running in the
  background; releasing the permit right away let a retry be admitted while the
  abandoned call still held a full plaintext-and-ciphertext buffer, exceeding the
  single-transfer memory bound the permit exists to enforce. Bounded by an
  explicit settle timeout, so a promise that genuinely never settles still
  releases the permit eventually; `SealClient` now states its `timeout: 10_000`
  explicitly rather than relying on the SDK default.
- The roster verifier (`authorVerifiedRoster`) now enforces its own bound on how
  many anchors it will enumerate (`MAX_CONSULTED_ANCHORS`, 32), instead of
  relying on `anchorStore`'s read cap to keep the list it is handed small. The
  verifier's loop had no bound of its own — correct today only because every
  caller happens to go through a store that already caps at 32 entries, not
  because the loop protects itself.
- Contract identity is resolved by **network** (one Console deployment per
  network: testnet, mainnet); a loopback host gets the testnet package set. A
  wrong package set cannot over-permission anything — the validator allowlists exact packages and
  refuses to sign, anchors recorded under other ids go stale, and `seal_approve`
  targets a package the key servers will not honour.

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