# Codegen plugin

**Verdict**: A− — Near-perfect match for the Emit action shape. Untested, but the design is sound and the recent path-resolution fix is the only thing keeping this from an A.

## Architecture

The plugin is a near-perfect match for the Emit action shape: one action, one effect, derived from the registry. `codegen.generate` declares `dependsOnKind: ['packages']`, so the reconciler refires it whenever any Publish action touches `registry.packages`, and `inputs: { output, codegenBin }` participates in the Emit's input hash so a config change also retriggers. `getStatus` provides a fast warm-cycle short-circuit: it walks `codegenTargets()` (registry entries that have a host-resolvable `path`), checks the per-package `<output>/<pkg.name>/` exists, and compares `newestMoveSourceMtime(pkg.path)` against the output dir's mtime. The mtime walk skips `build/` to avoid spurious work from `sui move build` artifacts. This is the right cost/coverage tradeoff: cheap O(sources) stat without re-running `sui move summary`.

The sui-ts-codegen invocation contract (lines 117–138) is the most subtle part of the file, and the CLAUDE comment is the right kind of comment — explaining *why* the package arg has to be `basename(packageDir)` and the cwd has to be `dirname(packageDir)`. The upstream CLI uses the package-arg verbatim as the output subdir; the workaround forces it to land at `<output>/<pkg.name>/`. This is fragile in the way that anything coupled to upstream CLI ergonomics is fragile, but it's localized and well-documented. The defensive `existsSync(expectedSubdir)` check after exit-0 (lines 148–155) catches the known sui-ts-codegen bug where it logs `Command failed, Error: ...` to stdout but exits 0 — that's a real failure mode (friction.md 974–987) and the error message names the most common cause (Move.toml missing matching `[addresses]` block).

## Problem fit

The generated output is excellent for downstream ergonomics. `vault.ts` exposes typed builders like `uploadEntry({ arguments: [name, blobIdBytes, sealIdBytes] })` that return `(tx: Transaction) => void`, plus `MoveStruct` instances (`File`, `Cap`) with `.get()` / `.getMany()` that auto-include `content: true` and parse `json` via the BCS schema. `UploadForm.tsx` line 61 reads `vault.uploadEntry({...})(tx)` — this is the ergonomic payoff: no string `moveCall`, no manual BCS, no `package` argument because `useDevstackPackage('vault')` (`use-devstack-package.ts:23`) pre-binds the live `packageId` from the manifest via `bindPackage()`. The `DevstackPackageRegistry` augmentation (`main.tsx:14–18`) makes this fully typed with no per-call casts. The two-layer split — codegen emits source-of-truth bindings, the React hook binds them at runtime — is genuinely clean. The plugin contributes the bindings; the React layer contributes the address.

## Integration

The plugin writes to `<appDir>/src/generated/sui/` — a side effect outside `.devstack/`. The repo `.gitignore` (line 55: `**/src/generated/sui/`) gitignores the tree, so it's effectively still managed state. Vite picks up the files as plain TS modules, no virtual module needed; HMR works by virtue of vite watching `src/`. The vite plugin (`plugins/vite/index.ts:16`) declares `needs: ['codegen.generate']`, so the dev server boots only after the first emit. Re-emits write to the same files; HMR observes the change naturally. This is a pleasingly minimal integration.

The dependency on the registry — only entries with `path` get bindings — is the right cut. `Package.path` is documented (`core/types.ts:240–244`) as the codegen signal. Imported packages (deepbook, seal, walrus) live inside docker images and have `path: undefined`, so they're silently skipped.

## Customizability + gaps

Surface area is intentionally tiny: one option, `output`. That's appropriate for the current scope but visible gaps:

- **No imported-package codegen.** friction.md:290–293 flags this — the imported `seal` package has no `path` so it's skipped, even though typed bindings would be useful for `seal_approve` calls. There's no upstream-source extraction path that would make `path` populated for imported packages, and no opt-in like `codegen({ includeImported: ['seal'] })`.
- **`--importExtension .js` is hardcoded** (line 134). Apps using `bundler` resolution or non-NodeNext setups can't override.
- **No per-package opt-in/out.** Every registry entry with `path` gets bindings; you can't exclude a package or add custom args.
- **No custom templates / no post-processing hook.** Tree-shaking, header injection, `// @ts-nocheck` workarounds (now resolved) all required upstream waits.
- **No registered output**: the plugin doesn't emit a kind into the registry, so the vite plugin's `needs: ['codegen.generate']` is the only ordering signal. Fine, but a `registry.ns('codegen').modules` entry would let other Emit actions consume the manifest of generated modules.

## Testing

**No coverage at all** — `find` returns one file, no `.test.ts`. Tests this plugin should have:

1. **`getStatus` idempotency**: given existing output and unchanged sources, returns `ok: true`; given any `.move` mtime newer than output, returns `ok: false`.
2. **No spurious regen** under reconciler `dependsOnKind` semantics: registry register-without-change leaves status `ok`.
3. **Path-resolution invariant**: with synthetic registry entries containing `/foo/move/vault`, the runner spawns with `cwd: /foo/move`, args ending `vault`, and `-o <abs>`.
4. **Silent-failure detection**: a mock spawn that exits 0 with empty stdout *and no output dir created* must throw with the actionable message.
5. **Pathless filtering**: registry entries with `path: undefined` produce no spawn calls.
6. **Generated-output structure**: integration test with a tiny fixture Move package asserting `<out>/<pkg>/<pkg>.ts` and `<out>/utils/index.ts` exist after one emit.

The path-resolution fix in `f9c533e` is exactly the kind of regression a unit test would have prevented; the absence of any test is the biggest weakness in an otherwise-tight plugin.

## Top recommendations

1. **Add `codegen/index.test.ts`** with the six cases above.
2. **Surface `--importExtension` as a plugin option** so non-NodeNext consumers aren't blocked.
3. **Add an `includeImported` opt-in** for codegen against imported packages, ideally via the same upstream-source extraction that seal already uses.
4. **Document the `path: undefined` skip** in the plugin's doc-comment so consumers debugging "why are deepbook bindings missing?" don't need to read source.
