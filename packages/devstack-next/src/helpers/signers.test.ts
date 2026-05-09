import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import type { Account } from '../shapes/index.js';
import { cliSigner, type CliSignerState } from './signers.js';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'devstack-next-cli-signer-'));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

const env: Env = {
	appName: 'demo',
	appDir: '/tmp/demo',
	network: 'testnet',
};

interface FakeKeystore {
	keystorePath: string;
	aliasesPath: string;
	keypairs: Record<string, Ed25519Keypair>;
}

// Stand up a minimal sui-CLI-shaped keystore + aliases pair in tmpDir.
// Each entry maps an alias to a pre-generated keypair we control, so
// tests can assert cliSigner returns the expected one.
async function makeFakeKeystore(aliases: string[]): Promise<FakeKeystore> {
	const keypairs: Record<string, Ed25519Keypair> = {};
	for (const alias of aliases) keypairs[alias] = Ed25519Keypair.generate();

	const keystoreEntries = Object.values(keypairs).map((kp) => kp.getSecretKey());
	const aliasesEntries = Object.entries(keypairs).map(([alias, kp]) => ({
		alias,
		public_key_base64: kp.getPublicKey().toBase64(),
	}));

	const keystorePath = join(tmpDir, 'sui.keystore');
	const aliasesPath = join(tmpDir, 'sui.aliases');
	await writeFile(keystorePath, JSON.stringify(keystoreEntries), 'utf8');
	await writeFile(aliasesPath, JSON.stringify(aliasesEntries), 'utf8');
	return { keystorePath, aliasesPath, keypairs };
}

describe('cliSigner (validation — no fs reads)', () => {
	it('rejects empty alias', () => {
		expect(() => cliSigner({ alias: '' })).toThrow(/alias/);
	});
});

describe('cliSigner (real keystore)', () => {
	it('loads the keypair matching the requested alias', async () => {
		const ks = await makeFakeKeystore(['publisher', 'minter']);
		const signer = cliSigner({
			alias: 'publisher',
			keystorePath: ks.keystorePath,
			aliasesPath: ks.aliasesPath,
		});
		const engine = new Engine({ stack: [signer] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const state = engine.getState().nodes.get('signer.publisher')!.state as CliSignerState;
		expect(state.alias).toBe('publisher');
		expect(state.address).toBe(ks.keypairs['publisher']!.toSuiAddress());
		expect(state.secretKey).toBe(ks.keypairs['publisher']!.getSecretKey());
	});

	it('signer Dep returns a working Ed25519Keypair', async () => {
		const ks = await makeFakeKeystore(['publisher']);
		const signer = cliSigner({
			alias: 'publisher',
			keystorePath: ks.keystorePath,
			aliasesPath: ks.aliasesPath,
		});
		let received: Ed25519Keypair | undefined;
		const consumer = define({
			name: 'consumer',
			deps: { sig: signer.get('signer') },
			start: async ({ deps: { sig } }) => {
				received = sig;
				return { ok: true };
			},
		});
		const engine = new Engine({ stack: [signer, consumer] }, { env });
		await engine.runOnce();
		expect(received).toBeInstanceOf(Ed25519Keypair);
		expect(received!.toSuiAddress()).toBe(ks.keypairs['publisher']!.toSuiAddress());
		// Sanity: signing a 32-byte payload returns a 64-byte signature.
		const sig = await received!.sign(new Uint8Array(32));
		expect(sig.byteLength).toBe(64);
	});

	it('errors with a clear message when alias is missing', async () => {
		const ks = await makeFakeKeystore(['publisher']);
		const signer = cliSigner({
			alias: 'minter',
			keystorePath: ks.keystorePath,
			aliasesPath: ks.aliasesPath,
		});
		const engine = new Engine({ stack: [signer] }, { env });
		const result = await engine.runOnce();
		const errored = result.errored.find((e) => e.name === 'signer.minter');
		expect(errored).toBeDefined();
		expect(errored?.error.message).toMatch(/alias 'minter' not found/);
	});

	it('errors when the keystore has no entry for the alias public key', async () => {
		const ks = await makeFakeKeystore(['publisher']);
		// Truncate keystore to be empty while leaving aliases intact.
		await writeFile(ks.keystorePath, '[]', 'utf8');
		const signer = cliSigner({
			alias: 'publisher',
			keystorePath: ks.keystorePath,
			aliasesPath: ks.aliasesPath,
		});
		const engine = new Engine({ stack: [signer] }, { env });
		const result = await engine.runOnce();
		const errored = result.errored.find((e) => e.name === 'signer.publisher');
		expect(errored).toBeDefined();
		expect(errored?.error.message).toMatch(/no entry matching alias/);
	});

	it('errors when the keystore file is missing', async () => {
		const signer = cliSigner({
			alias: 'publisher',
			keystorePath: join(tmpDir, 'does-not-exist.keystore'),
			aliasesPath: join(tmpDir, 'does-not-exist.aliases'),
		});
		const engine = new Engine({ stack: [signer] }, { env });
		const result = await engine.runOnce();
		const errored = result.errored.find((e) => e.name === 'signer.publisher');
		expect(errored).toBeDefined();
		expect(errored?.error.message).toMatch(/aliases file not found/);
	});

	it('represents.accounts surfaces the address for the manifest plugin', async () => {
		const ks = await makeFakeKeystore(['publisher']);
		const signer = cliSigner({
			alias: 'publisher',
			keystorePath: ks.keystorePath,
			aliasesPath: ks.aliasesPath,
		});
		const engine = new Engine({ stack: [signer] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('signer.publisher')!;
		const accounts = view.representations?.accounts as Account[];
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.name).toBe('publisher');
		expect(accounts[0]?.address).toBe(ks.keypairs['publisher']!.toSuiAddress());
	});
});
