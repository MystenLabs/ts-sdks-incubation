// Per-name account tag factory.
//
// `accounts({...})` builds a record of typed `PluginTag`s — one per
// spec key — plus a combined `__layer` that `defineDevstack` /
// `provideDevstack` merge into the runtime. Each tag yields the same
// `Account` shape (address, scheme, sign* fns), so downstream consumers
// don't care which acquisition path produced the keypair.
//
// Phase 8 added the `from:` discriminator. Today a spec can come from
// one of four sources:
//
//   - 'ephemeral-funded' — generate a fresh Ed25519 keypair, persist it
//     under `.devstack/stacks/<stack>/.keys/<name>.key` so warm starts
//     reuse the same address, and request faucet funding. The faucet
//     endpoint is read off the `Sui` tag's `faucet.host`; pointing at a
//     network with no faucet (mainnet, suiCustom without a faucet) is
//     a configuration error and fails at acquire-time.
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
// The bare `{}` form (legacy callers) is treated as
// `{from: 'ephemeral-funded'}` so existing example configs keep
// working without code edits.
//
// Only `ephemeral-funded` writes to disk and only `ephemeral-funded`
// funds; the other three assume the caller has already funded the
// account out-of-band or doesn't need a balance.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, FileSystem, Layer } from 'effect';
import {
	decodeSuiPrivateKey,
	encodeSuiPrivateKey,
	type SignatureScheme,
} from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import type { Keypair } from '@mysten/sui/cryptography';
import { makeTag, setPhase, type PluginTag, type TagIdentity } from '../advanced/tag.js';
import { Sui } from './sui.js';
import { AccountError } from './errors.js';
import { AccountRegistry } from '../engine/registries.js';
import { Leasing } from '../engine/leasing.js';
import { requestFunds } from '../engine/faucet.js';
import { StateStoreConfig } from '../engine/state-store.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import type { Account, SignAndExecuteError, TxResult } from './shared.js';

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
			 *  instead of minutes-per-account. Mirrors the `readyTimeoutMs`
			 *  knob on `suiLocalnet`. */
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
 * Per-account spec accepted by `accounts({...})`. Discriminated by
 * `from:` (see {@link AccountSource}). The bare `{}` form is accepted
 * for backwards-compat and treated as `{from: 'ephemeral-funded'}`.
 */
export type AccountSpec = AccountSource | Record<string, never>;

// Returned shape: each spec key becomes a typed PluginTag, plus a
// combined __layer that provides all of them. defineDevstack reads
// __layer; users yield* Acc.alice / Acc.bob inside action bodies.
export type AccountsHandle<S extends Record<string, AccountSpec>> = {
	readonly [K in keyof S & string]: PluginTag<`account/${K}`, Account>;
} & {
	readonly __layer: Layer.Layer<TagIdentity<`account/${string & keyof S}`>>;
};

