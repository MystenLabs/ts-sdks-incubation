import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
	AccountsContext,
	ActionRunContext,
	EmitAction,
	Package,
} from '../../core/types.js';
import { RegistryImpl } from '../../registry/index.js';
import { createInMemoryPortAllocator } from '../../runtime/port-allocator.js';
import { codegen } from './index.js';

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

	it('the lone action is Emit with `dependsOnKind: [\'packages\']`', () => {
		const action = getGenerateAction();
		expect(action.type).toBe('Emit');
		expect(action.name).toBe('generate');
		expect(action.dependsOnKind).toEqual(['packages']);
	});

	it('threads the `output` option into the action inputs (default `src/generated/sui`)', () => {
		const defaultAction = getGenerateAction();
		expect((defaultAction.inputs as { output: string }).output).toBe('src/generated/sui');
		const customAction = getGenerateAction('custom/out');
		expect((customAction.inputs as { output: string }).output).toBe('custom/out');
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
		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
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
		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
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
		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
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
		writeBindings(outputAbs, 'vault');
		setMtime(outputAbs, 2_000_000);

		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
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
		writeBindings(outputAbs, 'vault');
		setMtime(outputAbs, 1_000_000);
		setMtime(join(pkgPath, 'sources', 'vault.move'), 2_000_000);

		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'vault',
			packageId: '0x1',
			captured: {},
			network: 'localnet',
			path: pkgPath,
		});
		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
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
		writeBindings(outputAbs, 'vault');
		// Sources at T=1_000_000s; bindings dir at T=2_000_000s (newer).
		setMtime(join(pkgPath, 'Move.toml'), 1_000_000);
		setMtime(join(pkgPath, 'sources', 'vault.move'), 1_000_000);
		setMtime(outputAbs, 2_000_000);

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

		const action = getGenerateAction();
		const status = await action.getStatus!(makeCtx(appDir, registry));
		// `seal` doesn't generate a "bindings missing" failure because the
		// pathless entry is filtered by `codegenTargets()` before the loop.
		expect(status.ok).toBe(true);
		expect(status.detail).toMatch(/1 package\(s\) up-to-date/);
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
		writeBindings(outputAbs, 'vault');
		setMtime(outputAbs, 2_000_000);

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
		const first = await action.getStatus!(ctx);
		const second = await action.getStatus!(ctx);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(first.detail).toBe(second.detail);
	});
});
