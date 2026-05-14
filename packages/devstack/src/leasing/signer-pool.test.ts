import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../engine/types.js';
import type { Manifest } from '../shapes/index.js';
import { SignerPool } from './signer-pool.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-leasing-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

function localEnv(stack = 'test'): Env {
	return { appName: 'demo', appDir, network: 'localnet', stack };
}

async function seedKeystore(env: Env, names: string[]): Promise<Manifest> {
	const keysDir = join(env.appDir, '.devstack', 'stacks', env.stack ?? 'main', '.keys');
	await mkdir(keysDir, { recursive: true });
	const accounts: Manifest['accounts'] = [];
	for (const name of names) {
		const kp = Ed25519Keypair.generate();
		const secret = kp.getSecretKey();
		await writeFile(join(keysDir, `${name}.key`), secret, 'utf8');
		accounts.push({ name, address: kp.toSuiAddress() });
	}
	return {
		packages: [],
		endpoints: [],
		accounts,
		coins: [],
		extras: {},
	};
}

describe('SignerPool.fromManifest', () => {
	it('materializes signers for every account in the manifest', async () => {
		const env = localEnv();
		const manifest = await seedKeystore(env, ['alice', 'bob', 'carol']);
		const pool = await SignerPool.fromManifest(manifest, env);
		expect(pool.size()).toBe(3);
		expect(pool.names().sort()).toEqual(['alice', 'bob', 'carol']);
	});

	it('throws when a manifest account has no matching keystore file', async () => {
		const env = localEnv();
		const manifest: Manifest = {
			packages: [],
			endpoints: [],
			accounts: [{ name: 'ghost', address: '0x123' }],
			coins: [],
			extras: {},
		};
		await expect(SignerPool.fromManifest(manifest, env)).rejects.toThrow(/ghost/);
	});

	it('skips when the manifest carries no accounts (empty pool is legal)', async () => {
		const env = localEnv();
		const manifest: Manifest = {
			packages: [],
			endpoints: [],
			accounts: [],
			coins: [],
			extras: {},
		};
		const pool = await SignerPool.fromManifest(manifest, env);
		expect(pool.size()).toBe(0);
	});
});

describe('SignerPool — acquire / release', () => {
	async function makePool(names: string[]): Promise<SignerPool> {
		const env = localEnv();
		const manifest = await seedKeystore(env, names);
		return SignerPool.fromManifest(manifest, env);
	}

	it('acquire() returns a Lease carrying the signer + name', async () => {
		const pool = await makePool(['alice']);
		const lease = await pool.acquire();
		try {
			expect(lease.name).toBe('alice');
			expect(typeof lease.signer.toSuiAddress).toBe('function');
		} finally {
			lease.release();
		}
	});

	it('release() is idempotent (no throw on double release)', async () => {
		const pool = await makePool(['alice']);
		const lease = await pool.acquire();
		lease.release();
		expect(() => lease.release()).not.toThrow();
	});

	it('serializes concurrent acquires of the same single-signer pool', async () => {
		const pool = await makePool(['alice']);
		const order: number[] = [];
		const first = pool.acquire().then(async (lease) => {
			order.push(1);
			await new Promise((r) => setTimeout(r, 50));
			lease.release();
		});
		const second = pool.acquire().then(async (lease) => {
			order.push(2);
			lease.release();
		});
		await Promise.all([first, second]);
		expect(order).toEqual([1, 2]);
	});

	it('acquire() with preferred=[name] returns that signer when available', async () => {
		const pool = await makePool(['alice', 'bob', 'carol']);
		const lease = await pool.acquire({ preferred: ['bob'] });
		try {
			expect(lease.name).toBe('bob');
		} finally {
			lease.release();
		}
	});

	it('acquire() with preferred=[name] waits when that specific signer is held', async () => {
		const pool = await makePool(['alice', 'bob']);
		const held = await pool.acquire({ preferred: ['alice'] });
		const events: string[] = [];
		const pending = pool.acquire({ preferred: ['alice'] }).then((l) => {
			events.push('acquired');
			return l;
		});
		// Give the pending acquire a moment to settle into wait state.
		await new Promise((r) => setTimeout(r, 20));
		expect(events).toEqual([]);
		held.release();
		const second = await pending;
		expect(events).toEqual(['acquired']);
		expect(second.name).toBe('alice');
		second.release();
	});

	it('acquire() rejects with timeout when no signer becomes available', async () => {
		const env = localEnv();
		const manifest = await seedKeystore(env, ['alice']);
		const pool = await SignerPool.fromManifest(manifest, env, { acquireTimeoutMs: 50 });
		const held = await pool.acquire();
		try {
			await expect(pool.acquire()).rejects.toThrow(/timeout/i);
		} finally {
			held.release();
		}
	});

	it('rotates through available signers when called without preferred', async () => {
		const pool = await makePool(['alice', 'bob', 'carol']);
		const a = await pool.acquire();
		const b = await pool.acquire();
		const c = await pool.acquire();
		const seen = new Set([a.name, b.name, c.name]);
		expect(seen).toEqual(new Set(['alice', 'bob', 'carol']));
		a.release();
		b.release();
		c.release();
	});
});

