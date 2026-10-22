---
'@mysten-incubation/walrus-console-mcp': patch
---

Refuse known-vulnerable Node versions at startup. The server now requires stable Node 22.23.4+, 24.22.1+, or 26.12.1+ within those major lines, per the October 2026 Node.js security releases; odd-numbered majors, unreviewed future majors, prereleases, and malformed version strings are refused with exit status 1 and a message naming the detected version. The check runs from a dependency-free bootstrap before any application module loads, in both the npm bin and the `.mcpb` bundle. Update the Node executable your MCP host actually launches and restart the host.
