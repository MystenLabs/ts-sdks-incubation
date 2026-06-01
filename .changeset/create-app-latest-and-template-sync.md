---
'@mysten-incubation/create-devstack-app': patch
---

Scaffolded apps now pin the matching-latest SDK versions automatically. The scaffolder injects its
own (publish-time-resolved) `@mysten-incubation/devstack` and `@mysten-incubation/dev-wallet`
versions into the generated `package.json` at scaffold time — mirroring `create-dapp` — instead of
relying on the build-time template snapshot, which could drift from the published release. The
scaffolder lists these as `workspace:^` devDependencies, so `pnpm`'s publish-time workspace-protocol
rewrite keeps them in lockstep with the release, and `pnpm create @mysten-incubation/devstack-app@latest`
always resolves the newest scaffolder. The committed template carries the synced versions as a
fallback for dev checkouts.
