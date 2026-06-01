// Package plugin — Codegenable contribution.
//
// Distilled doc §Outputs: "Bindings input — the source path of every
// local Package is read by the bindings emitter (KnownPackages
// filtered out)."
//
// The contribution emitted here is the LIGHTWEIGHT one: package id +
// MVR placeholder + (for local packages) the source path the
// bindings emitter consumes. The HEAVY codegen — `@mysten/codegen`
// emitting typed function shims — happens in the codegen
// ORCHESTRATOR (plugin/codegen layer, NOT this plugin). The
// orchestrator walks every member's caps tuple, finds the
// Package-emitted contributions, and dispatches `@mysten/codegen`
// once across all of them so a single TS program references every
// emitted package binding.
//
// This file therefore declares the SEAM, not the binding bytes.
//
// The package contribution is `aggregateOnly`: it projects into the
// combined `generated/config.ts` (`config.packages.<name>` +
// top-level `config.objects.<name>`) and emits NO standalone
// `package/<name>.ts`. The `packageBindings` value is still exported
// on the emit context so the orchestrator's `isPackageBindings` seam
// forwards it to the Move-bindings emitter (bindings stay in
// `generated/bindings/`).

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ResolvedLocalPackage, ResolvedKnownPackage } from './registry.ts';

/** Per-network declared ids — pure literals the user supplies for
 *  prod-targeting (`testnet`/`mainnet`). No resolution. */
export interface PackageNetworkEntry {
	readonly packageId: string;
	readonly objects?: Readonly<Record<string, string>>;
}

export type PackageNetworks = Readonly<Record<string, PackageNetworkEntry>>;

/** Codegenable shape — what each Package contributes to the codegen
 *  orchestrator. Two variants mirror the local/known split. */
export interface PackageBindings {
	readonly name: string;
	readonly packageId: string;
	readonly mvrPlaceholder: string;
	/** Present for local packages only — the bindings emitter reads
	 *  this; KnownPackages omit it and the orchestrator skips them
	 *  for bindings emission (compile-time enforcement at the
	 *  factory layer per distilled doc Invariant 9). */
	readonly sourcePath: string | null;
	/** Per-package opt-out (distilled doc §Inputs — "Codegen
	 *  exclusion flag"). */
	readonly excluded: boolean;
}

/** Type guard for the `packageBindings` shape emitted into the
 *  CodegenEmitContext below. Lives in the plugin so the codegen
 *  orchestrator never has to recognize the shape — it only calls
 *  the projector. */
export const isPackageBindings = (v: unknown): v is PackageBindings =>
	typeof v === 'object' &&
	v !== null &&
	'name' in v &&
	'packageId' in v &&
	'mvrPlaceholder' in v &&
	'sourcePath' in v;

/** The typed shape one `config.packages.<name>` entry exports. */
export interface PackageConfigEntry {
	readonly mvr: string;
	/** Convenience = `byNetwork[config.network]` (the active network's
	 *  id). */
	readonly packageId: string;
	readonly byNetwork: Readonly<Record<string, string>>;
	/** Resolved (local) + declared (prod) object ids for the active
	 *  network. Present only when at least one object is known. */
	readonly objects?: Readonly<Record<string, string>>;
}

interface PackageProjectionInput {
	readonly name: string;
	readonly packageId: string;
	readonly mvrPlaceholder: string;
	readonly sourcePath: string | null;
	readonly excluded: boolean;
	/** Resolved local object captures (keyed by user `capture` name).
	 *  Surfaced into `config.objects.<name>` + `packages.<name>.objects`
	 *  for the active (local) network. */
	readonly captured: Readonly<Record<string, string>>;
	/** Declared per-network literals (testnet/mainnet). */
	readonly networks?: PackageNetworks;
}

/** Aggregate projection: fold this package into the combined
 *  `config.ts` aggregate under `packages.<name>` (with `byNetwork`
 *  + `objects`) and the top-level `objects.<name>` mirror. The
 *  orchestrator stays name-blind and deep-merges this with sui's
 *  `networks.local` and every other package's slice. */
