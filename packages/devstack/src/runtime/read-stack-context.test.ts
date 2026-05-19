// Tests for `readStackContext` / `readStackContextSync` — the unified
// manifest reader + projection introduced by stack-simplification-audit
// finding E19. Three reachable outcomes are exercised:
//
//   1. v5 happy path — manifest exists, parses, decodes against
//      `ManifestV5`, projection surfaces the convenience slices (sui,
//      dev, wallet, endpoint(name)).
//   2. v3-shaped input (missing `services` / `app` discriminators) —
//      throws `ManifestShapeError` with `phase: 'shape'` instead of
//      NPEing downstream.
//   3. Missing file — throws `ManifestDiscoveryError` so callers can
//      distinguish "no manifest" from "manifest is stale".

import { Effect, Exit } from 'effect';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestDiscoveryError, ManifestShapeError } from '../engine/errors.js';
import type { Manifest } from './manifest-schema.js';
import { readStackContext, readStackContextSync } from './read-stack-context.js';

// Minimal v5 manifest fixture — just enough fields to satisfy
// `ManifestV5` and exercise the projection (sui rpc, dev, wallet).
const v5Manifest = (): Manifest => ({
	version: 5,
	stack: { name: 'main', network: 'localnet', app: 'test-app' },
	services: {
		sui: {
			network: 'localnet',
			chainId: '0xabc',
			rpc: { url: 'http://sui.test-app.localhost:9000' },
			faucet: { url: 'http://faucet.test-app.localhost:9123' },
		},
	},
	packages: {},
	accounts: {},
	coins: {},
	app: {
		extras: {},
		dev: { url: 'http://dev.test-app.localhost:5175' },
		wallet: { url: 'http://wallet.test-app.localhost:5180', pairUrl: 'http://wallet#token=abc' },
	},
});

const writeManifestAt = (root: string, stack: string, body: unknown): string => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, 'manifest.json');
	writeFileSync(manifestPath, JSON.stringify(body));
	return manifestPath;
};

