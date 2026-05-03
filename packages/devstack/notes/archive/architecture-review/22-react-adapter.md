# React adapter

**Verdict**: A− — Solid, opinionated layer that genuinely removes per-app boilerplate without forking the dApp Kit story. Two warts: a `globalThis.__devstackDAppKit__` shim and a runtime probe for `waitForTransaction`.

## Architecture

The split is the standard React shape: one context (`DevstackProviderState = { manifest, packages }`) provided by `<DevstackProvider>`, consumed by `useDevstackContext` / `useDevstackManifest`, with task-shaped hooks layered on top. The provider intentionally lives *inside* dApp Kit's providers and `QueryClientProvider`, so the manifest-aware layer is purely additive — it never tries to own wallet or query state.

`bindPackage` is the load-bearing helper. It walks codegen module exports and wraps each function whose `length <= 1` so `options.package` defaults to the live `packageId`. That decouples codegen output (which uses the `@local-pkg/<name>` placeholder) from runtime address resolution and means every typed builder pre-binds without per-call casts.

`createDevstackDappKit` is a thin synchronous factory around `createDAppKit` + `SuiGrpcClient` — it owns network wiring and accepts pre-built `walletInitializers`, leaving the dev-wallet adapter and panels to the caller.

The walrus builder (`createDevstackWalrusClient`) is a small but pivotal piece: it lazy-imports `@mysten/walrus`, pulls `systemObject`/`stakingObject` from `manifest.registry.packages[walrus].captured`, and installs a fetch override that rewrites internal docker IPs to host-mapped proxy URLs from `manifest.registry.walrus.nodes`.

## Problem fit

`useDevstackPackage('vault')` beats inline manifest lookups on every axis: typed (via the `DevstackPackageRegistry` augmentation pattern, mirroring dApp Kit's `Register`), centrally validated ("not deployed yet" vs silent `undefined`), and memo-stable. The `useDevstackPackageOptional` variant for graceful pre-deploy gating is the right complement. `useDevstackDeployed({ requirePackages })` cleanly subsumes the per-app `isDeployed` constants.

The debug panel is genuinely useful: reflective form-per-builder with a JSON-array argument editor and a real `signAndExecute` submit, scaffold-eth-style. `import.meta.env.DEV` gating is the right default. The JSON-array UI is barebones — fine for v1.

## Integration

Composition is straightforward: `QueryClientProvider` → `DAppKitProvider` → `DevstackProvider` → app + `<DevstackDebugPanel>`. Module augmentation `declare module '@mysten-incubation/devstack/react' { interface DevstackPackageRegistry { vault: typeof vault } }` is the codegen typing seam, and the `dapp-kit.ts` file shows the dev-wallet adapter feeding into `walletInitializers` cleanly.

The `globalThis.__devstackDAppKit__` shim in `useDevstackSignAndExecute` is the ugly part. The hook needs `dAppKit.signAndExecuteTransaction`, but importing the app's specific `Register['dAppKit']` module-augmented instance from a peer-dep package isn't possible — so the lookup goes through a global. Two real consequences: (a) two devstack apps in one realm overwrite each other (already warned for in `createDevstackDappKit`), and (b) the hook is tied to consumers using the helper.

## Customizability + gaps

- **Custom tx patterns**: nothing blocks them — apps build their own `Transaction`, call `vault.uploadEntry({...})(tx)`, then either pass to `useDevstackSignAndExecute` or call `dAppKit.signAndExecuteTransaction` directly.
- **Error surfaces**: hook errors throw with actionable messages naming the next CLI command (`pnpm localnet:up`). The `useMutation` carries errors through `mutation.error`. No retry/backoff.
- **Invalidation**: simple keyset-based; runs after `waitForTransaction`. Missing: no `onSuccess` passthrough on the hook; per-call invalidation overrides require a wrapper.
- **Suspense / SSR**: hooks throw on missing manifest/dAppKit instead of suspending. `<DevstackProvider manifest={null}>` is documented as "permitted" but every consumer hook throws. SSR is effectively unsupported.
- **`bindPackage` heuristic**: arity-`<=1` is reasonable for codegen 0.10.x but coupled to that emitter shape.
- **`waitForTransaction` probe**: the runtime fallback (skip-the-wait if missing) trades a hard error for a silent invalidation race.

## Testing

Three tests cover: `bindPackage` (curry, override, pass-through, arity guard) — solid. `useDevstackDeployed` (null/empty/required-package matrix) — solid. `createDevstackDappKit` (network/url/extend/global-slot) — solid via mocked dApp Kit and gRPC.

Gaps: no rendered-hook tests for `useDevstackPackage`/`useDevstackPackageOptional`; no `useDevstackSignAndExecute` test (the global shim, the digest-extraction multi-shape parser, and the `waitForTransaction` fallback all want exercise); no `<DevstackProvider>` test; no `<DevstackDebugPanel>` test; no `createDevstackWalrusClient` test (the URL-rewrite override is the bug-prone part).

## Top recommendations

1. **Replace the `globalThis.__devstackDAppKit__` shim** with a `useDappKit()` hook the consumer threads explicitly, or accept `dAppKit` as a parameter to `useDevstackSignAndExecute`. Removes the global-overwrite footgun and SSR/micro-frontend hostility.
2. **Add rendered-hook tests** with `@testing-library/react` for `useDevstackPackage`, `useDevstackSignAndExecute` (digest extraction + waitForTransaction fallback + invalidation), and a smoke test for `<DevstackDebugPanel>`.
3. **Test `createDevstackWalrusClient`'s fetch override**: rules-not-matched, prefix-match, `Request`-branch.
4. **Surface invalidation knobs**: pass `onSuccess`/`onError`/`mutationKey` through `UseDevstackSignAndExecuteOptions`.
5. **Codify the codegen-builder contract** with a marker symbol (`Symbol.for('codegen.builder')`) instead of arity-`<=1` heuristic.
