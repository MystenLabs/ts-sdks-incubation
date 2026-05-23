# Vendored Move sources

The DeepBook trader example publishes these local packages during `devstack apply` so CI and
new checkouts do not need sibling `deepbookv3` or `deepbook-sandbox` repositories.

- `deepbookv3/token`, `deepbookv3/deepbook`, and `deepbookv3/dusdc` come from the upstream
  DeepBook v3 Move packages.
- `deepbook-sandbox/pyth` comes from the sandbox Pyth package used by local DeepBook setups.
- `deepbookv3/deepbook/Move.toml` uses a local `token = { local = "../token" }`
  dependency so the example stays self-contained.

When refreshing these sources, copy only source/package metadata and leave tests plus generated
`build/`, `package_summaries/`, and `Move.lock` files out of the vendored tree.
