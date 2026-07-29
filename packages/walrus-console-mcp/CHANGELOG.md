# walrus-console-mcp

## Unreleased

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