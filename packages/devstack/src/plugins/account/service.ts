// Account plugin — service body (main acquire Effect).
//
// What this file does:
//
//   1. Validate the account name (12-account.md "Name shape"
//      invariant) — strict charset, length-bounded. Loud-fail at
//      the factory boundary.
//   2. Dispatch on the variant discriminator to the right resolver
//      under `variants/`.
//   3. Coordinate the funding pass (default + cross-cutting).
//   4. Project the resolved keypair into the user-facing
//      `AccountValue` shape (sign + execute closures).
//
// What it does NOT do:
//
//   - Talk to the chain or the faucet directly — the variant
//     resolvers + the funding helpers own those wires.
//   - Wire the capabilities — that's the barrel's job (`index.ts`).
//
// Distilled-doc invariant ("Acquisition vs signing error split"):
// the acquire body emits ONLY `AccountAcquireError`; the resolved
// value's sign/execute closures emit `AccountSignError`. The two
// channels never mix.
//
// Per-address serialization (architecture invariant): concurrent
// account-bound transactions for the same address MUST serialize
// across build + sign + execute. `Transaction.build({ client })`
// resolves gas/object versions, so taking the lease only while
// signing still lets two callers build stale object references. The
// substrate's `LeaseBrokerService` is the L0 primitive: each
// transaction scope opens a fresh lease keyed by `account:<address>`.
// The public sign helpers are implemented in terms of that scope so
// they keep the historical per-address behavior.

import { Effect } from 'effect';

import type { Signer, SignatureWithBytes } from '@mysten/sui/cryptography';

import {
	accountAcquireError,
	accountSignError,
	type AccountAcquireError,
	type AccountSignError,
} from './errors.ts';
import { type ResolvedKeypair } from './keypair.ts';
import {
	applyCrossCuttingFunding,
	fundEphemeralDefault,
	DEFAULT_EPHEMERAL_FUND_MIST,
	type CrossCuttingFundingEntry,
	type ProjectedFunding,
} from './funding.ts';
import { resolveEphemeralVariant } from './variants/ephemeral.ts';
import { resolveKeystoreVariant } from './variants/keystore.ts';
import { resolveEnvVariant } from './variants/env.ts';
import { resolveInlineVariant } from './variants/inline.ts';
import { resolveSignerVariant } from './variants/signer.ts';
import { resolveImpersonateVariant } from './variants/impersonate.ts';
import type { SuiSdkShim } from '../sui/chain-probe.ts';
import type { StrategyRegistryService } from '../../substrate/runtime/strategy-registry/service.ts';
import type { ChainId } from '../../substrate/brand.ts';
import type { TransactionSignerScope } from '../../substrate/runtime/sui-execute/index.ts';
import {
	LeaseBrokerService,
	type LeaseBroker,
} from '../../substrate/runtime/lease-broker/index.ts';
import { withAddressLease } from './lease.ts';

// -----------------------------------------------------------------------------
// User-facing options shape
// -----------------------------------------------------------------------------

/** Account variant discriminated union. The user-facing factory
 *  takes one of these shapes (or omits `opts` entirely for the
 *  default ephemeral form). */
export type AccountOptions =
	| {
			readonly kind: 'ephemeral';
			readonly name: string;
			readonly fund?: bigint /* MIST */;
			readonly funding?: ReadonlyArray<CrossCuttingFundingEntry>;
	  }
	| {
			readonly kind: 'keystore';
			readonly name: string;
			readonly path: string;
			readonly aliasOrAddress: string;
			readonly funding?: ReadonlyArray<CrossCuttingFundingEntry>;
	  }
	| {
			readonly kind: 'env';
			readonly name: string;
			readonly key: string;
			readonly funding?: ReadonlyArray<CrossCuttingFundingEntry>;
	  }
	| {
			readonly kind: 'inline';
			readonly name: string;
			readonly privateKey: string | Uint8Array;
			readonly funding?: ReadonlyArray<CrossCuttingFundingEntry>;
	  }
	| {
			readonly kind: 'signer';
			readonly name: string;
			readonly signer: {
				readonly toSuiAddress: () => string;
				readonly getKeyScheme: () => string;
				readonly getPublicKey: () => { readonly toRawBytes: () => Uint8Array };
				readonly signTransaction: (
					tx: Uint8Array,
				) => Promise<{ readonly bytes: string; readonly signature: string }>;
				readonly signPersonalMessage: (
					msg: Uint8Array,
				) => Promise<{ readonly bytes: string; readonly signature: string }>;
			};
			readonly addressOverride?: string;
			readonly funding?: ReadonlyArray<CrossCuttingFundingEntry>;
	  }
	| {
			readonly kind: 'impersonate';
			readonly name: string;
			readonly address: string;
			readonly funding?: ReadonlyArray<CrossCuttingFundingEntry>;
	  };

