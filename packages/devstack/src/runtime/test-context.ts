// Test-only helper that constructs a synthetic `ActionRunContext`. Plugin
// authors writing unit tests for their own actions reach for this so they
// don't have to hand-stub the `Registry` + `AccountsContext` + `PortAllocator`
// + `appendLog` quartet themselves. Re-exported from `/authoring`.
//
// The helper is deliberately lightweight: pre-resolved account map (no
// factory invocation), in-memory port allocator that returns the preferred
// port (or a per-slot override) without binding anything, and an in-process
// log sink the test can assert on. For tests that need real port binding /
// real account materialization, integration-test seams elsewhere are the
// right tool — this is for the unit-test layer.

import type { Signer } from '@mysten/sui/cryptography';

import type {
	AccountsContext,
	ActionRunContext,
	LocalnetActionRunContext,
	Network,
	PortAllocator,
	Registry,
} from '../core/types.js';
import { RegistryImpl } from '../registry/index.js';

export interface CreateTestActionContextOptions {
	/** App name plumbed onto `ctx.appName`. Defaults to `'test-app'`. */
	appName?: string;
	/** Absolute path on disk used for `ctx.appDir`. Defaults to a fixed
	 * tmp-style placeholder; the helper does not create the directory.
	 * Tests that touch the filesystem should pass an `mkdtempSync`-based
	 * path. */
	appDir?: string;
	/** Localnet stack name. Ignored on live-net contexts (which omit the
	 * `stack` field). Defaults to `'main'`. */
	stack?: string;
	/** Active network. `'localnet'` (default) yields a `LocalnetActionRunContext`
	 * with `stack` + `ports`; `'testnet'` / `'mainnet'` yield a live-net
	 * context that omits both. */
	network?: Network;
	/**
	 * Pre-resolved `name → Signer` map plumbed through `ctx.accounts.get(name)`.
	 * Test-only — bypasses the usual `AccountFactory` resolution. Lookups for
	 * unseeded names throw with a clear message. Defaults to empty.
	 */
	accounts?: Record<string, Signer>;
	/**
	 * Per-slot port override. When a test calls `ctx.ports.allocate({ slot,
	 * preferred })`, the helper returns `[override]` if the slot is overridden,
	 * otherwise `[preferred ?? 1]`. Multi-port allocations (`count > 1`) yield
	 * a contiguous range starting at the resolved base. Only present on
	 * localnet contexts.
	 */
	ports?: Record<string, number>;
	/**
	 * `inputHash` plumbed onto the synthesized ctx. Defaults to
	 * `'test-input-hash'`. Plugin authors testing input-hash–sensitive paths
	 * (e.g. `containerService` resume-vs-recreate) override this to exercise
	 * both branches.
	 */
	inputHash?: string;
	/**
	 * Pre-existing registry to seed. Defaults to a fresh empty `RegistryImpl`.
	 * Pass an existing registry to share state across multiple synthesized
	 * contexts (e.g. simulating two actions in the same cycle).
	 */
	registry?: Registry;
	/**
	 * Captured `appendLog` lines. The helper pushes any `ctx.appendLog(line)`
	 * call into this array; tests can assert on it directly. Defaults to a
	 * fresh array; pass an existing one when the test wants to share captures
	 * across multiple contexts.
	 */
	appendLogSink?: string[];
}

/**
 * Construct a synthetic `ActionRunContext` for plugin unit tests.
 *
 * The returned context is a real `LocalnetActionRunContext` (or live-net
 * variant when `network` is testnet/mainnet) — no proxy magic, no partial
 * shape. Pass it directly to any action's `run` / `getStatus` /
 * `provides.registry` callback.
 *
 * Defaults are tuned for the common case (localnet, fresh registry, empty
 * accounts, no allocated ports): every field is overridable for tests that
 * exercise specific upstream conditions.
 *
 * Live-net contexts omit `stack` and `ports` per the discriminated union,
 * matching the runtime shape exactly.
 */
export function createTestActionContext(
	opts: CreateTestActionContextOptions = {},
): ActionRunContext {
	const network: Network = opts.network ?? 'localnet';
	const appName = opts.appName ?? 'test-app';
	const appDir = opts.appDir ?? '/tmp/test-devstack';
	const stack = opts.stack ?? 'main';
	const inputHash = opts.inputHash ?? 'test-input-hash';
	const registry = opts.registry ?? new RegistryImpl();
	const sink = opts.appendLogSink ?? [];

	const accountsMap = opts.accounts ?? {};
	const accounts: AccountsContext = {
		get(name) {
			const signer = accountsMap[name];
			if (signer === undefined) {
				const declared = Object.keys(accountsMap);
				const known = declared.length === 0 ? '(none)' : declared.join(', ');
				throw new Error(
					`createTestActionContext: account '${name}' not seeded — declared: ${known}`,
				);
			}
			return signer;
		},
		has(name) {
			return name in accountsMap;
		},
		names() {
			return Object.keys(accountsMap);
		},
	};

	const appendLog = (line: string) => {
		sink.push(line);
	};

	if (network === 'localnet') {
		const portsMap = opts.ports ?? {};
		const ports: PortAllocator = {
			async allocate({ slot, preferred, count = 1 }) {
				const base = portsMap[slot] ?? preferred ?? 1;
				return Array.from({ length: count }, (_, i) => base + i);
			},
		};
		const localnetCtx: LocalnetActionRunContext = {
			appName,
			appDir,
			network: 'localnet',
			stack,
			registry,
			accounts,
			ports,
			appendLog,
			inputHash,
		};
		return localnetCtx;
	}

	return {
		appName,
		appDir,
		network,
		registry,
		accounts,
		appendLog,
		inputHash,
	};
}
