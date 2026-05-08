import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
	AccountsContext,
	ActionRunContext,
	EmitAction,
	Package,
} from '../../core/types.js';
import { defineRegistryKind, RegistryImpl } from '../../registry/index.js';
import { createInMemoryPortAllocator } from '../../runtime/port-allocator.js';
import { codegen, renderTypedManifest } from './index.js';

// `codegen.generate` is the only action this plugin produces; tests below
// inspect its `getStatus` gate, since `run()` shells `sui-ts-codegen` which
// requires the Sui CLI on PATH (out of scope for unit tests).

const emptyAccounts: AccountsContext = {
	get: (name) => {
		throw new Error(`accounts.get('${name}'): no accounts in this fixture`);
	},
	has: () => false,
	names: () => [],
};

const makeCtx = (appDir: string, registry: RegistryImpl): ActionRunContext => ({
	appName: 'test',
	appDir,
	stack: 'main',
	network: 'localnet',
	registry,
	accounts: emptyAccounts,
	ports: createInMemoryPortAllocator(),
	inputHash: 'test',
	appendLog: () => {},
});

const getGenerateAction = (output?: string): EmitAction => {
	const plugin = codegen(output === undefined ? {} : { output });
	const actions = plugin.actions();
	const action = actions[0];
	if (action === undefined || action.type !== 'Emit') {
		throw new Error('codegen() did not produce an Emit action');
	}
	return action;
};

let tmpDirs: string[] = [];

const newAppDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-codegen-'));
	tmpDirs.push(dir);
	return dir;
};

const writeMovePackage = (root: string, name: string): string => {
	// Layout the codegen plugin's mtime walker actually inspects:
	// `<path>/Move.toml` + everything under `<path>/sources/**` ending in
	// `.move`. Returns the package's absolute path (suitable for
	// `Package.path`).
	const pkgDir = join(root, name);
	mkdirSync(join(pkgDir, 'sources'), { recursive: true });
	writeFileSync(join(pkgDir, 'Move.toml'), `[package]\nname = "${name}"\n`);
	writeFileSync(join(pkgDir, 'sources', `${name}.move`), `module ${name}::m {}\n`);
	return pkgDir;
};

const writeBindings = (outputAbs: string, pkgName: string): string => {
	const sub = join(outputAbs, pkgName);
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, 'index.ts'), `// generated for ${pkgName}\n`);
	return sub;
};

/** Pre-write the typed manifest exactly as `getStatus` expects, so tests
 * that exercise other gate branches don't trip the manifest-staleness
 * check first. Mirrors codegen's path convention: manifest.ts sits one
 * level up from the Move-bindings dir. */
const writeCurrentManifest = (outputAbs: string, ctx: ActionRunContext): void => {
	const manifestPath = resolve(outputAbs, '..', 'manifest.ts');
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, renderTypedManifest(ctx), 'utf8');
};

