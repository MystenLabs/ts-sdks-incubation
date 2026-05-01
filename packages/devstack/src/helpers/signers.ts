// Signer factories for the `accounts` config. Devstack ships these helpers
// so authors don't have to reach into `@mysten/sui` plumbing for the
// common cases. Third parties can write their own factories (Ledger, KMS,
// vault) without devstack changes; the contract is just `(ctx) => Signer`
// (or a synchronously-built `Signer` value).
//
// `cliSigner` reads the same `~/.sui/sui_config/sui.keystore` +
// `sui.aliases` that the `sui` CLI writes, so a deploy can sign with
// the same identity the user already has.
//
// `envSigner` reads a key from an env var. Two encodings are accepted:
//   - bech32 with `suiprivkey1` prefix (the `sui keytool export` format).
//   - 33-byte base64: scheme-byte (0x00 = Ed25519) followed by the
//     32-byte secret. This matches the per-entry layout inside
//     `sui.keystore`, so users can paste a single keystore line directly.
//   - 32-byte base64: bare Ed25519 secret, no scheme byte.
//
// `generatedKeypair` is the implicit fallback factory for accounts on
// localnet — it loads-or-creates a per-stack Ed25519 key on disk so
// addresses stay stable across `devstack up` cycles within a stack and
// the `walletServer()` plugin signs with the same identities the
// dev-wallet's `DevstackSignerAdapter` exposes to the frontend.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Signer, decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { AccountFactory } from '../core/types.js';
import { loadOrGenerateKeypair } from './keystore.js';

export interface CliSignerOptions {
	/** Alias from `sui.aliases`. Required: there's no "active alias" file in the sui CLI. */
	alias: string;
	/** Override the keystore file path. Defaults to `~/.sui/sui_config/sui.keystore`. */
	keystorePath?: string;
	/** Override the aliases file path. Defaults to `~/.sui/sui_config/sui.aliases`. */
	aliasesPath?: string;
}

interface SuiAliasEntry {
	alias: string;
	public_key_base64: string;
}

/** Build a `Signer` from the `sui` CLI keystore + aliases file. */
export function cliSigner(opts: CliSignerOptions): Signer {
	const keystorePath = opts.keystorePath ?? defaultPath('sui.keystore');
	const aliasesPath = opts.aliasesPath ?? defaultPath('sui.aliases');

	const aliases = JSON.parse(readFileSync(aliasesPath, 'utf8')) as SuiAliasEntry[];
	const entry = aliases.find((e) => e.alias === opts.alias);
	if (entry === undefined) {
		throw new Error(`cliSigner: alias '${opts.alias}' not found in ${redactHome(aliasesPath)}`);
	}

	const keystore = JSON.parse(readFileSync(keystorePath, 'utf8')) as string[];
	for (const raw of keystore) {
		const kp = decodeKeystoreEntry(raw);
		if (kp.getPublicKey().toBase64() === entry.public_key_base64) return kp;
	}
	throw new Error(
		`cliSigner: keystore at ${redactHome(keystorePath)} has no entry matching alias '${opts.alias}'`,
	);
}

export interface EnvSignerOptions {
	/** Env var name. Value is bech32 ('suiprivkey1...') or base64 (32 or 33 bytes). */
	name: string;
}

/** Build a `Signer` from an env var. */
export function envSigner(opts: EnvSignerOptions): Signer {
	const raw = process.env[opts.name];
	if (raw === undefined || raw === '') {
		throw new Error(`envSigner: env var '${opts.name}' is not set`);
	}

	if (raw.startsWith('suiprivkey1')) {
		const decoded = decodeSuiPrivateKey(raw);
		if (decoded.scheme !== 'ED25519') {
			throw new Error(`envSigner: '${opts.name}' is ${decoded.scheme}; only Ed25519 is supported`);
		}
		return Ed25519Keypair.fromSecretKey(decoded.secretKey);
	}

	const bytes = Buffer.from(raw, 'base64');
	if (bytes.length === 33) {
		const scheme = bytes[0];
		if (scheme !== 0x00) {
			throw new Error(
				`envSigner: '${opts.name}' has scheme byte 0x${scheme?.toString(16)}; only Ed25519 (0x00) is supported`,
			);
		}
		return Ed25519Keypair.fromSecretKey(bytes.subarray(1));
	}
	if (bytes.length === 32) {
		return Ed25519Keypair.fromSecretKey(bytes);
	}
	throw new Error(
		`envSigner: '${opts.name}' is not a recognized key (got ${bytes.length} bytes; expected 32, 33, or bech32 'suiprivkey1...')`,
	);
}

/**
 * Localnet-only `AccountFactory` that loads-or-creates a per-stack
 * Ed25519 key on disk and returns it as a `Signer`. Used as the implicit
 * fallback for accounts whose spec has no entry for the active network
 * (and no `default`) — so `accounts: { alice: {} }` just works on
 * localnet. Throws on testnet/mainnet to make the localnet-only contract
 * explicit; declare an explicit factory (`cliSigner`, `envSigner`) for
 * live nets.
 */
export function generatedKeypair(): AccountFactory {
	return ({ accountName, appDir, stack, network }) => {
		if (network !== 'localnet') {
			throw new Error(
				`generatedKeypair: '${accountName}' is only valid on localnet (got '${network}'). ` +
					'Provide an explicit factory (cliSigner / envSigner) under the live-net slot.',
			);
		}
		const { keypair } = loadOrGenerateKeypair(appDir, stack, accountName);
		return keypair;
	};
}

function defaultPath(file: string): string {
	return join(homedir(), '.sui', 'sui_config', file);
}

/** Replace the user's home dir with `~` in error-message paths so CI
 * logs forwarded to error trackers don't leak `/Users/<name>/...`. */
function redactHome(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function decodeKeystoreEntry(b64: string): Ed25519Keypair {
	const bytes = Buffer.from(b64, 'base64');
	if (bytes.length !== 33) {
		throw new Error(`cliSigner: keystore entry length ${bytes.length}, expected 33`);
	}
	if (bytes[0] !== 0x00) {
		throw new Error(
			`cliSigner: keystore entry has non-Ed25519 scheme byte 0x${bytes[0]?.toString(16)}`,
		);
	}
	return Ed25519Keypair.fromSecretKey(bytes.subarray(1));
}
