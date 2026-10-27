---
'@mysten-incubation/walrus-console-mcp': patch
---

Upgrade `zod` to 4.6.6+ (GHSA-mrhx-c7xc-m3w5) and refresh the shipped `npm-shrinkwrap.json` with patched `body-parser` 2.4.0, `fast-uri` 3.1.9, and `ip-address` 10.7.5. A `generate_api_key` response missing `permissions`, `status`, or `private_buckets` still parses to the documented fallbacks, and `update_file`'s nullable `description`/`tags` inputs keep their descriptions in the JSON schema agents see.
