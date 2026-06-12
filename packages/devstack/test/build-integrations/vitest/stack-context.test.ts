// Stack-context loader for the vitest integration.
//
// Architecture invariants verified:
//   - Walks up from cwd to find <runtimeRoot>/stacks/<stack>/manifest.json
//     (stack-scoped only — never returns a flat <runtimeRoot>/manifest.json).
//   - DEVSTACK_MANIFEST_PATH wins over `opts.manifestPath` and walk-up.
//   - Returns undefined on miss; throws VitestManifestNotFoundError with
//     a recovery hint when {required: true}.
//   - Surfaces VitestManifestShapeError with `phase: 'parse' | 'shape'`
//     when the file exists but decode fails.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	loadStackContext,
	type LoadStackContextOptions,
} from '../../../src/build-integrations/vitest/stack-context.ts';
import {
	VitestManifestNotFoundError,
	VitestManifestShapeError,
} from '../../../src/build-integrations/vitest/errors.ts';

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

const minimalManifest = (overrides: Partial<{ stack: string }> = {}) => ({
	identity: {
		app: 'demo-app',
		stack: overrides.stack ?? 'test',
		chain: 'devnet-local',
	},
	manifestVersion: 1,
	services: {},
	endpoints: {
		'sui#0:rpc': {
			name: 'rpc',
			url: 'http://localhost:9000',
			displayUrl: null,
			wireProtocol: 'http',
			pluginKey: 'sui',
			endpointKey: 'sui#0:rpc',
		},
		'host-service/app#0:dev': {
			name: 'dev',
			url: 'http://localhost:5173',
			displayUrl: 'http://dev.demo.localhost:5175',
			wireProtocol: 'http',
			pluginKey: 'dev',
			endpointKey: 'host-service/app#0:dev',
		},
	},
	extras: {},
});

interface Tmp {
	readonly root: string;
	readonly cleanup: () => void;
	writeManifest: (stack: string, body: unknown) => string;
}

