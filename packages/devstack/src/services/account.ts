// Account(name, opts?) — single-named account factory.
//
// Returns a typed Ref usable directly as a signer in `Package` / `Action`
// / `Wallet`. The Ref is simultaneously an Effect Layer (composed into
// the stack by `devstack(...)`) and an Effect tag (`yield* alice` returns
// the resolved `AccountShape`).
//
// A spec's `from:` discriminator selects how the keypair is acquired:
//
//   - 'ephemeral-funded' (default) — generate a fresh Ed25519 keypair,
//     persist it under `.devstack/stacks/<stack>/.keys/<name>.key` so
//     warm starts reuse the same address, and request faucet funding.
//     The faucet endpoint is read off the `Sui` tag's `faucet.host`;
//     pointing at a network with no faucet (mainnet, suiCustom without
//     a faucet) is a configuration error and fails at acquire-time.
//   - 'keystore' — read a `suiprivkey1...` entry from the standard Sui
//     CLI keystore (`~/.sui/sui_config/sui.keystore` by default). The
//     `alias` selects which entry: prefer the alias name from the
//     sibling `sui.aliases` file when present, else fall back to
//     matching by Sui address.
//   - 'env' — read a `suiprivkey1...` from `process.env[key]`. Intended
//     for CI / prod where the secret comes from the environment.
//   - 'inline' — accept a literal `suiprivkey1...` string. Useful for
//     tests where the test author wants a known address.
//
// The bare `{}` form is treated as `{from: 'ephemeral-funded'}` so
// callers without a discriminator keep working without code edits.
//
// Only `ephemeral-funded` writes to disk and only `ephemeral-funded`
// funds; the other three assume the caller has already funded the
// account out-of-band or doesn't need a balance.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, FileSystem, Schema } from 'effect';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import {
	decodeSuiPrivateKey,
	encodeSuiPrivateKey,
	type SignatureScheme,
} from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import type { Keypair } from '@mysten/sui/cryptography';
import { tag, setPhase, type Ref } from '../advanced/tag.js';
import { SuiTag } from './sui.js';
import { AccountError } from '../primitives/errors.js';
import { AccountRegistry } from '../engine/registries.js';
import { Leasing } from '../engine/leasing.js';
import { requestFunds } from '../engine/faucet.js';
import { StateStoreConfig } from '../engine/state-store.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import type {
	Account as AccountValue,
	SignAndExecuteError,
	TxResult,
} from '../primitives/shared.js';
import type { AccountRef } from './ref.js';

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

/** Per-account-instance shape. Every per-name account Ref produced by
 *  `Account(name, opts?)` yields a value satisfying this contract.
 *
 *  - `scheme` is lowercased to match the on-chain Move type conventions
 *    and the lowercase form `@mysten/sui` exposes via
 *    `decodeSuiPrivateKey(...).schema.toLowerCase()`.
 *  - `signAndExecute` returns the raw `SuiTransactionBlockResponse`;
 *    consumers that need a wrapper can project it themselves.
 *  - `signTransaction` returns the base64-encoded signature string.
 *  - `signPersonalMessage` retains the `{ signature, bytes }` shape
 *    because the dapp-kit personal-message flow needs both halves.
 */
export interface AccountShape {
	readonly name: string;
	readonly address: string;
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	readonly publicKey: Uint8Array;
	readonly signAndExecute: (
		tx: Transaction,
	) => Effect.Effect<SuiTransactionBlockResponse, AccountError>;
	readonly signTransaction: (tx: Transaction) => Effect.Effect<string, AccountError>;
	readonly signPersonalMessage: (
		message: Uint8Array,
	) => Effect.Effect<{ readonly signature: string; readonly bytes: string }, AccountError>;
}

/** Reference type for downstream consumers that take an account tag as
 *  configuration. Consumers (`Package({signer})`, `Seal({signer})`, …)
 *  accept any value matching this shape. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AccountTag = Ref<any, AccountShape, any, AccountError>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Runtime-validation mirror of `AccountShape`. Use
 *  `Schema.decode(AccountShapeSchema)` to validate a hand-rolled
 *  per-name account tag value, or in tests where you want to assert the
 *  shape on yield. Signing functions are closures (not Schema-validatable)
 *  so they're typed as `Unknown` here. */
