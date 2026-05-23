// Account variant — impersonate (fork-mode only).
//
// Distilled-doc invariants:
//
//   - "Impersonation only on fork": the variant must refuse outside
//     fork-runtime. The refusal lands at variant-resolution time
//     (typed AccountAcquireError, phase: bind-impersonation-slot).
//
//   - "Sign-and-execute is the only execution surface for
//     impersonation": synthetic impersonation signers must THROW
//     SYNCHRONOUSLY on direct sign calls so accidental bypass is
//     loud, not silent. We surface this through the
//     `SyntheticImpersonationSigner` object's `signTransaction` /
//     `signPersonalMessage` methods.
//
//   - "publicKey caveat": the resolved value's `publicKey` is a
//     zero buffer. The resolved-account TYPE (in `service.ts`)
//     encodes the source discriminator so consumers can't accidentally
//     treat an impersonation publicKey as authoritative.
//
// Distilled-doc opportunity: "Move the synthetic impersonation
// signer next to the other fork-only helpers". For now, it stays
// here because the variant resolver is the only construction site —
// if Wallet ever needs to materialize impersonation signers directly,
// we lift this into `plugins/sui/fork-orchestration.ts`.

import { Effect } from 'effect';

import { accountAcquireError, accountSignError, type AccountAcquireError } from '../errors.ts';
import type { ResolvedKeypair } from '../keypair.ts';

export interface ImpersonateVariantArgs {
	readonly name: string;
	/** The address to execute AS. Must appear in the fork's seed
	 *  manifest's owned-object index (typically by being listed
	 *  in `Sui({fork:{seed:{addresses}}})`). */
	readonly address: string;
	/** Sui's resolved runtime mode — gates the refusal-outside-fork
	 *  check. */
	readonly suiMode: 'local' | 'local-rpc' | 'live' | 'fork';
}

/** The synthetic impersonation signer object. THROWS SYNCHRONOUSLY
 *  on direct sign calls; routes `signAndExecute` through the fork's
 *  empty-signature submit path (wired in `service.ts`). */
export interface SyntheticImpersonationSigner {
	readonly _kind: 'impersonate';
	readonly toSuiAddress: () => string;
	readonly getKeyScheme: () => 'ed25519';
	readonly signTransaction: () => never;
	readonly signPersonalMessage: () => never;
}

const makeSyntheticSigner = (
	accountName: string,
	address: string,
): SyntheticImpersonationSigner => ({
	_kind: 'impersonate',
	toSuiAddress: () => address,
	// Stable lie: report ed25519 so manifest serialization doesn't
	// have to branch. Consumers that need the truth read `source`
	// off the resolved-account value (architecture-distilled
	// invariant).
	getKeyScheme: () => 'ed25519',
	signTransaction: () => {
		throw accountSignError({
			phase: 'impersonation-bypass-attempt',
			accountName,
			address,
			message: `Account '${accountName}' is an impersonation account — direct sign calls are forbidden. Route through signAndExecute (which goes via the fork's impersonation submit path).`,
		});
	},
	signPersonalMessage: () => {
		throw accountSignError({
			phase: 'impersonation-bypass-attempt',
			accountName,
			address,
			message: `Account '${accountName}' is an impersonation account — signPersonalMessage is not supported.`,
		});
	},
});

/** Resolve the impersonate variant.
 *
 *  Distilled-doc invariant: refuse outside fork mode. The refusal
 *  is a typed acquisition error pointing at the runtime requirement. */
export const resolveImpersonateVariant = (
	args: ImpersonateVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> => {
	if (args.suiMode !== 'fork') {
		return Effect.fail(
			accountAcquireError({
				phase: 'bind-impersonation-slot',
				accountName: args.name,
				variant: 'impersonate',
				message: `Account '${args.name}' uses {kind:'impersonate'} but Sui runtime is '${args.suiMode}'. Impersonation only works on fork-mode networks.`,
				hint: `Switch to suiFor(network).fork.{mainnet|testnet|devnet}(...) — or use a different account variant.`,
			}),
		);
	}
	return Effect.succeed({
		address: args.address,
		scheme: 'ed25519',
		// Zero-buffer publicKey — the type-level lie. The `source`
		// discriminator on the resolved AccountValue is the
		// trustworthy signal.
		publicKey: new Uint8Array(32),
		signer: makeSyntheticSigner(args.name, args.address),
		bech32Secret: null,
	} satisfies ResolvedKeypair);
};
