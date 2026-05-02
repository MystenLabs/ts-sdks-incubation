# `imported-package` + `upstream-source` helpers

**Verdict**: A− — Genuinely general (used by both imports and seal plugins). Two structural gaps: no build hooks for packages with pre-publish scripts, no local-source override for upstream-package contributors.

## Architecture

**`upstream-source.ts` — content-addressed source images.** The two-stage Dockerfile is the cleanest piece of the design: `alpine/git` clones the requested rev into `/src`, drops `.git`, then a `FROM scratch` final stage copies just the tree. The result is a layer-only blob keyed `dev-examples/upstream-source:<owner>__<repo>-<short-rev>` (note the double underscore, used so the slug round-trips through Docker tag rules). `ensureUpstreamSourceImage` early-returns when `imageExists(tag)` so the cache is the registry itself — no host-side tarball or `packages/devstack-state/imports/...` cache to GC. Bumping `rev` produces a new tag automatically.

**`extractUpstreamSource` — `docker create` + `docker cp` + `docker rm`.** Necessary because `FROM scratch` has no entrypoint, so `docker run --rm` cannot start the container. The helper deliberately passes `--entrypoint /_devstack_noop` (a path that does not exist) and never starts the container — only its filesystem layers are needed. The same shape is reused by the seal plugin (`packages/devstack/src/plugins/seal/index.ts:131`) and the recursive resolver (`packages/devstack/src/plugins/imports/resolve.ts:119`) to read a `Move.toml` before publishing — the helper is genuinely general, not imports-specific.

**`importMovePackage` — publish via the in-container CLI.** The flow is: extract `/src` to a host tmp dir, `docker cp` into `/tmp/devstack-imports/<alias>` in the sui container, inject a stub `[environments]` block if absent, `sui client switch --env localnet`, import the publisher's bech32 secret via stdin (not argv), `sui client switch --address`, faucet 5 SUI, then `sui client test-publish --build-env <env> --pubfile-path … --with-unpublished-dependencies --json`. The `--with-unpublished-dependencies` flag offloads transitive publishing entirely to the CLI, so the helper never patches `Move.toml` to rewrite addresses or topo-sorts manually. Output JSON is parsed by finding the first `{` (skipping any leading sui-CLI tracing), and the **last** `published` change is treated as the target — a correct convention since the CLI publishes deps before dependents.

**Secret hygiene.** Piping the bech32 secret via `sh -c 'sui keytool import "$(cat)" ed25519'` over stdin keeps it off `argv`/`/proc/<pid>/cmdline`. `dockerExecWithInput` also scrubs `stdin` from any thrown error message. This is unusually careful for a localnet-only path, and worth keeping.

**Cache key.** `prior.sourceDigest === rev && prior.chainId === chainId` short-circuits before any docker work — the rev *is* the digest (content-addressable), so no file-tree hash is computed. Mismatched `chainId` (force-regenesis) busts the cache.

## Problem fit

Yes for plain `move build` packages: DeepBook v3, walrus contracts, third-party Move libraries — all pull as `(repo, rev, subdir)` without forking. The wallet example consumes it (`examples/wallet/devstack.config.ts:32`).

**Gap: no build hooks.** Some Sui packages have generated sources or pre-publish scripts (e.g. anything that codegens a constants module from JSON, or pyth's address rewrites). The `FROM scratch` image holds raw checkout only — there is no `RUN move build`, no `npm install && tsx prebuild.ts`, no opportunity to apply a patch. A package that requires preprocessing today fails at `sui client test-publish`. There is also no `transform`/`patch` hook on `ImportSpec`.

## Integration

**Reuse is solid.** Three callers share the helpers:
- `imports` plugin's Build action ensures the image; Publish action extracts + publishes.
- `resolve.ts` reads `Move.toml` from the same image to walk transitive deps.
- `seal` plugin's `prepareSource` extracts a `srcPath` subpath from the seal image. The `srcPath` parameter exists exactly so non-imports images can reuse the extraction primitive.

The cache image is shared across these callers — the resolver's `Move.toml` read warms the same image that the importer later extracts.

## Customizability + gaps

- `subdir` covers monorepo packages (`pyth/sui`, `packages/deepbook`).
- `addresses[network]` lets curated mainnet/testnet IDs short-circuit publishing — appropriate for DeepBook/Pyth/Wormhole.
- `capture: { name: '::module::Type' }` extracts admin-cap-style objects from `objectChanges`.
- `dependsOn` (set by `withRecursiveDeps`) creates topo edges between `Publish` actions.

**Missing knobs:**
- No `local` source override — point at `~/code/deepbookv3` instead of cloning. Useful for upstream-package contributors.
- No patch/transform hook to mutate `Move.toml` or sources before publish.
- No way to override the `git clone` URL (no GitHub Enterprise, no auth tokens for private repos).
- Hardcoded `https://github.com/${REPO}.git` — non-GitHub git hosts are unreachable.
- The container path `/tmp/devstack-imports/<alias>` is `rm -rf`'d on each publish but is not cleaned up on container teardown failure paths.

## Testing

`index.test.ts` (450 lines) is thorough at the plugin shape level. `resolve.test.ts` covers transitive walking, dedup, framework-skip, local-dep policy, and `..`/absolute-path rejection. `move-toml.test.ts` covers parser edge cases.

**Gaps:** `imported-package.ts` and `upstream-source.ts` have no direct tests — `dockerExec`, `dockerExecWithInput`, `extractUpstreamSource`, the env-stub injection script, and the `--with-unpublished-dependencies` JSON parser are exercised only end-to-end via the import flow. The publisher Keypair guard, the JSON-start scan, and the secret-redaction error path would benefit from targeted unit tests with mocked `spawnSync`.

## Top recommendations

1. **Add a `local: { path }` source override** — point at a working-dir checkout instead of cloning. Critical for upstream contributors.
2. **Add a `patch` / `transform` hook** on `ImportSpec` to mutate `Move.toml` or sources before publish.
3. **Generalize the git URL** — accept any URL or a `(repo, rev) → URL` factory, instead of hardcoding GitHub.
4. **Add `imported-package.test.ts` + `upstream-source.test.ts`** with mocked `spawnSync` covering the JSON-start scan and the secret-redaction path.
