# @mysten-incubation/devstack

## Unreleased

First documented pre-release after the multi-phase surface stabilization. Major lines of work:

### Surface stabilization (Phases 0-8)

The package was rewritten over eight planned phases that landed before this entry. The result is a
single root barrel (`@mysten-incubation/devstack`) carrying every built-in plugin factory, plugin
authoring helper, capability decl type, and substrate helper namespace. The only public subpaths
are the L5 build-integration entrypoints — `/vitest`, `/vitest/setup`, `/playwright`,
`/playwright/global-setup`, and `/runtime` — exposed for tree-shaking and L5 isolation. See
`ARCHITECTURE.md` for layer boundaries and `STYLE_GUIDE.md` for code-level patterns.

### Critical correctness fixes

- Snapshot recovery scanner: a fresh `supervise` startup now reads the on-disk
  `snapshot.restore-pending.json` marker, re-tags any managed image that the restore step staged
  but did not promote, and clears the marker. Closes the SIGKILL-during-promote silent-failure
  window.
- Capability sinks atomicity: `registerSink` now wraps the `Ref.modify` + finalizer pair in
  `Effect.uninterruptible` so a fiber interrupt between the two does not leak a registration
  without a paired teardown.
- Supervisor background-snapshot interrupt: aligned with the stack-restart interrupt path —
  both now await `Fiber.interrupt` rather than returning immediately.
- Cross-process roster: heartbeat / release / setIntent paths now key on `(pid, startTime)`
  rather than `pid` alone, removing the PID-recycle false-match window.
- File-channel short-read: command-channel readers advance `state.offset` from the actual
  bytes returned, not from a stale `stat.size`. Closes the truncated-tail window.
- Windows path bug: the postgres data-dir bootstrap and walrus cargo-image loader now use
  `fileURLToPath(...)` instead of `decodeURIComponent(url.pathname)` so the leading `/` on
  Windows-style `file:///C:/...` URLs is stripped correctly.
- Deepbook: `buildKnownPlugin` now stamps a `pluginKey` matching the local/override branches
  so the dep-graph row-identity is stable across config edits; `findExistingPoolId` treats the
  normalized `0x0` address as the "no pool" sentinel instead of returning a bogus id.
- Walrus partial-URL handling: `known-deploy` nullifies only the missing URL field rather
  than all three when one is absent.
- Action plugin: produce-phase failures preserve their phase tag through
  `ArtifactPublishError` wrapping; build-phase raw `Error` throws are converted to typed
  `Effect.fail`.
- Account funding: the SUI funding branch is now strongly typed end-to-end rather than
  resting on a `<AccountFundingStrategy>` cast.

### Public API surface stabilization

Root-barrel exports added so plugin authors and embedders can author without reaching into
package subpaths:

- Contracts: `Renderer`, `RendererError`, `EntrypointDecl`, `NetworkResolver`,
  `NetworkResolutionError`, `FUNDS_READY_GATE_KEY`, `pluginErrorContributions`,
  `PluginErrorContribution`.
- Network inference helpers: `parseDevstackNetwork`, `parseDevstackNetworkName`,
  `DevstackNetworkParseError`, `resolveAppName`, `resolveStackName`, `resolveNetwork`,
  `DEFAULT_STACK_NAME`, `DEFAULT_DEVSTACK_NETWORK`, `DEVSTACK_NETWORK_NAMES`,
  `ParsedDevstackNetwork`, `ResolvedDevstackNetwork`, `DevstackNetworkName`.

A `resolveNetwork({ explicit, env, default })` helper centralizes the
`options > env > default` precedence so `api/run-stack.ts` and `cli/main.ts` no longer carry
parallel inline ladders.

### Capability contract ergonomics

- `projection({ kind, key, payload })` shorthand alongside the verbose
  `projection({ event })` form, so common-case callers don't restate `tag` + `at`.

### Layer-boundary fixes

- `build-integrations/{vitest,playwright}` now re-export `ManifestEnvelope`,
  `ManifestEnvelopeSchema`, `parseJsonTextSync` through `build-integrations/runtime/` rather
  than reaching across into `substrate/`.
- `playwright/wallet-context.ts` re-exports `WalletHttpPath` through the runtime bridge
  instead of importing from L0–L3.
- `build-integrations/runtime/conventional-routes.ts` derives the plugin-name route table
  from the manifest at runtime rather than from a hardcoded list.

### Documentation

- `ARCHITECTURE.md` now explicitly names `orchestrators/built-in-plugin-layers.ts` and
  `orchestrators/runtime-composition.ts` as the documented "built-in defaults composition"
  seam, with the plugin-author equivalent being `RunStackOptions.extendContext` +
  `CapabilitySinksService`.
- Substrate name-blindness allowlist documents the `account/`, `package/`, `wallet/`
  projection-key prefix exception.

### Tests

- Per-capability-decl contract tests added under `test/contracts/` — one per decl kind
  pinning the discriminated-union literal + required-field shape + a happy-path decode.
- Bug-regression tests added for each critical correctness fix above (recovery scanner,
  capture identity merge, prune misrouting, exit-code table, network validation, …).
- `CapabilitySinks` unregistered-kind test pins that emitting a custom kind with no
  registered sink surfaces a typed error.

### Removed stub surfaces

- `plugins/sui/seed-objects.ts` accumulator (never wired).
- `plugins/sui/live-faucet-strategy.ts` (never wired).
- `plugins/deepbook/` server / indexer routable factories and the
  `DEEPBOOK_SERVER_*` / `DEEPBOOK_INDEXER_METRICS_*` reserved entrypoint ports (never
  wired).

These will be re-introduced when actually consumed.

## 0.0.1

### Patch Changes

- 133fb14: Add the signer package required by the dev-wallet adapters barrel to scaffolded apps,
  align the generated Vitest version with devstack's published peer range, and update the devstack
  install docs.
- 133fb14: Switch to trusted publishing.
