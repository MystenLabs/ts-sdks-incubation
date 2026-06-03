---
'@mysten-incubation/devstack': minor
---

Reshape generated codegen output, make `deepbook()` a one-liner local DeX, and fix dashboard snapshot/restore.

**Codegen reshape (breaking for consumers of generated output).** `generated/` is now a runtime-only surface: a single combined `config.ts` (`{ network, networks, packages.byNetwork, objects }`) plus per-plugin siblings (`seal.ts`, `walrus.ts`, `deepbook.ts`, `coins.ts`) and Move `bindings/`. Dev-only and secret artifacts (the account name→address map and the dev-wallet pairing config) move out of the committed app surface into `.devstack/stacks/<stack>/generated-extras/`, reachable via a new `@devstack-dev` path alias. The old `accounts.ts` / `packages.ts` / `services.ts` / `sui/network.ts` / `dapp-kit/config.ts` / `extras.ts` outputs are removed; the `dappKitConfig` export is now `devWallet`. `localPackage` / `knownPackage` gain a `networks` option for per-network (testnet/mainnet) package and object ids, projected into `config.packages.*.byNetwork` and `config.objects` — so the same generated shape can target a real network with pre-deployed contracts by switching `config.network`.

**Deepbook one-liner.** `deepbook()` (or `deepbook({ mode: 'local' })`) with no arguments now provisions a working local DeepBook DeX: it bundles the DeepBook v3 + sandbox-Pyth Move sources as plugin assets, synthesizes the publish plus an ephemeral funded publisher, and seeds a default DEEP/SUI pool — consumable directly through `@mysten/deepbook-v3` against localnet. `package` / `pyth` / `pools` / `publisher` are now optional overrides; `known` / `override` modes are unchanged.

**Dashboard snapshot/restore.** A restore triggered from the web dashboard now re-acquires services automatically (no manual restart required) and surfaces `snapshotting` / `restoring` status instead of staying on "running". The post-restore re-acquire excludes the dashboard and host-service transport, so the restore mutation returns its result cleanly instead of tearing down the connection it is answering on (previously surfaced as a 502).
