# @mysten-incubation/create-devstack-app

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
