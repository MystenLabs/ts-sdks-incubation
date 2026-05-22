# Sui network cleanup plan

Last updated: 2026-05-22.

## 1. Context and goals

This plan covers the Sui network and mode surface:

- `packages/devstack/src/plugins/sui`
- `packages/devstack/src/api/inference-network.ts`
- `packages/devstack/src/substrate/network.ts`
- docs under `packages/docs/content/devstack/features/live-networks.mdx`, `features/local-dev.mdx`,
  and `reference/services.mdx`
- tests under `packages/devstack/test/plugins/sui`, `test/plugins/network-defaults.test.ts`, and
  mode-narrowing type tests.

The goal is to make Sui mode selection explicit, typed, and hard to misread. The current surface
works, but the plugin still mixes config import-time environment defaults, per-plugin network
parsing, internal runtime handles, and user-facing network identity in one resolved value.

## 2. Audit findings

### `sui()` hides mode selection behind process env

Current shape:

- `sui()` reads `DEVSTACK_NETWORK` during config import through `resolveDefaultMode()`.
- The CLI can also override network before config import.
- Walrus, Seal, and DeepBook repeat similar env parsing for their own defaults.

Target shape:

- Keep network resolution in one surface-owned place.
- Prefer `defineDevstackWith(network, ...)` plus `suiFor(network)` for typed configs.
- If `sui()` remains, document it as local-only shorthand or make the env defaulting path an
  explicit option.

### Static network identity is modeled as runtime override knobs

Current shape:

- Every Sui mode accepts `chainOverride?: string`.
- Downstream cache keys and codegen fold the resolved `chain` into runtime state.
- A broad override can make the chain id disagree with mode/network defaults.

Target shape:

- Remove broad `chainOverride`.
- Keep explicit chain pinning only where the caller supplies the endpoint, such as external/custom
  RPC modes.
- Mode defaults should derive chain id from a probe or known mode table, not from a universal
  override.

### `external` is a Sui mode but not a network mode

Current shape:

- `SuiPluginMode` includes `external`.
- `NetworkMode` is `local | live | fork`.
- `suiFor(network)` exposes `external(...)` under the `local` branch.

Target shape:

- Pick one vocabulary:
  - either make `external` a first-class network mode, or
  - rename it to a local-branch option such as `localRpc(...)`.
- Update type-level mode tests and docs so users do not have to learn two mode taxonomies.

### Resolved `SuiClient` does two jobs

Current shape:

- `SuiClient` is both the plugin-author dependency value and an internal runtime handle.
- It exposes app-facing URLs, SDK shim, chain probe, funds-ready gate, fork admin, host-gateway
  URLs, and `buildImage`.
- Package, Coin, Wallet, Account, Walrus, Seal, DeepBook, and Action consume different slices.

Target shape:

- Split the shape into a small public/plugin-author network handle and internal runtime details.
- Keep `rpcUrl`, `faucetUrl`, `graphqlUrl`, `chain`, and `sdk` on the public handle.
- Move `hostGateway`, `buildImage`, `waitForTransactionsReady`, `chainProbe`, and fork-only admin
  surfaces behind typed capability/strategy lookups or internal service helpers where possible.

### Fork mode is coming soon and must fail clearly

Current shape:

- Forking is no longer release-gated. It is a coming-soon feature.
- `parseDevstackNetwork(...)` refuses `*-fork` CLI/env network names with
  `DevstackNetworkComingSoonError`.
- `sui({ mode: 'fork', ... })` and the mode-narrowed `suiFor(fork).<network>()` branch throw
  `SuiForkComingSoonError` synchronously.
- The internal fork modules and type surfaces still exist for future work, but they are not a
  release-supported path.

Target shape:

- Keep fork user-facing docs marked coming soon until the runtime path has real product proof.
- Do not advertise runnable fork examples or CLI commands before that proof exists.
- When fork support resumes, replace the coming-soon refusals with a tested support matrix.

### Network parser aliases are public behavior

Current shape:

- `parseDevstackNetwork(...)` accepts `local`, `localnet`, `sui:local`, `sui:localnet`, and live
  names. Fork names are recognized only to produce the coming-soon refusal.
- `test/api/inference-network.test.ts` now pins the current alias and refusal behavior.
- Docs mention `devstack up --network testnet` but not the full alias contract.

