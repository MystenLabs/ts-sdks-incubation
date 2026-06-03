---
'@mysten-incubation/devstack': patch
---

Stage A of the devstack simplification: delete the dead `state-store` (and its snapshot `state.json` phantom) and hoist the Sui-domain helpers (`sui-execute`, `sui-move-build`, `sui-ledger`) out of the name-blind substrate into `plugins/sui/{exec,move,ledger}`. Internal refactor only — no public API change (release-surface is unchanged); the substrate no longer imports `@mysten/sui` or names any plugin.