describe('readStackContext (E19)', () => {
	let tmp: string;
	const savedEnv = {
		DEVSTACK_MANIFEST_PATH: undefined as string | undefined,
		DEVSTACK_STACK: undefined as string | undefined,
		DEVSTACK_STATE_DIR: undefined as string | undefined,
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'read-stack-context-'));
		savedEnv.DEVSTACK_MANIFEST_PATH = process.env.DEVSTACK_MANIFEST_PATH;
		savedEnv.DEVSTACK_STACK = process.env.DEVSTACK_STACK;
		savedEnv.DEVSTACK_STATE_DIR = process.env.DEVSTACK_STATE_DIR;
		delete process.env.DEVSTACK_MANIFEST_PATH;
		delete process.env.DEVSTACK_STACK;
		delete process.env.DEVSTACK_STATE_DIR;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		for (const key of ['DEVSTACK_MANIFEST_PATH', 'DEVSTACK_STACK', 'DEVSTACK_STATE_DIR'] as const) {
			const prev = savedEnv[key];
			if (prev === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = prev;
			}
		}
	});

	// ────────────────────────────────────────────────────────────────────
	// v5 happy path
	// ────────────────────────────────────────────────────────────────────

	describe('v5 happy path', () => {
		it('readStackContextSync — projects sui, dev, wallet, endpoint(name)', () => {
			const manifestPath = writeManifestAt(tmp, 'main', v5Manifest());
			const ctx = readStackContextSync({ manifestPath });
			expect(ctx.manifestPath).toBe(manifestPath);
			expect(ctx.stack).toEqual({ name: 'main', network: 'localnet', app: 'test-app' });
			expect(ctx.sui?.network).toBe('localnet');
			expect(ctx.sui?.chainId).toBe('0xabc');
			expect(ctx.sui?.rpc.url).toBe('http://sui.test-app.localhost:9000');
			expect(ctx.dev?.url).toBe('http://dev.test-app.localhost:5175');
			expect(ctx.wallet?.url).toBe('http://wallet.test-app.localhost:5180');
			expect(ctx.wallet?.pairUrl).toBe('http://wallet#token=abc');
			expect(ctx.endpoint('sui-rpc')?.url).toBe('http://sui.test-app.localhost:9000');
			expect(ctx.endpoint('sui-faucet')?.url).toBe('http://faucet.test-app.localhost:9123');
			expect(ctx.endpoint('frontend.dev-server')?.url).toBe('http://dev.test-app.localhost:5175');
			expect(ctx.endpoint('wallet-app')?.url).toBe('http://wallet.test-app.localhost:5180');
			expect(ctx.endpoint('does-not-exist')).toBeUndefined();
		});

		it('readStackContext (Effect) — same projection via the Effect surface', async () => {
			const manifestPath = writeManifestAt(tmp, 'main', v5Manifest());
			const ctx = await Effect.runPromise(readStackContext({ manifestPath }));
			expect(ctx.endpoint('sui-rpc')?.url).toBe('http://sui.test-app.localhost:9000');
			expect(ctx.sui?.faucet?.url).toBe('http://faucet.test-app.localhost:9123');
		});

		it('walks up from a nested cwd via DEVSTACK_STATE_DIR + DEVSTACK_STACK', () => {
			const manifestPath = writeManifestAt(tmp, 'main', v5Manifest());
			// Use override:cwd to anchor the walk-up.
			const nested = join(tmp, 'apps', 'nested');
			mkdirSync(nested, { recursive: true });
			const ctx = readStackContextSync({ cwd: nested });
			expect(ctx.manifestPath).toBe(manifestPath);
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// v3-shaped input throws ManifestShapeError
	// ────────────────────────────────────────────────────────────────────

	describe('stale / malformed manifest', () => {
		it('readStackContextSync — v3 shape (flat endpoints[], no services / app) throws ManifestShapeError', () => {
			const v3 = {
				endpoints: [{ name: 'sui-rpc', url: 'http://localhost:9000' }],
				packages: [],
				accounts: [],
			};
			const manifestPath = writeManifestAt(tmp, 'main', v3);
			try {
				readStackContextSync({ manifestPath });
				throw new Error('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestShapeError);
				const e = err as ManifestShapeError;
				expect(e.phase).toBe('shape');
				expect(e.path).toBe(manifestPath);
				expect(e.message).toMatch(/v5 schema/);
				// Schema error carried through `cause:` so pretty-error can
				// surface the offending field path.
				expect(e.cause).toBeDefined();
			}
		});

		it('readStackContext (Effect) — v3 shape fails with ManifestShapeError on the failure channel', async () => {
			const manifestPath = writeManifestAt(tmp, 'main', { endpoints: [] });
			const exit = await Effect.runPromiseExit(readStackContext({ manifestPath }));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const reasons = exit.cause.reasons;
				const failures = reasons.filter((r) => r._tag === 'Fail');
				expect(failures.length).toBeGreaterThan(0);
				const error = (failures[0] as { error: unknown }).error;
				expect(error).toBeInstanceOf(ManifestShapeError);
				expect((error as ManifestShapeError).phase).toBe('shape');
			}
		});

		it('readStackContextSync — corrupt JSON throws ManifestShapeError with phase=parse', () => {
			const dir = join(tmp, '.devstack', 'stacks', 'main');
			mkdirSync(dir, { recursive: true });
			const manifestPath = join(dir, 'manifest.json');
			writeFileSync(manifestPath, '{not-valid-json');
			try {
				readStackContextSync({ manifestPath });
				throw new Error('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestShapeError);
				const e = err as ManifestShapeError;
				expect(e.phase).toBe('parse');
				expect(e.path).toBe(manifestPath);
				expect(e.cause).toBeDefined();
			}
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// Missing file throws ManifestDiscoveryError
	// ────────────────────────────────────────────────────────────────────

	describe('missing manifest', () => {
		it('readStackContextSync — no manifest on disk throws ManifestDiscoveryError', () => {
			try {
				readStackContextSync({ cwd: tmp, stateDir: '.devstack-sentinel-missing' });
				throw new Error('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestDiscoveryError);
				const e = err as ManifestDiscoveryError;
				expect(e.phase).toBe('required-missing');
				expect(e.message).toMatch(/no manifest\.json/);
			}
		});

		it('readStackContextSync — explicit manifestPath that does not exist throws ManifestDiscoveryError', () => {
			const missing = join(tmp, 'no-such-manifest.json');
			try {
				readStackContextSync({ manifestPath: missing });
				throw new Error('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestDiscoveryError);
				expect((err as ManifestDiscoveryError).phase).toBe('walk-up');
			}
		});

		it('readStackContext (Effect) — missing manifest surfaces ManifestDiscoveryError on the failure channel', async () => {
			const exit = await Effect.runPromiseExit(
				readStackContext({ cwd: tmp, stateDir: '.devstack-sentinel-missing' }),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const reasons = exit.cause.reasons;
				const failures = reasons.filter((r) => r._tag === 'Fail');
				const error = (failures[0] as { error: unknown }).error;
				expect(error).toBeInstanceOf(ManifestDiscoveryError);
			}
		});
	});
});
