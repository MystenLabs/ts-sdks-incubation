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