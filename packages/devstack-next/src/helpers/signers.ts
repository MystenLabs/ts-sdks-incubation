import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Account } from '../shapes/index.js';

export interface CliSignerOptions {
	/** Alias from `sui.aliases`. The Sui CLI doesn't have an "active
	 * alias" concept; you have to name the account explicitly. */
	alias: string;
	/** Logical node name. Default `'signer.<alias>'`. */
	name?: string;
	/** Override the keystore file path. Default
	 * `~/.sui/sui_config/sui.keystore`. */
	keystorePath?: string;
	/** Override the aliases file path. Default
	 * `~/.sui/sui_config/sui.aliases`. */
	aliasesPath?: string;
}

export interface CliSignerState {
	alias: string;
	address: string;
	/** Bech32-encoded `suiprivkey1…` secret. Persisted in state so the
	 * signer Dep can re-hydrate the Ed25519Keypair without re-reading
	 * the keystore on every consumer call. */
	secretKey: string;
	keystorePath: string;
	aliasesPath: string;
}

const provides = {
	signer: dep((s: CliSignerState) => Ed25519Keypair.fromSecretKey(s.secretKey)),
	address: dep((s: CliSignerState) => s.address),
	full: dep((s: CliSignerState) => s),
} satisfies Provides<CliSignerState>;

interface SuiAliasEntry {
	alias: string;
	public_key_base64: string;
}

// `cliSigner({ alias })` — read an Ed25519 keypair from the local Sui
// CLI's keystore (`~/.sui/sui_config/{sui.keystore,sui.aliases}` by
// default). Returns a Producer that exposes the keypair via
// `signer.get('signer')` so it composes the same way as
// `accounts.get('signer', { name })` does on localnet:
//
//   const publisher = cliSigner({ alias: 'publisher' });
//   const tx = runTransaction({
//     signer: publisher.get('signer'),
//     ...
//   });
//
// The signer materializes once (in `start`) and is persisted into the
// snapshot. Warm-restarts re-hydrate from state without re-reading the
// keystore — important for live-net workflows where the keystore may
// be locked behind a hardware key.
//
// Devstack-next deliberately ships only this and (in future) `envSigner`
// — Ledger / KMS / cloud-HSM factories pull heavy optional deps that
// don't belong in the core package. Third parties can write their own
// using the same Producer shape.
export function cliSigner(opts: CliSignerOptions) {
	if (!opts.alias) throw new Error('cliSigner: `alias` is required');
	const name = opts.name ?? `signer.${opts.alias}`;
	const keystorePath = opts.keystorePath ?? defaultPath('sui.keystore');
	const aliasesPath = opts.aliasesPath ?? defaultPath('sui.aliases');

	return define<CliSignerState, typeof provides>({
		name,
		provides,
		inputs: () => ({ alias: opts.alias, keystorePath, aliasesPath }),
		start: async (): Promise<CliSignerState> => {
			const aliases = readAliases(aliasesPath);
			const entry = aliases.find((e) => e.alias === opts.alias);
			if (entry === undefined) {
				throw new Error(
					`cliSigner: alias '${opts.alias}' not found in ${redactHome(aliasesPath)}`,
				);
			}
			const keypair = findKeypairByPublicKey(keystorePath, entry.public_key_base64);
			if (keypair === undefined) {
				throw new Error(
					`cliSigner: keystore at ${redactHome(keystorePath)} has no entry matching alias '${opts.alias}'`,
				);
			}
			return {
				alias: opts.alias,
				address: keypair.toSuiAddress(),
				secretKey: keypair.getSecretKey(),
				keystorePath,
				aliasesPath,
			};
		},
		represents: {
			accounts: (s: CliSignerState): Account[] => [{ name: s.alias, address: s.address }],
		},
	});
}

function readAliases(path: string): SuiAliasEntry[] {
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') {
			throw new Error(`cliSigner: aliases file not found at ${redactHome(path)}`);
		}
		throw err;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error(`cliSigner: aliases file at ${redactHome(path)} is not an array`);
	}
	return parsed as SuiAliasEntry[];
}

function findKeypairByPublicKey(
	keystorePath: string,
	publicKeyBase64: string,
): Ed25519Keypair | undefined {
	let raw: string;
	try {
		raw = readFileSync(keystorePath, 'utf8');
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') {
			throw new Error(`cliSigner: keystore not found at ${redactHome(keystorePath)}`);
		}
		throw err;
	}
	const entries: unknown = JSON.parse(raw);
	if (!Array.isArray(entries)) {
		throw new Error(`cliSigner: keystore at ${redactHome(keystorePath)} is not an array`);
	}
	for (const entry of entries) {
		if (typeof entry !== 'string') continue;
		const kp = decodeKeystoreEntry(entry);
		if (kp === undefined) continue;
		if (kp.getPublicKey().toBase64() === publicKeyBase64) return kp;
	}
	return undefined;
}

