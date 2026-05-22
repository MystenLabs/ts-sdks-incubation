# Service family cleanup plan

Last updated: 2026-05-22.

## 1. Context and goals

This plan covers the built-in service plugin families:

- `packages/devstack/src/plugins/walrus`
- `packages/devstack/src/plugins/seal`
- `packages/devstack/src/plugins/deepbook`
- `packages/devstack/src/plugins/postgres`
- service docs and examples, especially `examples/private-content` and `examples/deepbook-trader`.

The goal is to make service factories mode-explicit, delete placeholder/local-only surfaces that do
not represent real built-in workflows, and keep the private-content and DeepBook examples honest.

Composite/lifted-sibling cleanup, router entrypoint ownership, and substrate boundary decoupling
have already happened. This plan focuses on each service family's public API and plugin-local
architecture.

## 2. Audit findings

### Service factories repeat env-driven mode defaults

Current shape:

- `walrus()`, `seal()`, and `deepbook()` each inspect `DEVSTACK_NETWORK` or assume local defaults.
- Their fallback behavior differs:
  - Walrus auto-routes fork/live networks to known deployments.
  - Seal throws on localnet unless a signer is supplied.
  - DeepBook local mode requires env deployment ids; non-local defaulting refuses.

Target shape:

- Prefer mode-narrowed factories for network-dependent services: `walrusFor(network)`,
  `sealFor(network)`, and `deepbookFor(network)`.
- Keep root `walrus`, `seal`, and `deepbook` only if they are local shorthands with no hidden
  environment branch.
- Update docs/examples to avoid relying on import-time env defaults.

### Public mode namespaces leak private refusal entries

Current shape:

- `walrusFor(fork)` includes `_localRefused`.
- `deepbookFor(fork)` includes `_localRefused`.
- `sealLocalKeygenStrict(network, opts)` is a second runtime-refusal factory alongside type-level
  mode narrowing.

Target shape:

- Delete underscore-prefixed public namespace members.
- Keep type-level refusal as the primary public contract.
- If runtime dynamic dispatch needs a refusal helper, keep it internal or expose one clearly named
  validator, not a factory-shaped private key.

### Walrus seed account semantics are overloaded

Current shape:

- `WalrusLocalClusterOptions.seedAccounts` means seed these accounts with WAL.
- The first seed account also doubles as the WAL exchange admin signer.
- `WalrusAdmin.seedWal(...)` fails at runtime when no seed account/exchange was wired.

Target shape:

- Split the public options:
  - `adminSigner` or `exchangeSigner` for the signer that can perform WAL swaps.
  - `seedAccounts` or `seedRecipients` for accounts that should receive initial WAL.
- Keep `admin: null` in known mode, but make local admin availability explicit at factory time.

### DeepBook local mode is not a real local deployment

Current shape:

- `deepbook({ mode: 'local', publisher })` reads `DEEPBOOK_PACKAGE_OVERRIDE_PACKAGE_ID`,
  `DEEPBOOK_PACKAGE_OVERRIDE_REGISTRY_ID`, and `DEEPBOOK_PACKAGE_OVERRIDE_ADMIN_CAP_ID`.
- The resolved local value reports empty pools, no Pyth, no server, no indexer, and no market maker.
- Docs say local mode wraps explicit local deployment ids.

Target shape:

- Rename this to an explicit override/known-local mode, or delete it until local publish/boot
  exists.
- If retained, make deployment ids options, not env-only requirements.
- Do not call it `local` unless the plugin actually creates or manages a local DeepBook deployment.

### Known deployment records are embedded but uneven

Current shape:

- DeepBook embeds mainnet/testnet package, registry, and Pyth ids.
- Walrus known deployment options require explicit object ids/nodes unless the resolver has network
  defaults.
- Seal live options have network defaults through `validateLiveInputs`.

Target shape:

- Use one naming pattern across services: `known({ network })`, `known({ ids... })`, or explicit
  live/fork branches.
- Keep hardcoded known deployment tables behind tests that prove codegen and examples match the
  intended current network.
- Make docs clear about which values are built in and which must be supplied.

### Root exports include service internals

Current shape:

- Walrus root exports include `WAL_FAUCET_STRATEGY_KEY`, `WalFaucetStrategy`, `WalFaucetRequest`,
  `WALRUS_STATE_REGISTRY_KEY`, `WalrusStateEntry`, and `WALRUS_ROUTER_PORT`.
- Seal exports registry/resource helper shapes and `SealKeyManager`.
- DeepBook exports `deepbookPluginKey` from the plugin barrel.
- Postgres exports connection string helpers and TCP endpoint constants from the root.

Target shape:

- Root exports should expose factories, option types, resolved values, bindings, and public errors.
- Registry keys, plugin keys, router ports, key managers, and faucet strategy internals should be
  internal unless a first-party custom-plugin example imports them.
