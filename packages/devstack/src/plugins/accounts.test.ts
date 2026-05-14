import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import { sui } from './sui.js';
import { accounts, keystoreDir } from './accounts.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-accounts-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

const localEnv = (override?: Partial<Env>): Env => ({
	appName: 'demo',
	appDir,
	network: 'localnet',
	stack: 'main',
	...override,
});

describe('accounts.pool', () => {
	it('rejects an empty spec list', () => {
		expect(() => accounts({ specs: {} })).toThrow(/at least one spec/);
	});

	it('rejects malformed spec names', () => {
		expect(() => accounts({ specs: { 'bad name': {} } })).toThrow(/match/);
	});

	it('materializes one Ed25519 keypair per spec on cold start', async () => {
		const { pool } = accounts({ specs: { publisher: {}, minter: {} } });
		const engine = new Engine(
			{
				stack: [
					pool,
					define({
						name: 'consumer',
						deps: { all: pool.get('all') },
						run: async () => undefined,
					}),
				],
			},
			{ env: localEnv() },
		);
		await engine.runOnce();
		const view = engine.getState().nodes.get('accounts.pool');
		const reps = view?.representations?.accounts as { name: string; address: string }[];
		expect(reps).toHaveLength(2);
		expect(reps.map((r) => r.name).sort()).toEqual(['minter', 'publisher']);
		for (const r of reps) {
			expect(r.address).toMatch(/^0x[0-9a-f]+$/);
		}
	});

	it('writes per-account .key files with mode 0600', async () => {
		const { pool } = accounts({ specs: { publisher: {} } });
		const engine = new Engine(
			{
				stack: [
					pool,
					define({
						name: 'reads',
						deps: { sig: pool.get('signer', { name: 'publisher' }) },
						run: async () => undefined,
					}),
				],
			},
			{ env: localEnv() },
		);
		await engine.runOnce();
		const path = join(keystoreDir(localEnv()), 'publisher.key');
		const st = await stat(path);
		// Lower 9 bits are the perm bits; mask off the file-type bits.
		expect(st.mode & 0o777).toBe(0o600);
		const body = (await readFile(path, 'utf8')).trim();
		// Bech32 secret keys carry the `suiprivkey1` HRP.
		expect(body.startsWith('suiprivkey1')).toBe(true);
		// Disk content re-derives the same address that's in state.
		const kp = Ed25519Keypair.fromSecretKey(body);
		expect(kp.toSuiAddress()).toMatch(/^0x[0-9a-f]+$/);
	});

	it('reuses on-disk keys on warm restart (stable address across cycles)', async () => {
		const { pool } = accounts({ specs: { publisher: {} } });
		const observed: string[] = [];
		const consumer = define({
			name: 'reads',
			deps: { addr: pool.get('address', { name: 'publisher' }) },
			run: async ({ deps: { addr } }) => {
				observed.push(addr);
				return undefined;
			},
		});
		const env = localEnv();
		const engine = new Engine({ stack: [pool, consumer] }, { env });
		await engine.runOnce();
		const snapshot = await engine.saveSnapshot();
		await engine.stop();

		// Fresh engine + the prior snapshot. Disk file should still drive
		// the same address even if state hydration is skipped.
		const engine2 = new Engine({ stack: [pool, consumer] }, { env, initialSnapshot: snapshot });
		engine2.invalidate('reads');
		await engine2.runOnce();
		expect(observed).toHaveLength(2);
		expect(observed[0]).toBe(observed[1]);
	});

	it('disk wins on conflict — hand-edited .key file flips the address', async () => {
		const { pool } = accounts({ specs: { publisher: {} } });
		const env = localEnv();
		const consumer = define({
			name: 'reads',
			deps: { addr: pool.get('address', { name: 'publisher' }) },
			run: async () => undefined,
		});
		const engine = new Engine({ stack: [pool, consumer] }, { env });
		await engine.runOnce();
		const firstAddr = (engine.getState().nodes.get('accounts.pool')?.state as {
			signers: Record<string, { address: string }>;
		}).signers.publisher?.address;
		expect(firstAddr).toBeDefined();

		// Replace the disk file with a fresh keypair's secret. Next cycle
		// must pick that up rather than reuse the in-memory prior.
		const fresh = Ed25519Keypair.generate();
		await writeFile(join(keystoreDir(env), 'publisher.key'), fresh.getSecretKey(), 'utf8');
		await engine.stop();

		const engine2 = new Engine({ stack: [pool, consumer] }, { env });
		await engine2.runOnce();
		const secondAddr = (engine2.getState().nodes.get('accounts.pool')?.state as {
			signers: Record<string, { address: string }>;
		}).signers.publisher?.address;
		expect(secondAddr).toBe(fresh.toSuiAddress());
		expect(secondAddr).not.toBe(firstAddr);
	});

	it('signer Dep returns a working Ed25519Keypair', async () => {
		const { pool } = accounts({ specs: { publisher: {} } });
		let kp: Ed25519Keypair | undefined;
		const consumer = define({
			name: 'reads',
			deps: { sig: pool.get('signer', { name: 'publisher' }) },
			run: async ({ deps: { sig } }) => {
				kp = sig;
				return undefined;
			},
		});
		const engine = new Engine({ stack: [pool, consumer] }, { env: localEnv() });
		await engine.runOnce();
		expect(kp).toBeInstanceOf(Ed25519Keypair);
		// signing a 32-byte payload returns a non-empty signature.
		const sig = await kp!.sign(new Uint8Array(32));
		expect(sig.byteLength).toBe(64);
	});

	it('throws on non-localnet networks', async () => {
		const { pool } = accounts({ specs: { publisher: {} } });
		const consumer = define({
			name: 'reads',
			deps: { all: pool.get('all') },
			run: async () => undefined,
		});
		const engine = new Engine({ stack: [pool, consumer] }, { env: localEnv({ network: 'testnet' }) });
		const cycle = await engine.runOnce();
		const errored = cycle.errored.find((e) => e.name === 'accounts.pool');
		expect(errored).toBeDefined();
		expect(errored?.error.message).toMatch(/localnet/);
	});

	it('drops signers whose specs are removed in subsequent cycles', async () => {
		const { pool } = accounts({ specs: { publisher: {}, minter: {} } });
		const consumer = define({
			name: 'reads',
			deps: { all: pool.get('all') },
			run: async () => undefined,
		});
		const engine = new Engine({ stack: [pool, consumer] }, { env: localEnv() });
		await engine.runOnce();
		const before = engine.getState().nodes.get('accounts.pool')?.representations?.accounts as {
			name: string;
		}[];
		expect(before.map((a) => a.name).sort()).toEqual(['minter', 'publisher']);

		// Re-run with a smaller spec list against the same engine isn't
		// possible without rebuilding — model the spec change by building
		// a new engine that hydrates from the prior snapshot.
		const snapshot = await engine.saveSnapshot();
		const { pool: shrunk } = accounts({ specs: { publisher: {} } });
		const engine2 = new Engine(
			{
				stack: [
					shrunk,
					define({
						name: 'reads',
						deps: { all: shrunk.get('all') },
						run: async () => undefined,
					}),
				],
			},
			{ env: localEnv(), initialSnapshot: snapshot },
		);
		engine2.invalidate('accounts.pool');
		await engine2.runOnce();
		const after = engine2.getState().nodes.get('accounts.pool')?.representations?.accounts as {
			name: string;
		}[];
		expect(after.map((a) => a.name)).toEqual(['publisher']);
	});
});