const makeTmp = (): Tmp => {
	const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-'));
	return {
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
		writeManifest: (stack: string, body: unknown) => {
			const dir = join(root, '.devstack', 'stacks', stack);
			mkdirSync(dir, { recursive: true });
			const path = join(dir, 'manifest.json');
			writeFileSync(path, JSON.stringify(body));
			return path;
		},
	};
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('loadStackContext', () => {
	let tmp: Tmp;

	beforeEach(() => {
		tmp = makeTmp();
	});
	afterEach(() => tmp.cleanup());

	const baseOpts = (overrides: Partial<LoadStackContextOptions> = {}): LoadStackContextOptions => ({
		cwd: tmp.root,
		env: {}, // explicit empty env so process.env doesn't leak in
		...overrides,
	});

	it('returns undefined when no manifest exists and required is false', () => {
		expect(loadStackContext(baseOpts({ stack: 'test' }))).toBeUndefined();
	});

	it('throws VitestManifestNotFoundError when required: true and no manifest', () => {
		expect(() => loadStackContext(baseOpts({ stack: 'test', required: true }))).toThrow(
			VitestManifestNotFoundError,
		);
	});

	it('VitestManifestNotFoundError carries searchedFrom + recovery hint', () => {
		try {
			loadStackContext(baseOpts({ stack: 'test', required: true }));
			expect.fail('expected throw');
		} catch (e) {
			expect(e).toBeInstanceOf(VitestManifestNotFoundError);
			const err = e as VitestManifestNotFoundError;
			expect(err.searchedFrom).toBe(tmp.root);
			expect(err.stack).toBe('test');
			expect(err.recovery).toContain('devstack up');
		}
	});

	it('reads the stack-scoped manifest from the walk-up', () => {
		tmp.writeManifest('test', minimalManifest({ stack: 'test' }));
		const ctx = loadStackContext(baseOpts({ stack: 'test' }));
		expect(ctx).toBeDefined();
		expect(ctx?.identity.stack).toBe('test');
		expect(ctx?.endpoint('rpc')).toBe('http://localhost:9000');
	});

	it('displayEndpoint falls back to url when displayUrl is null', () => {
		tmp.writeManifest('test', minimalManifest());
		const ctx = loadStackContext(baseOpts({ stack: 'test' }));
		expect(ctx?.displayEndpoint('rpc')).toBe('http://localhost:9000');
		expect(ctx?.displayEndpoint('dev')).toBe('http://dev.demo.localhost:5175');
	});

	it('endpoint() returns undefined for unknown names', () => {
		tmp.writeManifest('test', minimalManifest());
		const ctx = loadStackContext(baseOpts({ stack: 'test' }));
		expect(ctx?.endpoint('does-not-exist')).toBeUndefined();
	});

	it('different stacks live at distinct paths', () => {
		tmp.writeManifest('main', minimalManifest({ stack: 'main' }));
		tmp.writeManifest('test', minimalManifest({ stack: 'test' }));
		expect(loadStackContext(baseOpts({ stack: 'main' }))?.identity.stack).toBe('main');
		expect(loadStackContext(baseOpts({ stack: 'test' }))?.identity.stack).toBe('test');
	});

	it('infers the stack from the nearest package.json name when no stack option or env is set', () => {
		// Mirrors the CLI's `resolveStackName`: `devstack up` in a bare app
		// (no stackName, no DEVSTACK_STACK) names the stack after the
		// package, so the loader must find that manifest the same way.
		writeFileSync(join(tmp.root, 'package.json'), JSON.stringify({ name: '@scope/smoke-app' }));
		tmp.writeManifest('main', minimalManifest({ stack: 'main' })); // decoy at the old default
		tmp.writeManifest('smoke-app', minimalManifest({ stack: 'smoke-app' }));
		const ctx = loadStackContext(baseOpts());
		expect(ctx?.identity.stack).toBe('smoke-app');
	});

	it('DEVSTACK_STACK env wins over package-name stack inference', () => {
		writeFileSync(join(tmp.root, 'package.json'), JSON.stringify({ name: '@scope/smoke-app' }));
		tmp.writeManifest('smoke-app', minimalManifest({ stack: 'smoke-app' })); // decoy
		tmp.writeManifest('from-env', minimalManifest({ stack: 'from-env' }));
		const ctx = loadStackContext(baseOpts({ env: { DEVSTACK_STACK: 'from-env' } }));
		expect(ctx?.identity.stack).toBe('from-env');
	});

	it('DEVSTACK_MANIFEST_PATH env override wins over walk-up', () => {
		const overridePath = tmp.writeManifest('explicit', minimalManifest({ stack: 'explicit' }));
		// stack arg says 'test' but env override points at 'explicit'.
		const ctx = loadStackContext(
			baseOpts({
				stack: 'test',
				env: { DEVSTACK_MANIFEST_PATH: overridePath },
			}),
		);
		expect(ctx?.identity.stack).toBe('explicit');
	});

	it('opts.manifestPath bypasses walk-up', () => {
		const path = tmp.writeManifest('via-opt', minimalManifest({ stack: 'via-opt' }));
		const ctx = loadStackContext(baseOpts({ stack: 'unused', manifestPath: path }));
		expect(ctx?.identity.stack).toBe('via-opt');
	});

	it('throws VitestManifestShapeError with phase=parse on malformed JSON', () => {
		const dir = join(tmp.root, '.devstack', 'stacks', 'test');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'manifest.json'), '{not json');
		try {
			loadStackContext(baseOpts({ stack: 'test' }));
			expect.fail('expected throw');
		} catch (e) {
			expect(e).toBeInstanceOf(VitestManifestShapeError);
			expect((e as VitestManifestShapeError).phase).toBe('parse');
			expect((e as VitestManifestShapeError).recovery).toContain('devstack apply');
		}
	});

	it('throws VitestManifestShapeError with phase=shape on schema mismatch', () => {
		tmp.writeManifest('test', { identity: { app: 'x' } /* missing fields */ });
		try {
			loadStackContext(baseOpts({ stack: 'test' }));
			expect.fail('expected throw');
		} catch (e) {
			expect(e).toBeInstanceOf(VitestManifestShapeError);
			expect((e as VitestManifestShapeError).phase).toBe('shape');
		}
	});

	it('walks up through parent directories', () => {
		tmp.writeManifest('test', minimalManifest({ stack: 'test' }));
		const nested = join(tmp.root, 'a', 'b', 'c');
		mkdirSync(nested, { recursive: true });
		const ctx = loadStackContext(baseOpts({ cwd: nested, stack: 'test' }));
		expect(ctx?.identity.stack).toBe('test');
	});

	it('does NOT match a flat .devstack/manifest.json (stack-scoped only)', () => {
		// Flat path that the engine never writes; must remain invisible.
		const flatDir = join(tmp.root, '.devstack');
		mkdirSync(flatDir, { recursive: true });
		writeFileSync(join(flatDir, 'manifest.json'), JSON.stringify(minimalManifest()));
		expect(loadStackContext(baseOpts({ stack: 'test' }))).toBeUndefined();
	});
});