const projectPackageConfig = (
	exported: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null => {
	const projection = exported['__packageConfig'];
	if (typeof projection !== 'object' || projection === null) return null;
	const input = projection as PackageProjectionInput;

	// `byNetwork.local` = the resolved local id; declared `networks`
	// literals fill the other networks (testnet/mainnet).
	const byNetwork: Record<string, string> = { local: input.packageId };
	for (const [net, entry] of Object.entries(input.networks ?? {})) {
		byNetwork[net] = entry.packageId;
	}

	// Active-network objects: local = captured ids. (Prod object
	// selection happens at consume-time by flipping `config.network`;
	// the local entry is what the dev runtime reads.)
	const objects =
		Object.keys(input.captured).length > 0 ? { ...input.captured } : undefined;

	const packageEntry: PackageConfigEntry = {
		mvr: input.mvrPlaceholder,
		packageId: input.packageId,
		byNetwork,
		...(objects !== undefined ? { objects } : {}),
	};

	return {
		packages: { [input.name]: packageEntry },
		...(objects !== undefined ? { objects: { [input.name]: objects } } : {}),
	};
};

/** Build the Codegenable contribution for a local package. */
export const makeLocalCodegenable = (
	resolved: ResolvedLocalPackage,
	options: { readonly excluded: boolean; readonly networks?: PackageNetworks },
): CodegenableDecl<'package'> => ({
	kind: 'codegenable',
	emitterName: 'package',
	// Dead output path — `aggregateOnly` skips the standalone file. The
	// distinct per-name value keeps path-resolution well-formed.
	outputPath: `package/${resolved.mvrPlaceholder}.ts`,
	// One Package contribution per published package. The shared
	// `'package'` emitter name is by-design — the codegen orchestrator
	// skips its emitter-name uniqueness check for this flag.
	allowEmitterNameRepetition: true,
	aggregateOnly: true,
	aggregate: {
		kind: 'package',
		bucket: 'config.ts',
		project: projectPackageConfig,
	},
	emit: (ctx) =>
		Effect.sync(() => {
			// `packageBindings` feeds the orchestrator's `isPackageBindings`
			// seam → the Move-bindings emitter (bindings stay in
			// `generated/bindings/`). `__packageConfig` feeds the
			// `config.ts` aggregate projector.
			ctx.exportConst('packageBindings', {
				name: resolved.name,
				packageId: resolved.packageId,
				mvrPlaceholder: resolved.mvrPlaceholder,
				sourcePath: resolved.sourcePath,
				excluded: options.excluded,
			} satisfies PackageBindings);
			ctx.exportConst('__packageConfig', {
				name: resolved.name,
				packageId: resolved.packageId,
				mvrPlaceholder: resolved.mvrPlaceholder,
				sourcePath: resolved.sourcePath,
				excluded: options.excluded,
				captured: resolved.captured,
				...(options.networks !== undefined ? { networks: options.networks } : {}),
			} satisfies PackageProjectionInput);
			return ctx.done();
		}),
});

/** Build the Codegenable contribution for a known package. The
 *  shape is identical except `sourcePath: null` and no captured
 *  object ids. */
export const makeKnownCodegenable = (
	resolved: ResolvedKnownPackage,
	options: { readonly networks?: PackageNetworks } = {},
): CodegenableDecl<'package'> => ({
	kind: 'codegenable',
	emitterName: 'package',
	outputPath: `package/${resolved.mvrPlaceholder}.ts`,
	// Mirrors `makeLocalCodegenable` — one Package contribution per
	// known package.
	allowEmitterNameRepetition: true,
	aggregateOnly: true,
	aggregate: {
		kind: 'package',
		bucket: 'config.ts',
		project: projectPackageConfig,
	},
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('packageBindings', {
				name: resolved.name,
				packageId: resolved.packageId,
				mvrPlaceholder: resolved.mvrPlaceholder,
				sourcePath: null,
				excluded: true, // implicit — KnownPackages never emit bindings.
			} satisfies PackageBindings);
			ctx.exportConst('__packageConfig', {
				name: resolved.name,
				packageId: resolved.packageId,
				mvrPlaceholder: resolved.mvrPlaceholder,
				sourcePath: null,
				excluded: true,
				captured: {},
				...(options.networks !== undefined ? { networks: options.networks } : {}),
			} satisfies PackageProjectionInput);
			return ctx.done();
		}),
});
