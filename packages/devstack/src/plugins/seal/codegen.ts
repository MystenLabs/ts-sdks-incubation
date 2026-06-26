// Seal plugin — Codegenable contribution, via the UNIFIED config-binding
// declaration.
//
// The seal plugin contributes ONE codegen shape — the `seal-key-server`
// config the user-facing bindings consume to construct a `SealClient`.
//
// ONE declaration, TWO derivations (see `contracts/config-bindings.ts`). Every
// seal instance folds into a single `generated/seal.ts` exporting
// `export const seal = { <name>: SealBindings, ... }` (sibling-keyed bucket):
//   - LIVE (boot): bakes the resolved key-server object id / URL / configs
//     AND feeds the generic deployment `values` channel.
//   - STATIC (committed tree): emits `requireValue(dep, 'seal:<name>', '<key>')`
//     so the committed `seal.ts` carries NO baked object id / endpoint URL.
//
// STRUCTURAL fields (`name`, `mode`) stay literals; the object id, key-server
// URL, and `serverConfigs` committee (an array blob) are RUNTIME (loaded
// config data), resolved at app build/dev time.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import {
	keyedBucketSpec,
	liveBucketCodegen,
	staticBucketCodegen,
	type BucketField,
	type SiblingBucketSpec,
} from '../../contracts/config-bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/deployment.ts';
import type { SealKeyServerEntry } from './registry-publish.ts';

/** Static-codegen TS type for the `serverConfigs` field — mirrors
 *  `SealKeyServerEntry` (the structural literal so the committed `seal.ts`
 *  carries the concrete type with NO emitted import). The `apiKey?` slot is
 *  kept in the TYPE so a consumer can inject the secret at runtime, but devstack
 *  never emits a `apiKey` VALUE (see `stripApiKey`). */
const SERVER_CONFIGS_TS_TYPE =
	'ReadonlyArray<{ readonly objectId: string; readonly weight: number; readonly apiKeyName?: string; readonly apiKey?: string; readonly aggregatorUrl?: string }>';

/** Defense-in-depth: drop any `apiKey` from an emitted `serverConfigs` array.
 *  devstack NEVER carries the secret committee apiKey value — both the committed
 *  `seal.ts` and the browser-injected `deployment.json` (the `values` channel)
 *  are world-readable. `validateLiveInputs` already refuses to accept an apiKey,
 *  so this is belt-and-suspenders at the codegen boundary. The app injects the
 *  apiKey into `serverConfigs` at runtime, keyed by the emitted non-secret
 *  `apiKeyName`. */
const stripApiKey = (serverConfigs: ReadonlyArray<SealKeyServerEntry>): JsonValue =>
	serverConfigs.map((entry) => {
		const rest: Record<string, unknown> = { ...entry };
		delete rest.apiKey;
		return rest;
	}) as unknown as JsonValue;

/** Codegen-emitted shape for seal. */
export interface SealBindings {
	readonly name: string;
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;
	/** Whether the SDK should verify the key servers (true on live /
	 *  fork-known, false on local-keygen). Declared config — known at
	 *  factory time, emitted as a plain boolean literal (never a
	 *  `requireValue`, since it's not a secret). */
	readonly verifyKeyServers: boolean;
	readonly mode: 'local-keygen' | 'live' | 'fork-known';
}

/** User-declared known seal ids, available at factory time. The `live` and
 *  `fork-known` modes resolve their `{objectId, keyServerUrl, serverConfigs}`
 *  tuple at factory time (DECLARED config), so the committed `seal.ts` bakes
 *  them as LITERALS. Absent for `local-keygen` (dev-deployed) whose key-server
 *  ids/URL are dynamic. */
export interface SealKnownIds {
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;
	readonly verifyKeyServers: boolean;
}

/** Static-config shape a seal instance knows BEFORE acquire — the
 *  structural names the stack-free `staticCodegen` hook needs. When `known`
 *  is present (live / fork-known), its declared ids are baked as literals;
 *  otherwise (local-keygen) every id resolves at app build/dev time. */
export interface SealStaticConfig {
	readonly name: string;
	readonly mode: SealBindings['mode'];
	readonly known?: SealKnownIds;
}

