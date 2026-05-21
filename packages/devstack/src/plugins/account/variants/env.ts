// Account variant — env (read bech32 secret from a process env var).
//
// Distilled-doc surface: scoped to CI / vault-injected configurations.
// The env-var NAME is taken verbatim from the user's options — the
// VALUE is never logged, spanned, or surfaced in error messages
// (security invariant: only the variable name is referenced).

import { Effect } from 'effect';

import { accountAcquireError, type AccountAcquireError } from '../errors.ts';
import { decodeBech32Secret, type ResolvedKeypair } from '../keypair.ts';

export interface EnvVariantArgs {
	readonly name: string;
	/** The `process.env` variable name holding the bech32 secret. */
	readonly varName: string;
}

/** Resolve the env variant.
 *
 *  Stub: the actual env-read happens inside `Effect.sync` against
 *  the resolved-once process env. The decode path then funnels into
 *  `decodeBech32Secret`. */
export const resolveEnvVariant = (
	args: EnvVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.gen(function* () {
		// Stub: read env, refuse empty / missing.
		const bech32 = yield* Effect.sync((): string | undefined => {
			const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
				.process;
			return proc?.env?.[args.varName];
		}).pipe(
			Effect.flatMap((v) =>
				v === undefined || v === ''
					? Effect.fail(
							accountAcquireError({
								phase: 'read-env',
								accountName: args.name,
								variant: 'env',
								// Reference the variable's NAME only — never the value.
								message: `Account '${args.name}': env var '${args.varName}' is missing or empty.`,
								hint: `Set ${args.varName}=suiprivkey1... in the process environment.`,
							}),
						)
					: Effect.succeed(v),
			),
		);
		return yield* decodeBech32Secret(bech32, args.name, 'env');
	});
