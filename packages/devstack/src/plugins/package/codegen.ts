// Package plugin — Codegenable contribution, via the UNIFIED config-binding
// declaration.
//
// Distilled doc §Outputs: "Bindings input — the source path of every local
// Package is read by the bindings emitter (KnownPackages filtered out)."
//
// The contribution emitted here is the LIGHTWEIGHT one: package id + MVR
// placeholder + (for local packages) the source path the bindings emitter
// consumes. The HEAVY codegen — `@mysten/codegen` emitting typed function
// shims — happens in the codegen ORCHESTRATOR (NOT this plugin). This file
// declares the SEAM, not the binding bytes.
//
// ONE declaration, TWO derivations. A package declares its `config.ts`
// contributions ONCE as a `ConfigBindingSet`; the framework's
// `projectLiveConfig` / `projectStaticConfig` derive both behaviors:
//   - LIVE (boot): bakes the resolved package id literal — boot's
//     `assembleDeployment` reads it into the loadable deployment.
//   - STATIC (committed-tree): emits `resolveId('<mvr>')` so the committed
//     `config.ts` carries NO on-chain id (resolved at app build/dev time).
//
// The package contribution is `aggregateOnly`: it projects into the combined
// `generated/config.ts` (`config.packages.<name>` + top-level
// `config.objects.<name>`) and emits NO standalone `package/<name>.ts`. The
// `packageBindings` value is still exported on the emit context so the
// orchestrator's `isPackageBindings` seam forwards it to the Move-bindings
// emitter (bindings stay in `generated/bindings/`).

import type { CodegenableDecl, StaticCodegenSource } from '../../contracts/codegenable.ts';
import {
	configCodegenable,
	type ConfigBinding,
	type ConfigBindingSet,
} from '../../contracts/config-bindings.ts';
import type { PackageBindings } from '../../orchestrators/codegen/bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/deployment.ts';
import { mvrNamedForm, mvrNamedFormFrom } from './dep-resolution.ts';
import type { ResolvedLocalPackage, ResolvedKnownPackage } from './registry.ts';

/** Codegenable shape — what each Package contributes to the codegen
 *  orchestrator. Defined once on the orchestrator's `emitBindings` consumer
 *  contract (`orchestrators/codegen/bindings.ts`); re-exported here as the
 *  package plugin's public surface. */
export type { PackageBindings };

/** The typed shape one `config.packages.<name>` entry exports. Per-network
 *  package ids now live in the injected deployment envelope (live local +
 *  committed `deployments/<net>.ts`), resolved via
 *  `config.forNetwork(net).packages.<name>.id` — so this entry carries only
 *  the MVR placeholder + the default-network convenience id. */
export interface PackageConfigEntry {
	readonly mvr: string;
	/** The default (local) network's resolved id. */
	readonly packageId: string;
	/** Resolved (local) object ids for the default network. Present only
	 *  when at least one object is known. */
	readonly objects?: Readonly<Record<string, string>>;
}

/** The state the LIVE binding derivation reads — the resolved package's
 *  active-network id + captured object ids. */
interface PackageLiveState {
	readonly packageId: string;
	readonly captured: Readonly<Record<string, string>>;
}

