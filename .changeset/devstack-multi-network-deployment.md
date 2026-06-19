---
"@mysten-incubation/create-devstack-app": minor
"@mysten-incubation/dev-wallet": minor
"@mysten-incubation/devstack": minor
---

Multi-network deployment config.

- **devstack**: renamed the persisted `id-config`/`ids` layer to `deployment` (`NetworkDeployment`/`DevstackDeployment`, `loadDeployment`, `dump-deployment`). Added multi-network support — per-network service buckets via `forNetwork(network)`, typed committed `deployments/<net>.ts` files (`dump-deployment --network <net>`), and a deployment envelope merged at the Vite layer (committed networks for a prod build, the live local stack overlaid on `vite dev`). Removed the legacy `resolve*()` config-runtime shims and the `@devstack-dev/generated-extras` subsystem.
- **dev-wallet**: the injected dev wallet now operates across the full network set — it advertises every configured network as the wallet-standard chain `sui:<name>` (including fork/custom names), routes a per-network faucet, and stays registered across a dApp Kit `switchNetwork`. `createDevstackAdapterFromManifest` accepts an optional `networks` set so manifest-built adapters advertise the same chains.
- **create-devstack-app**: templates reshaped around the deployment API and multi-network deployments (typed `deployments/<net>.ts` authoring surface, dApp Kit wired to the generated network set).
