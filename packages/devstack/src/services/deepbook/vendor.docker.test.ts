// L3 real-docker test for `vendorDeepbook` — clones the deepbook +
// deepbook-sandbox repos and materializes all six packages into
// `.devstack/vendor/deepbook/<ref>/`. Verifies each package's
// `Move.toml` is patched with local-path deps.
//
// Skips when Docker isn't reachable (matches the convention used by
// `engine/snapshot.docker.test.ts`). gitFetch doesn't strictly need
// Docker but the rest of the test gate's L3 fixtures do, so we keep
// the same gate.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Effect, Layer } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { DOCKER_OK, stampSkipNoticeIfMissing } from '../../../test-setup/docker/probe.js';
import { vendorDeepbook } from './vendor.js';

const TEST_TIMEOUT_MS = 360_000; // 6 min — cold clone can be slow

// Gate on both DOCKER_OK and DEVSTACK_INTEGRATION_TESTS — the test needs
// real outbound git network access (clone from github.com) and
// materializes ~30MB of Move source. Default-skip so `pnpm test` stays
// fast; opt in via `DEVSTACK_INTEGRATION_TESTS=1`.
const RUN_INTEGRATION = DOCKER_OK && process.env.DEVSTACK_INTEGRATION_TESTS === '1';

describe.skipIf(!RUN_INTEGRATION)('vendorDeepbook — real-Docker fixture', () => {
	it(
		'clones + materializes all 6 packages and patches each Move.toml with local-path deps',
		async () => {
			const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'devstack-vendor-'));
			const savedStateDir = process.env.DEVSTACK_STATE_DIR;
			process.env.DEVSTACK_STATE_DIR = tmpRoot;

			try {
				const vendor = vendorDeepbook({ ref: 'main' });

				// Build via Layer.build so all internal layers are wired without
				// per-layer `Effect.provide` plumbing in the test.
				const layerList = (vendor.__layers ?? []) as ReadonlyArray<Layer.Layer<any, any, any>>;
				let composedLayer: Layer.Layer<any, any, any> = NodeServicesLayer as Layer.Layer<
					any,
					any,
					any
				>;
				for (const l of layerList) {
					composedLayer = Layer.mergeAll(composedLayer, l);
				}

				const program: Effect.Effect<any, any, any> = Effect.gen(function* () {
					return yield* vendor;
				});

				const result: { root: string } = (await Effect.runPromise(
					Effect.scoped(program.pipe(Effect.provide(composedLayer))) as Effect.Effect<
						unknown,
						never,
						never
					>,
				)) as { root: string };

				// Each of the six packages should exist with a Move.toml.
				const packageNames = [
					'token',
					'deepbook',
					'pyth',
					'usdc',
					'deepbook_margin',
					'margin_liquidation',
				] as const;
				for (const pkg of packageNames) {
					const movePath = path.join(result.root, pkg, 'Move.toml');
					expect(existsSync(movePath), `${pkg}/Move.toml missing`).toBe(true);
				}

				// Verify the local-path rewrite for `deepbook_margin`, which
				// declares deps on `token`, `deepbook`, and `pyth`.
				const marginToml = readFileSync(
					path.join(result.root, 'deepbook_margin', 'Move.toml'),
					'utf8',
				);
				expect(marginToml).toContain('local = "../token"');
				expect(marginToml).toContain('local = "../deepbook"');
				expect(marginToml).toContain('local = "../pyth"');
			} finally {
				rmSync(tmpRoot, { recursive: true, force: true });
				if (savedStateDir === undefined) {
					delete process.env.DEVSTACK_STATE_DIR;
				} else {
					process.env.DEVSTACK_STATE_DIR = savedStateDir;
				}
			}
		},
		TEST_TIMEOUT_MS,
	);
});

stampSkipNoticeIfMissing('vendorDeepbook.docker.test');