// Sui keystore entries are either bech32 (`suiprivkey1…`) for newer
// configs or base64 of `<scheme><32-byte-secret>` (33 bytes) for
// legacy ones. Legacy bare-base64 32-byte entries are also accepted
// for compatibility with hand-edited keystores. Returns undefined for
// non-Ed25519 schemes — the caller treats that as "not a match" and
// keeps scanning.
function decodeKeystoreEntry(entry: string): Ed25519Keypair | undefined {
	if (entry.startsWith('suiprivkey1')) {
		const decoded = decodeSuiPrivateKey(entry);
		if (decoded.scheme !== 'ED25519') return undefined;
		return Ed25519Keypair.fromSecretKey(decoded.secretKey);
	}
	const bytes = Buffer.from(entry, 'base64');
	if (bytes.length === 33) {
		if (bytes[0] !== 0x00) return undefined; // non-Ed25519 scheme byte
		return Ed25519Keypair.fromSecretKey(bytes.subarray(1));
	}
	if (bytes.length === 32) {
		return Ed25519Keypair.fromSecretKey(bytes);
	}
	return undefined;
}

export interface EnvSignerOptions {
	/** Env var name. Value is bech32 (`'suiprivkey1...'`), or base64 of
	 * `<scheme><32-byte-secret>` (33 bytes), or raw 32-byte base64. */
	var: string;
	/** Logical node name. Default `'signer.<lower-cased var>'`. */
	name?: string;
}

export interface EnvSignerState {
	envVar: string;
	address: string;
	secretKey: string;
}

const envProvides = {
	signer: dep((s: EnvSignerState) => Ed25519Keypair.fromSecretKey(s.secretKey)),
	address: dep((s: EnvSignerState) => s.address),
	full: dep((s: EnvSignerState) => s),
} satisfies Provides<EnvSignerState>;

// `envSigner({ var: 'PUBLISHER_KEY' })` — read an Ed25519 keypair
// from an env var. Accepts the three shapes the Sui ecosystem uses:
//
//   - bech32  `'suiprivkey1...'`
//   - base64 of `<scheme-byte><32-byte-secret>` (33 bytes; scheme 0x00 = Ed25519)
//   - bare base64 of the 32-byte secret (legacy / hand-edited)
//
// CI / cloud-deploy patterns: store the secret in a secret manager,
// inject as env var, point `envSigner({ var })` at it. Safer than
// pinning a path on a build agent.
//
// Same surface as `cliSigner` (signer / address / full). Pick whichever
// source matches your deploy workflow.
export function envSigner(opts: EnvSignerOptions) {
	if (!opts.var) throw new Error('envSigner: `var` is required');
	const name = opts.name ?? `signer.${opts.var.toLowerCase()}`;

	return define<EnvSignerState, typeof envProvides>({
		name,
		provides: envProvides,
		// Read the env var inside `inputs` so a value change between
		// processes flips the input hash and forces a re-run on next
		// cycle. Same env var → same value → identity stable.
		inputs: () => ({ var: opts.var, value: process.env[opts.var] ?? '' }),
		start: async (): Promise<EnvSignerState> => {
			const raw = process.env[opts.var];
			if (raw === undefined || raw === '') {
				throw new Error(`envSigner: env var '${opts.var}' is not set`);
			}
			const keypair = decodeKeypairLoose(raw, opts.var);
			return {
				envVar: opts.var,
				address: keypair.toSuiAddress(),
				secretKey: keypair.getSecretKey(),
			};
		},
		represents: {
			accounts: (s: EnvSignerState): Account[] => [
				{ name: s.envVar.toLowerCase(), address: s.address },
			],
		},
	});
}

function decodeKeypairLoose(raw: string, varName: string): Ed25519Keypair {
	if (raw.startsWith('suiprivkey1')) {
		const decoded = decodeSuiPrivateKey(raw);
		if (decoded.scheme !== 'ED25519') {
			throw new Error(
				`envSigner: '${varName}' is ${decoded.scheme}; only Ed25519 is supported`,
			);
		}
		return Ed25519Keypair.fromSecretKey(decoded.secretKey);
	}
	const bytes = Buffer.from(raw, 'base64');
	if (bytes.length === 33) {
		const scheme = bytes[0];
		if (scheme !== 0x00) {
			throw new Error(
				`envSigner: '${varName}' has scheme byte 0x${scheme?.toString(16)}; ` +
					`only Ed25519 (0x00) is supported`,
			);
		}
		return Ed25519Keypair.fromSecretKey(bytes.subarray(1));
	}
	if (bytes.length === 32) {
		return Ed25519Keypair.fromSecretKey(bytes);
	}
	throw new Error(
		`envSigner: '${varName}' is not a recognized key (got ${bytes.length} bytes; ` +
			`expected 32, 33, or bech32 'suiprivkey1...')`,
	);
}

function defaultPath(filename: string): string {
	return join(homedir(), '.sui/sui_config', filename);
}

function redactHome(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? path.replace(home, '~') : path;
}
