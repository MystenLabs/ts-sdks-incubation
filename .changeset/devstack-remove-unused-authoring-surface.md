---
'@mysten-incubation/devstack': minor
---

Remove unused plugin-authoring API surface that had no consumers.

The decl authoring helpers `routable`, `strategyContributor`, `snapshotable`, and `codegenable` are removed from the package root. Built-in plugins build these contribution decls as inline `{ kind: '...' }` object literals, so the helpers carried no callers; `projection` remains (it has live call sites). The `PluginContext` passed to plugin contribution functions also drops its unused `persist`, `requires`, and `fail` verbs — plugins persist via `CacheService` and read strategies via the strategy registry directly — leaving a closed five-verb authoring surface (`codegen`, `endpoint`, `snapshotExtra`, `publish`, `provides`).

No in-repo consumer used any of these. External plugin authors building decls through the removed helpers should switch to the inline `kind` literals.