export const AccountShapeSchema = Schema.Struct({
	name: Schema.String,
	address: Schema.String,
	scheme: Schema.Literals(['ed25519', 'secp256k1', 'secp256r1']),
	publicKey: Schema.Unknown,
	signAndExecute: Schema.Unknown,
	signTransaction: Schema.Unknown,
	signPersonalMessage: Schema.Unknown,
});

// -----------------------------------------------------------------------------
// Spec
// -----------------------------------------------------------------------------

/**
 * Per-account source discriminator. Selects how the keypair backing
 * the per-name account tag is acquired. See module header for the
 * full lifecycle of each source.
 */
export type AccountSource =
	| {
			readonly from: 'ephemeral-funded';
			/** Reserved for a future faucet-amount knob. Today's localnet
			 *  faucet ignores it — funding is a fixed amount per request —
			 *  but accepting the field now keeps the spec stable across
			 *  the eventual server-side change. */
			readonly initialBalanceSui?: number;
			/** Wall-clock budget for the faucet funding request, including
			 *  all retries. Defaults to 90_000 (90s) — sized for a cold
			 *  sui-localnet boot. CI configs pointed at a clearly-broken
			 *  faucet can lower this so failure surfaces in seconds
			 *  instead of minutes-per-account. */
			readonly faucetTimeoutMs?: number;
			/** Maximum number of faucet retry attempts before giving up
			 *  (the initial attempt plus `faucetMaxAttempts` retries).
			 *  Defaults to 40 — paired with the default 90s budget, the
			 *  schedule saturates well before the wall-clock timeout
			 *  fires. */
			readonly faucetMaxAttempts?: number;
	  }
	| {
			readonly from: 'keystore';
			/** Alias name (from `sui.aliases`) or the on-chain address. The
			 *  factory tries the alias file first, then falls back to a
			 *  by-address match. */
			readonly alias: string;
			/** Override the default `~/.sui/sui_config/sui.keystore` path. */
			readonly path?: string;
	  }
	| {
			/**
			 * Load a `suiprivkey1...` string from `process.env[key]`.
			 *
			 * The env-var name is taken verbatim; the dev controls it. Prefer narrow
			 * names (`ALICE_PRIVATE_KEY`, not `APP_SECRET`) so the variable's purpose
			 * is unambiguous. The value never appears in logs, spans, or error
			 * messages — only the variable's name is referenced.
			 */
			readonly from: 'env';
			/** `process.env` variable holding a `suiprivkey1...` bech32 string. */
			readonly key: string;
			/** Reserved for a future raw-hex form. Today the value is always
			 *  bech32 so the scheme is read off the encoded prefix and this
			 *  field is unused. */
			readonly scheme?: 'ed25519' | 'secp256k1' | 'secp256r1';
	  }
	| {
			/**
			 * Use a literal `suiprivkey1...` string embedded in the config.
			 *
			 * **SECURITY: tests and demos only.** The key is serialized as part of
			 * your devstack config — if that file is committed to git, the key is now
			 * in your history. For production code, use `'env'` (load from an env var)
			 * or `'keystore'` (load from `~/.sui/sui_config/sui.keystore`).
			 */
			readonly from: 'inline';
			/** Bech32 `suiprivkey1...` literal. */
			readonly privateKey: string;
	  };

/**
 * Per-account spec accepted by `Account(name, opts?)`. Discriminated by
 * `from:` (see {@link AccountSource}). The bare `{}` form is accepted
 * and treated as `{from: 'ephemeral-funded'}`.
 */
export type AccountSpec = AccountSource | Record<string, never>;

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** Factory for a single named account. The returned Ref is both an
 *  Effect Layer (composed into the merged stack by `devstack(...)`) and
 *  an Effect tag (`yield* alice` returns the resolved `AccountShape`).
 *
 *  Default source: `'ephemeral-funded'` — generate a fresh keypair,
 *  persist it under `.devstack/stacks/<stack>/.keys/<name>.key`, and
 *  request faucet funding. Pass `{ from: 'env', key: '...' }` or
 *  `{ from: 'keystore', alias: '...' }` for non-localnet stacks. */
