# Example app authoring flow (cross-cutting)

**Verdict**: B− — Devstack is roughly **80% of an SE-2 caliber experience** for an opinionated user once they're inside this monorepo. Runtime is genuinely strong; **what's missing to close the gap is almost entirely the on-ramp**. No `create-devstack-app`, no template directory, no recipe in the docs that maps "I want to add example #5" to a sequence of commands.

## Summary

Devstack runtime is genuinely strong — declarative reconciler with status-skip, single combined `pnpm dev` log, typed `useDevstackPackage()` hooks bound to the live `packageId`, and a credible live-network `deploy --network testnet` story via per-account `cliSigner`/`envSigner` factories. That's a real upgrade over SE-2 in several places.

**What's missing**: there is no `create-devstack-app`, no template directory, no copy-paste-ready `examples/_template/`. The four existing apps each carry ~12 boilerplate files of effectively-identical scaffolding. A fresh dev's first hour is spent xeroxing one of arena/wallet/token-studio and diff-editing names. SE-2's `yarn create scaffold-eth` hides exactly that step.

## The path today

**1. Discoverability.** `README.md` and `packages/devstack/README.md` are well-written; `getting-started.mdx` is concrete. But none answer "how do I add example #5?" — the docs assume you've installed devstack into an existing app. The four apps under `examples/` are the only de-facto template, and you find them by reading source. There is no `pnpm create devstack-app my-app` and no `examples/_template/`.

**2. Boilerplate per app.** Concrete duplication, after diffing the four apps:

- `src/dapp-kit.ts` — **byte-identical across all four apps** (32 lines).
- `src/main.tsx` — identical except for one line of `import * as <pkg> from './generated/sui/<pkg>/<module>.js'` and the `DevstackPackageRegistry` augmentation.
- `playwright.config.ts` — one-liner, all identical.
- `vitest.config.ts` — one-liner, all identical.
- `vite.config.ts` — same five plugins, only the port number differs.
- `tsconfig.{app,node,json}` — identical except `private-content` has a single missing `baseUrl` line.
- `index.html` — identical except the `<title>`.
- `src/index.css` — verified identical (Tailwind import + Inter/JetBrains font tokens + dark mode).
- `src/vite-env.d.ts` — each app **inlines** the 50-line `Manifest` shape from devstack to avoid pulling devstack's TS source through the app's typecheck.
- `src/generated/deployment.ts` — each app hand-writes a 40–95 line manifest projection.
- `src/lib/format.ts` — `shortAddress`/`labelFor` is **explicitly noted as the "fourth copy" with a `FRICTION` comment**.
- `<appName>Plugin.ts` co-located in each app root.
- `package.json scripts` — eight identical entries copied app-to-app.

**3. Friction points vs SE-2.** SE-2's narrative is "clone, run three commands, edit one Solidity file, your UI updates." Devstack's equivalent narrative *exists* but there are sharp edges:

- **Per-app port hand-allocation.** Each app picks RPC/faucet/walletServer/Vite ports by hand to avoid collisions with sibling apps. SE-2 doesn't have this problem because there's exactly one app.
- **The `vite-env.d.ts` inlining.** Every new app has to duplicate 30–50 lines of TS module declaration. The fix (a single `/// <reference types="@mysten-incubation/devstack/manifest" />`) is a one-day project but unbuilt.
- **`deployment.ts` ceremony.** Friction-journal-acknowledged but live. Apps currently can't write generic UI utilities against "the deployment" because shapes diverge.
- **dApp-kit + dev-wallet + devstack-wallet-panels three-package import chain.** The friction journal already flagged the `createDevstackDappKit` factory as the right answer (which exists), yet the four apps still all paste identical 32-line files.
- **Move.toml authoring.** No template. `[addresses]` + `[package]` + `[dependencies]` interactions surface late as obscure publish errors.
- **No e2e starter.** `connect-four.spec.ts` reads the manifest via raw `JSON.parse(readFileSync)`, recapitulates loadKey, etc.

**4. Path to production.** Better than SE-2 in concept: `cliSigner({ alias })` + `envSigner({ name })` + per-network `accounts: { publisher: { testnet: cliSigner(...), mainnet: envSigner(...) } }` is cleaner than SE-2's hardhat-network constants gymnastics, and `devstack deploy --network testnet` skips Service+Build correctly. But: no docs page on "deploying my-app to testnet", no recipe for capturing addresses across local→testnet→mainnet promotion, no monitoring/observability hooks, no secrets management beyond raw env vars.

## What devstack genuinely beats SE-2 at

- **Reconciler with `getStatus`.** Warm cycles are 1–3 s vs SE-2's "redeploy on every restart." This is a real win.
- **`useDevstackPackage()` with manifest-bound builders.** SE-2 has typed-contract bindings via wagmi codegen; devstack's hook pre-binds the `packageId`, which SE-2 does not.
- **Multi-stack support.** `devstack stack new feature-x` for parallel experiments has no SE-2 analog.
- **Server-backed signing** (`walletServer()` + `DevstackSignerAdapter`) keeps dev keys out of the bundle. SE-2 puts burner keys in localStorage.
- **`DevstackDebugPanel`** as a built-in form-per-builder — SE-2's `/debug` page inspired it but devstack's is reflective rather than hand-coded.

## Verdict

**Scaffold-eth-2 caliber: not yet.** The runtime story is at parity or better; the **authoring story is missing the most visible piece — a scaffolder.** A `pnpm create @mysten-incubation/devstack-app my-app` that writes the 12 boilerplate files plus a `move/<name>/` skeleton plus a wired `<Name>Plugin.ts` would close ~70% of the gap. The other ~30%: lift `format.ts` + `deployment.ts` + the `vite-env.d.ts` declarations into the package, auto-allocate ports per stack, and add a "deploy to testnet" walkthrough.

## Top recommendations (smallest-cost-first)

1. **Ship `@mysten-incubation/devstack/manifest.d.ts`** ambient declaration — eliminates `vite-env.d.ts` inlining.
2. **Lift `examples/*/src/lib/format.ts`** (literally labelled "fourth copy") into `@mysten-incubation/devstack/react` or a new `@mysten-incubation/ui-utils`.
3. **Auto-allocate ports** based on app name hash unless overridden.
4. **Add `examples/_template/` and an `examples/README.md`** "to add an app" recipe — does not even require a code generator.
5. **Then build `pnpm create devstack-app`.**

Steps 1–4 are <1 week and would already make the gap to SE-2 feel like polish rather than a missing feature. Step 5 is the headline ergonomic win.