interface PackageBindingInput {
	readonly name: string;
	readonly mvrPlaceholder: string;
	/** Pinned literal id (KNOWN package with a declared id). When set, the
	 *  active-network id is a LITERAL binding (identical in both paths). When
	 *  absent (a LOCAL package, or a KNOWN-shaped local stub), the id is a
	 *  RESOLVED binding: static emits `resolveId('<mvr>')`, live computes the
	 *  real resolved id from acquired state. */
	readonly pinnedId?: string | undefined;
	/** Resolved local object captures (keyed by user `capture` name).
	 *  Surfaced into `config.objects.<name>` + `packages.<name>.objects`
	 *  for the active (local) network. Empty on the committed-stub path —
	 *  the captured IDS are loaded config data (resolved at app build/dev
	 *  time), so the static path emits `resolveValue` from `objectKeys`. */
	readonly captured: Readonly<Record<string, string>>;
	/** The capture KEYS this package declares (the user `capture` option's
	 *  key set, known at config time). Drives the object-id bindings on BOTH
	 *  paths so the committed stub carries `resolveValue('package:<name>:
	 *  objects', '<key>')` references rather than a live-only `objects` field.
	 *  When omitted, falls back to the keys present in `captured` (live path).
	 */
	readonly objectKeys?: ReadonlyArray<string> | undefined;
	/** OPT-IN Move datatypes to expose as MVR `types` overrides. Each entry is a
	 *  `'<module>::<Name>'` suffix relative to this package (the `@local/<slug>`
	 *  prefix is implied). Each emits one
	 *  `mvrOverrides.types['@local/<slug>::<module>::<Name>']` whose static value
	 *  resolves per-network as `` `${requireId(dep, "<mvr>")}::<module>::<Name>` ``.
	 *  Absent / empty ⇒ no `types` entries (the orchestrator emits `types: {}`).
	 *  Identical on the live and static paths (config-known, resolution-
	 *  independent); the live deployment slice ignores the value (keeps
	 *  `types: {}`). */
	readonly mvrTypes?: ReadonlyArray<string> | undefined;
}

/** Validate + normalize a declared MVR-type suffix. Entries are
 *  `'<module>::<Name>'` relative to the package; we reject anything that does
 *  not parse as two `::`-joined Move identifiers so a typo fails at config time
 *  rather than emitting an `isValidNamedType`-rejected key into the override
 *  map. The `@local/<slug>::` prefix is implied (and stripped if the developer
 *  redundantly included it). */
const normalizeMvrTypeSuffix = (packageName: string, mvr: string, entry: string): string => {
	// Tolerate a redundant `@local/<slug>::` prefix the developer may have
	// pasted from a fully-qualified tag.
	const suffix = entry.startsWith(`${mvr}::`) ? entry.slice(mvr.length + 2) : entry;
	if (!/^[A-Za-z_][\w]*::[A-Za-z_][\w]*$/.test(suffix)) {
		throw new Error(
			`localPackage('${packageName}') mvrTypes entry '${entry}' must be '<module>::<Name>' ` +
				`(two Move identifiers joined by '::'); the '${mvr}' package prefix is implied.`,
		);
	}
	return suffix;
};

/**
 * Build the package's config-binding set, declared ONCE. The `name` keys the
 * `config.packages.<name>` entry; `mvrPlaceholder` is a literal in both paths;
 * the active-network id is a RESOLVED binding (sugar `resolveId('<mvr>')` when
 * `resolveViaRuntime`, otherwise a literal already-known id). Declared
 * per-network literals (testnet/mainnet) and captured objects are literals.
 *
 * The same set drives `projectStaticConfig` (committed tree) and
 * `projectLiveConfig` (boot deployment) — no parallel projectors.
 */