export const Account = <const N extends string>(
	name: N,
	opts?: AccountSpec,
): AccountRef<`account/${N}`> => {
	// Backwards-compat: the bare `{}` form (without a `from:` key)
	// means "ephemeral-funded with defaults". Branch here so the rest of
	// the body can treat `source` as a fully-discriminated `AccountSource`.
	const source: AccountSource =
		opts !== undefined && 'from' in opts ? (opts as AccountSource) : { from: 'ephemeral-funded' };

	const accountTag = tag(
		`account/${name}` as const,
		Effect.fn(`account(${name})`)(function* () {
			yield* Effect.annotateCurrentSpan({
				'account.name': name,
				'account.source': source.from,
			});
			const sui = yield* SuiTag;
			const leasing = yield* Leasing;

			if (source.from === 'keystore' || source.from === 'env' || source.from === 'inline') {
				yield* setPhase('loading keystore');
			}
			const keypair = yield* acquireKeypair(name, source);
			const address = keypair.getPublicKey().toSuiAddress();
			const scheme = keypair.getKeyScheme() as AccountValue['scheme'];

			yield* Effect.annotateCurrentSpan({ 'account.address': address });

			if (source.from === 'ephemeral-funded') {
				if (sui.faucet === undefined) {
					return yield* Effect.fail(
						new AccountError({
							phase: 'fund',
							message:
								`Account: '${name}' is ephemeral-funded but the configured Sui has no ` +
								`faucet. Use {from: 'keystore'|'env'|'inline'} for accounts on this ` +
								`network, or pick the default localnet which exposes a faucet.`,
						}),
					);
				}
				// Host-side faucet — runs in the supervisor process, not inside a container.
				const faucetUrl = sui.faucet.host;
				// Before the first faucet POST, ask the Sui primitive to
				// confirm the chain is actually funds-transferable. The
				// supervisor's Sui-ready gate is socket-level only — the
				// faucet HTTP server is bound but the underlying validator
				// may still be mid-genesis, in which case `/v2/gas` returns
				// 200 OK with body `{status: {Failure: ...}}`. The retry
				// budget in `requestFunds` already absorbs this race for a
				// single account, but each parallel account would otherwise
				// spend its own retry budget rediscovering the same fact;
				// centralizing the wait at `sui` (the primitive memoizes via
				// `Effect.cached`) lets every ephemeral-funded account
				// share one cached resolution.
				yield* setPhase('awaiting chain funds-transferable');
				yield* sui.waitForTransactionsReady().pipe(
					Effect.catchTag('SuiError', (cause) =>
						Effect.fail(
							new AccountError({
								phase: 'fund',
								message: `Account: '${name}' aborted before funding — chain never became funds-transferable: ${cause.message}`,
								cause,
							}),
						),
					),
				);
				yield* setPhase('requesting funds');
				yield* requestFunds({
					faucetUrl,
					address,
					// Surface retry progress so a slow cold-start (sui-faucet
					// binary still warming up, returning 503 or body-level
					// `Failure` for the first ~30s after genesis) doesn't
					// look like a hang in the TUI. `setPhase` mutates the
					// row's status text — the dashboard re-renders within
					// one tick.
					onAttempt: (attempt, err) =>
						setPhase(
							`requesting funds (attempt ${attempt}, last: ${err.message.replace(/\n.*$/s, '')})`,
						),
					// Pass through the per-account retry-budget overrides
					// when present. `requestFunds` falls back to its own
					// defaults (90s / 40 attempts) when these are undefined,
					// so the unset path matches today's behavior exactly.
					...(source.faucetTimeoutMs !== undefined ? { timeoutMs: source.faucetTimeoutMs } : {}),
					...(source.faucetMaxAttempts !== undefined
						? { maxAttempts: source.faucetMaxAttempts }
						: {}),
				}).pipe(
					Effect.catchTag('FaucetError', (cause) =>
						Effect.fail(
							new AccountError({
								phase: 'fund',
								message: `Account: failed to fund '${name}' via ${faucetUrl}`,
								cause,
							}),
						),
					),
				);
			}

			yield* AccountRegistry.publish({ name, address });

			// Serialize tx submission per-address. Two parallel sign+execute
			// calls from the same signer race the gas-coin object's version
			// and one fails with LockedSharedObject. `withExclusive` holds
			// the permit for the lifetime of the work effect and releases
			// it automatically on success, failure, or interrupt.
			const signAndExecute = (transaction: Parameters<AccountValue['signAndExecute']>[0]) =>
				leasing.withExclusive(
					address,
					Effect.tryPromise({
						try: () =>
							sui.client.signAndExecuteTransaction({
								signer: keypair,
								transaction,
								options: {
									showEffects: true,
									showObjectChanges: true,
									showBalanceChanges: true,
								},
							}),
						catch: (cause): SignAndExecuteError => ({
							_tag: 'SignAndExecuteError',
							message: `Account: signAndExecute failed for '${name}': ${stringifyCause(cause)}`,
							cause,
						}),
					}).pipe(
						Effect.flatMap(
							(r): Effect.Effect<TxResult, SignAndExecuteError> =>
								r.effects?.status?.status === 'success'
									? Effect.tryPromise({
											// Block until the RPC's indexer has the tx's
											// effects visible. Without this, a follow-up tx
											// that references an object created here (e.g.
											// a `publish` → `tx.moveCall(${packageId}::…)`
											// sequence) can race the indexer and fail with
											// "Dependent package not found on-chain" even
											// though the publish reported success.
											try: () => sui.client.waitForTransaction({ digest: r.digest }),
											catch: (cause): SignAndExecuteError => ({
												_tag: 'SignAndExecuteError',
												message: `Account: waitForTransaction failed for '${name}': ${stringifyCause(cause)}`,
												cause,
											}),
										}).pipe(
											Effect.as({
												digest: r.digest,
												effects: r.effects,
												objectChanges: r.objectChanges ?? [],
												balanceChanges: r.balanceChanges,
											}),
										)
									: Effect.fail({
											_tag: 'SignAndExecuteError',
											message:
												r.effects?.status?.error ?? `Account: unknown tx failure for '${name}'`,
										}),
						),
					),
				);

			const signTransaction = (transactionBytes: Uint8Array) =>
				Effect.tryPromise({
					try: () => keypair.signTransaction(transactionBytes),
					catch: (cause): SignAndExecuteError => ({
						_tag: 'SignAndExecuteError',
						message: `Account: signTransaction failed for '${name}': ${stringifyCause(cause)}`,
						cause,
					}),
				});

			const signPersonalMessage = (messageBytes: Uint8Array) =>
				Effect.tryPromise({
					try: () => keypair.signPersonalMessage(messageBytes),
					catch: (cause): SignAndExecuteError => ({
						_tag: 'SignAndExecuteError',
						message: `Account: signPersonalMessage failed for '${name}': ${stringifyCause(cause)}`,
						cause,
					}),
				});

			return {
				name,
				address,
				publicKey: keypair.getPublicKey().toRawBytes(),
				scheme,
				signAndExecute,
				signTransaction,
				signPersonalMessage,
			} satisfies AccountValue;
		})(),
		{
			kind: 'account',
			displayTitle: `accounts.${name}`,
			// Full address in `primary` — users routinely copy-paste it
			// into faucet UIs, explorers, and tx scripts. The dashboard
			// wraps overflow rather than truncate.
			display: (s) => ({ title: `accounts.${s.name}`, primary: s.address }),
		},
	);
	// Stamp `__kind` so the engine-level kind aligns with the TUI section
	// discriminator. The cast widens the inferred `{name: N}` shape to the
	// broader `Account` contract and erases the per-source R requirements
	// off `__layer`; callers provide those via `devstack(...)` / their test
	// base layer.
	return Object.assign(accountTag, {
		__kind: 'account' as const,
	}) as unknown as AccountRef<`account/${N}`>;
};

