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

/** Codegen-emitted shape for seal. */
export interface SealBindings {
	readonly name: string;
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;
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
						value: known.serverConfigs as unknown as JsonValue,
					},
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
						tsType:
							'ReadonlyArray<{ readonly objectId: string; readonly weight: number; readonly aggregatorUrl?: string }>',
						live: (s) => s.serverConfigs as unknown as JsonValue,
					},
				];
	return keyedBucketSpec({ bucket: 'seal.ts', kind: 'seal', key: structural.name, fields });
};

/** Build the LIVE Codegenable contribution for a seal instance. Bakes the
 *  resolved key-server fields + feeds the generic deployment `values`
 *  channel. */
export const makeSealCodegenable = (bindings: SealBindings): CodegenableDecl =>
	liveBucketCodegen(sealBucketSpec({ name: bindings.name, mode: bindings.mode }), bindings);

/** Build the STATIC (stack-free) Codegenable contribution for a seal
 *  instance. Emits `requireValue(dep, 'seal:<name>', '<key>')` for the runtime
 *  fields; the committed `seal.ts` carries no baked object id / endpoint URL. */
export const makeSealStaticCodegen = (config: SealStaticConfig): CodegenableDecl =>
	staticBucketCodegen(sealBucketSpec(config));
