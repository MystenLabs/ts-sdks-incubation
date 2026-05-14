// Vitest fixtures for devstack-effect. Thin wrapper that hands the
// composed devstack layer to @effect/vitest's `it.layer(...)`, so tests
// can `yield*` whichever primitive tags the devstack provides without
// re-deriving a Layer each time.
//
//   import { defineDevstack, suiLocalnet } from '@mysten-incubation/devstack-effect';
//   import { withDevstack } from '@mysten-incubation/devstack-effect/vitest';
//
//   const devstack = defineDevstack([suiLocalnet()]);
//
//   withDevstack(devstack)('my suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () {
//       const s = yield* Sui;
//       // ...
//     }));
//   });
//
// `readManifest` / `readSnapshot` exist for tests that just want the
// on-disk JSON artefacts — no Layer / Effect needed.
//
// Divergences from v3's harness:
//   - No `setup` / `teardown`. v3 exposed those for `vitest globalSetup`
//     bring-up; v4's Effect-native model puts the layer behind
//     `it.layer` (via `withDevstack`), and out-of-band bring-up is
//     covered by `setupDevstack` in `../playwright/setup-devstack.ts`
//     (Playwright globalSetup/globalTeardown — works for any
//     out-of-test acquire/release boundary).
//   - No `getNodeState`. v4 layers don't expose per-node acquire status
//     outside the engine; if a primitive needs to publish state, it
//     does so via its tag's shape or via `StateStore` (internal).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Layer } from 'effect';
import { it as effectIt } from '@effect/vitest';
import type { Devstack } from '../define-devstack.js';
import { jsonBigintReviver } from '../internal/json-bigint.js';
import type { SuiNetwork } from '../primitives/sui.js';

// Bind a devstack to `@effect/vitest`'s `it.layer(...)`. Returns the
// curried `(name?, body)` describe-binder so tests in the body can
// `yield*` services from the stack directly. The devstack's layer
// carries `R = any` by design (see `define-devstack.ts`) — we cast to
// the `never` requirement that `it.layer` expects; any unmet service
// surfaces at runtime via Effect's ServiceNotFound, same as `run()`.
export const withDevstack = (devstack: Devstack) =>
	effectIt.layer(devstack.layer as Layer.Layer<any, any, never>);

/** Read the manifest JSON sidecar written by the `manifest()` plugin.
 * Defaults to `.devstack/manifest.json` relative to cwd — pass an
 * explicit path for non-default layouts. Returns the parsed JSON;
 * shape is intentionally `unknown` so callers cast / validate. */
export const readManifest = async (path?: string): Promise<unknown> => {
	const raw = await readFile(path ?? '.devstack/manifest.json', 'utf-8');
	return JSON.parse(raw);
};

/** Read the persisted state-store JSON for the given stack/network.
 * Mirrors the path scoping in `src/internal/state-store.ts`:
 *   - localnet (default): `.devstack/stacks/<stack>/state.json`
 *   - other networks:     `.devstack/networks/<network>.json`
 * Uses the tagged-bigint reviver so values written via the state-store
 * round-trip as `bigint`. Returns the raw parsed JSON; shape is
 * intentionally `unknown` so callers cast / validate. */
export const readSnapshot = async (
	stack: string = 'main',
	network: SuiNetwork = 'localnet',
): Promise<unknown> => {
	// `DEVSTACK_APP_DIR` matches the state-store's app-root convention;
	// fall back to cwd so unconfigured tests still resolve relative paths.
	const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
	const path =
		network === 'localnet'
			? join(appDir, '.devstack', 'stacks', stack, 'state.json')
			: join(appDir, '.devstack', 'networks', `${network}.json`);
	const raw = await readFile(path, 'utf-8');
	return JSON.parse(raw, jsonBigintReviver);
};