// -----------------------------------------------------------------------------
// Source-specific keypair acquisition. Each branch yields a ready-to-sign
// `Keypair`; downstream code (funding, registry publish, sign closures)
// doesn't care which branch ran.
// -----------------------------------------------------------------------------

type AcquireRequirements = FileSystem.FileSystem | StateStoreConfig;

const acquireKeypair = (
	name: string,
	source: AccountSource,
): Effect.Effect<Keypair, AccountError, AcquireRequirements> => {
	switch (source.from) {
		case 'ephemeral-funded':
			return acquireEphemeral(name);
		case 'keystore':
			return acquireFromKeystore(name, source);
		case 'env':
			return acquireFromEnv(name, source);
		case 'inline':
			return decodeKeypair(name, source.privateKey);
	}
};

// Persist the bech32 secret key under `.devstack/stacks/<stack>/.keys/<name>.key`
// (mode 0o600, dir 0o700) so warm starts keep a stable address.
const acquireEphemeral = (
	name: string,
): Effect.Effect<Keypair, AccountError, AcquireRequirements> =>
	Effect.gen(function* () {
		const cfg = yield* StateStoreConfig;
		const fs = yield* FileSystem.FileSystem;
		const baseDir =
			cfg.stateDir ??
			`${process.env.DEVSTACK_APP_DIR ?? process.cwd()}/.devstack/stacks/${cfg.stack}`;
		const keysDir = `${baseDir}/.keys`;
		const keyPath = `${keysDir}/${name}.key`;

		const exists = yield* fs.exists(keyPath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (exists) {
			const raw = yield* fs.readFileString(keyPath).pipe(
				Effect.mapError(
					(cause) =>
						new AccountError({
							phase: 'load-key',
							message: `Account: failed to read key file for '${name}' at ${keyPath}`,
							cause,
						}),
				),
			);
			// Re-tighten perms on warm-start in case an older run wrote
			// the file under a permissive umask. Best-effort — Windows /
			// some filesystems silently no-op.
			yield* bestEffortChmod(fs, keyPath, 0o600);
			return yield* decodeKeypair(name, raw.trim());
		}

		yield* fs.makeDirectory(keysDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
		yield* bestEffortChmod(fs, keysDir, 0o700);

		const keypair = Ed25519Keypair.generate();
		const serialized = encodeSuiPrivateKey(
			decodeSuiPrivateKey(keypair.getSecretKey()).secretKey,
			'ED25519',
		);
		yield* fs.writeFileString(keyPath, serialized).pipe(
			Effect.mapError(
				(cause) =>
					new AccountError({
						phase: 'write-key',
						message: `Account: failed to write key file for '${name}' at ${keyPath}`,
						cause,
					}),
			),
		);
		yield* bestEffortChmod(fs, keyPath, 0o600);
		return keypair;
	});

// Read a `suiprivkey1...` from the standard Sui CLI keystore. The keystore
// is a JSON array of bech32 strings; the sibling `sui.aliases` file maps
// human-friendly names to base64-encoded public keys (flag-prefixed). We
// try alias-name resolution first, then fall back to address matching so
// callers can supply either form transparently.
const acquireFromKeystore = (
	name: string,
	source: Extract<AccountSource, { from: 'keystore' }>,
): Effect.Effect<Keypair, AccountError> =>
	Effect.gen(function* () {
		const keystorePath = source.path ?? defaultKeystorePath();
		const raw = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(keystorePath, 'utf8'),
			catch: (cause) =>
				new AccountError({
					phase: 'load-key',
					message: `Account: failed to read keystore for '${name}' at ${keystorePath}`,
					cause,
				}),
		});

		const entries = yield* Effect.try({
			try: () => JSON.parse(raw) as Array<string>,
			catch: (cause) =>
				new AccountError({
					phase: 'load-key',
					message: `Account: keystore at ${keystorePath} is not valid JSON`,
					cause,
				}),
		});
		if (!Array.isArray(entries) || entries.length === 0) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'load-key',
					message: `Account: keystore at ${keystorePath} is empty`,
				}),
			);
		}

		// Step 1: try to resolve `alias` via the sibling aliases file. The
		// alias file is a JSON array of `{alias, public_key_base64}` where
		// the base64 payload is `flag || pubkey`. We decode each candidate
		// keypair to compute its derived address, then match either path —
		// by alias name (resolved to a public-key prefix) or by address —
		// before scanning the whole keystore.
		const targetAddress = yield* resolveAliasAddress(keystorePath, source.alias, entries);

		for (const entry of entries) {
			const candidate = yield* decodeKeypair(name, entry).pipe(
				Effect.catch(() => Effect.succeed<Keypair | undefined>(undefined)),
			);
			if (candidate === undefined) continue;
			const candidateAddress = candidate.getPublicKey().toSuiAddress();
			if (
				candidateAddress === targetAddress ||
				candidateAddress === source.alias ||
				candidateAddress === normalizeAddress(source.alias)
			) {
				return candidate;
			}
		}
		return yield* Effect.fail(
			new AccountError({
				phase: 'load-key',
				message:
					`Account: keystore at ${keystorePath} has no entry matching alias/address ` +
					`'${source.alias}' for '${name}'`,
			}),
		);
	});

