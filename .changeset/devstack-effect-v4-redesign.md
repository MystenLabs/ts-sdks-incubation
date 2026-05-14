---
'@mysten-incubation/devstack-effect': major
---

v4 redesign — interface-driven multi-implementation primitives.

The package is still `private: true`. This is a tracking changeset for the
post-Phase-1-through-11 reshuffle.

**Added.**

- Interface tags in `src/interfaces/` — `Sui`, `Package`, `LocalPackage`,
  `Coin`, `WalrusNetwork`, `WalrusNodes`, `WalrusProxy`, `WalrusAdmin`,
  `SealKeyServer`, `SealKeyManager`, `DeepbookCore`, `DeepbookAdmin`,
  `DeepbookMarketMaker`, `AccountShape`. Every multi-impl factory produces
  a `Layer` for one of these; consumers depend on the tag, not on a
  specific factory.
- `provideTag(InterfaceTag, build)` — primary tag factory. `makeTag` is
  retained as one-off-tag sugar.
- Multi-impl factories: `suiLocalnet` / `suiTestnet` / `suiMainnet` /
  `suiCustom`, `deepbookLocalDeploy` / `deepbookKnownPackage`,
  `walrusLocalCluster` / `walrusKnownDeployment`, `sealLocalKeygen` /
  `sealKnownKeyServer`.
- `provideDevstack(stack, opts)` — pure-DI consumption surface (no TUI,
  no run-loop). `examples/effect-app/` demonstrates the consumer
  pattern.
- `accounts({alice: {from: 'ephemeral-funded' | 'keystore' | 'env' | 'inline'}})`
  source discriminator. The bare `{}` shorthand still maps to
  `ephemeral-funded`.
- `manifest({extras: object | (() => object) | Effect})` — plain-JS
  overloads alongside the Effect form.
- `pickCreatedByTypeSuffix` / `pickCreatedByTypeIncludes` helpers in
  `src/primitives/sui-helpers.ts` for `publishMove({capture})` and
  `manifest({extras})`.
- `knownDeployments` registry (`src/internal/known-deployments.ts`) with
  real deepbook + walrus + seal URLs for testnet/mainnet.
- Shipped subpath dts — `./dapp-kit`, `./vitest`, `./playwright`,
  `./plugin-author` no longer need consumer `tsconfig` overrides.

**Breaking (renames + removals).**

- `sui()` → `suiLocalnet()` (and friends). The old name is gone.
- `walrus()` → `walrusLocalCluster()`.
- `seal()` → `sealLocalKeygen()`.
- `deepbook()` → `deepbookLocalDeploy()`.
- Legacy `Walrus` composite tag removed. Yield `WalrusNetwork` /
  `WalrusNodes` / `WalrusProxy` / `WalrusAdmin` instead.
- Legacy type aliases removed: `Seal`, `SealOptions`, `WalrusOptions`.
  Use `SealLocalKeygenShape`, `SealLocalKeygenOptions`,
  `WalrusLocalClusterOptions`.
- `PublishedPackage.path` → `PublishedPackage.sourcePath`.
- `composeTag` is retired from the recommended surface. Existing
  primitives have migrated to `provideTag` + multi-Layer composition;
  the export remains on `./plugin-author` for advanced cases that still
  want aggregate-tag semantics.

**Other.**

- 55 vitest tests across 12 files cover the unit-testable slice.
- See `README.md` for the audience-segmented overview and
  `PLUGIN-AUTHORING.md` for the plugin-author walkthrough.
