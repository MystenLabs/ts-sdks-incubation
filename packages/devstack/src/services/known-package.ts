// KnownPackage(name, opts) — declare a remote/well-known Move package
// without publishing one from local source. Lets `Codegen` emitters
// (`DappKitEmitter`, future user emitters) reference packages whose id
// is fixed on the target network — testnet deepbook, mainnet seal,
// vendored utility packages — and surface them in generated code
// alongside locally-deployed packages.
//
// Unlike `Package(name, source, opts)`, `KnownPackage` doesn't run
// `sui client publish` — there's no Move source on disk, no
// `sourcePath`, no on-chain side effect. The resulting Ref satisfies
// `PackageShape` (not `LocalPackageShape`) so the type system rules
// out passing a KnownPackage where a Move-source-required emitter
// (e.g. `BindingsEmitter`) expects it.

import { Effect } from 'effect';
import { tag } from '../advanced/tag.js';
import { PackageRegistry } from '../engine/registries.js';
import type { PackageShape } from './package.js';

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
}

/** Declare a `Package`-shaped Ref backed by a fixed on-chain
 *  `packageId`. Useful for referencing testnet/mainnet packages, or
 *  any package the user didn't publish themselves but wants threaded
 *  through `Codegen` / `Action({ needs })` / cross-reference flows. */
export const KnownPackage = <const N extends string>(name: N, opts: KnownPackageOptions) => {
	const shape: PackageShape = {
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
			yield* PackageRegistry.publish({
				name,
				packageId: opts.packageId,
				...(opts.upgradeCapId !== undefined ? { upgradeCapId: opts.upgradeCapId } : {}),
				...(opts.mvrPlaceholder !== undefined ? { mvrPlaceholder: opts.mvrPlaceholder } : {}),
			});
			return shape;
		}),
		{
			kind: 'package',
			displayTitle: `packages.${name}`,
			display: (s: PackageShape) => ({
				title: `packages.${s.name}`,
				primary: s.packageId,
				extras: ['known'],
			}),
		},
	);
};