- Keep Postgres connection helpers only if docs/examples use them as app-facing utilities.

### Postgres comments preserve future-live architecture

Current shape:

- The Postgres barrel describes deferred Cloud SQL/Neon/RDS live modes.
- The actual implementation is local-container only.

Target shape:

- Document the current local-only surface.
- Delete future-live comments until there is a real built-in consumer or design note.

## 3. Specific public API changes

- Remove `_localRefused` entries from `walrusFor(...)` and `deepbookFor(...)`.
- Delete or internalize `sealLocalKeygenStrict(...)` if type-level mode narrowing covers all
  first-party uses.
- Change Walrus local options so admin signer and seed recipients are separate fields.
- Rename or delete DeepBook `mode: 'local'` unless it performs a real local deployment.
- Remove service internals from the root barrel:
  - Walrus registry/faucet/router constants unless still required by tests through root imports.
  - Seal registry resource helpers and key manager types unless app-facing.
  - DeepBook plugin-key export.
- Trim Postgres public docs/comments to current local-only behavior.

## 4. Internal implementation changes

- Move service-family network defaulting behind `defineDevstackWith` or a shared helper from
  `sui-network-cleanup-plan.md`.
- Update Walrus admin construction so missing admin inputs are impossible or represented in the
  resolved type.
- Update DeepBook local/override code so deployment ids come from typed options if the mode remains.
- Keep bootstrap asset helpers inside service folders; avoid exporting build-image internals.
- Update service error exports so cross-cutting fork errors use one canonical shape without aliases
  unless root import collisions require a different public name.

## 5. Built-in plugin/component migration steps

1. Convert private-content Walrus/Seal config to the chosen explicit mode forms.
2. Convert deepbook-trader to the chosen known/override DeepBook form.
3. Update mode-narrowed type refusal tests for removed underscore properties.
4. Remove root exports and fix tests to import implementation details from internal paths only.
5. Re-run service docs and examples against generated bindings.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/features/services.mdx`
- `packages/docs/content/devstack/features/live-networks.mdx`
- `packages/docs/content/devstack/reference/services.mdx`
- `packages/devstack/README.md`

Examples to update:

- `examples/private-content/devstack.config.ts`
- `examples/deepbook-trader/devstack.config.ts`
- any template that shows service factories.

Tests to update:

- `test/plugins/walrus/local-cluster-options.test.ts`
- `test/plugins/walrus/seed-accounts.test.ts`
- `test/plugins/walrus/routable.test.ts`
- `test/plugins/seal/public-refs.test-d.ts`
- `test/plugins/seal/deploy.test.ts`
- `test/plugins/seal/keygen.test.ts`
- `test/plugins/deepbook/factory.test.ts`
- `test/plugins/deepbook/type-refusal.test-d.ts`
- `test/plugins/postgres/*.test.ts` if root exports change.

## 7. Verification commands

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/plugins/walrus/local-cluster-options.test.ts \
	test/plugins/walrus/seed-accounts.test.ts \
	test/plugins/walrus/routable.test.ts \
	test/plugins/seal/public-refs.test-d.ts \
	test/plugins/seal/deploy.test.ts \
	test/plugins/seal/keygen.test.ts \
	test/plugins/deepbook/factory.test.ts \
	test/plugins/deepbook/type-refusal.test-d.ts \
	test/plugins/barrel-imports.test.ts \
	test/build-integrations/release-surface.test.ts
pnpm --filter @mysten-incubation/private-content test:e2e
pnpm --filter @mysten-incubation/deepbook-trader build
```

Residue scans:

```bash
rg -n "_localRefused|sealLocalKeygenStrict|DEEPBOOK_PACKAGE_OVERRIDE|WALRUS_STATE_REGISTRY_KEY|WAL_FAUCET_STRATEGY_KEY|deepbookPluginKey" \
	packages/devstack/src packages/docs/content/devstack examples
rg -n "Cloud SQL|Neon|RDS|deferred" packages/devstack/src/plugins/postgres packages/docs/content/devstack
```

## 8. Acceptance criteria

- Service factories do not hide network switching behind per-plugin env parsing.
- Public mode namespaces contain no underscore/private keys.
- Walrus admin signer and WAL seed recipients are explicit.
- DeepBook does not advertise a fake local deployment mode.
- Root exports contain only app/plugin-author service APIs.
- Private-content and deepbook-trader still build or pass their focused e2e command.
- Typecheck, focused service tests, and release-surface tests pass.

## 9. Explicit out-of-scope items

- Implementing a full local DeepBook deployment if the cleanup chooses to delete/rename the fake
  local mode.
- Adding new managed cloud Postgres modes.
- Verifying current mainnet/testnet object ids against live chain data unless the implementation
  change updates those tables.
