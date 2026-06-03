---
'@mysten-incubation/devstack': patch
---

Fix a stray NUL byte in the codegen orchestrator's `pathKey` separator (`orchestrators/codegen/service.ts`). The NUL made `file(1)` classify the source as binary `data` and caused `grep` to silently skip it, and it also broke the duplicate-output-path error message: that path is extracted with `pathKey.slice(pathKey.indexOf(' ') + 1)`, which expects a space separator the NUL wasn't. The separator is now a space, fixing both the tooling/grep issue and the error-message extraction.
