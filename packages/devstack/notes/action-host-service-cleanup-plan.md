# Action and host-service cleanup plan

Last updated: 2026-05-22.

## 1. Context and goals

This plan covers user-authored one-shot actions and supervised host processes:

- `packages/devstack/src/plugins/action`
- `packages/devstack/src/plugins/host-service`
- `examples/_template`, `examples/connect-four`, `examples/wallet`, `examples/token-studio`,
  `examples/private-content`, and `examples/fork-greeting`
- docs under `packages/docs/content/devstack/features/local-dev.mdx`,
  `features/testing-playwright.mdx`, and `reference/services.mdx`.

The goal is to make the two main app-composition primitives predictable. `action(...)` should be a
clear transaction/action cache primitive, and `hostService(...)` should be a clear
supervised-process entrypoint with ordering semantics that match the rest of the plugin API.

## Current status

Completed on 2026-05-22:

- `composeDiscriminatorMaterial(...)` now includes the declared dependency resource ids in order as
  `dependencies=[...]`, so changing or reordering `dependsOn` changes the action cache material.
- `test/plugins/action/discriminator.test.ts` pins dependency inclusion, dependency changes,
  dependency reordering, dynamic discriminator material, and the empty dependency list.
- Host-service ordering is now spelled `after`, not `needs`, matching its ordering-only behavior.
  The public `HostServiceOptions` type, host-service factory, first-party examples, scaffolder
  template, template sync fixups, and focused tests were updated directly with no compatibility
  alias.
- The unsupported public `ctx.tx(build, opts?)` helper story was removed from `ActionBuildContext`
  and action docs/comments. Action bodies now expose only `ctx.sui` and the receipt-producing
  `ctx.signAndExecute(account, build)` helper.
- `HostServiceScriptOptions` and bash-backed `script` support were removed from the public
  host-service option surface. `hostService(...)` now accepts `command`/`args` only; `script`
  remains a type-level `never` field and a runtime config error for clearer mistakes, not a
  supported path.
- Action dependency-shape projection now reuses the shared `resolveDependencyValues(...)` helper
  from the plugin API instead of maintaining a local mirror.
- Root action exports were trimmed to the app/plugin-author surface: `action`, options/context
  types, typed action errors, and `ActionReceipt`. Helper/schema/discriminator internals such as
  `ActionReceiptSchema`, `signAndExecute`, `ActionLifecyclePhase`, `DynamicDiscriminator`,
  `StaticDiscriminator`, and `ActionObjectChange` are no longer exported from the root barrel, and
  `release-surface.test.ts` pins that.
- Exported example/template `stack` values now annotate with the public erased `Stack` type, and
  `Stack` has a default generic parameter. This keeps example declaration generation from leaking
  internal plugin projection types from package `dist` paths.

Current verification:

- `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/action/discriminator.test.ts test/plugins/action/execute.test.ts test/e2e/action-cache.test.ts`
  passed (2 files / 9 tests; the Docker-gated e2e cache file was not enabled in this non-Docker
  focused lane).
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/action/discriminator.test.ts test/plugins/action/execute.test.ts test/e2e/action-cache.test.ts test/plugins/host-service/service.test.ts test/build-integrations/release-surface.test.ts`
  passed (4 files / 31 tests).
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/host-service/service.test.ts test/api/define-devstack.test.ts test/build-integrations/release-surface.test.ts`
  passed (3 files / 40 tests).
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/action/discriminator.test.ts test/plugins/action/execute.test.ts test/e2e/action-cache.test.ts test/plugins/host-service/service.test.ts test/api/define-devstack.test.ts test/build-integrations/release-surface.test.ts`
  passed (5 files / 49 tests).
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/host-service/service.test.ts test/api/define-devstack.test.ts test/build-integrations/release-surface.test.ts test/plugins/action/discriminator.test.ts test/plugins/action/execute.test.ts`
  passed (5 files / 48 tests).
- The same focused action/host-service set passed again after replacing the local action dependency
  projector with the shared helper.
