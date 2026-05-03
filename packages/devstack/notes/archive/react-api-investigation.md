# Investigation — devstack React API scope

Triggered by the observation that `@mysten-incubation/devstack/react`
exports a surface that wraps general dapp-kit-react / codegen / walrus
patterns. Apps end up importing devstack-flavored hooks throughout
their UI code, which means swapping to mainnet would require
rewriting every component that signs a tx or binds a package — the
opposite of what we want.

This note documents what's actually in the surface today, what each
export does, and what makes sense to keep / move / generalize. **No
code changes proposed for this commit** — the user's framing was
"don't complicate apps and their setups by changing things, but let's
take a careful look."

## What devstack/react exports today

```
DevstackProvider, useDevstackContext, useDevstackManifest      # manifest plumbing
DevstackDebugPanel                                             # localnet debug UI
useDevstackDeployed                                            # is-stack-up gate
useDevstackPackage, useDevstackPackageOptional                 # codegen module + pkgId
useDevstackSignAndExecute                                      # dapp-kit sign mutation
bindPackage                                                    # pure: codegen pkgId injection
createDevstackDappKit                                          # createDAppKit wrapper
createDevstackWalrusClient                                     # WalrusClient wrapper
```

Three categories under the hood (see analysis below):

1. **Localnet-as-config-source helpers** — read the manifest, expose
   the values plugins published. Legitimate devstack scope.
2. **General SDK wrappers** — wrap dapp-kit / codegen / walrus
   patterns that have nothing to do with localnet. App code consumes
   these and ends up with devstack imports threaded through every
   component.
3. **Localnet-specific config injection** — translate localnet quirks
   (docker IPs → host ports, manifest-derived RPC URL) into the shape
   a general SDK accepts. Today these are wrappers AROUND the SDK;
   the cleaner shape is config-input helpers ALONGSIDE.

## Per-export analysis

### `DevstackProvider` / `useDevstackContext` / `useDevstackManifest`

**Category 1 — keep.** The manifest is a localnet artifact (no
mainnet equivalent). Apps that target multiple networks read the
manifest on localnet and a different config source on mainnet, but
the provider layer is the natural abode for "current
deployment-state context."

Already-clean addition from Phase 6: `dAppKit?: unknown` field
threading the dapp-kit instance through context. That's an extension
of the same role (provider holds local-deployment context that
hooks need).

### `DevstackDebugPanel`

**Category 1 — keep.** Reflective debug UI, dev-only by default,
warns when mounted on a live network. Pure devstack concept.
Internally it consumes `useDevstackSignAndExecute` (a Category-2
hook) — if that hook moves, the panel moves with it or rebuilds the
sign+execute logic inline.

### `useDevstackDeployed`

**Category 1 — keep, possibly rename.** Reads `manifest.registry` to
gate UI on "stack is up." Useful only when you have a manifest, i.e.
on localnet (or after `pnpm apply`). Could rename to
`useManifestReady` or `useStackReady` for less devstack-specific
framing, but the role is fundamentally manifest-driven.

### `bindPackage(module, packageId)`

**Category 2 — pure utility, doesn't belong in devstack.** No
React, no manifest, no localnet — walks a codegen module's exports
and replaces the `'@local-pkg/<name>'` placeholder default with a
live `packageId`. This is generic codegen-runtime behavior. Lives
here only because `useDevstackPackage` consumes it.

**Where it should live:** upstream in `@mysten/codegen` (a
`bindPackage` runtime helper next to the emitter). Apps that ship to
mainnet bind once at construction time the same way:
`bindPackage(connectFourModule, MAINNET_PACKAGE_ID)`. Identical call
site between local and prod.

### `useDevstackPackage(name)` / `useDevstackPackageOptional(name)`

**Category 2 — wraps `bindPackage` with manifest lookup.**
Effectively:

```ts
function useDevstackPackage(name) {
  const { manifest, packages } = useDevstackContext();
  const pkgId = manifest.registry.packages.find(p => p.name === name).packageId;
  return bindPackage(packages[name], pkgId);
}
```

Two concerns are conflated:

- The codegen module → bound builder transformation (generic).
- The "where does the packageId come from" lookup (env-specific:
  manifest on localnet; constants/env vars on mainnet).

**The smell:** every component file in every example does
`useDevstackPackage('foo')`. To migrate that to mainnet, every call
site would change.

**Cleaner shape:** apps define their own `usePackage(name)` once, in
a per-environment file, using `bindPackage` + their resolver:

