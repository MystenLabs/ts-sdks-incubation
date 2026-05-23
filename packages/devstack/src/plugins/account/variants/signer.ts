// Account variant — signer (provided as a Signer object directly).
//
// Distilled-doc surface: the escape hatch for hardware wallets,
// custom KMS adapters, and dApp-side signers. Devstack NEVER calls
// `getSecretKey()` on this branch — the supplied signer's
// `signTransaction` / `signPersonalMessage` / `signAndExecuteTransaction`
// methods are called directly.
//
// Type-encoded contract: the `signer` field is the @mysten/sui
// abstract `Signer` shape. We accept `unknown` here at the variant
// boundary (the substrate's import surface stays SDK-free for tree-
// shaking and version-pinning); the user-facing factory in `index.ts`
// pins `Signer` from `@mysten/sui/cryptography`.

import { Effect } from 'effect';

import { accountAcquireError, type AccountAcquireError } from '../errors.ts';
import { normalizeScheme, type ResolvedKeypair } from '../keypair.ts';

export interface SignerVariantArgs {
	readonly name: string;
	/** A `@mysten/sui/cryptography` `Signer` instance. Typed loosely
	 *  here; the user-facing factory pins the SDK type. */
	readonly signer: {
		readonly toSuiAddress: () => string;
		readonly getKeyScheme: () => string;
		readonly getPublicKey: () => { readonly toRawBytes: () => Uint8Array };
	};
	/** Optional address override. When omitted, `signer.toSuiAddress()`
	 *  is called. Useful for signers whose address is more expensive
	 *  to derive than to memoize. */
	readonly addressOverride?: string;
}

/** Resolve the signer variant.
 *
 *  The body reads the address + scheme via the SDK shim and hands
 *  back the resolved-keypair view. The `bech32Secret` field is
 *  `null` — we never fish the secret out of an external signer. */
export const resolveSignerVariant = (
	args: SignerVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.gen(function* () {
		const address = args.addressOverride ?? args.signer.toSuiAddress();
		const rawScheme = args.signer.getKeyScheme();
		const scheme = yield* normalizeScheme(rawScheme, args.name, 'signer');
		const publicKey = yield* Effect.try({
			try: () => args.signer.getPublicKey().toRawBytes(),
			catch: (cause) =>
				accountAcquireError({
					phase: 'bind-signer',
					accountName: args.name,
					variant: 'signer',
					message: `Account '${args.name}': signer.getPublicKey().toRawBytes() threw.`,
					cause,
				}),
		});
		return {
			address,
			scheme,
			publicKey,
			signer: args.signer,
			bech32Secret: null,
		} satisfies ResolvedKeypair;
	});
