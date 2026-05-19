// Canonical per-stack runtime directory + opt-in extras registry.
//
// Phase 3 of the snapshot redesign collapses every service's
// scattered host-side persisted state into one directory under the
// stack root:
//
//   localnet:  <appDir>/.devstack/stacks/<stack>/runtime/<service>/...
//   live nets: <appDir>/.devstack/networks/<network>/runtime/<service>/...
//
// `snapshot save` tars this entire directory (one .tar) plus
// `state.json` plus any opt-in extras passed via the `extras: [...]`
// argument to `saveSnapshot`. Restore is the reverse, atomic.
// Combined with the writable-layer flip in
// Phase 2 (chain state + indexer-db in the container layer), one
// snapshot is a fully replayable artifact: containers via `docker
// commit + save`, state via `state.json`, secrets / deploy outputs via
// `runtime/`.
//
// Why a dedicated `runtime/` subdir vs. just the stack root: keeps
// engine-internal files (`state.json`, `state.json.lock`, `active`) out
// of the snapshot tar by construction. Anything a SERVICE owns and
// wants snapshotted goes under `runtime/<service>/`; anything the
// engine owns lives alongside.
//
// **Invariant: nothing importable from app code lives under
// `.devstack/`.** Codegen bindings (the TS app actually `import`s)
// continue to land in user-controlled output dirs (`opts.output`,
// conventionally `src/devstack/` or `src/generated/`). The dot-dir is
// for state that should be invisible to TS tooling and lint configs.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Schema } from 'effect';
import { resolveAppDir } from './resolve-app-dir.js';
import { StateStoreConfig, type StateStoreConfigShape } from './state-store.js';

/** Name of the canonical per-stack subdirectory holding service-owned
 *  runtime state. Changing this constant is the SINGLE knob that
 *  retargets every service write + every snapshot tar entry. Keep all
 *  callers routed through `servicePath()` / `runtimeRoot` (or import
 *  this constant directly for fallback paths in optional-config
 *  branches) — no string-literal `'runtime'` should appear elsewhere
 *  in the codebase, so renaming this is a one-line change.
 *
 *  Co-located with the path resolver below so the relationship is
 *  obvious; exported for the (rare) callers that need to build a
 *  fallback path when `StateStoreConfig` isn't available. */
export const RUNTIME_DIR_NAME = 'runtime';

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

const requireValidServiceName = (service: string): void => {
	if (!SERVICE_NAME_RE.test(service)) {
		throw new Error(
			`servicePath: service name '${service}' is invalid ` +
				`(must match ${SERVICE_NAME_RE.source} — lowercase + digits + dashes, 1-64 chars)`,
		);
	}
};

/** Compute the canonical runtime root for the active stack/network.
 *  Mirrors the path scoping in `engine/state-store.ts:resolvePaths`:
 *  legacy `DEVSTACK_STATE_DIR` overrides everything, then explicit
 *  `cfg.stateDir`, then network-aware (`stacks/<stack>` for localnet,
 *  `networks/<network>` for live nets). */
const resolveRuntimeRoot = (cfg: StateStoreConfigShape): string => {
	const envOverride = process.env.DEVSTACK_STATE_DIR;
	if (envOverride !== undefined && envOverride.length > 0) {
		return join(envOverride, RUNTIME_DIR_NAME);
	}
	if (cfg.stateDir !== undefined && cfg.stateDir.length > 0) {
		return join(cfg.stateDir, RUNTIME_DIR_NAME);
	}
	const appDir = resolveAppDir();
	// Same local-like routing as state-store + snapshot — fork variants
	// own per-stack writable runtime state under
	// `.devstack/stacks/<stack>/`. Keeping the check inline (vs.
	// importing `isLocalLikeNetwork`) avoids a runtime dep edge from
	// this module to `engine/network.ts`.
	if (cfg.network === 'localnet' || cfg.network.endsWith('-fork')) {
		return join(appDir, '.devstack', 'stacks', cfg.stack, RUNTIME_DIR_NAME);
	}
	return join(appDir, '.devstack', 'networks', cfg.network, RUNTIME_DIR_NAME);
};

/** Resolve a path under the canonical `runtime/<service>/` directory
 *  for the active stack. Lazily `mkdir -p`s the service subdirectory on
 *  first read so callers don't have to. Returns an absolute path.
 *
 *  Typical use:
 *  ```
 *  const dir   = yield* servicePath('walrus');                  // -> .devstack/stacks/<stack>/runtime/walrus
 *  const file  = yield* servicePath('seal', 'master-key.env');  // -> .../runtime/seal/master-key.env
 *  const nest  = yield* servicePath('walrus', 'deploy', 'cfg'); // -> .../runtime/walrus/deploy/cfg
 *  ```
 *
 *  The service name is validated against `[a-z][a-z0-9-]*` to keep the
 *  on-disk layout predictable and avoid path-traversal via crafted names.
 *  Sub-parts are not validated — `join`'d together — so callers can pass
 *  any user-controlled filenames they want; the service name itself is
 *  the only trusted slice. */
export const servicePath = (
	service: string,
	...parts: ReadonlyArray<string>
): Effect.Effect<string, never, StateStoreConfig> =>
	Effect.gen(function* () {
		requireValidServiceName(service);
		const cfg = yield* StateStoreConfig;
		const root = resolveRuntimeRoot(cfg);
		const serviceDir = join(root, service);
		// `mkdir -p` is idempotent + race-tolerant; cheap on warm starts
		// (a single stat-like syscall when the dir already exists).
		if (!existsSync(serviceDir)) {
			mkdirSync(serviceDir, { recursive: true });
		}
		return parts.length === 0 ? serviceDir : join(serviceDir, ...parts);
	});

/** Resolve the canonical runtime root for the active stack/network.
 *  The snapshot save / restore pipeline calls this to know which
 *  directory tree to tar / extract. */
export const runtimeRoot: Effect.Effect<string, never, StateStoreConfig> = Effect.gen(function* () {
	const cfg = yield* StateStoreConfig;
	return resolveRuntimeRoot(cfg);
});

/** Schema-validated path shape for snapshot manifest. The save/restore
 *  pipeline reads this from `<snapshot>/meta.json` so a future migration
 *  can rename keys or add fields without losing forward-compat. */
export const ExtraPathEntry = Schema.Struct({
	key: Schema.String,
	path: Schema.String,
});
