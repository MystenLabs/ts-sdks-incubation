import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Signer } from '@mysten/sui/cryptography';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Engine } from '../../engine/class.js';
import type { Env } from '../../engine/types.js';
import { dep } from '../../factories/dep.js';
import { define } from '../../factories/define.js';
import { manifest } from '../manifest.js';
import { walletApp } from './index.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-walletapp-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

function envFor(stack = 'main'): Env {
	return { appName: 'demo', appDir, network: 'localnet', stack };
}

function makeSignerProducer(name: string, signer: Signer) {
	type S = { name: string };
	return define<S>({
		name: `signer.${name}`,
		provides: { signer: dep((): Signer => signer) },
		start: async () => ({ name }),
	});
}

describe('walletApp (engine integration)', () => {
	it('starts a listener and exposes url/token/port through state + provides', async () => {
		const alice = new Ed25519Keypair();
		const aliceProducer = makeSignerProducer('alice', alice);
		const wallet = walletApp.create({
			accounts: [{ name: 'alice', signer: aliceProducer.get('signer') }],
		});

		const engine = new Engine({ stack: [aliceProducer, wallet] }, { env: envFor() });
		try {
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const view = engine.getState().nodes.get('walletApp');
			expect(view).toBeDefined();
			const state = view!.state as { url: string; token: string; port: number };
			expect(state.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
			expect(state.token).toHaveLength(64);
			expect(state.port).toBeGreaterThan(0);

			const health = await fetch(`${state.url}/health`);
			expect(health.status).toBe(200);

			const list = await fetch(`${state.url}/api/v1/devstack/accounts`, {
				headers: { Authorization: `Bearer ${state.token}` },
			});
			expect(list.status).toBe(200);
			const body = (await list.json()) as {
				accounts: Array<{ name: string; address: string }>;
			};
			expect(body.accounts.map((a) => a.name)).toEqual(['alice']);
			expect(body.accounts[0]?.address).toBe(alice.toSuiAddress());
		} finally {
			await engine.stop();
		}
	});

	it('persists the bearer token across cold restarts (same stackDir)', async () => {
		const alice = new Ed25519Keypair();

		const buildStack = () => {
			const aliceProducer = makeSignerProducer('alice', alice);
			return [
				aliceProducer,
				walletApp.create({
					accounts: [{ name: 'alice', signer: aliceProducer.get('signer') }],
				}),
			];
		};

		const first = new Engine({ stack: buildStack() }, { env: envFor() });
		let token1: string;
		try {
			await first.runOnce();
			token1 = (first.getState().nodes.get('walletApp')!.state as { token: string }).token;
		} finally {
			await first.stop();
		}

		const written = await readFile(join(appDir, '.devstack/stacks/main/wallet-token'), 'utf8');
		expect(written.trim()).toBe(token1);

		const second = new Engine({ stack: buildStack() }, { env: envFor() });
		try {
			await second.runOnce();
			const token2 = (second.getState().nodes.get('walletApp')!.state as { token: string }).token;
			expect(token2).toBe(token1);
		} finally {
			await second.stop();
		}
	});

	it('folds devServerOrigin into the CORS allowlist + manifest endpoint Dep', async () => {
		const alice = new Ed25519Keypair();
		const aliceProducer = makeSignerProducer('alice', alice);

		// Standalone producer publishing a dev-server origin so walletApp
		// can Dep on it the same way it would on viteDevServer.get('origin').
		const devServer = define<{ origin: string }>({
			name: 'fake-dev-server',
			provides: { origin: dep((s) => s.origin) },
			start: async () => ({ origin: 'http://localhost:5173' }),
		});

		const wallet = walletApp.create({
			accounts: [{ name: 'alice', signer: aliceProducer.get('signer') }],
			devServerOrigin: devServer.get('origin'),
		});
		const m = manifest({ endpoints: [wallet.get('endpoint')] });

		const engine = new Engine(
			{ stack: [aliceProducer, devServer, wallet, m] },
			{ env: envFor() },
		);
		try {
			await engine.runOnce();
			const state = engine.getState().nodes.get('walletApp')!.state as { url: string };

			// CORS preflight from the dev-server origin should succeed.
			const preflight = await fetch(`${state.url}/api/v1/devstack/accounts`, {
				method: 'OPTIONS',
				headers: { Origin: 'http://localhost:5173' },
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

			// And the manifest projection should carry the wallet-app endpoint.
			const body = await readFile(join(appDir, 'src/generated/manifest.ts'), 'utf8');
			expect(body).toContain('"name": "wallet-app"');
			expect(body).toContain(state.url);
		} finally {
			await engine.stop();
		}
	});

	it('throws on empty accounts list', () => {
		expect(() => walletApp.create({ accounts: [] })).toThrow(/at least one account/);
	});
});