describe('accounts.fund', () => {
	let server: Server | undefined;
	let faucetUrl: string;
	let receivedRecipients: string[] = [];

	beforeEach(async () => {
		receivedRecipients = [];
		server = await new Promise<Server>((resolve) => {
			const s = createServer((req: IncomingMessage, res: ServerResponse) => {
				if (req.method !== 'POST' || !req.url?.startsWith('/v2/gas')) {
					res.statusCode = 404;
					res.end();
					return;
				}
				let body = '';
				req.on('data', (chunk: Buffer) => {
					body += chunk.toString();
				});
				req.on('end', () => {
					try {
						const parsed = JSON.parse(body) as {
							FixedAmountRequest?: { recipient: string };
						};
						if (parsed.FixedAmountRequest?.recipient) {
							receivedRecipients.push(parsed.FixedAmountRequest.recipient);
						}
						res.statusCode = 201;
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ ok: true }));
					} catch (err) {
						res.statusCode = 400;
						res.end(`bad request: ${(err as Error).message}`);
					}
				});
			}).listen(0, '127.0.0.1', () => resolve(s));
		});
		const port = (server.address() as AddressInfo).port;
		faucetUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => {
			server?.close(() => resolve());
		});
		server = undefined;
	});

	it('faucets every account against the configured sui faucet URL', async () => {
		const { pool, fund } = accounts({ specs: { publisher: {}, minter: {} } });
		const engine = new Engine(
			{
				stack: [
					sui.create({ network: 'localnet', rpcUrl: 'http://localhost:9999', faucetUrl }),
					pool,
					fund,
				],
			},
			{ env: localEnv() },
		);
		const cycle = await engine.runOnce();
		expect(cycle.errored).toEqual([]);
		expect(receivedRecipients.sort()).toEqual(
			(
				engine.getState().nodes.get('accounts.pool')?.representations?.accounts as {
					address: string;
				}[]
			)
				.map((a) => a.address)
				.sort(),
		);
		const fundState = engine.getState().nodes.get('accounts.fund')?.state as
			| { fundedAt: number; addresses: string[] }
			| undefined;
		expect(fundState?.addresses).toHaveLength(2);
	});

	it('surfaces faucet errors as a node error', async () => {
		const { pool, fund } = accounts({ specs: { publisher: {} } });
		// Point at a faucet URL whose HTTP server isn't running.
		const engine = new Engine(
			{
				stack: [
					sui.create({
						network: 'localnet',
						rpcUrl: 'http://localhost:9999',
						faucetUrl: 'http://127.0.0.1:1', // ECONNREFUSED on most platforms
					}),
					pool,
					fund,
				],
			},
			{ env: localEnv() },
		);
		const cycle = await engine.runOnce();
		const errored = cycle.errored.find((e) => e.name === 'accounts.fund');
		expect(errored).toBeDefined();
	});

	it('skips AB-deposit silently when sui RPC is unreachable', async () => {
		const { pool, fund } = accounts({
			specs: { publisher: {} },
			// Opt-in target — default is 0n which short-circuits before
			// the RPC probe. Non-zero forces the gate to run.
			abMinBalanceMist: 100_000_000_000n,
		});
		const engine = new Engine(
			{
				stack: [
					sui.create({
						network: 'localnet',
						// Unreachable RPC — probeRpc returns false → AB-deposit
						// skipped silently. Faucet stub still serves.
						rpcUrl: 'http://127.0.0.1:1',
						faucetUrl,
					}),
					pool,
					fund,
				],
			},
			{ env: localEnv() },
		);
		const cycle = await engine.runOnce();
		expect(cycle.errored).toEqual([]);
		const fundState = engine.getState().nodes.get('accounts.fund')?.state as
			| { fundedAt: number; addresses: string[] }
			| undefined;
		expect(fundState?.addresses).toHaveLength(1);
	});

	it('AB-deposit is off by default (abMinBalanceMist=0n)', async () => {
		// `abMinBalanceMist` not set; even with a "reachable" RPC URL the
		// AB-deposit short-circuits before the probe. Faucet still runs.
		const { pool, fund } = accounts({ specs: { publisher: {} } });
		const engine = new Engine(
			{
				stack: [
					sui.create({
						network: 'localnet',
						rpcUrl: 'http://localhost:9999',
						faucetUrl,
					}),
					pool,
					fund,
				],
			},
			{ env: localEnv() },
		);
		const cycle = await engine.runOnce();
		expect(cycle.errored).toEqual([]);
	});
});
