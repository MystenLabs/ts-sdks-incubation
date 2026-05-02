import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cliSigner, envSigner, generatedKeypair } from './signers.js';

// signers.ts is the user-facing factory layer. The architecture review flagged
// `envSigner`'s three-format branching (bech32 / 33-byte / 32-byte) as
// silent-failure prone, and `cliSigner` lacks a useful error when the alias
// isn't present. Cover all branches + the localnet `generatedKeypair` stable-
// per-stack contract.

let tmpDirs: string[] = [];

const newTmpDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// Build a deterministic Ed25519 keypair from a 32-byte seed so every
// branch of envSigner can be tested against the SAME ground-truth address.
const seedKeypair = (): Ed25519Keypair => {
	const secret = new Uint8Array(32);
	for (let i = 0; i < 32; i++) secret[i] = (i * 7 + 13) & 0xff;
	return Ed25519Keypair.fromSecretKey(secret);
};

const seed32Bytes = (): Uint8Array => {
	const secret = new Uint8Array(32);
	for (let i = 0; i < 32; i++) secret[i] = (i * 7 + 13) & 0xff;
	return secret;
};

describe('cliSigner — alias resolution against on-disk keystore', () => {
	it('returns the keypair whose pubkey matches the alias entry', () => {
		const dir = newTmpDir('devstack-cli-signer-');
		const kp = seedKeypair();
		// keystore is JSON array of base64-encoded 33-byte strings
		// (1 scheme byte + 32 secret bytes), matching the on-disk layout
		// the sui CLI writes.
		const decoded = decodeSuiPrivateKey(kp.getSecretKey());
		const entry = Buffer.concat([Buffer.from([0x00]), Buffer.from(decoded.secretKey)]).toString(
			'base64',
		);
		const keystorePath = join(dir, 'sui.keystore');
		const aliasesPath = join(dir, 'sui.aliases');
		writeFileSync(keystorePath, JSON.stringify([entry]));
		writeFileSync(
			aliasesPath,
			JSON.stringify([
				{ alias: 'publisher', public_key_base64: kp.getPublicKey().toBase64() },
			]),
		);

		const signer = cliSigner({ alias: 'publisher', keystorePath, aliasesPath });
		expect(signer.toSuiAddress()).toBe(kp.toSuiAddress());
	});

	it('throws a useful error when the alias is missing from sui.aliases', () => {
		const dir = newTmpDir('devstack-cli-signer-');
		const keystorePath = join(dir, 'sui.keystore');
		const aliasesPath = join(dir, 'sui.aliases');
		writeFileSync(keystorePath, JSON.stringify([]));
		writeFileSync(aliasesPath, JSON.stringify([{ alias: 'someone-else', public_key_base64: 'x' }]));

		expect(() => cliSigner({ alias: 'ghost', keystorePath, aliasesPath })).toThrow(
			/alias 'ghost' not found/,
		);
	});

	it('throws when the alias exists but no keystore entry matches its public key', () => {
		const dir = newTmpDir('devstack-cli-signer-');
		const kp = seedKeypair();
		const keystorePath = join(dir, 'sui.keystore');
		const aliasesPath = join(dir, 'sui.aliases');
		// Empty keystore — alias points at a public key but there's no secret
		// for it on disk.
		writeFileSync(keystorePath, JSON.stringify([]));
		writeFileSync(
			aliasesPath,
			JSON.stringify([
				{ alias: 'publisher', public_key_base64: kp.getPublicKey().toBase64() },
			]),
		);
		expect(() =>
			cliSigner({ alias: 'publisher', keystorePath, aliasesPath }),
		).toThrow(/no entry matching alias 'publisher'/);
	});
});

