---
'@mysten-incubation/create-devstack-app': patch
---

Scaffolded apps now install and boot on pnpm 11. The templates ship a `pnpm-workspace.yaml` with an `allowBuilds` map — the key pnpm 11+ reads, since it no longer reads the `pnpm` field in `package.json` — plus the mirrored `pnpm.onlyBuiltDependencies` in `package.json` for pnpm 10, approving the `esbuild` / `msgpackr-extract` / `protobufjs` native build scripts. Previously a stock pnpm-11 user's `pnpm install` / `pnpm dev` failed with `ERR_PNPM_IGNORED_BUILDS` before the app ever started.
