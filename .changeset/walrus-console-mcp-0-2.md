---
'@mysten-incubation/walrus-console-mcp': minor
---

Sync Walrus Console MCP for the 0.2.0 release. Silent installs now require
`--register` or `--no-register`. Saved folders support explicit shared access,
and file transfers reject Home as a root and protect sensitive download paths.
Destructive tools request human confirmation when the client supports it.

`ping_console` verifies the configured key against Console, and the running
server checks in on startup. Bearer and signer credentials are paired from the
same source, and tool errors hide stack traces by default. Bucket creation preserves the
reserved bucket ID when finalize cannot confirm the result, and uploads report
the stored filename.

List, create, rename, move, and delete subfolders in Console buckets. Upload and
list files in a specific folder, or move files between folders in the same
bucket without re-encrypting them. Recursive folder deletion requires explicit
confirmation.
