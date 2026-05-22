# Engine API migration plan

Last updated: 2026-05-22.

## Goal

Finish the public API migration by making the engine consume the same resource-native plugin shape
that authors now write:

```ts
definePlugin({
	id: 'resource/id',
	dependsOn: { upstream },
	start: (_ctx, { upstream }) => Effect.succeed(...),
	capabilities: ({ value }) => [...],
});
```

No compatibility shim, deprecation path, or parallel tag/member engine should remain. This package is
unreleased, so wrong surfaces should be deleted directly.

## Target engine model

- Plugin identity is `plugin.id`, not `plugin.provides.id`.
- Dependency scheduling uses normalized `plugin.dependsOn` resource refs, not `plugin.consumes`
  tags.
- Runtime dependency values are assembled by the supervisor from declared resource refs and passed to
  `plugin.start(ctx, deps)`.
- `Stack` remains opaque to users; internal readers may expose the supervised plugin list, but not
  the old `StackMember` tuple model.
- Capability harvesting, dynamic capability factories, scoped lifecycle, post-acquire hooks, router,
  snapshot, codegen, and manifest extras keep their current behavior.

## Work plan

1. **Core substrate contract**
   - Move resource/plugin primitives into `src/substrate/plugin.ts`.
   - Make `src/api/define-plugin.ts` a public re-export of that contract.
   - Delete tag/member concepts after downstream callsites are migrated.

2. **Stack composition**
   - Port `defineDevstack` and `defineDevstackWith` validation/expansion from
     `provides`/`consumes` to `id`/`dependsOn`.
   - Preserve recursive plugin dependency expansion, duplicate provider detection, cycle detection,
     and wallet `accounts: 'all'` expansion.
   - Remove the Sui auto-mount special case. Built-ins may depend on the abstract `sui` resource,
     but stacks that need Sui now list a concrete `sui(...)` provider explicitly.

3. **Lifecycle engine**
   - Port dep graph keying and dependency resolution to resource ids.
   - Replace `BuildContext.get/use` with direct resolved dependency construction.
   - Run plugin `start` directly inside the existing scoped/provided Effect context.

4. **Callsite cleanup**
   - Remove `resourceTag`, built-in `*Tag` exports, `StackMember`, `AnyMember`, `MEMBER_BRAND`,
     `ResolvedOf`, `TagIdOf`, and `substrate/tag.ts`.
   - Update plugin tests and docs to assert ids/dependency ids instead of tag/member internals.

5. **Verification**
   - Run package-local typecheck, focused Vitest for API/lifecycle/plugin shape changes, full package
     Vitest, build, and packed-consumer smoke.

## Progress

- Core substrate contract is resource-native: `src/substrate/plugin.ts` defines resource refs,
  `definePlugin`, dependency-shape helpers, normalized dependency refs, and missing-provider type
  helpers.
- `src/api/define-plugin.ts` re-exports the substrate contract; the tag/member adapter path is gone.
- `defineDevstack`, `defineDevstackWith`, the lifecycle dep graph, plugin registry, and supervisor
  now consume `id`/`dependsOn`/`start` directly.
- Repeated dependency refs keep prior tested behavior: `plugin.dependsOn` is deduped for scheduling,
  while the original authored dependency input is retained so `start` callback dependency shape and
  recursive plugin expansion still match the authored object/tuple/single form.
- Sui is no longer special-cased by the composer. Examples/docs/tests that rely on Sui now include
  an explicit `sui()` or mode-specific `sui(...)` provider at the stack root.
- Removed old bridge files and tests: `src/substrate/tag.ts`, `src/api/consume-members.ts`,
  `src/api/tag.ts`, `src/api/plugin-authoring.ts`, `src/contracts/node-plugin.ts`,
  `test/api/consume-members.test.ts`, and `test/substrate/engine-member.ts`.
- Old-pattern cleanup scans no longer find live `defineTag`, `resourceTag`, `StackMember`,
  `AnyMember`, `MEMBER_BRAND`, `ResolvedOf`, `TagIdOf`, `.provides`, or `.consumes` engine usage.
  Remaining `.acquire` hits are unrelated lease/container/lifecycle APIs, and remaining
  `sealManagerTagId` hits are negative release-surface assertions.
- `ARCHITECTURE.md` and `STYLE_GUIDE.md` now describe the resource-native engine model instead of
  the removed tag/member substrate internals.

## Open risks

- Docs and generated examples have been updated for explicit Sui, but full docs-site verification is
  outside this engine package pass.

## Consumer smoke posture

- `smoke:pack-consumer` intentionally typechecks the packed consumer with `skipLibCheck: true`.
  Devstack's plugin-author and engine surfaces expose Effect v4 beta types, and strict library
  checking would typecheck Effect's declaration files rather than just the devstack package boundary.

## Verification log

- `pnpm --filter @mysten-incubation/devstack typecheck` passed.
- Focused Vitest passed: `pnpm --filter @mysten-incubation/devstack exec vitest run
  test/api/define-devstack.test.ts test/plugins/wallet/accounts-all.test.ts
  test/substrate/build-context-use.test.ts test/substrate/runtime/run.test.ts
  test/substrate/runtime/supervisor.test.ts test/plugins/deepbook/factory.test.ts
  test/plugins/walrus/seed-accounts.test.ts test/plugins/seal/public-refs.test.ts
  test/plugins/host-service/service.test.ts test/substrate/manifest-extras.test.ts` (10 files,
  86 tests).
- `pnpm --filter @mysten-incubation/devstack build` passed.
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/cli/main.test.ts
  test/cli/move-bindings-codegen.test.ts test/runtime/docker/ownership-lifecycle.test.ts` passed
  after rebuilding `dist` (3 files, 34 tests).
- `pnpm --filter @mysten-incubation/devstack test` passed (146 files, 1000 tests).
- `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer` passed its CLI/runtime import,
  removed-subpath, minimal boot, stack-context, and skipLibCheck-enabled typecheck checks.
- Final cleanup reruns: `pnpm --filter @mysten-incubation/devstack typecheck` passed, and
  `pnpm --filter @mysten-incubation/devstack exec vitest run
  test/plugins/walrus/local-cluster-options.test.ts test/api/define-devstack.test.ts
  test/plugins/wallet/accounts-all.test.ts` passed (3 files, 39 tests).
