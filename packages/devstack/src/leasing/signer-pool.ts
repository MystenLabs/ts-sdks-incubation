import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Env } from '../engine/types.js';
import type { Manifest } from '../shapes/index.js';

// Per-process signer pool. Runtime-only — the lease ledger lives in
// memory and never persists. Vitest and Playwright fixtures expose a
// `signerPool` worker fixture so tests don't construct this directly,
// but the explicit `fromManifest` factory is available for callers
// outside those harnesses.
//
// Why: parallel tests that share a named signer (e.g. two specs both
// publishing through `publisher`) collide on the signer's gas coin
// versions. `pool.withLease(fn)` serializes the access — within one
// process — so tests don't have to thread synchronization primitives
// themselves. The same-signer mutex on the engine side (Phase 5,
// `exclusiveDep`) is the in-engine analog; the pool covers the
// test-runtime case where no engine is in the loop.

export interface Lease {
	name: string;
	signer: Signer;
	release(): void;
}

export interface LeakInfo {
	name: string;
	acquiredAt: string;
}

export interface SignerPoolOptions {
	/** How long an `acquire()` will wait for a free signer before
	 * rejecting with a timeout error. Default 30s. */
	acquireTimeoutMs?: number;
	/** Called for every still-held lease when `reportLeaks()` fires
	 * (typically at fixture teardown). Defaults to a console.error
	 * carrying the acquire-site stack trace. */
	onLeak?: (info: LeakInfo) => void;
}

interface PendingAcquire {
	preferred: string[] | undefined;
	resolve: (lease: Lease) => void;
	reject: (err: Error) => void;
	timeoutHandle: ReturnType<typeof setTimeout>;
}

interface LeaseRecord {
	released: boolean;
	acquiredAt: string;
}

export class SignerPool {
	private readonly signers: Map<string, Signer>;
	private readonly inFlight: Map<string, LeaseRecord>;
	private readonly waiters: PendingAcquire[];
	private readonly acquireTimeoutMs: number;
	private readonly onLeak: (info: LeakInfo) => void;

	private constructor(signers: Map<string, Signer>, opts: SignerPoolOptions) {
		this.signers = signers;
		this.inFlight = new Map();
		this.waiters = [];
		this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 30_000;
		this.onLeak =
			opts.onLeak ??
			((info) =>
				console.error(
					`[devstack/leasing] leaked lease on signer '${info.name}'\n  acquired at: ${info.acquiredAt}`,
				));
	}

	/**
	 * Materialize one `Signer` per account in the manifest, looking up
	 * the secret key from the disk-backed keystore the `accounts`
	 * plugin writes to `<appDir>/.devstack/stacks/<stack>/.keys/`.
	 *
	 * Throws if any manifest account has no corresponding keystore
	 * file — manifest and keystore must be in sync. This means the
	 * caller must run `setup()` first so the engine populates both.
	 */
	static async fromManifest(
		manifest: Manifest,
		env: Env,
		opts: SignerPoolOptions = {},
	): Promise<SignerPool> {
		const keystoreDir = join(env.appDir, '.devstack', 'stacks', env.stack ?? 'main', '.keys');
		const signers = new Map<string, Signer>();
		for (const account of manifest.accounts) {
			const keyPath = join(keystoreDir, `${account.name}.key`);
			let secret: string;
			try {
				secret = (await readFile(keyPath, 'utf8')).trim();
			} catch (err) {
				if ((err as { code?: string }).code === 'ENOENT') {
					throw new Error(
						`SignerPool.fromManifest: no keystore file for account '${account.name}' ` +
							`at ${keyPath}. Has the accounts plugin run? (manifest carries the account, ` +
							`keystore doesn't — these usually drift apart after a partial wipe.)`,
					);
				}
				throw err;
			}
			signers.set(account.name, Ed25519Keypair.fromSecretKey(secret));
		}
		return new SignerPool(signers, opts);
	}

	size(): number {
		return this.signers.size;
	}

	names(): string[] {
		return [...this.signers.keys()];
	}

