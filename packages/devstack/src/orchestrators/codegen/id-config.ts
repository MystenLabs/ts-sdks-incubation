// The id-config interchange file — the single source of on-chain ids.
//
// Stop treating on-chain ids as codegen OUTPUT. Treat them as loaded
// CONFIG DATA. Codegen is a deterministic, stack-free function
// `(Move source, id-config?) → generated`. Booting a stack's only new
// job is to PRODUCE this file; the codegen verb READS it (or runs with
// none); the vite plugin INJECTS it into the app build/dev server.
//
// Four authors/consumers, one shared schema:
//   - WRITER:   `orchestrators/boot.ts` post-acquire assembles this from
//               acquired plugin state and writes it to the gitignored
//               `.devstack/stacks/<name>/devstack-ids.json`.
//   - READER:   the stack-free `devstack codegen` verb reads it via the
//               optional `--config <file>` flag (absent ⇒ ids unresolved).
//   - CONSUMER: the emitted `config-runtime.ts` resolver reads the same
//               shape off the injected `__DEVSTACK_IDS__` global.
//   - INJECTOR: the vite plugin reads the live file (dev) or a committed
//               id-config file (prod, via `ids`/`DEVSTACK_IDS_FILE`) and
//               `define`s the global.
//
// The shape is the id-half of today's `config.ts`: networks (rpc + the
// rest), per-package ids (+ captured object ids), account addresses, and
// the MVR placeholder → id override map an app feeds dapp-kit.

import { Effect, FileSystem, Schema } from 'effect';

import { atomicWriteFile } from '../../substrate/runtime/atomic-write.ts';
import {
	decodeJsonText,
	decodeJsonTextSync,
	type RuntimeDecodeIssue,
} from '../../substrate/runtime/runtime-decode.ts';

// -----------------------------------------------------------------------------
// Sentinel — the all-zero id that marks an UNRESOLVED on-chain id.
// -----------------------------------------------------------------------------

/** The all-zero Sui object id used as the placeholder for an unresolved
 *  (stack-free) id. A committed `config.ts` resolver treats this value —
 *  and a missing id — identically: it THROWS `DevstackConfigMissingError`
 *  at access time (see `config-runtime.ts`). Apps never transact with it. */
export const UNRESOLVED_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** True when `id` is absent or the all-zero sentinel — i.e. not a real
 *  resolved on-chain id. */
export const isUnresolvedId = (id: string | undefined | null): boolean =>
	id === undefined || id === null || id === UNRESOLVED_ID;

// -----------------------------------------------------------------------------
// JSON value space — the generic `values` channel carries exactly JSON.
// -----------------------------------------------------------------------------

/** Any JSON-serialisable value. The id-config round-trips through
 *  `JSON.stringify` into the injected `__DEVSTACK_IDS__` global, so a
 *  plugin live value carried in the generic `values` channel must be JSON. */
export type JsonValue =
	| null
	| string
	| number
	| boolean
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue };

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/** One `networks.<name>` entry — the connection coordinates for a
 *  network. Mirrors `SuiNetworkConfigEntry` (plugins/sui/codegen.ts);
 *  `rpc` is the load-bearing field the app reads synchronously at module
 *  load. */
export const IdConfigNetworkSchema = Schema.Struct({
	rpc: Schema.String,
	chainId: Schema.optional(Schema.String),
	faucet: Schema.optional(Schema.NullOr(Schema.String)),
	graphql: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One `packages.<name>` entry — the resolved package id plus any
 *  resolved object captures for the active network. */
export const IdConfigPackageSchema = Schema.Struct({
	id: Schema.String,
	objects: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** A JSON-serialisable value carried in the generic `values` channel.
 *  The whole id-config round-trips through `JSON.stringify` into the
 *  vite `define` global, so the value space is exactly JSON. */
// Typed as `Schema.Codec<JsonValue>` (NOT `Schema.Schema<JsonValue>`): the
// type-only `Schema<T>` widens `DecodingServices` to `unknown`, which would
// poison every decoder of `IdConfigSchema`; `Codec<T>` defaults the decode/
// encode services to `never`, matching the real (service-free) recursion.
export const IdConfigJsonSchema: Schema.Codec<JsonValue> = Schema.suspend(() =>
	Schema.Union([
		Schema.Null,
		Schema.String,
		Schema.Number,
		Schema.Boolean,
		Schema.Array(IdConfigJsonSchema),
		Schema.Record(Schema.String, IdConfigJsonSchema),
	]),
) as Schema.Codec<JsonValue>;

/** The generic resolver channel: a two-level namespaced map of arbitrary
 *  JSON values a plugin contributes at boot and the committed `config.ts`
 *  reads back via `resolveValue(namespace, key)`. This is the open-ended
 *  sibling to the typed `network`/`networks`/`packages`/`accounts`/
 *  `mvrOverrides` fields — it carries the plugin live values the fixed
 *  channel can't (deepbook pool ids, coin types, walrus/seal endpoints). */
export const IdConfigValuesSchema = Schema.Record(
	Schema.String,
	Schema.Record(Schema.String, IdConfigJsonSchema),
);

/** The id-config interchange shape. The whole document is data — no
 *  functions, no devstack imports — so it round-trips through JSON and a
 *  `JSON.stringify` into a vite `define` global. */
export const IdConfigSchema = Schema.Struct({
	/** Active network name (the `networks.<name>` key the app reads).
	 *  Load-bearing — an id-config MUST name its network + connection. */
	network: Schema.String,
	networks: Schema.Record(Schema.String, IdConfigNetworkSchema),
	/** Resolved package ids (+ object captures). Optional, default `{}`: an
	 *  id-config may have zero packages (a network-only stack, or a
	 *  hand-authored deploy file), and the boot writer always emits the key
	 *  anyway — defaulting keeps the injected blob well-formed so the app's
	 *  resolvers throw `DevstackConfigMissingError` rather than a raw
	 *  TypeError on a missing section. */
	packages: Schema.Record(Schema.String, IdConfigPackageSchema).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({})),
	),
	accounts: Schema.Record(Schema.String, Schema.String).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({})),
	),
	/** MVR placeholder (`@local/<slug>`) → resolved id, for the active
	 *  network. An app feeds this straight into dapp-kit's
	 *  `mvr.overrides.packages`. Optional, default `{}` (see `packages`). */
	mvrOverrides: Schema.Record(Schema.String, Schema.String).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({})),
	),
	/** Generic resolver channel — `values[namespace][key]` carries
	 *  arbitrary live plugin JSON the typed fields above can't. Optional
	 *  so older id-config files (no `values`) still decode. */
	values: Schema.optional(IdConfigValuesSchema),
});

