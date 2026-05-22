// Account variant — ephemeral (generate-or-recover, fund-by-default).
//
// Distilled-doc invariants:
//
//   - "Concurrent first-time keypair persistence": EXCL-create write.
//     Two parallel generators must not both win; the loser falls
//     back to reading the winner's persisted key.
//   - "Restrictive file permissions": 0o600 secret + 0o700 parent.
//   - "Bare form equals ephemeral-funded": this resolver is what the
//     bare `account('alice')` factory call lands on.
//   - "Auto-promotion to fork-impersonate funding": handled in
//     `funding.ts`; this file just hands off the address. The
//     promotion event is emitted there (loud-by-default).
//
// Persistence note: these accounts are "ephemeral" relative to user-
// managed key material, but they are stable inside a devstack runtime
// root. Package cache keys and wallet accounts depend on that stability
// across warm starts.

import { dirname } from 'node:path';
import * as nodeFs from 'node:fs/promises';

import { Effect } from 'effect';

import { decodeBech32Secret, generateEd25519Keypair, type ResolvedKeypair } from '../keypair.ts';
import { accountAcquireError, type AccountAcquireError } from '../errors.ts';

export interface EphemeralVariantArgs {
	readonly name: string;
	/** Filesystem path where the bech32 secret will be persisted by
	 *  the resolver and covered by the account snapshot capability. */
	readonly secretFilePath: string;
}

type WriteResult = 'wrote' | 'exists';

const isErrnoCode = (cause: unknown, code: string): boolean =>
	typeof cause === 'object' &&
	cause !== null &&
	'code' in cause &&
	(cause as { readonly code?: unknown }).code === code;

const bestEffortChmod = (path: string, mode: number): Effect.Effect<void> =>
	Effect.promise(() => nodeFs.chmod(path, mode)).pipe(Effect.ignore);

const readPersistedKeypair = (
	args: EphemeralVariantArgs,
	message: string,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.gen(function* () {
		const raw = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(args.secretFilePath, 'utf8'),
			catch: (cause): AccountAcquireError =>
				accountAcquireError({
					phase: 'read-persisted-keypair',
					accountName: args.name,
					variant: 'ephemeral',
					message,
					cause,
				}),
		});
		yield* bestEffortChmod(args.secretFilePath, 0o600);
		return yield* decodeBech32Secret(raw.trim(), args.name, 'ephemeral');
	});

const readPersistedKeypairIfPresent = (
	args: EphemeralVariantArgs,
): Effect.Effect<ResolvedKeypair | null, AccountAcquireError> =>
	readPersistedKeypair(
		args,
		`Account '${args.name}': failed to read persisted ephemeral keypair at ${args.secretFilePath}.`,
	).pipe(
		Effect.catch((cause: AccountAcquireError) =>
			isErrnoCode(cause.cause, 'ENOENT') ? Effect.succeed(null) : Effect.fail(cause),
		),
	);

const persistGeneratedSecret = (
	args: EphemeralVariantArgs,
	secret: string,
): Effect.Effect<WriteResult, AccountAcquireError> =>
	Effect.tryPromise({
		try: async () => {
			await nodeFs.mkdir(dirname(args.secretFilePath), { recursive: true, mode: 0o700 });
			await nodeFs.chmod(dirname(args.secretFilePath), 0o700).catch(() => {});
			try {
				await nodeFs.writeFile(args.secretFilePath, secret, { flag: 'wx', mode: 0o600 });
				return 'wrote';
			} catch (cause) {
				if (isErrnoCode(cause, 'EEXIST')) return 'exists';
				throw cause;
			}
		},
		catch: (cause): AccountAcquireError =>
			accountAcquireError({
				phase: 'persist-keypair',
				accountName: args.name,
				variant: 'ephemeral',
				message: `Account '${args.name}': failed to persist ephemeral keypair at ${args.secretFilePath}.`,
				cause,
			}),
	});

/** Resolve the ephemeral variant — read or generate an Ed25519 keypair.
 *
 *  First-time writes use O_EXCL so parallel acquires for the same
 *  account cannot both publish different addresses; the loser re-reads
 *  the winner's file and returns the persisted identity. */
export const resolveEphemeralVariant = (
	args: EphemeralVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.gen(function* () {
		const persisted = yield* readPersistedKeypairIfPresent(args);
		if (persisted !== null) return persisted;

		const generated = yield* generateEd25519Keypair(args.name);
		if (generated.bech32Secret === null) {
			return yield* Effect.fail(
				accountAcquireError({
					phase: 'generate-keypair',
					accountName: args.name,
					variant: 'ephemeral',
					message: `Account '${args.name}': generated keypair did not expose a bech32 secret.`,
				}),
			);
		}

		const writeResult = yield* persistGeneratedSecret(args, generated.bech32Secret);
		if (writeResult === 'exists') {
			return yield* readPersistedKeypair(
				args,
				`Account '${args.name}': lost ephemeral keypair write race at ${args.secretFilePath} and failed to read the winner.`,
			);
		}

		yield* bestEffortChmod(args.secretFilePath, 0o600);
		return generated;
	});
