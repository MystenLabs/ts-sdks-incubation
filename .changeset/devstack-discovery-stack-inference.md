---
'@mysten-incubation/devstack': patch
---

Build-integration manifest discovery (vitest, playwright, vite) now infers the default stack name from the nearest package.json `name`, matching the CLI's `resolveStackName` ladder (explicit > `DEVSTACK_STACK` > package name > `main`). Previously the discovery ladder hard-defaulted to `main`, so in a bare app — where `devstack up` names the stack after the package — `pnpm test` (and any standalone consumer of the discovery ladder) failed with "no devstack manifest found for stack 'main'" even though the stack was live. The vitest setup hook's stack advisory now names the inferred stack too.