const setMtime = (path: string, ms: number): void => {
	// `statSync(p).mtimeMs` reads what utimesSync writes; both take seconds
	// since epoch as floats. Used to deterministically position bindings
	// before/after sources without relying on real wall-clock between writes.
	const seconds = ms / 1000;
	utimesSync(path, seconds, seconds);
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('codegen() factory', () => {
	it('returns a Plugin named `codegen` with exactly one action', () => {
		const plugin = codegen();
		expect(plugin.name).toBe('codegen');
		expect(plugin.actions()).toHaveLength(1);
	});

	it('the lone action is Emit gated on the wildcard so plugin-namespaced kinds also re-fire it', () => {
		const action = getGenerateAction();
		expect(action.type).toBe('Emit');
		expect(action.name).toBe('generate');
		// Wildcard — any registry kind dirty re-fires codegen, including
		// plugin-namespaced kinds (walrus.nodes, seal.keyServer, …) that
		// aren't enumerable at action-construction time.
		expect(action.dependsOnKind).toEqual(['*']);
	});

	it('threads the `output` option into the action inputs (default `src/generated/sui`)', () => {
		const defaultAction = getGenerateAction();
		expect((defaultAction.inputs as { output: string }).output).toBe('src/generated/sui');
		const customAction = getGenerateAction('custom/out');
		expect((customAction.inputs as { output: string }).output).toBe('custom/out');
	});
});

describe('renderTypedManifest', () => {
	it('emits a TypeScript module with a `: Manifest` type annotation imported from devstack', () => {
		const registry = new RegistryImpl();
		registry.accounts.register({ name: 'alice', address: '0x1', funded: true });
		registry.services.register({
			name: 'sui-rpc',
			kind: 'rpc',
			url: 'http://localhost:31000',
			port: 31000,
		});
		const ctx = makeCtx('/app', registry);
		const out = renderTypedManifest(ctx);
		expect(out).toMatch(/import type \{ Manifest \} from '@mysten-incubation\/devstack';/);
		expect(out).toMatch(/export const manifest: Manifest =/);
		expect(out).toMatch(/"alice"/);
		expect(out).toMatch(/"sui-rpc"/);
	});

	it('includes plugin-namespaced registry kinds at top level of `registry`', () => {
		const registry = new RegistryImpl();
		const sharedObjects = defineRegistryKind<{ name: string; objectId: string }>(
			'arena.sharedObjects',
		);
		sharedObjects(registry).register({ name: 'openLobby', objectId: '0xabc' });
		const ctx = makeCtx('/app', registry);
		const out = renderTypedManifest(ctx);
		expect(out).toMatch(/"arena":/);
		expect(out).toMatch(/"sharedObjects":/);
		expect(out).toMatch(/"openLobby"/);
	});

	it('is deterministic for unchanged input (powers the staleness check)', () => {
		const registry = new RegistryImpl();
		registry.accounts.register({ name: 'alice', address: '0x1', funded: true });
		const ctx = makeCtx('/app', registry);
		expect(renderTypedManifest(ctx)).toBe(renderTypedManifest(ctx));
	});

	it('strips absolute on-host `path` from package entries — no home-dir leak in committed bundle', () => {
		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'connect_four',
			packageId: '0xabc',
			captured: {},
			network: 'localnet',
			path: '/Users/foo/code/examples/arena/move/connect_four',
		});
		const out = renderTypedManifest(makeCtx('/app', registry));
		expect(out).not.toContain('/Users/foo');
		expect(out).not.toMatch(/"path":/);
		expect(out).toContain('"connect_four"');
	});
});