- The focused action/host-service/release-surface set passed again after trimming root action
  exports.
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/api/define-devstack.test.ts test/build-integrations/release-surface.test.ts`
  passed (2 files / 28 tests).
- `pnpm --filter @mysten-incubation/devstack typecheck` passed.
- `pnpm --filter @mysten-incubation/devstack build` passed.
- Direct node-config typechecks passed for `wallet`, `token-studio`, `private-content`,
  `deepbook-full`, `connect-four`, and `_template`; `example-fork-greeting` package typecheck
  passed.
- `pnpm --filter @mysten-incubation/create-devstack-app run check-template` passed.
- `pnpm --filter @mysten-incubation/create-devstack-app typecheck` passed.
- Residue scan for `needs:`/`.needs` over live host-service callsites is clean; remaining `needs`
  matches are unrelated prose or identifiers.
- Residue scan for `ctx.tx`/raw serialized-byte action helper text over live source/docs/examples is
  clean.
- Residue scan for host-service `script:`/`HostServiceScriptOptions` over live source/docs/examples
  has only the explicit rejection tests and the runtime/type-level guard in `service.ts`.

Non-blocking outcome:

- Host-service root exports are already narrow (`hostService`, `HOST_SERVICE_PORT_TOKEN`, option,
  ready-probe, value, and error types). No additional host-service root deletion was made in this
  pass, and this is not a release blocker.

## 2. Audit findings

### Action discriminator drops dependency ids

Current shape:

- `StaticDiscriminator` includes `dependencyResourceIds`.
- `composeDiscriminatorMaterial(...)` currently emits `dependencies=` but does not append the ids.
- The file comments and action header say dependency ids are part of the content hash.

Target shape:

- Include dependency resource ids in the discriminator material.
- Add a focused unit test proving changing or reordering dependencies changes the material.
- Keep this as a bug fix in the action cleanup implementation, not a new abstraction.

### Action body and low-level helper contract disagree

Current shape:

- Docs in `action/index.ts` say lower-level bodies can use `ctx.tx(build, opts?)` for custom signing
  surfaces.
- `ActionOptions.body` must return `Effect<ActionReceipt, ActionError, Scope.Scope>`.
- `ctx.tx(...)` returns raw transaction bytes, with no public helper to turn custom execution back
  into a valid `ActionReceipt`.

Target shape:

- Either remove the public low-level `ctx.tx` story or add a clear `ctx.receipt(...)` /
  `ctx.executeRaw(...)` helper that returns `ActionReceipt`.
- Examples should teach the high-level `ctx.signAndExecute(...)` path unless a real built-in
  custom-signing action exists.

### Action duplicates dependency shape plumbing

Current shape:

- Action imports `dependencyList`, `isResourceRef`, and manually reconstructs resolved dependency
  shapes with `resolveActionDependencies(...)`.
- This mirrors generic dependency helper logic in `define-plugin.ts`.

Target shape:

- Reuse one internal dependency-shape projector from the plugin API module.
- Keep action-specific code focused on action cache keys and transaction execution.

### Action has no codegen or capture helper despite examples needing receipts

Current shape:

- `action(...)` returns an `ActionReceipt`.
- Examples read action results only through resolved deps during stack boot, not through generated
  app-facing bindings.
- `ActionReceipt.objectChanges` is `unknown[]`; users must hand-roll projections.

Target shape:

- Decide whether action receipts are devstack-internal boot facts or app-facing generated values.
- If app-facing, add a codegenable action binding and a small public projection helper.
- If internal only, do not export broad receipt schemas from the root.

### Host-service `needs` is ordering-only but named like dependency data

Current shape:

- `hostService({ needs })` feeds `definePlugin({ dependsOn: needs })`.
- The host-service start body ignores resolved dependency values.
- Examples rely on `needs` to ensure generated files and services are ready before Vite starts.

Target shape:

- Rename `needs` to `after` if it remains ordering-only.
- Rename it to `dependsOn` only if resolved values will be passed to the host-service body later.
- Update docs to describe host-service as a process that starts after dependencies, not a consumer
  of dependency values.

### Host-service command surface has sample-only flexibility

Current shape:

- Options accept either `command`/`args` or `script`.
- `script` runs through `bash -lc`.
- Env and args use `HOST_SERVICE_PORT_TOKEN` substitution.

Target shape:

- Keep `command`/`args` as the main public form.
- Delete `script` unless a first-party example uses it.
- Keep `HOST_SERVICE_PORT_TOKEN` if examples need strict-port Vite; otherwise prefer setting `PORT`
  env and document that.

## 3. Specific public API changes

- Fix `composeDiscriminatorMaterial(...)` to include `dependencyResourceIds`.
- Add or remove low-level action helpers so `ActionBuildContext` only exposes paths that can produce
  a valid `ActionReceipt`.
- Internalize `signAndExecute` root export unless it is meant as plugin-author API.
- Decide and apply `hostService({ after })` or `hostService({ dependsOn })`; delete `needs`.
- Delete `HostServiceScriptOptions` and the `script` public option unless a real example remains.
- Reassess root exports for `ActionReceiptSchema`, `ActionLifecyclePhase`, `StaticDiscriminator`,
  `DynamicDiscriminator`, and `ActionObjectChange`.

## 4. Internal implementation changes

- Extract dependency-shape projection from `define-plugin.ts` so Action can reuse it.
- Add unit coverage for action discriminator material.
- Update action docs/comments to match actual helper behavior.
- Update host-service normalization and tests for the chosen ordering option name.
- If `script` is deleted, remove shell-specific validation and tests.
- Keep post-acquire task behavior for host-service startup so Vite/app processes start after codegen
  and manifest writes.

## 5. Built-in plugin/component migration steps

1. Patch action discriminator material and add tests.
2. Update examples that define actions:
   - `examples/connect-four/devstack.config.ts`
   - `examples/wallet/devstack.config.ts`
3. Rename host-service ordering option across examples and create-devstack-app template.
4. Remove unused action/host-service root exports and update release-surface tests.
5. Re-run wallet, token-studio, private-content, and template checks because host-service starts the
   app in those workflows.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/reference/services.mdx`