const packageConfigBindings = (input: PackageBindingInput): ConfigBindingSet<PackageLiveState> => {
	const { name, mvrPlaceholder } = input;

	const bindings: Array<ConfigBinding<PackageLiveState>> = [];

	// `packages.<name>.mvr` — pure literal in both paths.
	bindings.push({
		variant: 'literal',
		configPath: ['packages', name, 'mvr'],
		value: mvrPlaceholder,
	});

	// The active-network id binding. Two cases:
	//   - no pinned id (LOCAL, or KNOWN-shaped local stub) → RESOLVED (sugar
	//     `resolveId('<mvr>')` static; live = the concrete resolved id from
	//     `state.packageId`).
	//   - pinned literal (KNOWN with a declared id) → LITERAL (the id stands
	//     identically in both paths).
	// Reused for `packages.<name>.packageId` and the `mvrOverrides` entry so
	// both agree.
	const pinned = input.pinnedId;
	const idBinding = (configPath: ReadonlyArray<string>): ConfigBinding<PackageLiveState> =>
		pinned === undefined
			? {
					variant: 'resolved',
					configPath,
					namespace: 'package',
					key: `${name}:packageId`,
					sugar: { kind: 'id', mvrPlaceholder },
					live: (state) => state.packageId,
				}
			: { variant: 'literal', configPath, value: pinned };

	bindings.push(idBinding(['packages', name, 'packageId']));

	// Active-network objects — captured ids (local). The captured ids are
	// LOADED CONFIG DATA, so each is a RESOLVED binding on the generic
	// `resolveValue('package:<name>:objects', '<key>')` channel: the static
	// committed stub emits the resolver expr, the live path bakes the real
	// captured id AND feeds the deployment `values` channel. The key set comes
	// from `objectKeys` (config-known) so BOTH paths emit identical paths —
	// no live-only `objects` field. Falls back to the live capture keys when
	// `objectKeys` is absent (the live emit path).
	const objectKeys = input.objectKeys ?? Object.keys(input.captured);
	if (objectKeys.length > 0) {
		const objectsNamespace = `package:${name}:objects`;
		for (const objectKey of objectKeys) {
			const objectBinding = (
				configPath: ReadonlyArray<string>,
			): ConfigBinding<PackageLiveState> => ({
				variant: 'resolved',
				configPath,
				namespace: objectsNamespace,
				key: objectKey,
				live: (state) => (state.captured[objectKey] ?? null) as JsonValue,
			});
			bindings.push(objectBinding(['packages', name, 'objects', objectKey]));
			// Top-level `objects.<name>.<key>` mirror.
			bindings.push(objectBinding(['objects', name, objectKey]));
		}
	}

	// Active-network MVR override entry — `mvrOverrides.packages.<mvr> = <active
	// id>` (the @mysten MVR override shape's `packages` map). The sibling `types`
	// map is OPT-IN — populated below ONLY from developer-declared `mvrTypes`
	// (the change from auto-enumerating every package type). A resolved binding
	// always emits (the resolver expr / live id); a pinned literal emits only
	// when non-empty.
	if (pinned === undefined || pinned.length > 0) {
		bindings.push(idBinding(['mvrOverrides', 'packages', mvrPlaceholder]));
	}

	// OPT-IN MVR `types` overrides — `mvrOverrides.types['<mvr>::<module>::<Name>']`
	// for each developer-declared `<module>::<Name>`. The static path emits the
	// per-network type tag `` `${requireId(dep, "<mvr>")}::<module>::<Name>` ``
	// (the `mvrType` sugar); the live path's value is ignored by the live
	// deployment slice (`deploymentFromBucket` keeps `types: {}`). Sugar bindings
	// never touch the generic `values` channel. No declared types ⇒ no entries
	// here (the orchestrator emits `types: {}`).
	for (const entry of input.mvrTypes ?? []) {
		const typeSuffix = normalizeMvrTypeSuffix(name, mvrPlaceholder, entry);
		const tag = `${mvrPlaceholder}::${typeSuffix}`;
		bindings.push({
			variant: 'resolved',
			configPath: ['mvrOverrides', 'types', tag],
			namespace: 'package',
			key: `${name}:mvrType:${tag}`,
			sugar: { kind: 'mvrType', mvrPlaceholder, typeSuffix },
			// Ignored by the live deployment slice; a value is required by the
			// binding shape. The resolved per-network tag is what the static
			// committed `config.ts` emits via the sugar.
			live: () => tag,
		});
	}

	return {
		bucket: 'config.ts',
		kind: 'package',
		emitterName: 'package',
		// One Package contribution per published package — shared `'package'`
		// emitter name is by-design (the orchestrator skips its uniqueness
		// check for this flag).
		allowEmitterNameRepetition: true,
		bindings,
	};
};

