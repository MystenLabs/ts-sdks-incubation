---
'@mysten-incubation/walrus-console-mcp': minor
---

Initial release of the Walrus Console MCP server: bucket and file management
against the Walrus Console API with Seal-encrypted private files, client-side
transaction validation (owner/manager/roster pins on sponsored create-bucket
PTBs), a path-sandboxed filesystem surface, and a guided credential installer.
Runs against Walrus Console on mainnet by default; testnet is available via
`CONSOLE_API_BASE_URL=https://api.testnet.console.walrus.xyz`.