export const accounts = <S extends Record<string, AccountSpec>>(specs: S): AccountsHandle<S> => {
	const handle: Record<string, unknown> = {};
	const layers: Array<Layer.Layer<unknown>> = [];
	for (const [name, rawSpec] of Object.entries(specs)) {
		// Backwards-compat: the bare `{}` form (without a `from:` key)
		// means "ephemeral-funded with defaults". Branch here so the
		// rest of the body can treat `source` as a fully-discriminated
		// `AccountSource`.
		const source: AccountSource =
			'from' in rawSpec ? (rawSpec as AccountSource) : { from: 'ephemeral-funded' };
		const tag = makeTag(
			`account/${name}` as const,
			Effect.fn(`account(${name})`)(function* () {
				yield* Effect.annotateCurrentSpan({
					'account.name': name,
					'account.source': source.from,
				});
				const sui = yield* Sui;
				const leasing = yield* Leasing;

				if (source.from === 'keystore' || source.from === 'env' || source.from === 'inline') {
					yield* setPhase('loading keystore');
				}
				const keypair = yield* acquireKeypair(name, source);
				const address = keypair.getPublicKey().toSuiAddress();
				const scheme = keypair.getKeyScheme() as Account['scheme'];

				yield* Effect.annotateCurrentSpan({ 'account.address': address });

				if (source.from === 'ephemeral-funded') {
					if (sui.faucet === undefined) {
						return yield* Effect.fail(
							new AccountError({
								phase: 'fund',
								message:
									`accounts: '${name}' is ephemeral-funded but the configured Sui has no ` +
									`faucet. Use {from: 'keystore'|'env'|'inline'} for accounts on this ` +
									`network, or pick suiLocalnet/suiTestnet which expose a faucet.`,
							}),
						);
					}
					// Host-side faucet — `accounts.fund` runs in the supervisor
					// process, not inside a container.
					const faucetUrl = sui.faucet.host;
					// Before the first faucet POST, ask the Sui primitive to
					// confirm the chain is actually funds-transferable. The
					// supervisor's Sui-ready gate is socket-level only — the
					// faucet HTTP server is bound but the underlying validator
					// may still be mid-genesis, in which case `/v2/gas` returns
					// 200 OK with body `{status: {Failure: ...}}`. The
					// `requestFunds` retry budget below already absorbs this
					// race for a single account, but each parallel account
					// would otherwise spend its own retry budget rediscovering
					// the same fact; centralizing the wait at `sui` (the
					// primitive memoizes via `Effect.cached`) lets every
					// ephemeral-funded account share one cached resolution.
					// The retry below stays as defense — `waitForTransactions
					// Ready` confirms transferability against a sentinel
					// recipient, then the real funding call races against any
					// transient post-warm-up jitter.
					yield* setPhase('awaiting chain funds-transferable');
					yield* sui.waitForTransactionsReady().pipe(
						Effect.catchTag('SuiError', (cause) =>
							Effect.fail(
								new AccountError({
									phase: 'fund',
									message: `accounts: '${name}' aborted before funding — chain never became funds-transferable: ${cause.message}`,
									cause,
								}),
							),
						),
					);
					yield* setPhase('requesting funds');
					yield* requestFunds({
						faucetUrl,
						address,
						// Surface retry progress so a slow cold-start
						// (sui-faucet binary still warming up, returning 503
						// or body-level `Failure` for the first ~30s after
						// genesis) doesn't look like a hang in the TUI.
						// `setPhase` mutates the row's status text — the
						// dashboard re-renders within one tick.
						onAttempt: (attempt, err) =>
							setPhase(
								`requesting funds (attempt ${attempt}, last: ${err.message.replace(/\n.*$/s, '')})`,
							),
						// Pass through the per-account retry-budget overrides
						// when present. `requestFunds` falls back to its own
						// defaults (90s / 40 attempts) when these are
						// undefined, so the unset path matches today's
						// behavior exactly.
						...(source.faucetTimeoutMs !== undefined ? { timeoutMs: source.faucetTimeoutMs } : {}),
						...(source.faucetMaxAttempts !== undefined
							? { maxAttempts: source.faucetMaxAttempts }
							: {}),
					}).pipe(
						Effect.catchTag('FaucetError', (cause) =>
							Effect.fail(
								new AccountError({
									phase: 'fund',
									message: `accounts: failed to fund '${name}' via ${faucetUrl}`,
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
				const signAndExecute = (transaction: Parameters<Account['signAndExecute']>[0]) =>
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
								message: `accounts: signAndExecute failed for '${name}': ${stringifyCause(cause)}`,
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
												// though the publish reported success. Matches
												// v3's `client.waitForTransaction({ digest })`.
												try: () => sui.client.waitForTransaction({ digest: r.digest }),
												catch: (cause): SignAndExecuteError => ({
													_tag: 'SignAndExecuteError',
													message: `accounts: waitForTransaction failed for '${name}': ${stringifyCause(cause)}`,
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
													r.effects?.status?.error ?? `accounts: unknown tx failure for '${name}'`,
											}),
							),
						),
					);

				const signTransaction = (transactionBytes: Uint8Array) =>
					Effect.tryPromise({
						try: () => keypair.signTransaction(transactionBytes),
						catch: (cause): SignAndExecuteError => ({
							_tag: 'SignAndExecuteError',
							message: `accounts: signTransaction failed for '${name}': ${stringifyCause(cause)}`,
							cause,
						}),
					});

				const signPersonalMessage = (messageBytes: Uint8Array) =>
					Effect.tryPromise({
						try: () => keypair.signPersonalMessage(messageBytes),
						catch: (cause): SignAndExecuteError => ({
							_tag: 'SignAndExecuteError',
							message: `accounts: signPersonalMessage failed for '${name}': ${stringifyCause(cause)}`,
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
				} satisfies Account;
			})(),
			{
				kind: 'action',
				displayTitle: `accounts.${name}`,
				// Full address in `primary` — users routinely copy-paste it
				// into faucet UIs, explorers, and tx scripts. The dashboard
				// wraps overflow rather than truncate.
				display: (s) => ({ title: `accounts.${s.name}`, primary: s.address }),
			},
		);
		handle[name] = tag;
		layers.push((tag as unknown as { __layer: Layer.Layer<unknown> }).__layer);
	}
	const combined =
		layers.length > 0
			? Layer.mergeAll(...(layers as [Layer.Layer<unknown>, ...Array<Layer.Layer<unknown>>]))
			: Layer.empty;
	(handle as { __layer: unknown }).__layer = combined;
	return handle as AccountsHandle<S>;
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
// (mode 0o600, dir 0o700) so warm starts keep a stable address. Mirrors v3's
// disk-keystore layout in `packages/devstack/src/plugins/accounts.ts`.
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
							message: `accounts: failed to read key file for '${name}' at ${keyPath}`,
							cause,
						}),
				),
			);
			// Re-tighten perms on warm-start in case an older run wrote
			// the file under a permissive umask. Best-effort — Windows
			// / some filesystems silently no-op.
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
						message: `accounts: failed to write key file for '${name}' at ${keyPath}`,
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
					message: `accounts: failed to read keystore for '${name}' at ${keystorePath}`,
					cause,
				}),
		});

		const entries = yield* Effect.try({
			try: () => JSON.parse(raw) as Array<string>,
			catch: (cause) =>
				new AccountError({
					phase: 'load-key',
					message: `accounts: keystore at ${keystorePath} is not valid JSON`,
					cause,
				}),
		});
		if (!Array.isArray(entries) || entries.length === 0) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'load-key',
					message: `accounts: keystore at ${keystorePath} is empty`,
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
					`accounts: keystore at ${keystorePath} has no entry matching alias/address ` +
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
					message: `accounts: env var '${source.key}' is not set for account '${name}'`,
				}),
			);
		}
		return yield* decodeKeypair(name, raw.trim());
	});