	/**
	 * Acquire a free signer, preferring those in `opts.preferred` if
	 * supplied. Blocks (with `acquireTimeoutMs` upper bound) when no
	 * acceptable signer is free. The returned `Lease` MUST be
	 * released — `withLease()` is the recommended path.
	 */
	async acquire(opts: { preferred?: string[] } = {}): Promise<Lease> {
		const tryAcquire = (): Lease | undefined => {
			const candidates = opts.preferred ?? this.names();
			for (const name of candidates) {
				if (!this.signers.has(name)) continue;
				if (this.inFlight.has(name)) continue;
				return this.materialize(name);
			}
			return undefined;
		};

		const immediate = tryAcquire();
		if (immediate) return immediate;

		return new Promise<Lease>((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				const i = this.waiters.findIndex((w) => w.timeoutHandle === timeoutHandle);
				if (i >= 0) this.waiters.splice(i, 1);
				const wanted = opts.preferred?.join(', ') ?? '<any>';
				reject(
					new Error(
						`SignerPool.acquire: timeout after ${this.acquireTimeoutMs}ms waiting for a free ` +
							`signer (preferred: ${wanted}; in-flight: ${[...this.inFlight.keys()].join(', ') || '<none>'})`,
					),
				);
			}, this.acquireTimeoutMs);
			this.waiters.push({
				...(opts.preferred !== undefined ? { preferred: opts.preferred } : { preferred: undefined }),
				resolve,
				reject,
				timeoutHandle,
			});
		});
	}

	/**
	 * Acquire + run + release. Use this. The escape hatch is the raw
	 * `acquire()` / `Lease.release()` pair; `withLease` is what should
	 * appear in test code.
	 */
	async withLease<T>(
		fn: (lease: Lease) => Promise<T>,
		opts?: { preferred?: string[] },
	): Promise<T> {
		const lease = await this.acquire(opts ?? {});
		try {
			return await fn(lease);
		} finally {
			lease.release();
		}
	}

	/** Snapshot of currently-held leases (diagnostics). */
	leakedLeases(): LeakInfo[] {
		return [...this.inFlight.entries()].map(([name, record]) => ({
			name,
			acquiredAt: record.acquiredAt,
		}));
	}

	/**
	 * Fire `onLeak` for every still-held lease. Fixtures should call
	 * this at teardown so accidental lease holds surface as
	 * console.error (or whatever the caller's `onLeak` does) rather
	 * than silently breaking parallel tests in a later run.
	 */
	reportLeaks(): void {
		for (const info of this.leakedLeases()) this.onLeak(info);
	}

	private materialize(name: string): Lease {
		const signer = this.signers.get(name)!;
		const acquiredAt = captureAcquireSite();
		this.inFlight.set(name, { released: false, acquiredAt });
		return {
			name,
			signer,
			release: () => this.releaseInternal(name, acquiredAt),
		};
	}

	private releaseInternal(name: string, acquiredAt: string): void {
		const record = this.inFlight.get(name);
		if (record === undefined || record.acquiredAt !== acquiredAt) {
			// Lease was already released (or replaced by a re-acquire).
			// Idempotent — silent no-op rather than throwing, so cleanup
			// paths in tests don't have to track lease state themselves.
			return;
		}
		this.inFlight.delete(name);
		this.tryFulfillWaiter();
	}

	private tryFulfillWaiter(): void {
		for (let i = 0; i < this.waiters.length; i++) {
			const waiter = this.waiters[i]!;
			const candidates = waiter.preferred ?? this.names();
			for (const name of candidates) {
				if (!this.signers.has(name)) continue;
				if (this.inFlight.has(name)) continue;
				this.waiters.splice(i, 1);
				clearTimeout(waiter.timeoutHandle);
				waiter.resolve(this.materialize(name));
				return;
			}
		}
	}
}

// Capture a stack trace at acquire time. We strip the SignerPool's
// own internals so the top frame is the user's `pool.acquire()` /
// `pool.withLease()` call — which is the actionable bit when a leak
// gets reported.
function captureAcquireSite(): string {
	const e = new Error('acquire site');
	const lines = (e.stack ?? '').split('\n');
	// Drop the "Error: acquire site" header and the frames inside this
	// module (captureAcquireSite + materialize + acquire/withLease).
	const filtered = lines
		.filter((line) => line.trim().startsWith('at '))
		.filter((line) => !line.includes('signer-pool.ts') && !line.includes('signer-pool.mjs'));
	return filtered.length > 0 ? filtered.join('\n') : (e.stack ?? '<no stack>');
}