Target shape:

- Decide the canonical accepted CLI/env names.
- Keep the accepted alias table and error messages pinned as the mode surface changes.
- Avoid leaking chain-id aliases if the public CLI should only accept `localnet`, `testnet`,
  `mainnet`, `devnet`, and `*-fork`.

## 3. Specific public API changes

- Remove or narrow `SuiCommonOptions.chainOverride`.
- Rename or promote `SuiExternalOptions` so `external` no longer sits awkwardly under
  `suiFor(local).external(...)`.
- Consider making `sui()` local-only shorthand and moving env-driven mode selection to
  `defineDevstackWith`/CLI.
- Stop exporting internal Sui runtime surfaces from the root unless custom plugin authors need them:
  `ForkAdminSurface`, `WaitForTransactionsReady`, `FundsReadyStrategy`, `SeedObjectsAccumulator`,
  and `ForkMeta`.
- Keep `SuiClient` exported only after the resolved value has been split and intentionally named.

## 4. Internal implementation changes

- Centralize network parsing/defaulting in one module used by CLI, `defineDevstackWith`, and Sui.
- Update `packages/devstack/src/plugins/sui/index.ts` so capability construction does not require
  exporting the full internal resolved shape.
- Move fork admin and seed-object internals behind plugin-local modules or strategy lookups.
- Update downstream consumers to depend on narrower fields:
  - Account: chain, SDK, funding mode.
  - Package/Action/Coin: SDK, chain, build helper if needed.
  - Wallet: chain and app-facing URL.
  - Walrus/Seal/DeepBook: mode-compatible network/service handles.

## 5. Built-in plugin/component migration steps

1. Choose and apply the `external` vocabulary.
2. Split `SuiClient` and migrate built-in consumers one slice at a time.
3. Update mode-narrowed namespaces and type refusal tests.
4. Update examples to use explicit `sui({ mode: ... })` or `suiFor(network)` consistently.
5. Remove root exports that no first-party custom-plugin example uses.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/features/live-networks.mdx`
- `packages/docs/content/devstack/features/local-dev.mdx`
- `packages/docs/content/devstack/reference/services.mdx`
- `packages/devstack/ARCHITECTURE.md`
- `packages/devstack/STYLE_GUIDE.md`

Examples/tests to update:

- `packages/devstack/examples-test/complex.ts`
- `packages/devstack/test/plugins/network-defaults.test.ts`
- `packages/devstack/test/plugins/sui/local-image.test.ts`
- `packages/devstack/test/plugins/sui/local-ports.test.ts`
- `packages/devstack/test/plugins/sui/routable.test.ts`
- examples that set explicit live/fork modes.

Add tests for:

- accepted and rejected network aliases,
- `external`/renamed external mode narrowing,
- fork SDK refusal,
- no broad `chainOverride` on modes where it is deleted.

## 7. Verification commands

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/plugins/network-defaults.test.ts \
	test/plugins/sui/local-image.test.ts \
	test/plugins/sui/local-ports.test.ts \
	test/plugins/sui/routable.test.ts \
	test/api/define-devstack.test.ts \
	test/plugins/account/variants.test.ts \
	test/plugins/package/public-ergonomics.test-d.ts \
	test/plugins/action/execute.test.ts
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
```

Residue scans:

```bash
rg -n "chainOverride|mode: 'external'|SuiExternalOptions|ForkMeta|SeedObjectsAccumulator" \
	packages/devstack/src packages/docs/content/devstack examples
rg -n "DEVSTACK_NETWORK" packages/devstack/src/plugins packages/docs/content/devstack
```

## 8. Acceptance criteria

- Sui mode selection has one documented precedence path.
- `external` vocabulary is either first-class or renamed away.
- Broad `chainOverride` is gone or restricted to caller-supplied endpoints.
- Public Sui resolved types expose only intentional plugin-author fields.
- Fork support/refusal behavior is documented and tested.
- Typecheck, focused Sui/downstream tests, build, and packed-consumer smoke pass.

## 9. Explicit out-of-scope items

- Changing the Sui SDK itself.
- Adding new Sui network modes.
- Reworking Docker/router internals except where the Sui public surface requires it.
- Walrus/Seal/DeepBook mode ergonomics; covered by `service-family-cleanup-plan.md`.
