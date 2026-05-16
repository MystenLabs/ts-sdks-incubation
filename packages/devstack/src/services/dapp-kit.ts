// DappKit(opts) — convenience facade for the dapp-kit codegen emitter.
// Wraps `Codegen({ emitters: [DappKitEmitter(...)] })` so the
// single-purpose "I want a generated dapp-kit config file" case doesn't
// need the user to declare a separate `Codegen({...})` ref.
//
// Replaces the runtime `createDevstackDappKit(...)` path under
// `@mysten-incubation/devstack/dapp-kit`. The runtime path stays
// available for back-compat until the example apps migrate; new
// code should reach for `DappKit({...})` instead.

import type { Ref } from '../advanced/tag.js';
import {
	DappKitEmitter,
	type DappKitEmitterOptions,
	type DappKitFlavor,
} from '../codegen/emitters/dapp-kit.js';
import { Codegen } from './codegen.js';

export interface DappKitRefOptions {
	/** Packages whose MVR placeholders the generated file folds into
	 *  `mvr.overrides`. Local packages emit their `mvrPlaceholder` →
	 *  `packageId` mapping; `KnownPackage(...)` entries surface their
	 *  fixed id. */
	readonly packages?: ReadonlyArray<Ref<any, any, any, any>>;
	/** Output directory. The generated file lands at
	 *  `<output>/dapp-kit/index.ts`. Defaults to `./src/generated` —
	 *  same canonical default as `Codegen({...})`, so a single
	 *  `<output>/dapp-kit/` lives alongside `<output>/bindings/` under
	 *  one importable source root. */
	readonly output?: string;
	/** Dapp-kit flavor to import from. Defaults to `'react'`. */
	readonly flavor?: DappKitFlavor;
	/** Override the localnet RPC URL baked into the generated file. */
	readonly localnetRpcUrl?: string;
	/** Whether to wire the burner-wallet adapter. Defaults to `true`. */
	readonly enableBurnerWallet?: boolean;
	/** Override tag name. Defaults to `'dapp-kit'`. */
	readonly name?: string;
}

/** DappKit codegen factory. Returns a Ref. Equivalent to:
 *
 *     Codegen({
 *       output: opts.output,
 *       packages: opts.packages,
 *       emitters: [DappKitEmitter({...})],
 *     })
 */
export const DappKit = (opts: DappKitRefOptions = {}) => {
	const emitterOpts: DappKitEmitterOptions = {
		...(opts.flavor !== undefined ? { flavor: opts.flavor } : {}),
		...(opts.localnetRpcUrl !== undefined ? { localnetRpcUrl: opts.localnetRpcUrl } : {}),
		...(opts.enableBurnerWallet !== undefined
			? { enableBurnerWallet: opts.enableBurnerWallet }
			: {}),
	};
	return Codegen({
		// `output` flows through Codegen's own optional default
		// (`./src/generated`) when the caller omits it. Passing through
		// `opts.output` either way keeps `Codegen` as the single source
		// of truth for the default path.
		...(opts.output !== undefined ? { output: opts.output } : {}),
		emitters: [DappKitEmitter(emitterOpts)],
		...(opts.packages !== undefined ? { packages: opts.packages } : {}),
		name: opts.name ?? 'dapp-kit',
	});
};
