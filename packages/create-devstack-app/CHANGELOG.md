# @mysten-incubation/create-devstack-app

## 0.1.3

### Patch Changes

- 7cfef58: Scaffolded apps now pin the matching-latest SDK versions automatically. The scaffolder
  injects its own (publish-time-resolved) `@mysten-incubation/devstack` and
  `@mysten-incubation/dev-wallet` versions into the generated `package.json` at scaffold time —
  mirroring `create-dapp` — instead of relying on the build-time template snapshot, which could
  drift from the published release. The scaffolder lists these as `workspace:^` devDependencies, so
  `pnpm`'s publish-time workspace-protocol rewrite keeps them in lockstep with the release, and
  `pnpm create @mysten-incubation/devstack-app@latest` always resolves the newest scaffolder. The
  committed template carries the synced versions as a fallback for dev checkouts.

## 0.1.2

### Patch Changes

- Restore the generated app `.gitignore` from the packed template so scaffolded projects do not
  commit `node_modules` or devstack runtime output.

## 0.1.1

### Patch Changes

- 133fb14: Add the signer package required by the dev-wallet adapters barrel to scaffolded apps,
  align the generated Vitest version with devstack's published peer range, and update the devstack
  install docs.
- 133fb14: Switch to trusted publishing.
