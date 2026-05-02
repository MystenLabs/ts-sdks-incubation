# Publish action + move-package helper

**Verdict**: A− — Solid extraction. `definePublishAction` is the right level of opinion and the four-stage skip cascade is well-motivated. Two small documentation gaps and one missing test layer.

## Architecture

The two-tier split is the right shape: `definePublishAction` is a single 90-line opinion that absorbs the repeated `getStatus`/`run` pair the example apps used to hand-roll, while bare `publish()` survives as an escape hatch (used by `imports/index.ts` for the curated-address branch and by `scope-actions.test.ts`). All four examples now collapse to ~10-20 lines of pure declaration; seal's only remaining custom code is the `prepareSource` extracts the upstream Move package out of the docker image.

The skip cascade is well-layered. `definePublishAction.getStatus` checks (1) prior cache entry exists, (2) chainId matches, (3) packageId still resolves on chain, (4) source digest matches — and only then returns `ok: true`. `publishMovePackage` then re-checks (digest + chainId + on-chain liveness) before paying for `sui move build`. This double check is intentional and correct: the reconciler can call `getStatus` and `run` separately (one-shot deploy hydrates registry then runs), and `run` cannot trust that `getStatus` was just called. The cost is minimal — a single `getObject` round trip if both fire.

The `prepareSource` hook is the cleanest part. Seal needs sources extracted from a docker image; declaring `sourcePath: imageTag` (a stable input-hash label) and returning `{ dir, cleanup }` from `prepareSource` keeps the registry's `path` undefined so codegen silently skips it (matching `'<imported>'` convention from `imports/index.ts`). The `cleanup` runs in `finally`, including on publish failure — verified.

`buildEnv: 'container' | 'host'` cleanly separates localnet (no host CLI required) from live-net (where the container isn't running). The host-CLI fallback's error message even names the install command — friction-journal-quality polish.

## Subtle correctness issues

1. **`capture` filter for `UpgradeCap` is wrong-but-works.** `match-type.ts` says: filters with `<` use `includes`, filters without `<` use `endsWith`. The wallet/token-studio examples write `upgradeCapId: '0x2::package::UpgradeCap'` — no `<`, so it `endsWith`. But Sui's `objectType` for an UpgradeCap is bare `0x2::package::UpgradeCap` (no generics), so `endsWith` works. However, the `TreasuryCap<` and `CoinMetadata<` filters do contain `<` and switch to `includes`. This is fine but undocumented in `definePublishAction`'s `capture?` JSDoc.

2. **`chainId` cache key vs `network`.** `Package` carries both `chainId` and `network`, but the cache gate only compares `chainId`. This is correct — `chainId` derives from genesis, so a localnet re-genesis flips it without touching `network`. But `network` is *also* recorded on `register({ ..., network: ctx.network })` and never inspected at gate time. The `network` field is dead weight in the gate and the `Package` type could clarify it's purely informational.

3. **`definePublishAction` vs bare `publish()` re-emit semantics.** The reconciler hashes `action.inputs` for cache invalidation. `definePublishAction` puts only `{ path, capture, publisher }` in inputs — *not* the `prepareSource` hook, *not* `onPublished`, *not* `registryAs`. If a plugin author swaps `prepareSource` impls or changes `registryAs` between cycles, `lastInputHash` matches and the action is skipped purely because `getStatus` runs first. There's no defense-in-depth.

## Integration

- **Registry write is single-call atomic** (one `register({ ... })` per Publish). `captured` lives on `Package` and round-trips through the manifest writer, so `tokens` Emit and codegen Emit see post-publish state in the same cycle via `dependsOnKind: ['packages']`.
- **Source-digest gate interaction:** the digest is recomputed *both* in `getStatus` and in `publishMovePackage`. Slightly wasteful — two SHA-256 walks on warm cycles where `getStatus` says ok.
- **`prepareSource`-using plugins get a free pass on the digest gate** (`getStatus` skips digest comparison when `prepareSource !== undefined`). This is correct — the seal source is content-addressed by image tag.

## Customizability + gaps

**Has:** `prepareSource`, `capture`, custom `publisher`, `registryAs`, `onPublished`, `needs` plus capability tokens (`provides`).
**Missing:**
- **No upgrade-vs-republish** — every cycle that fails the gate publishes a fresh `packageId`. Sui's `package::UpgradeCap` flow is ignored entirely. The `wallet/walletPlugin.ts` already captures `upgradeCapId` but nothing consumes it.
- **No retry on transient chain errors.** `publishMovePackage` throws on the first failed `signAndExecuteTransaction` — common during localnet warm-up if RPC isn't fully ready. The reconciler will mark the action `failed` and require a manual retry. The CLAUDE.md anti-pattern list calls out exactly this. Add exponential-backoff with jitter inside `publishMovePackage`.
- **No build-only / typecheck-only mode.** Useful for `devstack check`-style fast feedback that catches Move build errors without paying the publish round trip.
- **No pre-publish hook** symmetric to `onPublished`.
- **No `dependsOnTokens` / `dependsOnPackages`** equivalent on Publish (Emit has `dependsOnKind`).

## Testing

`publish.test.ts` covers shape, default `getStatus` (no-prior, chainId-mismatch, on-chain hit), and `onPublished` (fresh-publish + cache-hit + custom publisher + `registryAs`) — solid for the high-level factory. **Gaps:**

- No coverage of the `chainId` mismatch path inside `publishMovePackage` (the helper itself is never unit-tested — it's mocked away).
- No coverage of the source-digest gate's *off-disk* branch (`prepareSource` set, on-host source absent — the new `existsSync(sourceDir)` skip).
- `applyCapture` and `objectTypeMatchesFilter` have no test (`match-type.ts` ships without a sibling `.test.ts`). Given the `<`-trigger behavior is load-bearing for `TreasuryCap<...>` matching, this should have explicit cases.
- No e2e for the `getStatus` → cache-hit fast path.
- No test for `cleanup` running on publish failure.

## Top recommendations

1. **Document the `capture` filter `<` rule in JSDoc** with both forms shown.
2. **Add `match-type.test.ts`** covering the `<` trigger, generics matching, and edge cases.
3. **Add exponential-backoff retry inside `publishMovePackage`** for transient chain errors during warmup.
4. **Add an `upgrade()` action** or an `upgradeCap` field on `definePublishAction` so the captured upgrade caps stop being dead weight.
5. **Drop `network` from `Package` or document it as informational-only**; the cache gate uses only `chainId`.