```ts
// app's lib/packages.ts on localnet
import { bindPackage } from '@mysten/codegen/runtime';
import { useDevstackManifest } from '@mysten-incubation/devstack/react';
import * as connectFour from '../generated/sui/connect_four/game.js';

const REGISTRY = { connect_four: connectFour };

export function usePackage(name) {
  const manifest = useDevstackManifest();
  const id = manifest.registry.packages.find(p => p.name === name).packageId;
  return bindPackage(REGISTRY[name], id);
}
```

```ts
// same file on mainnet
import { bindPackage } from '@mysten/codegen/runtime';
import * as connectFour from '../generated/sui/connect_four/game.js';

const REGISTRY = { connect_four: connectFour };
const PKG_IDS = { connect_four: '0xabc...' };

export function usePackage(name) {
  return useMemo(() => bindPackage(REGISTRY[name], PKG_IDS[name]), [name]);
}
```

Component code is `usePackage('connect_four')` either way. Devstack
provides manifest reading; codegen provides bindPackage; the app
owns the assembly.

### `useDevstackSignAndExecute(options)`

**Category 2 — pure dapp-kit-react ergonomics, not localnet.**
Wraps:

- `dAppKit.signAndExecuteTransaction({ transaction })` (the dapp-kit
  primitive)
- `client.waitForTransaction({ digest })` (post-confirm)
- React Query invalidation by key

dapp-kit-react 2.0.1 does NOT export a `useSignAndExecuteTransaction`
hook (verified in
`node_modules/@mysten/dapp-kit-react/dist/index.d.mts`); the
primitive lives on the `DAppKit` instance. This hook fills a real
gap, but the gap is in dapp-kit, not in devstack.

**Where it should live:**

- Ideally, upstream in `@mysten/dapp-kit-react` as
  `useSignAndExecuteTransaction({ invalidateKeys })`. There's
  precedent (the pre-2.0 dapp-kit had one).
- Until then: an app-local helper in each app's `lib/`. The four
  examples already had verbatim copies before this hook was
  extracted into devstack — putting them back is a regression in
  one sense (more code per app) but a wash in another (the code
  uses vanilla dapp-kit and survives a mainnet swap unchanged).
- Or: a separate `@mysten-incubation/dapp-kit-utils` package that
  ships generic dapp-kit-react extensions. Apps import it on every
  network.

### `createDevstackDappKit(opts)`

**Category 3 — config-input helper masquerading as a wrapper.** Reads
the manifest to derive the localnet RPC URL, then calls `createDAppKit`
with that + the user's `walletInitializers` + a few pass-through
fields. The non-localnet logic is purely call-through.

**Where it should live:**

```ts
// devstack ships:
export function localnetDappKitConfig(manifest, opts?): Partial<DAppKitConfig> {
  const rpcUrl = manifest?.registry?.services?.find(s => s.name === 'sui-rpc')?.url;
  return {
    defaultNetwork: 'localnet',
    networks: ['localnet'],
    createClient: (network) => new SuiGrpcClient({ network, baseUrl: rpcUrl }),
  };
}

// app does:
import { createDAppKit } from '@mysten/dapp-kit-core';
import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
import { manifest } from 'virtual:devstack-manifest';

const { dAppKit } = createDAppKit({
  ...localnetDappKitConfig(manifest),
  walletInitializers: [devWalletInitializer({ ... })],
});
```

The mainnet version is the same call shape with a different config
piece:

```ts
const { dAppKit } = createDAppKit({
  defaultNetwork: 'mainnet',
  networks: ['mainnet'],
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: MAINNET_RPC }),
  walletInitializers: [/* prod adapters */],
});
```

App reaches `createDAppKit` directly in both. Devstack disappears
from the production code path.

### `createDevstackWalrusClient(opts)`

**Category 3 — same shape.** Reads the manifest's
`registry.walrus.nodes` to build a fetch override that translates
each storage node's docker-internal URL (`https://10.0.0.10:9185`)
to its host-mapped port (`http://localhost:19185`), then
constructs a `WalrusClient`. The fetch override IS localnet-specific
(no mainnet walrus deployment uses internal docker IPs); the
WalrusClient construction is generic.

**Where it should live:**

```ts
// devstack ships:
export function localnetWalrusOptions(manifest): {
  packageConfig: { systemObjectId, stakingPoolId };
  storageNodeClientOptions: { fetch };
} {
  /* ... fetch override builder + manifest lookups ... */
}

// app does:
import { WalrusClient } from '@mysten/walrus';
import { localnetWalrusOptions } from '@mysten-incubation/devstack/react';
import { manifest } from 'virtual:devstack-manifest';

const client = new WalrusClient({
  suiClient,
  ...localnetWalrusOptions(manifest),
});
```

