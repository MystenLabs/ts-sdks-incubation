# Imports plugin

**Verdict**: A− — Cleanest extraction in the codebase. Strongest test coverage. Two real gaps: no live-deploy path (forced to curated), and codegen silently skips imported packages.

## Architecture

The plugin emits two actions per `ImportSpec`:

- `imports.<name>-source` (Build) — ensures a content-addressed `dev-examples/upstream-source:<repo>__<rev>` Docker image exists. The image is `FROM scratch` with a baked git checkout under `/src` (see `helpers/upstream-source.ts`).
- `imports.<name>` (Publish, `path: '<imported>'`) — branches on `curatedAddressFor(spec, network)`. If a curated address exists for the resolved network, it registers the address into `registry.packages` and skips on-chain work. Otherwise it calls `requireLocalnetCtx`, then shells `importMovePackage` which `docker cp`s the source into the sui container and runs `sui client test-publish --build-env <env> --with-unpublished-dependencies --pubfile-path …`.

Pinning is via git rev — the rev is the cache key (content addressable) and doubles as `sourceDigest`. Bumping rev busts the upstream-source image and forces a re-publish on next cycle (`getStatus` uses `prior.sourceDigest === rev` short-circuit in `imported-package.ts:89`). Address-resolution **does not** consult the registry's packages namespace — it lets the Sui CLI walk Move.toml deps and emit `published` object-changes; the plugin then keys the auto-published deps map by the dep's first module name (`imported-package.ts:233-239`). That's a load-bearing convention with no validation.

## Problem fit

This is the right shape for the realistic cases. Wallet's `devstack.config.ts:32-46` is a clean one-spec block for DeepBook v3 — replaces the long-standing hand-rolled import (called out in `notes/friction.md:30`). The `addresses` map cleanly captures the live-net case: `{ testnet: '0xdee9testnet', mainnet: '0xdee9mainnet' }` makes a config a one-line answer for "deepbook on mainnet." Curated path skips both the source image build and the chain probe entirely, which is exactly what production deploys want.

Where it falls short: there is no support for **publishing fresh source on testnet/mainnet**. `run` calls `requireLocalnetCtx` when no curated address is present (`index.ts:250`), so an app trying to publish a third-party package onto testnet must always seed a curated address. The error path is correct ("requires localnet but got testnet") but the framing is wrong — the journal mentions live deploys as a goal, and the plugin closes that door with a thrown error rather than routing through `publishMovePackage`.

## Integration

- **Registry.packages**: imports register entries with `path` undefined (`Package` type at `core/types.ts:236-244`); the codegen plugin's `codegenTargets` filter drops these (`plugins/codegen/index.ts:97-101`). **Codegen does NOT run for imported packages.** That's documented but it's a real consumer-side hole — apps swapping DeepBook for a curated address get no TypeScript bindings; they fall back to `@mysten/deepbook-v3` SDKs or hand-rolled clients.
- **Helper boundary**: `imported-package.ts` is the heavy machinery; the plugin file is a thin orchestration layer over it. The import flow handles publisher-key import (with stdin-piped secret to avoid argv leakage, `imported-package.ts:159-168`), CLI env switch, faucet, and `--with-unpublished-dependencies`. Solid.
- **Recursive walker (`withRecursiveDeps`)**: exported from `src/index.ts:101` but **unused by every example**. It's a config-time async helper that walks Move.toml git deps via `parseMoveToml` + the upstream-source image, dedupes by `(repo, rev, subdir)`, and sets `dependsOn` for topo ordering. It's well-tested in `resolve.test.ts` but production code has no callers — it's a workstream D2 deliverable that hasn't been adopted.

## Customizability + gaps

- **Naming validation** (`IMPORT_NAME_RE = /^[a-z][a-z0-9_-]*$/`) is correct; rejects `DeepBook` and `deep.book`. No collision check against `registry.packages` names from other plugins, so `imports({ packages: [{ name: 'walrus' }]})` clobbers the `walrus()` plugin's entry silently. Worth a cross-plugin guard.
- **No `addressName`** support. Move.toml uses named addresses (`@deepbook` → `0x...`); this plugin doesn't surface that mapping. Apps that want to call DeepBook from their own Move package have to read `registry.packages.find('deepbook').packageId` manually and stitch it in — there's no Move.toml-side synthesis.
- **No version constraints**. Two specs at different revs of the same repo would both build and publish (no warning). Resolver dedup is by `(repo, rev, subdir)` only.
- **`addresses` is per-network, but the resolver checks `network !== 'localnet'`** — a curated address never wins on localnet, even if the user explicitly set one. Reasonable default; the comment at `index.ts:292` makes the policy clear, but it's a real foot-gun if someone configures a localnet address expecting it to be honored.
- **The recursive walker's name collision policy** is shaky: `name = isSeed ? '${entry.name}-${dep.name.toLowerCase()}' : dep.name.toLowerCase()` (`resolve.ts:82`). Two unrelated seeds depending on a shared transitive `deep` would produce two entries named `deep`, and the registry collapses them by name on the second register.

## Testing

Coverage is genuinely good for an active workstream — the test suites are the strongest in the repo so far.

- `move-toml.test.ts` covers the realistic subset: package name extraction, comments, missing rev throws, ssh/https URLs, host-impersonation rejection (anchored regex, `Foo = { git = "https://github.com.evil.com/..." }`), and ignoring non-string fields. Edge cases I'd want: multi-line dependency syntax (currently silently dropped), nested-table syntax (`[dependencies.Foo]`), and `override = true` semantics (currently parsed but not surfaced anywhere — fine since the parser comments call this out, but should be tested as "ignored").
- `resolve.test.ts` covers single seed, transitive walking, dedup, framework skip, local-dep skip, and subdir traversal rejection. There's a bug worth flagging: the `beforeEach` shim at `resolve.test.ts:127-136` calls `import('vitest').then(...)` inside a sync helper — this is racy and won't reliably reset mocks before the first test.
- `index.test.ts` covers shape, build action curated/uncurated branches, publish `getStatus` (no-prior, chainId mismatch, deps-on-chain, deps-missing, curated registers), and publish `run` (importMovePackage forwarded, curated path skips helper, live-net-without-curated throws). Missing: `dependsOn` propagation into `needs`, and `withRecursiveDeps` end-to-end.

## Top recommendations

1. **Adopt `withRecursiveDeps` in at least one example** (wallet is the obvious candidate — DeepBook has transitive deps). Until something pulls it, the resolver's elegant design rots.
2. **Implement codegen for imported packages** via upstream-source extraction. The mechanism is right there in seal's plugin — generalize it, then drop the `path: undefined` filter.
3. **Add a cross-plugin name-collision guard** in the registry write path. Today `imports({ packages: [{ name: 'walrus' }] })` wins last-write — silently overwrites the real walrus package.
4. **Open a path for live-net publish of imported sources** rather than throwing. Either add `mode: 'publish' | 'curated'` per spec or fall through to `publishMovePackage` when `requireLocalnetCtx` would have thrown.