- `packages/docs/content/devstack/features/local-dev.mdx`
- `packages/docs/content/devstack/features/testing-playwright.mdx`
- `packages/devstack/README.md`

Examples/template to update:

- `examples/_template/devstack.config.ts`
- `examples/connect-four/devstack.config.ts`
- `examples/wallet/devstack.config.ts`
- `examples/token-studio/devstack.config.ts`
- `examples/private-content/devstack.config.ts`
- `examples/fork-greeting/devstack.config.ts`
- `packages/create-devstack-app/template/devstack.config.ts`

Tests to update:

- `test/plugins/action/execute.test.ts`
- add `test/plugins/action/discriminator.test.ts`
- `test/e2e/action-cache.test.ts`
- `test/plugins/host-service/service.test.ts`
- `test/build-integrations/release-surface.test.ts`
- create-devstack-app template sync/check tests.

## 7. Verification commands

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/plugins/action/execute.test.ts \
	test/e2e/action-cache.test.ts \
	test/plugins/host-service/service.test.ts \
	test/build-integrations/release-surface.test.ts
pnpm --filter @mysten-incubation/create-devstack-app run check-template
pnpm --filter @mysten-incubation/create-devstack-app typecheck
pnpm --filter @mysten-incubation/wallet test:e2e
pnpm --filter @mysten-incubation/token-studio test:e2e
```

Residue scans:

```bash
rg -n "needs:" packages/devstack/src packages/docs/content/devstack examples packages/create-devstack-app
rg -n "script:" packages/devstack/src/plugins/host-service packages/docs/content/devstack examples
rg -n "dependencies=\\n|ctx\\.tx|signAndExecute" packages/devstack/src/plugins/action packages/docs/content/devstack examples
```

## 8. Acceptance criteria

- Action cache material actually includes dependency resource ids.
- Public action helpers all lead to valid `ActionReceipt` values.
- Action dependency-shape plumbing is not duplicated.
- Host-service ordering option has a name that matches its behavior.
- `script` is either deleted or backed by a first-party example and tests.
- Examples and create-devstack-app template use the new host-service option.
- Focused action/host-service tests and app e2e smoke commands pass.

## 9. Explicit out-of-scope items

- A generic workflow/orchestration engine.
- Multi-step action DAGs beyond existing plugin dependencies.
- Router entrypoint ownership; tracked in `boundary-cleanup-plan.md`.
- General build-integration consolidation; tracked in `boundary-cleanup-plan.md`.