/**
 * Build the package's `CodegenableDecl` from its binding set via the unified
 * `configCodegenable` derivation. Mode `'live'` bakes concrete values + feeds
 * the deployment; `'static'` emits resolver expressions. The decl ALSO exports
 * `packageBindings` (the `extraExports` hook) so the orchestrator's
 * `isPackageBindings` seam forwards it to the Move-bindings emitter (bindings
 * stay in `generated/bindings/`).
 */
const packageDecl = (
	set: ConfigBindingSet<PackageLiveState>,
	bindings: PackageBindings,
	how: 'static' | { readonly mode: 'live'; readonly state: PackageLiveState },
): CodegenableDecl<'package'> =>
	configCodegenable<PackageLiveState, 'package'>(set, how, {
		extraExports: { packageBindings: bindings },
	});

/** Build the Codegenable contribution for a local package (LIVE path).
 *  Bakes the resolved active-network id + captured objects. */
export const makeLocalCodegenable = (
	resolved: ResolvedLocalPackage,
	options: {
		readonly excluded: boolean;
		/** OPT-IN MVR `types` to expose — `'<module>::<Name>'` suffixes. */
		readonly mvrTypes?: ReadonlyArray<string> | undefined;
	},
): CodegenableDecl<'package'> => {
	// Coerce the resolved placeholder into the current `@local/<slug>` named
	// form at the emit seam rather than trusting it verbatim — a cache-served
	// `mvrPlaceholder` can be a STALE BARE slug. `mvrNamedFormFrom` is pure +
	// deterministic; computed ONCE so the binding default and `config.mvr`
	// stay equal. A LOCAL package has NO pinned id — the active-network id is
	// always a RESOLVED binding (live bakes the real id; static emits
	// `resolveId`).
	const mvrPlaceholder = mvrNamedFormFrom(resolved.mvrPlaceholder);
	const set = packageConfigBindings({
		name: resolved.name,
		mvrPlaceholder,
		captured: resolved.captured,
		...(options.mvrTypes !== undefined ? { mvrTypes: options.mvrTypes } : {}),
	});
	const bindings: PackageBindings = {
		name: resolved.name,
		packageId: resolved.packageId,
		mvrPlaceholder,
		sourcePath: resolved.sourcePath,
		excluded: options.excluded,
	};
	return packageDecl(set, bindings, {
		mode: 'live',
		state: { packageId: resolved.packageId, captured: resolved.captured },
	});
};

/** Build the Codegenable contribution for a known package — `sourcePath:
 *  null`, no captured object ids. A KNOWN package's declared id is a PINNED
 *  LITERAL (not loaded runtime data), so it renders identically in both the
 *  live and static paths. */
export const makeKnownCodegenable = (
	resolved: ResolvedKnownPackage,
	options: { readonly mvrTypes?: ReadonlyArray<string> | undefined } = {},
): CodegenableDecl<'package'> => {
	// Defensive parity with the local emit seam: coerce to the current
	// `@local/<slug>` named form (preserving an already-named override).
	const mvrPlaceholder = mvrNamedFormFrom(resolved.mvrPlaceholder);
	const set = packageConfigBindings({
		name: resolved.name,
		mvrPlaceholder,
		captured: {},
		pinnedId: resolved.packageId,
		...(options.mvrTypes !== undefined ? { mvrTypes: options.mvrTypes } : {}),
	});
	const bindings: PackageBindings = {
		name: resolved.name,
		packageId: resolved.packageId,
		mvrPlaceholder,
		sourcePath: null,
		excluded: true, // implicit — KnownPackages never emit bindings.
	};
	// A pinned literal renders identically in both paths; derive as `static`
	// (the literal bindings ignore live state).
	return packageDecl(set, bindings, 'static');
};