const acquireFromEnv = (
	name: string,
	source: Extract<AccountSource, { from: 'env' }>,
): Effect.Effect<Keypair, AccountError> =>
	Effect.gen(function* () {
		const raw = process.env[source.key];
		if (raw === undefined || raw.length === 0) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'load-key',
					message: `Account: env var '${source.key}' is not set for account '${name}'`,
				}),
			);
		}
		return yield* decodeKeypair(name, raw.trim());
	});

// Bech32-decode a `suiprivkey1...` and dispatch to the matching keypair
// class. The scheme is encoded in the bech32 flag byte, so callers don't
// have to declare it.
const decodeKeypair = (name: string, bech32: string): Effect.Effect<Keypair, AccountError> =>
	Effect.try({
		try: () => {
			const { scheme, secretKey } = decodeSuiPrivateKey(bech32);
			return keypairForScheme(scheme, secretKey);
		},
		catch: (cause) =>
			new AccountError({
				phase: 'decode-key',
				message: `Account: failed to decode private key for '${name}'`,
				cause,
			}),
	});

const keypairForScheme = (scheme: SignatureScheme, secretKey: Uint8Array): Keypair => {
	switch (scheme) {
		case 'ED25519':
			return Ed25519Keypair.fromSecretKey(secretKey);
		case 'Secp256k1':
			return Secp256k1Keypair.fromSecretKey(secretKey);
		case 'Secp256r1':
			return Secp256r1Keypair.fromSecretKey(secretKey);
		default:
			throw new Error(
				`unsupported signature scheme '${scheme}' (MultiSig/ZkLogin/Passkey not yet handled by Account())`,
			);
	}
};

