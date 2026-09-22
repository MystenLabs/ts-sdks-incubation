---
'@mysten-incubation/devstack': patch
---

Pin `@effect/platform-node-shared` to match the pinned `effect` version. `@effect/platform-node`
depends on it with a caret prerelease range, so fresh installs pulled `4.0.0-rc.117`, which imports
a module that `effect@4.0.0-beta.65` doesn't have, and `devstack` crashed on startup with
`ERR_MODULE_NOT_FOUND`.
