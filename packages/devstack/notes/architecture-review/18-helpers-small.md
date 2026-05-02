# Helpers: signers + keystore + sui-client + match-type + seed-shared-object

**Verdict**: A− — Right size, deliberately thin. Chief weakness: zero unit tests despite three of them being silent-failure prone, and the `<` matching rule is load-bearing but unmentioned in user docs.

## Architecture — what these abstractions enable

These are five **deliberately thin** helpers. Together they encode a tiny opinionated layer over `@mysten/sui` that the rest of devstack — and user plugins — can lean on without re-deriving:

- **`signers.ts`** ships three `AccountFactory` shapes (`cliSigner`, `envSigner`, `generatedKeypair`) so authors compose `accounts: { alice: { default: cliSigner({ alias: 'alice' }) } }` declaratively. Each factory hides one decoding nuisance: bech32 vs 33-byte vs 32-byte base64 (`envSigner`); aliases-then-public-key linkage against the `sui` CLI's split files (`cliSigner`); per-stack on-disk persistence (`generatedKeypair`).
- **`keystore.ts`** owns the on-disk key file format (`<stackDir>/.keys/<account>.key`, single bech32 line, `0o600`). It's the load-or-create primitive behind `generatedKeypair()` and is also read by `walletServer` so the dev-wallet's `DevstackSignerAdapter` signs with the same keys plugins use server-side.
- **`sui-client.ts`** is a one-liner factory around `SuiJsonRpcClient`. The friction it solves is documented in its own comment: four plugins were redefining it verbatim.
- **`match-type.ts`** is the load-bearing 14-line filter rule (see below).
- **`seed-shared-object.ts`** wraps "submit Move call → find created shared object in `objectChanges`" with a `buildTx?` extension hook.

None of them re-implement `@mysten/sui` machinery; they delegate. The substance is **conventions** (file paths, key encodings, factory contract) and **guardrails** (Ed25519-only, network-aware errors).

## Problem fit — do plugins reach around them?

Mostly no, with a few telling exceptions:

- `actions/publish.ts:211` defines its own `openSuiClient(ctx)` that calls `new SuiJsonRpcClient(...)` directly instead of `createLocalSuiClient`. Trivial drift, but it's the in-tree Publish action — the canonical caller — bypassing the helper.
- `cli/console.ts:79` does the same. Acceptable since `console` runs against arbitrary networks.
- The `inspectContainer + healthcheck` pattern repeats across `plugins/sui`, `plugins/seal`, `plugins/walrus` (15+ call sites) but lives in `plugins/sui/docker.ts`, not `helpers/`. Real candidate for promotion if a fourth container-based plugin lands.
- No parallel signer implementations.

## Integration

`helpers.ts` (the public `@mysten-incubation/devstack/helpers` barrel) re-exports `seedSharedObject`, `objectTypeMatchesFilter`, `createLocalSuiClient`, `loadOrGenerateKeypair`, `keyFilePath`, `keysDir`. The signer factories (`cliSigner` / `envSigner` / `generatedKeypair`) are deliberately *not* re-exported here — they're authoring-time API on the main `index.ts` barrel.

## Customizability + gaps

- **`match-type.ts`** has zero programmatic escape hatch. If a user wants regex or full-name match, they fork.
- **`seedSharedObject`** captures only the *first* matching created object. Multi-shared-object Move calls would need a `seedSharedObjects` (plural).
- **`signers.ts`** has no `ledgerSigner` / `kmsSigner`; the `AccountFactory` contract supports them, but the eager `resolveAccounts` only handles sync factories.
- No helper for the recurring `inspectContainer → poll-until-healthy` pattern.

## `match-type.ts` — the load-bearing `<` rule

```ts
if (filter.includes('<')) return typeStr.includes(filter);
return typeStr.endsWith(filter);
```

This 2-line dispatch is the contract every Publish `capture` block depends on:

```ts
capture: {
  treasuryCapId: '::coin::TreasuryCap<',     // includes — matches 0x2::coin::TreasuryCap<<pkg>::mock_usdc::MOCK_USDC>
  metadataId:    '::coin::CoinMetadata<',
  upgradeCapId:  '0x2::package::UpgradeCap', // endsWith — exact, no generic
}
```

The `<` is the pivot: presence flips the matcher from `endsWith` to `includes`. **`endsWith` is essential** because without it, `::registry::Registry` would also match `0x2::dynamic_field::Field<u64, <pkg>::registry::RegistryInner>`. **`includes` is essential** because a filter pinned to `<` cannot be a suffix.

**Risk:** the rule is undocumented in user-facing docs (only in the file comment). A user writing `capture: { treasuryCapId: '::coin::TreasuryCap' }` (no `<`) would silently fail because `endsWith` won't match the generic-suffixed real type.

## Testing — gaps

**Zero unit-test coverage for any of these five files.** Closest signals: `runtime/accounts.test.ts` exercises `generatedKeypair()` indirectly; `actions/publish.test.ts` mocks `@mysten/sui/jsonRpc`. Untested behaviours: bech32-vs-33-byte-vs-32-byte branching in `envSigner` (silent off-by-one risk on the scheme-byte check); the redactHome path; `loadOrGenerateKeypair`'s scheme check; **and most importantly the `<` trigger rule in `match-type.ts`**.

## Top recommendations

1. **Add `match-type.test.ts`** with the four canonical cases (TreasuryCap, CoinMetadata, UpgradeCap, Lobby) plus the dynamic-field anti-example.
2. **Document the `<` rule** in user-facing docs (Publish capture section).
3. **Migrate `actions/publish.ts:211` and `cli/console.ts:79` to `createLocalSuiClient`**; add a `from-registry` overload that takes `ctx`.
4. **Add `signers.test.ts`** covering the bech32-vs-33-byte-vs-32-byte branching in `envSigner`.
5. **Add `seedSharedObjects` (plural)** for multi-shared-object Move calls.
