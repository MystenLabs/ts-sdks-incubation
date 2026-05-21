// Account variant — keystore (read from Sui CLI keystore file).
//
// Distilled-doc surface: read a `suiprivkey1...` entry by alias or
// by address from a CLI-shape keystore file. Devstack NEVER copies
// the keystore — only reads. Persistence stays with the user's
// CLI tooling.
//
// Keystore file shape (canonical sui-cli output):
//   `<path>`           — a JSON array of bech32 `suiprivkey1...` strings
//   `<path>.aliases`   — a sibling JSON array of `{alias, public_key_base64}`
//                         entries; the array's index matches the keystore.
//
// Lookup precedence: alias match first (case-sensitive), then by-address
// match (the resolver decodes each bech32 row, derives the address,
// and compares). The address path is intentionally O(n) — keystores
// are small and the alternative is a side-table the CLI doesn't
// maintain.

import { Effect, Schema } from 'effect';
import { promises as fs } from 'node:fs';

import { accountAcquireError, type AccountAcquireError } from '../errors.ts';
import { decodeBech32Secret, type ResolvedKeypair } from '../keypair.ts';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface KeystoreVariantArgs {
	readonly name: string;
	/** Absolute path to the keystore file. Defaults at the factory
	 *  boundary to `~/.sui/sui_config/sui.keystore`. */
	readonly path: string;
	/** Alias name (from the sibling `sui.aliases` file) OR the
	 *  on-chain address — the resolver tries alias first, then a
	 *  by-address lookup. */
	readonly aliasOrAddress: string;
}

const AliasesShape = Schema.Array(
	Schema.Struct({
		alias: Schema.String,
		// Optional because some CLI versions omit it for newer rows;
		// we only need the alias for the alias-path.
		public_key_base64: Schema.optional(Schema.String),
	}),
);

const KeystoreShape = Schema.Array(Schema.String);

/** Resolve the keystore variant. */
export const resolveKeystoreVariant = (
	args: KeystoreVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.gen(function* () {
		// --- read + parse the keystore ----------------------------------
		const raw = yield* Effect.tryPromise({
			try: () => fs.readFile(args.path, 'utf-8'),
			catch: (cause): AccountAcquireError =>
				accountAcquireError({
					phase: 'load-keystore',
					accountName: args.name,
					variant: 'keystore',
					message: `Account '${args.name}': failed to read keystore at '${args.path}'.`,
					hint: 'Verify the path exists and is readable. The Sui CLI default is `~/.sui/sui_config/sui.keystore`.',
					cause,
				}),
		});
		const parsed: unknown = yield* Effect.try({
			try: () => JSON.parse(raw),
			catch: (cause): AccountAcquireError =>
				accountAcquireError({
					phase: 'load-keystore',
					accountName: args.name,
					variant: 'keystore',
					message: `Account '${args.name}': keystore at '${args.path}' is not valid JSON.`,
					cause,
				}),
		});
		const rows = yield* Schema.decodeUnknownEffect(KeystoreShape)(parsed).pipe(
			Effect.mapError(
				(cause): AccountAcquireError =>
					accountAcquireError({
						phase: 'load-keystore',
						accountName: args.name,
						variant: 'keystore',
						message: `Account '${args.name}': keystore at '${args.path}' did not match the expected schema (array of bech32 strings).`,
						cause,
					}),
			),
		);

		// --- alias path -------------------------------------------------
		// Best-effort: missing aliases file is not fatal — fall through
		// to the by-address path.
		const aliasesPath = `${args.path.replace(/\.keystore$/, '')}.aliases`;
		const aliasIdx = yield* resolveAliasIndex(aliasesPath, args.aliasOrAddress).pipe(
			Effect.orElseSucceed(() => -1),
		);
		if (aliasIdx >= 0 && aliasIdx < rows.length) {
			const bech32 = rows[aliasIdx]!;
			return yield* decodeBech32Secret(bech32, args.name, 'keystore');
		}

		// --- by-address path -------------------------------------------
		// Normalize the lookup key to a lowercased 0x-prefixed string so
		// comparisons match regardless of caller casing.
		const wantAddr = normalizeAddress(args.aliasOrAddress);
		for (const bech32 of rows) {
			const addr = yield* tryDeriveAddress(bech32).pipe(Effect.orElseSucceed(() => null));
			if (addr !== null && normalizeAddress(addr) === wantAddr) {
				return yield* decodeBech32Secret(bech32, args.name, 'keystore');
			}
		}

		return yield* Effect.fail(
			accountAcquireError({
				phase: 'load-keystore',
				accountName: args.name,
				variant: 'keystore',
				message: `Account '${args.name}': keystore at '${args.path}' has no entry matching alias-or-address '${args.aliasOrAddress}'.`,
				hint: 'Check the sibling sui.aliases file for the alias spelling, or pass the on-chain address (0x-prefixed) directly.',
			}),
		);
	});

const resolveAliasIndex = (
	aliasesPath: string,
	want: string,
): Effect.Effect<number, AccountAcquireError> =>
	Effect.gen(function* () {
		const raw = yield* Effect.tryPromise({
			try: () => fs.readFile(aliasesPath, 'utf-8'),
			catch: (cause): AccountAcquireError =>
				accountAcquireError({
					phase: 'load-keystore',
					accountName: '<keystore>',
					variant: 'keystore',
					message: `aliases file '${aliasesPath}' missing or unreadable`,
					cause,
				}),
		});
		const parsed: unknown = yield* Effect.try({
			try: () => JSON.parse(raw),
			catch: (cause): AccountAcquireError =>
				accountAcquireError({
					phase: 'load-keystore',
					accountName: '<keystore>',
					variant: 'keystore',
					message: `aliases file '${aliasesPath}' is not valid JSON`,
					cause,
				}),
		});
		const aliases = yield* Schema.decodeUnknownEffect(AliasesShape)(parsed).pipe(
			Effect.mapError(
				(cause): AccountAcquireError =>
					accountAcquireError({
						phase: 'load-keystore',
						accountName: '<keystore>',
						variant: 'keystore',
						message: `aliases file '${aliasesPath}' did not match the expected schema`,
						cause,
					}),
			),
		);
		return aliases.findIndex((row) => row.alias === want);
	});

/** Derive the on-chain address from a bech32 secret without
 *  surfacing a typed error — used by the by-address scan, which
 *  swallows per-row failures and moves on. */
const tryDeriveAddress = (bech32: string): Effect.Effect<string, Error> =>
	Effect.try({
		try: () => {
			const parsed = decodeSuiPrivateKey(bech32);
			if (parsed.scheme !== 'ED25519') {
				throw new Error(`scheme ${parsed.scheme} not yet derivable here`);
			}
			return Ed25519Keypair.fromSecretKey(parsed.secretKey).toSuiAddress();
		},
		catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
	});

const normalizeAddress = (addr: string): string => {
	const lower = addr.toLowerCase();
	return lower.startsWith('0x') ? lower : `0x${lower}`;
};
