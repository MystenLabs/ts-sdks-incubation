// KnownPackage(name, opts) — declare a remote/well-known Move package
// without publishing one from local source. Lets `Codegen` emitters
// (`DappKitConfigEmitter`, future user emitters) reference packages
// whose id is fixed on the target network — testnet deepbook, mainnet
// seal, vendored utility packages — and surface them in generated
// code alongside locally-deployed packages.
//
// Unlike `Package(name, source, opts)`, `KnownPackage` doesn't run
// `sui client publish` — there's no Move source on disk, no
// `sourcePath`, no on-chain side effect. The resulting LayeredTag satisfies
// `Package` (not `LocalPackage`) so the type system rules
// out passing a KnownPackage where a Move-source-required emitter
// (e.g. `BindingsEmitter`) expects it.

import { Effect } from 'effect';
import { tag } from '../advanced/tag.js';
import { publishPackage } from '../engine/registries.js';
import type { Package } from './package.js';

export interface KnownPackageOptions {
	/** On-chain package id this name resolves to. */
	readonly packageId: string;
	/** Optional MVR placeholder. When omitted, downstream Codegen
	 *  emitters use `name` directly. */
	readonly mvrPlaceholder?: string;
	/** Optional upgrade-cap id. Most known packages don't have one
	 *  visible to the consumer (the cap lives in whoever deployed the
	 *  package's account), so this is rarely set. */
	readonly upgradeCapId?: string;
	/**
	 * Optional seed-object ids the package depends on at runtime
	 * (Walrus' system object, Deepbook's registry/pools, etc.). When
	 * the supervisor runs a sui-fork stack, these are auto-merged into
	 * `Sui({fork:{seed:{objects: [...]}}})` so the fork pre-fetches
	 * them on first boot — without this, the fork's per-read GraphQL
	 * dial-out would either error or silently degrade to
	 * `ObjectNotFound` (R2). On non-fork stacks (live nets, localnet)
	 * this field is ignored. Phase 3 P3.7 of
	 * `notes/sui-fork-integration.md`.
	 */
	readonly seedObjects?: ReadonlyArray<string>;
}

/** Module-level set of seed objects accumulated by every `KnownPackage`
 *  declared in the current process. `Sui({fork:{...}})`'s `buildFork`
 *  reads this at acquire time and unions it with the user-supplied
 *  `fork.seed.objects` so KnownPackage-declared objects flow through
 *  to the fork's `--object` seed flags automatically.
 *
 *  Lives at module scope (not in a registry) because the consumer is
 *  the *factory* layer of `Sui()` — registries are only available
 *  inside Effect contexts during acquire. The factory needs the values
 *  at composition time so the fork meta-consistency gate (P4.16) can
 *  digest them as part of the config hash.
 *
 *  Order of declarations matters: KnownPackages declared BEFORE the
 *  `Sui()` call see their seed objects merged; KnownPackages declared
 *  AFTER `Sui()` do not (the fork has already digested its seed list
 *  by then). Document this in the example app. */
const accumulatedSeedObjects = new Set<string>();

/** Snapshot the accumulated seed-object set. Used by `services/sui.ts`'s
 *  `buildFork` to merge into the fork's `--object` flags. Returns a
 *  fresh array so subsequent `addKnownPackageSeedObject` calls don't
 *  mutate the caller's view. */
export const collectKnownPackageSeedObjects = (): ReadonlyArray<string> => [
	...accumulatedSeedObjects,
];

/** Clear the accumulated set. Called at the top of each `devstack(...)`
 *  compose so two `devstack(...)` invocations in the same process
 *  (e.g. test files) don't leak state. */
export const clearKnownPackageSeedObjects = (): void => {
	accumulatedSeedObjects.clear();
};

/** Declare a `Package`-shaped LayeredTag backed by a fixed on-chain
 *  `packageId`. Useful for referencing testnet/mainnet packages, or
 *  any package the user didn't publish themselves but wants threaded
 *  through `Codegen` / `Action({ needs })` / cross-reference flows. */
export const KnownPackage = <const N extends string>(name: N, opts: KnownPackageOptions) => {
	// Eagerly accumulate seed objects so the `Sui()` factory (which
	// closures over `fork.seed.objects` at composition time) sees them
	// regardless of compose order — the supervisor doesn't acquire
	// Sui until every factory has run. Same-id duplicates are absorbed
	// by `Set`.
	if (opts.seedObjects !== undefined) {
		for (const obj of opts.seedObjects) accumulatedSeedObjects.add(obj);
	}

	const shape: Package = {
		name,
		packageId: opts.packageId,
		upgradeCapId: opts.upgradeCapId,
	};
	return tag(
		`package/${name}` as const,
		Effect.gen(function* () {
			// Publish to the registry so the v4 manifest emitter picks it
			// up alongside `Package(...)` entries. Without this, downstream
			// readers (dapp-kit, frontend bindings imports) would only see
			// locally-deployed packages.
			yield* publishPackage({
				name,
				packageId: opts.packageId,
				...(opts.upgradeCapId !== undefined ? { upgradeCapId: opts.upgradeCapId } : {}),
				...(opts.mvrPlaceholder !== undefined ? { mvrPlaceholder: opts.mvrPlaceholder } : {}),
			});
			return shape;
		}),
		{
			kind: 'package',
			plugin: 'move',
			displayTitle: `packages.${name}`,
			display: (s: Package) => ({
				title: `packages.${s.name}`,
				primary: s.packageId,
				extras: ['known'],
			}),
		},
	);
};