describe('SignerPool.withLease', () => {
	async function makePool(names: string[]): Promise<SignerPool> {
		const env = localEnv();
		const manifest = await seedKeystore(env, names);
		return SignerPool.fromManifest(manifest, env);
	}

	it('acquires, runs fn, releases, returns fn result', async () => {
		const pool = await makePool(['alice']);
		const result = await pool.withLease(async ({ name }) => `hello ${name}`);
		expect(result).toBe('hello alice');
		// Re-acquire to prove the lock was released.
		const next = await pool.acquire();
		next.release();
	});

	it('releases the lease even when fn throws', async () => {
		const pool = await makePool(['alice']);
		await expect(
			pool.withLease(async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow(/boom/);
		// Pool is reusable after a fn throw.
		const next = await pool.acquire();
		next.release();
	});
});

describe('SignerPool — concurrency property test', () => {
	async function makePool(names: string[]): Promise<SignerPool> {
		const env = localEnv();
		const manifest = await seedKeystore(env, names);
		return SignerPool.fromManifest(manifest, env);
	}

	it('100 random acquire/release sequences hold the no-concurrent-same-name invariant', async () => {
		const pool = await makePool(['alice', 'bob', 'carol']);
		const inFlight = new Set<string>();
		const violations: string[] = [];
		const tasks: Promise<void>[] = [];

		for (let i = 0; i < 100; i++) {
			tasks.push(
				(async () => {
					const lease = await pool.acquire();
					if (inFlight.has(lease.name)) {
						violations.push(`concurrent lease on '${lease.name}'`);
					}
					inFlight.add(lease.name);
					// Random hold time 0-3ms — exercise the contention path.
					await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
					inFlight.delete(lease.name);
					lease.release();
				})(),
			);
		}
		await Promise.all(tasks);
		expect(violations).toEqual([]);
	});
});

describe('SignerPool — leak detection', () => {
	async function makePool(names: string[]): Promise<SignerPool> {
		const env = localEnv();
		const manifest = await seedKeystore(env, names);
		return SignerPool.fromManifest(manifest, env);
	}

	it('leakedLeases() reports leases that are still held', async () => {
		const pool = await makePool(['alice', 'bob']);
		const a = await pool.acquire();
		const b = await pool.acquire();
		expect(pool.leakedLeases()).toHaveLength(2);
		a.release();
		expect(pool.leakedLeases()).toHaveLength(1);
		expect(pool.leakedLeases()[0]!.name).toBe('bob');
		b.release();
		expect(pool.leakedLeases()).toEqual([]);
	});

	it('onLeak callback fires with the acquire-site stack trace when a lease is reported leaked', async () => {
		const onLeak = vi.fn();
		const env = localEnv();
		const manifest = await seedKeystore(env, ['alice']);
		const pool = await SignerPool.fromManifest(manifest, env, { onLeak });
		await pool.acquire(); // intentionally not released
		pool.reportLeaks();
		expect(onLeak).toHaveBeenCalledTimes(1);
		const [info] = onLeak.mock.calls[0]!;
		expect(info.name).toBe('alice');
		expect(info.acquiredAt).toContain('signer-pool.test.ts'); // stack trace from acquire site
	});
});