const defaultKeystorePath = (): string =>
	nodePath.join(nodeOs.homedir(), '.sui', 'sui_config', 'sui.keystore');

// Resolve `alias` against the sibling `sui.aliases` file. The file's
// shape is a JSON array of `{alias, public_key_base64}`. When present
// and the alias matches, decode each keystore entry, compare the derived
// public key against the alias entry, and return that entry's address.
// Returns undefined if the alias file doesn't exist or the alias isn't
// found there — keystore matching by address is the fallback path.
const resolveAliasAddress = (
	keystorePath: string,
	alias: string,
	entries: ReadonlyArray<string>,
): Effect.Effect<string | undefined, AccountError> =>
	Effect.gen(function* () {
		const aliasesPath = keystorePath.replace(/\.keystore$/, '.aliases');
		if (aliasesPath === keystorePath) return undefined;

		const raw = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(aliasesPath, 'utf8'),
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
		if (raw === undefined) return undefined;

		const parsed = yield* Effect.try({
			try: () =>
				JSON.parse(raw) as Array<{ readonly alias: string; readonly public_key_base64: string }>,
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.succeed<unknown>(undefined)));
		if (!Array.isArray(parsed)) return undefined;

		const match = parsed.find((entry) => entry?.alias === alias);
		if (!match || typeof match.public_key_base64 !== 'string') return undefined;

		for (const entry of entries) {
			const candidate = yield* decodeKeypair('keystore-resolve', entry).pipe(
				Effect.catch(() => Effect.succeed<Keypair | undefined>(undefined)),
			);
			if (candidate === undefined) continue;
			// The alias file's `public_key_base64` encodes `flag || pubkey`.
			// Compare against the candidate's flagged public key so we don't
			// have to know which scheme each entry uses ahead of time.
			const candidatePublic = candidate.getPublicKey();
			const flagged = new Uint8Array(candidatePublic.toRawBytes().length + 1);
			flagged[0] = candidatePublic.flag();
			flagged.set(candidatePublic.toRawBytes(), 1);
			if (toBase64(flagged) === match.public_key_base64) {
				return candidate.getPublicKey().toSuiAddress();
			}
		}
		return undefined;
	});

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

// Pad short hex addresses up to the canonical 0x-prefixed 32-byte form
// so callers that supply a truncated address (`0xabc`) still match the
// keystore entry's full form.
const normalizeAddress = (input: string): string => {
	if (!input.startsWith('0x')) return input;
	const hex = input.slice(2);
	if (hex.length >= 64) return `0x${hex.toLowerCase()}`;
	return `0x${hex.padStart(64, '0').toLowerCase()}`;
};

// Best-effort `chmod`. Failures collapse to `Effect.void` because chmod is
// purely defensive (the file already holds the secret).
const bestEffortChmod = (
	fs: FileSystem.FileSystem,
	path: string,
	mode: number,
): Effect.Effect<void> =>
	fs.chmod(path, mode).pipe(
		Effect.catch(() =>
			Effect.tryPromise({
				try: () => nodeFs.chmod(path, mode),
				catch: () => undefined,
			}).pipe(Effect.catch(() => Effect.void)),
		),
	);