// ---------------------------------------------------------------------------
// Stack-free codegen derivation (the `codegen` verb)
//
// The live `start` body resolves a package (publish/verify) and feeds the
// resolved value into `makeLocalCodegenable` / `makeKnownCodegenable`. The
// `staticCodegen` sources below reconstruct the SAME decls from CONFIG ALONE
// — no chain, no publish — drawing the `packageId` from the projection
// id-resolver (sentinel for `'placeholder'`, declared id for `'known'`). The
// decl SHAPE is identical to the live path.
// ---------------------------------------------------------------------------

/** Build the static (stack-free) codegen source for a LOCAL package.
 *  `sourcePath` is the resolved on-disk Move tree the bindings emitter
 *  compiles (a local `sourcePath`; a git source whose tree has not been
 *  materialized contributes `null`, so the bindings step skips it). */
export const makeLocalStaticCodegen = (config: {
	readonly name: string;
	readonly sourcePath: string | null;
	readonly mvrPlaceholder?: string | undefined;
	readonly excluded: boolean;
	/** Capture KEYS declared by the user `capture` option (config-known).
	 *  The static stub emits `resolveValue('package:<name>:objects', '<key>')`
	 *  for each so the committed tree carries object-id references with NO
	 *  baked id and NO live-only `objects` field. */
	readonly objectKeys?: ReadonlyArray<string> | undefined;
	/** OPT-IN MVR `types` to expose — `'<module>::<Name>'` suffixes. */
	readonly mvrTypes?: ReadonlyArray<string> | undefined;
}): StaticCodegenSource => {
	const mvrPlaceholder = mvrNamedForm(config.mvrPlaceholder ?? config.name);
	return () => {
		// A LOCAL package has no pinned id — resolve the active id at app
		// build/dev time, never embed it in the committed tree. A git source
		// whose tree has NOT been materialized has no local path, so the
		// bindings emitter can't compile it; the `sourcePath` carries through
		// (null → bindings step skips it) but the `config.ts` entry is the same.
		const set = packageConfigBindings({
			name: config.name,
			mvrPlaceholder,
			captured: {},
			...(config.objectKeys !== undefined ? { objectKeys: config.objectKeys } : {}),
			...(config.mvrTypes !== undefined ? { mvrTypes: config.mvrTypes } : {}),
			// No pinned id — the active id resolves at app build/dev time.
		});
		const bindings: PackageBindings = {
			name: config.name,
			// No live publish → the committed stub carries no id (the resolver
			// fills it at app build/dev time). Carry the sentinel-free name.
			packageId: '',
			mvrPlaceholder,
			sourcePath: config.sourcePath,
			excluded: config.sourcePath === null ? true : config.excluded,
		};
		return [packageDecl(set, bindings, 'static')];
	};
};

/** Build the static (stack-free) codegen source for a KNOWN package. Known
 *  packages already carry a literal `packageId` in config; the committed stub
 *  emits it verbatim. */
export const makeKnownStaticCodegen = (config: {
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId?: string | undefined;
	readonly mvrPlaceholder?: string | undefined;
	/** OPT-IN MVR `types` to expose — `'<module>::<Name>'` suffixes. */
	readonly mvrTypes?: ReadonlyArray<string> | undefined;
}): StaticCodegenSource => {
	const mvrPlaceholder = mvrNamedForm(config.mvrPlaceholder ?? config.name);
	return () => {
		const set = packageConfigBindings({
			name: config.name,
			mvrPlaceholder,
			captured: {},
			pinnedId: config.packageId,
			...(config.mvrTypes !== undefined ? { mvrTypes: config.mvrTypes } : {}),
		});
		const bindings: PackageBindings = {
			name: config.name,
			packageId: config.packageId,
			mvrPlaceholder,
			sourcePath: null,
			excluded: true,
		};
		// A known package's literal id renders the same in both paths — derive
		// the decl as `static` (the literal bindings ignore live state).
		return [packageDecl(set, bindings, 'static')];
	};
};