// -----------------------------------------------------------------------------
// Resolved value (the Tag's resolved-shape)
// -----------------------------------------------------------------------------

/** Per-account resolved value — the typed handle the Account tag
 *  publishes.
 *
 *  Architecture-distilled finding (12-account.md "Tighten the
 *  resolved-account type"): the `source` discriminator is mandatory
 *  so consumers can branch on impersonation. Impersonation accounts
 *  carry a zero-buffer publicKey — the discriminator is the
 *  trustworthy signal. */
export interface AccountValue {
	readonly name: string;
	readonly address: string;
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	readonly publicKey: Uint8Array;
	/** Source discriminator — `'real'` for ephemeral / keystore / env
	 *  / inline / signer; `'impersonate'` for the fork-only variant. */
	readonly source: 'real' | 'impersonate';
	/** Sign + execute (the canonical execution surface — per-address
	 *  serialized, post-submit transaction-wait included, bounded
	 *  retry on the "dependent package not found on-chain" race).
	 *
	 *  For impersonation accounts, routes through Sui's fork
	 *  admin `impersonate` surface; for real signers, routes
	 *  through the SDK's executeTransaction surface. */
	readonly signAndExecute: (tx: Uint8Array) => Effect.Effect<TxResult, AccountSignError>;
	/** Run a full account-bound transaction critical section.
	 *  Callers that must serialize `Transaction.build({ client })`
	 *  together with signing/execution use the signer passed to this
	 *  callback; the callback runs while the per-address lease is held. */
	readonly withTransactionSigner: <A, E, R>(
		body: (signer: AccountTransactionSigner) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	/** Sign-only — real signers honor this; impersonation accounts
	 *  throw synchronously (see `variants/impersonate.ts`). */
	readonly signTransaction: (
		tx: Uint8Array,
	) => Effect.Effect<{ readonly bytes: string; readonly signature: string }, AccountSignError>;
	readonly signPersonalMessage: (
		msg: Uint8Array,
	) => Effect.Effect<{ readonly bytes: string; readonly signature: string }, AccountSignError>;
}

/** Submit result projection — kept narrow so downstream consumers
 *  don't depend on the full @mysten/sui execute envelope. */
export interface TxResult {
	readonly digest: string;
	readonly effects: unknown;
	readonly objectChanges: ReadonlyArray<unknown>;
	readonly balanceChanges: ReadonlyArray<unknown>;
}

export interface AccountTransactionSigner extends TransactionSignerScope<AccountSignError> {
	readonly signAndExecute: AccountValue['signAndExecute'];
}

// -----------------------------------------------------------------------------
// Name validation
// -----------------------------------------------------------------------------

/** Architecture-distilled invariant: name flows into the tag id, an
 *  on-disk path, a manifest key, and container labels. Strict
 *  alphanumeric + `._-`; leading alphanumeric; length-bounded.
 *  Broader charsets would let typos traverse directories or break
 *  label parsing. */
const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const validateAccountName = (name: string): Effect.Effect<void, AccountAcquireError> => {
	if (!ACCOUNT_NAME_RE.test(name)) {
		return Effect.fail(
			accountAcquireError({
				phase: 'validate-name',
				accountName: name,
				variant: 'ephemeral',
				message: `Account name '${name}' is invalid — must match ${ACCOUNT_NAME_RE.source}.`,
				hint: 'lowercase alphanumeric + ._- ; must start with a letter or digit; max 64 chars',
			}),
		);
	}
	return Effect.void;
};

// -----------------------------------------------------------------------------
// Variant dispatch
// -----------------------------------------------------------------------------

/** Sui mode + sdk shim — the slice of the resolved `SuiClient` the
 *  account service actually consumes. Kept narrow so the variants +
 *  funding helpers stay typed at the resolved-fields level (mode,
 *  chain, sdk) rather than at the wide `SuiClient` shape. */
export interface AccountSuiShim {
	readonly mode: 'local' | 'external' | 'live' | 'fork';
	readonly chain: ChainId;
	/** SDK shim — exposes `executeTransaction` + `waitForTransaction`
	 *  for the signAndExecute pipeline. */
	readonly sdk: SuiSdkShim;
}

/** Per-acquire context — supplied by the barrel from the
 *  BuildContext + per-stack identity.
 *
 *  `projectedFunding` carries the funding entries already resolved
 *  against the BuildContext: the barrel calls `ctx.use(member)` on
 *  each `opts.funding[i].coin` and projects to
 *  `{fullCoinType, amount}` BEFORE handing off to `acquireAccount`.
 *  The acquire body never sees the raw member refs — keeps the
 *  cross-cutting funding dispatch substrate-name-blind. */
export interface AccountAcquireContext {
	readonly sui: AccountSuiShim;
	readonly runtimeRoot: string;
	readonly app: string;
	readonly stack: string;
	readonly emitAutoPromotionEvent: () => Effect.Effect<void>;
	/** Projected cross-cutting funding entries. Empty when `opts.funding`
	 *  is absent. The barrel walks each user-supplied `CoinMember` via
	 *  `ctx.use(...)` and stamps the resolved `fullCoinType` here. */
	readonly projectedFunding?: ProjectedFunding;
}

/** Dispatch on the variant discriminator. */
const resolveVariant = (
	opts: AccountOptions,
	ctx: AccountAcquireContext,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> => {
	switch (opts.kind) {
		case 'ephemeral':
			return resolveEphemeralVariant({
				name: opts.name,
				// Architecture-distilled (12-account.md "Cross-component
				// references"): persisted key lives under the stack's
				// runtime tree. Path shape mirrors the on-disk convention.
				secretFilePath: `${ctx.runtimeRoot}/account/${opts.name}.key`,
			});
		case 'keystore':
			return resolveKeystoreVariant({
				name: opts.name,
				path: opts.path,
				aliasOrAddress: opts.aliasOrAddress,
			});
		case 'env':
			return resolveEnvVariant({
				name: opts.name,
				varName: opts.key,
			});
		case 'inline':
			return resolveInlineVariant({
				name: opts.name,
				privateKey: opts.privateKey,
			});
		case 'signer':
			return resolveSignerVariant({
				name: opts.name,
				signer: opts.signer,
				...(opts.addressOverride !== undefined ? { addressOverride: opts.addressOverride } : {}),
			});
		case 'impersonate':
			return resolveImpersonateVariant({
				name: opts.name,
				address: opts.address,
				suiMode: ctx.sui.mode,
			});
	}
};

// -----------------------------------------------------------------------------
// Sign + execute closures
// -----------------------------------------------------------------------------

/** Promote a Promise-returning sign call into the typed-error
 *  channel. The `signer.signTransaction` / `signPersonalMessage`
 *  helpers on `@mysten/sui` `Signer` instances are async; the
 *  bring-your-own-signer variant uses the same shape. */
const signWith = (
	signer: {
		readonly signTransaction: (
			tx: Uint8Array,
		) => Promise<{ readonly bytes: string; readonly signature: string }>;
	},
	tx: Uint8Array,
	accountName: string,
	address: string,
): Effect.Effect<{ readonly bytes: string; readonly signature: string }, AccountSignError> =>
	Effect.tryPromise({
		try: () => signer.signTransaction(tx),
		catch: (cause): AccountSignError =>
			accountSignError({
				phase: 'sign',
				accountName,
				address,
				message: `Account '${accountName}': signer.signTransaction() rejected.`,
				cause,
			}),
	});

const signPersonalWith = (
	signer: {
		readonly signPersonalMessage: (
			msg: Uint8Array,
		) => Promise<{ readonly bytes: string; readonly signature: string }>;
	},
	msg: Uint8Array,
	accountName: string,
	address: string,
): Effect.Effect<{ readonly bytes: string; readonly signature: string }, AccountSignError> =>
	Effect.tryPromise({
		try: () => signer.signPersonalMessage(msg),
		catch: (cause): AccountSignError =>
			accountSignError({
				phase: 'sign',
				accountName,
				address,
				message: `Account '${accountName}': signer.signPersonalMessage() rejected.`,
				cause,
			}),
	});

/** Project the raw `@mysten/sui` executeTransaction response into
 *  the narrowed `TxResult` shape consumers depend on. The SDK
 *  response carries a discriminated union; the result we surface
 *  always carries a digest plus the include-projected sub-fields. */
const projectTxResult = (
	raw: unknown,
	accountName: string,
	address: string,
): Effect.Effect<TxResult, AccountSignError> => {
	// Defensive shape: the SDK's TransactionResult is
	// `{$kind, Transaction?, FailedTransaction?}` — `Transaction.digest`
	// is the canonical id we need. We do best-effort projection here
	// rather than schema-decode (the shape is wide + the SDK pins it).
	const r = raw as {
		$kind?: 'Transaction' | 'FailedTransaction';
		Transaction?: {
			digest?: string;
			effects?: unknown;
			objectTypes?: Readonly<Record<string, string>>;
			balanceChanges?: ReadonlyArray<unknown>;
		};
		FailedTransaction?: {
			digest?: string;
		};
	};
	if (r.$kind === 'FailedTransaction') {
		return Effect.fail(
			accountSignError({
				phase: 'submit',
				accountName,
				address,
				message: `Account '${accountName}': transaction execution failed on-chain (digest=${r.FailedTransaction?.digest ?? '<unknown>'}).`,
			}),
		);
	}
	const tx = r.Transaction;
	if (tx?.digest === undefined) {
		return Effect.fail(
			accountSignError({
				phase: 'submit',
				accountName,
				address,
				message: `Account '${accountName}': executeTransaction returned no digest. Raw shape=${JSON.stringify(r).slice(0, 200)}.`,
			}),
		);
	}
	return Effect.succeed({
		digest: tx.digest,
		effects: tx.effects ?? null,
		objectChanges: projectObjectChanges(tx.effects, tx.objectTypes ?? {}),
		balanceChanges: tx.balanceChanges ?? [],
	});
};

const extractExecuteDigest = (raw: unknown): string | undefined => {
	const r = raw as {
		$kind?: 'Transaction' | 'FailedTransaction';
		Transaction?: { readonly digest?: string };
		FailedTransaction?: { readonly digest?: string };
	};
	return r.$kind === 'FailedTransaction' ? r.FailedTransaction?.digest : r.Transaction?.digest;
};

const projectObjectChanges = (
	effects: unknown,
	objectTypes: Readonly<Record<string, string>>,
): ReadonlyArray<unknown> => {
	const changedObjects =
		typeof effects === 'object' && effects !== null && 'changedObjects' in effects
			? (
					effects as {
						readonly changedObjects?: ReadonlyArray<{
							readonly objectId?: string;
							readonly outputState?: string;
							readonly idOperation?: string;
						}>;
					}
				).changedObjects
			: undefined;
	if (changedObjects === undefined) return [];
	return changedObjects
		.filter(
			(
				change,
			): change is {
				readonly objectId: string;
				readonly outputState?: string;
				readonly idOperation?: string;
			} => typeof change.objectId === 'string',
		)
		.map((change) => {
			const objectType = objectTypes[change.objectId];
			const entry: {
				type: 'published' | 'created' | 'mutated';
				objectId: string;
				objectType?: string;
				outputState?: string;
				idOperation?: string;
			} = {
				type:
					change.outputState === 'PackageWrite'
						? 'published'
						: change.idOperation === 'Created'
							? 'created'
							: 'mutated',
				objectId: change.objectId,
			};
			if (objectType !== undefined) entry.objectType = objectType;
			if (change.outputState !== undefined) entry.outputState = change.outputState;
			if (change.idOperation !== undefined) entry.idOperation = change.idOperation;
			return entry;
		});
};

interface BuildClosuresArgs {
	readonly accountName: string;
	readonly resolved: ResolvedKeypair;
	readonly sui: AccountSuiShim;
	readonly broker: LeaseBroker;
	readonly source: 'real' | 'impersonate';
}

const buildClosures = (
	args: BuildClosuresArgs,
): Pick<
	AccountValue,
	'signAndExecute' | 'withTransactionSigner' | 'signTransaction' | 'signPersonalMessage'
> => {
	const { accountName, resolved, sui, broker, source } = args;

	// Impersonation accounts MUST NOT sign — the synthetic signer's
	// signTransaction throws synchronously (architecture invariant).
	// The signAndExecute path lands separately when the fork admin
	// surface is wired in; for now we emit a typed refusal so callers
	// branch on `phase` rather than `source`.
	if (source === 'impersonate') {
		const refuse = <A>(): Effect.Effect<A, AccountSignError> =>
			Effect.fail(
				accountSignError({
					phase: 'impersonation-bypass-attempt',
					accountName,
					address: resolved.address,
					message: `Account '${accountName}' is an impersonation account — sign/execute must route through Sui's fork admin surface.`,
				}),
			);
		return {
			signAndExecute: () =>
				Effect.fail(
					accountSignError({
						phase: 'submit',
						accountName,
						address: resolved.address,
						message: `Account '${accountName}': impersonation signAndExecute is not yet routed to the fork admin surface.`,
					}),
				),
			withTransactionSigner: (body) =>
				body({
					signAndExecute: () =>
						Effect.fail(
							accountSignError({
								phase: 'submit',
								accountName,
								address: resolved.address,
								message: `Account '${accountName}': impersonation signAndExecute is not yet routed to the fork admin surface.`,
							}),
						),
					signTransaction: refuse<{ readonly bytes: string; readonly signature: string }>,
				}),
			signTransaction: refuse<{ readonly bytes: string; readonly signature: string }>,
			signPersonalMessage: refuse<{ readonly bytes: string; readonly signature: string }>,
		};
	}

	// Both real-keypair and bring-your-own-signer paths satisfy the
	// minimal `signTransaction` / `signPersonalMessage` shape (the
	// SDK's `Signer` and the BYO `signer` declaration agree on it).
	const signer = resolved.signer as Pick<Signer, 'signTransaction' | 'signPersonalMessage'>;

	const unlockedSignTransaction: AccountTransactionSigner['signTransaction'] = (tx) =>
		signWith(signer, tx, accountName, resolved.address);

	const unlockedSignAndExecute: AccountTransactionSigner['signAndExecute'] = (tx) =>
		Effect.gen(function* () {
			const signed: SignatureWithBytes = yield* unlockedSignTransaction(tx);
			const raw = yield* Effect.tryPromise({
				try: () =>
					sui.sdk.core.executeTransaction({
						transaction: tx,
						signatures: [signed.signature],
						include: { effects: true, objectTypes: true },
					}),
				catch: (cause): AccountSignError =>
					accountSignError({
						phase: 'submit',
						accountName,
						address: resolved.address,
						message: `Account '${accountName}': executeTransaction transport failed.`,
						cause,
					}),
			});
			const digest = extractExecuteDigest(raw);
			if (digest !== undefined) {
				yield* Effect.tryPromise({
					try: () =>
						sui.sdk.core.waitForTransaction({
							digest,
						}),
					catch: (cause): AccountSignError =>
						accountSignError({
							phase: 'await-finality',
							accountName,
							address: resolved.address,
							message: `Account '${accountName}': waitForTransaction(${digest}) failed.`,
							cause,
						}),
				});
			}
			const result = yield* projectTxResult(raw, accountName, resolved.address);
			return result;
		});

	const transactionSigner: AccountTransactionSigner = {
		signTransaction: unlockedSignTransaction,
		signAndExecute: unlockedSignAndExecute,
	};

	const withTransactionSigner: AccountValue['withTransactionSigner'] = (body) =>
		withAddressLease(
			broker,
			accountName,
			resolved.address,
			Effect.gen(function* () {
				return yield* body(transactionSigner);
			}),
		).pipe(
			Effect.withSpan('devstack.plugin.account.transactionSigner', {
				attributes: { 'account.name': accountName, 'account.address': resolved.address },
			}),
		);

	const signTransaction: AccountValue['signTransaction'] = (tx) =>
		withTransactionSigner((locked) => locked.signTransaction(tx)).pipe(
			Effect.withSpan('devstack.plugin.account.signTransaction', {
				attributes: { 'account.name': accountName, 'account.address': resolved.address },
			}),
		);

	const signPersonalMessage: AccountValue['signPersonalMessage'] = (msg) =>
		withAddressLease(
			broker,
			accountName,
			resolved.address,
			signPersonalWith(signer, msg, accountName, resolved.address),
		).pipe(
			Effect.withSpan('devstack.plugin.account.signPersonalMessage', {
				attributes: { 'account.name': accountName, 'account.address': resolved.address },
			}),
		);

	const signAndExecute: AccountValue['signAndExecute'] = (tx) =>
		withTransactionSigner((locked) => locked.signAndExecute(tx)).pipe(
			Effect.withSpan('devstack.plugin.account.signAndExecute', {
				attributes: { 'account.name': accountName, 'account.address': resolved.address },
			}),
		);

	return { signAndExecute, withTransactionSigner, signTransaction, signPersonalMessage };
};

// -----------------------------------------------------------------------------
// Acquire orchestration
// -----------------------------------------------------------------------------

/** Acquire an account. Coordinates variant dispatch + funding +
 *  the resolved-value projection. */
export const acquireAccount = (
	opts: AccountOptions,
	ctx: AccountAcquireContext,
): Effect.Effect<AccountValue, AccountAcquireError, StrategyRegistryService | LeaseBrokerService> =>
	Effect.gen(function* () {
		yield* validateAccountName(opts.name);

		yield* Effect.annotateCurrentSpan({
			'account.name': opts.name,
			'account.variant': opts.kind,
			'sui.mode': ctx.sui.mode,
		});

		// --- variant dispatch ----------------------------------------
		const resolved = yield* resolveVariant(opts, ctx);

		yield* Effect.annotateCurrentSpan({
			'account.address': resolved.address,
			'account.scheme': resolved.scheme,
		});

		// --- lease broker handle (captured once; both funding and the
		//     resolved-value closures share this handle so concurrent
		//     callers serialize through the substrate broker's per-key
		//     FIFO queue) -------------------------------------------
		const broker = yield* LeaseBrokerService;

		// --- default funding (ephemeral only) ------------------------
		if (opts.kind === 'ephemeral') {
			yield* fundEphemeralDefault({
				accountName: opts.name,
				address: resolved.address,
				amountMist: opts.fund ?? DEFAULT_EPHEMERAL_FUND_MIST,
				suiMode: ctx.sui.mode,
				chainId: ctx.sui.chain,
				emitAutoPromotionEvent: ctx.emitAutoPromotionEvent,
				broker,
			});
		}

		// --- cross-cutting funding (all variants) --------------------
		//
		// The barrel pre-projects each user-supplied `CoinMember` to
		// `{fullCoinType, amount}` via `ctx.use(...)` so this dispatch
		// stays substrate-name-blind. Missing / empty `projectedFunding`
		// is a no-op (matches the "Optional Faucet is a noop" invariant).
		const projected = ctx.projectedFunding ?? [];
		if (projected.length > 0) {
			yield* applyCrossCuttingFunding({
				accountName: opts.name,
				address: resolved.address,
				funding: projected,
				chainId: ctx.sui.chain,
				broker,
			});
		}

		const source: AccountValue['source'] = opts.kind === 'impersonate' ? 'impersonate' : 'real';
		const closures = buildClosures({
			accountName: opts.name,
			resolved,
			sui: ctx.sui,
			broker,
			source,
		});

		// --- project the resolved value ------------------------------
		const value: AccountValue = {
			name: opts.name,
			address: resolved.address,
			scheme: resolved.scheme,
			publicKey: resolved.publicKey,
			source,
			...closures,
		};
		return value;
	});