Production:

```ts
const client = new WalrusClient({
  suiClient,
  /* mainnet packageConfig + default fetch */
});
```

Same call shape; the localnet config object is the only difference.
Devstack out of the production path.

## Summary table

| Export | Category | Today | Recommendation |
|---|---|---|---|
| `DevstackProvider` | 1 | wraps manifest + dAppKit context | keep |
| `useDevstackContext` | 1 | reads provider | keep |
| `useDevstackManifest` | 1 | reads provider's manifest | keep |
| `useDevstackDeployed` | 1 | gates UI on stack readiness | keep, maybe rename |
| `DevstackDebugPanel` | 1 | dev-only debug UI | keep |
| `bindPackage` | 2 | codegen runtime util | move to `@mysten/codegen` (or app-local) |
| `useDevstackPackage` | 2 | bindPackage + manifest lookup | replace with app-local `usePackage` using `bindPackage` + `useDevstackManifest` |
| `useDevstackPackageOptional` | 2 | optional variant | same |
| `useDevstackSignAndExecute` | 2 | dapp-kit sign + react-query | move out — upstream into dapp-kit-react ideally; until then app-local helper or separate `dapp-kit-utils` package |
| `createDevstackDappKit` | 3 | createDAppKit + manifest RPC | replace with `localnetDappKitConfig(manifest)`; app calls `createDAppKit` directly |
| `createDevstackWalrusClient` | 3 | WalrusClient + fetch override | replace with `localnetWalrusOptions(manifest)`; app constructs `WalrusClient` directly |

Categories 1–3:

- **1.** Manifest-as-config-source. Devstack-specific by definition.
  Reads localnet-published artifacts. Stays.
- **2.** Generic SDK wrappers (codegen, dapp-kit-react). Don't belong
  in devstack.
- **3.** Localnet-specific config that's wrapped around a generic
  SDK construction. Should be config-input helpers, not wrappers.

## Migration approach

Don't break apps in one PR. Three rounds:

**Round 1 — Add the new shapes alongside existing ones.**

- Ship `localnetDappKitConfig(manifest)` and
  `localnetWalrusOptions(manifest)` next to the existing `create*`
  wrappers.
- Examples migrate one at a time.
- Existing wrappers gain a one-line JSDoc note pointing at the new
  shape.

**Round 2 — Pull `bindPackage` upstream into `@mysten/codegen` (if
the maintainers want it there) or move it into a tiny separate
package.** Apps import from there. `useDevstackPackage` gets a
JSDoc pointing at the new app-local pattern. Existing apps stay
working.

**Round 3 — Major bump removes the deprecated wrappers.** All four
examples already migrated by then. The new minimum surface for
`@mysten-incubation/devstack/react`:

```
DevstackProvider, useDevstackContext, useDevstackManifest, useDevstackDeployed
DevstackDebugPanel
localnetDappKitConfig, localnetWalrusOptions
```

That's seven exports, all manifest-grounded, all unambiguously
local-dev-specific. `useDevstackSignAndExecute`, `useDevstackPackage`,
`bindPackage`, `createDevstackDappKit`, `createDevstackWalrusClient`
are gone.

## Open questions for the user

1. Is the right home for `useSignAndExecuteTransaction` upstream
   `@mysten/dapp-kit-react`, or a new `@mysten-incubation/dapp-kit-utils`
   package, or app-local copies? (Each has trade-offs around who
   maintains the hook and how fast bug fixes propagate.)

2. Same question for `bindPackage`: codegen upstream vs. small
   separate package vs. app-local?

3. `useDevstackDeployed` — is the rename worth it? The current name
   is precise; a more generic `useStackReady` doesn't carry the
   "manifest-driven" connotation, which might be a feature or a bug.

4. The four examples are the canonical consumers. If the migration
   makes them visibly noisier (more imports, more boilerplate
   around `createDAppKit` / `WalrusClient`), is that acceptable as
   the price of "local code looks like prod code"? Or should the
   helpers be richer (e.g. one helper that takes manifest +
   wallet-initializers and returns a fully-wired DAppKit)?

5. Should `createDevstackDappKit` stay as a "fully-pre-wired" path
   for the very common case, with `localnetDappKitConfig` as the
   escape hatch? The downside is the smell remains — apps default
   to the wrapper and the production divergence still hurts on
   migration.