// Bech32-decode a `suiprivkey1...` and dispatch to the matching keypair
// class. The scheme is encoded in the bech32 flag byte, so callers don't
// have to declare it. `decodeSuiPrivateKey` itself throws on malformed
// input — wrap it in `Effect.try` so the failure mode is a typed
// `AccountError` rather than a defect.
const decodeKeypair = (name: string, bech32: string): Effect.Effect<Keypair, AccountError> =>
	Effect.try({
		try: () => {
			const { scheme, secretKey } = decodeSuiPrivateKey(bech32);
			return keypairForScheme(scheme, secretKey);
		},
		catch: (cause) =>
			new AccountError({
				phase: 'decode-key',
				message: `accounts: failed to decode private key for '${name}'`,
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
				`unsupported signature scheme '${scheme}' (MultiSig/ZkLogin/Passkey not yet handled by accounts())`,
			);
	}
};

const defaultKeystorePath = (): string =>
	nodePath.join(nodeOs.homedir(), '.sui', 'sui_config', 'sui.keystore');

// Resolve `alias` against the sibling `sui.aliases` file. The file's
// shape is a JSON array of `{alias, public_key_base64}`. When present
// and the alias matches, decode each keystore entry, compare the derived
// public key against the alias entry, and return that entry's address.
// Returns undefined (Option.none-equivalent) if the alias file doesn't
// exist or the alias isn't found there — keystore matching by address
// is the fallback path in the caller.
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

// Best-effort `chmod` — `FileSystem.chmod` is the happy path; node:fs
// is the fallback for platforms where Effect's FS returns a typed
// error we'd otherwise have to thread through; failures collapse to
// `Effect.void` because chmod is purely defensive (the file already
// holds the secret).
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