describe('codegen.getStatus — gate behavior', () => {
	it('returns ok:true with `no codegen-able packages` when registry holds zero on-host paths', async () => {
		const appDir = newAppDir();
		const registry = new RegistryImpl();
		// Pathless package — codegen silently skips per review 05's flagged behavior.
		registry.packages.register({
			name: 'imported_pkg',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			// path: undefined  ← imported package
		});
		const ctx = makeCtx(appDir, registry);
		// Pre-stage the typed manifest the way `run()` would have, so the
		// staleness gate passes and we hit the no-codegen-able-packages branch.
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		writeCurrentManifest(outputAbs, ctx);
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		expect(status.ok).toBe(true);
		expect(status.detail).toMatch(/no codegen-able packages/);
	});

	it('returns ok:false when the output dir does not yet exist', async () => {
		const appDir = newAppDir();
		const moveRoot = mkdtempSync(join(tmpdir(), 'devstack-codegen-move-'));
		tmpDirs.push(moveRoot);
		const pkgPath = writeMovePackage(moveRoot, 'vault');
		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		const ctx = makeCtx(appDir, registry);
		// Stage a current manifest.ts so the staleness gate passes and we hit
		// the missing-bindings-dir branch we want to assert on.
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		writeCurrentManifest(outputAbs, ctx);
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		expect(status.ok).toBe(false);
		expect(status.detail).toMatch(/missing/);
	});

	it('returns ok:false when bindings for a package are missing', async () => {
		const appDir = newAppDir();
		const moveRoot = mkdtempSync(join(tmpdir(), 'devstack-codegen-move-'));
		tmpDirs.push(moveRoot);
		const pkgPath = writeMovePackage(moveRoot, 'vault');
		// Output dir exists but no per-package subdir.
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		const ctx = makeCtx(appDir, registry);
		writeCurrentManifest(outputAbs, ctx);
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		expect(status.ok).toBe(false);
		expect(status.detail).toMatch(/vault bindings missing/);
	});

	it('returns ok:true when bindings exist and are newer than Move sources', async () => {
		const appDir = newAppDir();
		const moveRoot = mkdtempSync(join(tmpdir(), 'devstack-codegen-move-'));
		tmpDirs.push(moveRoot);
		const pkgPath = writeMovePackage(moveRoot, 'vault');
		// Stamp sources at T=1000s, bindings at T=2000s — bindings newer.
		setMtime(join(pkgPath, 'Move.toml'), 1_000_000);
		setMtime(join(pkgPath, 'sources', 'vault.move'), 1_000_000);
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const subdir = writeBindings(outputAbs, 'vault');
		setMtime(subdir, 2_000_000);

		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		const ctx = makeCtx(appDir, registry);
		writeCurrentManifest(outputAbs, ctx);
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		expect(status.ok).toBe(true);
		expect(status.detail).toMatch(/up-to-date/);
	});

	it('returns ok:false when Move sources are newer than bindings', async () => {
		const appDir = newAppDir();
		const moveRoot = mkdtempSync(join(tmpdir(), 'devstack-codegen-move-'));
		tmpDirs.push(moveRoot);
		const pkgPath = writeMovePackage(moveRoot, 'vault');
		// Bindings at T=1000s; source touched at T=2000s.
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const subdir = writeBindings(outputAbs, 'vault');
		setMtime(subdir, 1_000_000);
		setMtime(join(pkgPath, 'sources', 'vault.move'), 2_000_000);

		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		const ctx = makeCtx(appDir, registry);
		writeCurrentManifest(outputAbs, ctx);
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		expect(status.ok).toBe(false);
		expect(status.detail).toMatch(/sources newer than bindings/);
	});

	it("silently skips packages whose `path` is `undefined` ('<imported>'-equivalent)", async () => {
		const appDir = newAppDir();
		const moveRoot = mkdtempSync(join(tmpdir(), 'devstack-codegen-move-'));
		tmpDirs.push(moveRoot);
		const pkgPath = writeMovePackage(moveRoot, 'vault');

		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const subdir = writeBindings(outputAbs, 'vault');
		// Sources at T=1_000_000s; bindings dir at T=2_000_000s (newer).
		setMtime(join(pkgPath, 'Move.toml'), 1_000_000);
		setMtime(join(pkgPath, 'sources', 'vault.move'), 1_000_000);
		setMtime(subdir, 2_000_000);

		const registry = new RegistryImpl();
		// Mix: one on-host package + one pathless (e.g. seal/walrus).
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		registry.packages.register({
			name: 'seal',
			packageId: '0x2',
			captured: {},
			network: 'localnet',
			// path: undefined  → review 05: silently skipped
		});
		// Note: a literal '<imported>' path string isn't filtered by the
		// current implementation (review 05 flagged this as a future
		// hardening). The supported skip is `path: undefined`.

		const ctx = makeCtx(appDir, registry);
		writeCurrentManifest(outputAbs, ctx);
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		// `seal` doesn't generate a "bindings missing" failure because the
		// pathless entry is filtered by `codegenTargets()` before the loop.
		expect(status.ok).toBe(true);
		expect(status.detail).toMatch(/1 package\(s\) up-to-date/);
	});

	it('returns ok:false when manifest.ts is absent (run() must regenerate)', async () => {
		const appDir = newAppDir();
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const registry = new RegistryImpl();
		registry.accounts.register({ name: 'alice', address: '0x1', funded: true });
		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
		expect(status.ok).toBe(false);
		expect(status.detail).toMatch(/manifest\.ts stale/);
	});

	it('returns ok:false when manifest.ts content drifts from the current registry snapshot', async () => {
		const appDir = newAppDir();
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const registry = new RegistryImpl();
		registry.accounts.register({ name: 'alice', address: '0x1', funded: true });
		const ctx = makeCtx(appDir, registry);
		writeCurrentManifest(outputAbs, ctx);
		// Drift the registry without re-writing the file.
		registry.accounts.register({ name: 'bob', address: '0x2', funded: true });
		const action = getGenerateAction();
		const status = await action.getStatus!(ctx);
		expect(status.ok).toBe(false);
		expect(status.detail).toMatch(/manifest\.ts stale/);
	});

	it('idempotency: a second getStatus on unchanged inputs still returns ok:true (no spurious re-gen)', async () => {
		const appDir = newAppDir();
		const moveRoot = mkdtempSync(join(tmpdir(), 'devstack-codegen-move-'));
		tmpDirs.push(moveRoot);
		const pkgPath = writeMovePackage(moveRoot, 'vault');
		setMtime(join(pkgPath, 'Move.toml'), 1_000_000);
		setMtime(join(pkgPath, 'sources', 'vault.move'), 1_000_000);
		const outputAbs = join(appDir, 'src', 'generated', 'sui');
		mkdirSync(outputAbs, { recursive: true });
		const subdir = writeBindings(outputAbs, 'vault');
		setMtime(subdir, 2_000_000);

		const pkg: Package = {
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		};
		const registry = new RegistryImpl();
		registry.packages.register(pkg);

		const action = getGenerateAction();
		const ctx = makeCtx(appDir, registry);
		writeCurrentManifest(outputAbs, ctx);
		const first = await action.getStatus!(ctx);
		const second = await action.getStatus!(ctx);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(first.detail).toBe(second.detail);
	});
});