export type IdConfig = typeof IdConfigSchema.Type;
export type IdConfigNetwork = typeof IdConfigNetworkSchema.Type;
export type IdConfigPackage = typeof IdConfigPackageSchema.Type;
export type IdConfigValues = typeof IdConfigValuesSchema.Type;

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

/** Failure reading or decoding an id-config file. */
export class IdConfigError extends Schema.TaggedErrorClass<IdConfigError>()('IdConfigError', {
	source: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

// -----------------------------------------------------------------------------
// Read / write helpers
// -----------------------------------------------------------------------------

/** Canonical filename of the per-stack id-config under
 *  `.devstack/stacks/<name>/`. */
export const ID_CONFIG_FILENAME = 'devstack-ids.json';

/** Write the id-config as pretty JSON. Idempotent at the byte level for
 *  identical input (sorted by the caller's assembly order). */
export const writeIdConfig = (
	path: string,
	config: IdConfig,
): Effect.Effect<void, IdConfigError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const text = `${JSON.stringify(config, null, 2)}\n`;
		const bytes = new TextEncoder().encode(text);
		// Atomic temp+rename — the Vite plugin reads this file with a plain
		// `readFileSync` + `JSON.parse`, so a torn / partial write would surface
		// as a parse error. `atomicWriteFile` ensures the parent dir (the
		// id-config write may run before the manifest write) and fsyncs before
		// the rename, so readers only ever see a complete file.
		yield* atomicWriteFile(path, bytes, { mode: 0o644 }).pipe(
			Effect.mapError(
				(cause) => new IdConfigError({ source: path, message: 'failed to write id-config', cause }),
			),
		);
	});

/** Project a runtime-decode issue into the typed `IdConfigError`. */
const mkIdConfigError = (issue: RuntimeDecodeIssue): IdConfigError =>
	new IdConfigError({
		source: issue.source,
		message: issue.message,
		...(issue.cause === undefined ? {} : { cause: issue.cause }),
	});

/** Decode + validate an id-config from already-read JSON text. The single
 *  schema-decode seam every reader shares (the Vite plugin, the `dump-ids`
 *  verb, the codegen verb) so the parse-and-validate decision lives in ONE
 *  place rather than each caller hand-rolling `JSON.parse`. Throws
 *  `IdConfigError` on malformed JSON or a shape that violates
 *  `IdConfigSchema`. */
export const decodeIdConfig = (text: string): IdConfig =>
	decodeJsonTextSync(IdConfigSchema, text, {
		source: ID_CONFIG_FILENAME,
		mkError: mkIdConfigError,
	});

/** Read + decode the id-config at `path`. Resolves to `null` when the file
 *  is absent (no stack booted / no committed id-config); fails with
 *  `IdConfigError` on a read error or a malformed/invalid file. The Effect
 *  reader for Effect callers (`dump-ids`, the codegen verb); the Vite plugin
 *  is sync and uses {@link decodeIdConfig} over its own `readFileSync`. */
export const readIdConfig = (
	path: string,
): Effect.Effect<IdConfig | null, IdConfigError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return null;
		const text = yield* fs
			.readFileString(path)
			.pipe(
				Effect.mapError(
					(cause) =>
						new IdConfigError({ source: path, message: 'failed to read id-config', cause }),
				),
			);
		return yield* decodeJsonText(IdConfigSchema, text, { source: path, mkError: mkIdConfigError });
	});