type SealLiveState = SealBindings;

/** Build the seal instance's config-binding spec for `name`. `name` / `mode`
 *  are structural literals. For a `local-keygen` instance the object id / URL
 *  are dynamically-deployed (`requireValue(dep, …)`) and `serverConfigs` is a runtime
 *  committee blob; for a `live` / `fork-known` instance these are DECLARED
 *  config, baked as literals. */
const sealBucketSpec = (structural: SealStaticConfig): SiblingBucketSpec<SealLiveState> => {
	const known = structural.known;
	const fields: ReadonlyArray<BucketField<SealLiveState>> =
		known !== undefined
			? [
					{ key: 'name', variant: 'literal', value: structural.name },
					{ key: 'mode', variant: 'literal', value: structural.mode },
					{ key: 'objectId', variant: 'literal', value: known.objectId },
					{ key: 'keyServerUrl', variant: 'literal', value: known.keyServerUrl },
					{
						key: 'serverConfigs',
						variant: 'literal',
						// Bake objectId / weight / aggregatorUrl / apiKeyName as literals.
						// Any apiKey is stripped — devstack never carries the secret; the
						// app injects it at runtime keyed by apiKeyName.
						value: stripApiKey(known.serverConfigs),
					},
					// Declared config: a plain boolean literal (not a secret, so never
					// a `requireValue`). True on live / fork-known.
					{ key: 'verifyKeyServers', variant: 'literal', value: known.verifyKeyServers },
				]
			: [
					{ key: 'name', variant: 'literal', value: structural.name },
					{ key: 'mode', variant: 'literal', value: structural.mode },
					{ key: 'objectId', variant: 'resolved', tsType: 'string', live: (s) => s.objectId },
					{
						key: 'keyServerUrl',
						variant: 'resolved',
						tsType: 'string',
						live: (s) => s.keyServerUrl,
					},
					{
						key: 'serverConfigs',
						variant: 'resolved',
						// Inline structural literal mirroring `SealKeyServerEntry` so the
						// committed `seal.ts` carries the concrete type (no emitted import).
						// `stripApiKey` guards the world-readable `values` channel — the
						// resolved blob must never carry a secret apiKey.
						tsType: SERVER_CONFIGS_TS_TYPE,
						live: (s) => stripApiKey(s.serverConfigs),
					},
					{
						key: 'verifyKeyServers',
						variant: 'resolved',
						tsType: 'boolean',
						live: (s) => s.verifyKeyServers,
					},
				];
	return keyedBucketSpec({ bucket: 'seal.ts', kind: 'seal', key: structural.name, fields });
};

/** Build the LIVE Codegenable contribution for a seal instance.
 *
 *  Live / fork-known deployments resolve their ids at factory time, so they
 *  are DECLARED config — pass `known` so they bake as literals (the SAME branch
 *  the static codegen uses). This keeps the two derivations consistent AND
 *  keeps the known `serverConfigs` OUT of the world-readable `values` channel
 *  entirely (literals don't ride `values`). Only `local-keygen`'s
 *  dynamically-deployed ids flow through the resolved/`values` channel. */
export const makeSealCodegenable = (bindings: SealBindings): CodegenableDecl => {
	const known: SealKnownIds | undefined =
		bindings.mode === 'local-keygen'
			? undefined
			: {
					objectId: bindings.objectId,
					keyServerUrl: bindings.keyServerUrl,
					serverConfigs: bindings.serverConfigs,
					verifyKeyServers: bindings.verifyKeyServers,
				};
	return liveBucketCodegen(
		sealBucketSpec({ name: bindings.name, mode: bindings.mode, known }),
		bindings,
	);
};

/** Build the STATIC (stack-free) Codegenable contribution for a seal
 *  instance. Emits `requireValue(dep, 'seal:<name>', '<key>')` for the runtime
 *  fields; the committed `seal.ts` carries no baked object id / endpoint URL. */
export const makeSealStaticCodegen = (config: SealStaticConfig): CodegenableDecl =>
	staticBucketCodegen(sealBucketSpec(config));