describe('envSigner — three input formats', () => {
	const VAR = 'DEVSTACK_TEST_ENVSIGNER_KEY';
	const expected = seedKeypair().toSuiAddress();

	afterEach(() => {
		delete process.env[VAR];
	});

	it('decodes bech32 (suiprivkey1...) input', () => {
		process.env[VAR] = seedKeypair().getSecretKey();
		const signer = envSigner({ name: VAR });
		expect(signer.toSuiAddress()).toBe(expected);
	});

	it('decodes 33-byte base64 input (scheme byte 0x00 + 32-byte secret)', () => {
		const secret = seed32Bytes();
		const buf = Buffer.concat([Buffer.from([0x00]), Buffer.from(secret)]);
		expect(buf.length).toBe(33);
		process.env[VAR] = buf.toString('base64');
		const signer = envSigner({ name: VAR });
		expect(signer.toSuiAddress()).toBe(expected);
	});

	it('decodes 32-byte base64 input (raw secret, ed25519)', () => {
		const buf = Buffer.from(seed32Bytes());
		expect(buf.length).toBe(32);
		process.env[VAR] = buf.toString('base64');
		const signer = envSigner({ name: VAR });
		expect(signer.toSuiAddress()).toBe(expected);
	});

	it('treats 33-byte input with a non-Ed25519 scheme byte as an error', () => {
		const secret = seed32Bytes();
		const buf = Buffer.concat([Buffer.from([0x01]), Buffer.from(secret)]); // 0x01 = secp256k1
		process.env[VAR] = buf.toString('base64');
		expect(() => envSigner({ name: VAR })).toThrow(/scheme byte 0x1/);
	});

	it('throws when the env var is unset', () => {
		delete process.env[VAR];
		expect(() => envSigner({ name: VAR })).toThrow(/is not set/);
	});

	it('throws when the env var is the empty string', () => {
		process.env[VAR] = '';
		expect(() => envSigner({ name: VAR })).toThrow(/is not set/);
	});

	it('throws when the value is not bech32 and not a recognized base64 length', () => {
		// 7 bytes of base64 — not 32, not 33, no `suiprivkey1` prefix.
		process.env[VAR] = Buffer.from('garbage').toString('base64');
		expect(() => envSigner({ name: VAR })).toThrow(/not a recognized key/);
	});
});

describe('generatedKeypair — stable per (appDir, stack, accountName)', () => {
	it('returns a Signer whose address matches across two factory invocations', () => {
		const appDir = newTmpDir('devstack-gen-keypair-');
		const factory = generatedKeypair();

		const first = factory({
			accountName: 'alice',
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		const second = factory({
			accountName: 'alice',
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});

		// generatedKeypair() is sync on localnet — reading from disk.
		if (first instanceof Promise || second instanceof Promise) {
			throw new Error('expected generatedKeypair to be synchronous on localnet');
		}
		expect(first.toSuiAddress()).toBe(second.toSuiAddress());
	});

	it('throws on testnet/mainnet (localnet-only contract)', () => {
		const appDir = newTmpDir('devstack-gen-keypair-');
		const factory = generatedKeypair();
		expect(() =>
			factory({
				accountName: 'alice',
				appDir,
				stack: 'main',
				network: 'testnet',
				rpcUrl: 'https://rpc.example',
			}),
		).toThrow(/only valid on localnet/);
	});

	it('produces distinct addresses across different account names in the same stack', () => {
		const appDir = newTmpDir('devstack-gen-keypair-');
		const factory = generatedKeypair();
		const alice = factory({
			accountName: 'alice',
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		const bob = factory({
			accountName: 'bob',
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		if (alice instanceof Promise || bob instanceof Promise) {
			throw new Error('expected generatedKeypair to be synchronous on localnet');
		}
		expect(alice.toSuiAddress()).not.toBe(bob.toSuiAddress());
	});

	it('produces distinct addresses across different stacks for the same account name', () => {
		const appDir = newTmpDir('devstack-gen-keypair-');
		const factory = generatedKeypair();
		const onMain = factory({
			accountName: 'alice',
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		const onScratch = factory({
			accountName: 'alice',
			appDir,
			stack: 'scratch',
			network: 'localnet',
			rpcUrl: '',
		});
		if (onMain instanceof Promise || onScratch instanceof Promise) {
			throw new Error('expected generatedKeypair to be synchronous on localnet');
		}
		expect(onMain.toSuiAddress()).not.toBe(onScratch.toSuiAddress());
	});
});
