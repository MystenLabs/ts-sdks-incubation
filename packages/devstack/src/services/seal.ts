// Seal(opts?) — canonical Seal factory. Auto-picks the local-keygen
// path on localnet (full container + master key + chain registration)
// and the known-key-server path on testnet/mainnet (read-only handle
// pointing at Mysten's public Seal deployment).
//
// Mode override: `{ mode: 'local' }` or `{ mode: 'known' }` forces a
// specific path regardless of the surrounding network.

import {
	sealKnownKeyServer,
	sealLocalKeygen,
	type SealKnownKeyServerOptions,
	type SealLocalKeygenOptions,
} from '../primitives/seal.js';
import type { Account } from '../primitives/shared.js';
import type { PluginTag } from '../advanced/tag.js';
import type { StackMember } from '../engine/supervisor.js';
import { withSection } from './ref.js';

export interface SealOptions {
	/** Which Seal source to use. `'auto'` (default) picks based on the
	 *  surrounding `Sui` network — local on localnet, known otherwise.
	 *  `'local'` forces the in-process keygen + container; `'known'`
	 *  forces a remote handle. */
	readonly mode?: 'auto' | 'local' | 'known';
	/** Signer used to publish the Seal Move package on the local-keygen
	 *  path. Required for `mode: 'local'` (or `'auto'` resolving to local).
	 *  Ignored on `mode: 'known'`. */
	readonly signer?: PluginTag<any, Account, any, any>;
	/** Pass-through extras for the local-keygen path. */
	readonly local?: Omit<SealLocalKeygenOptions<string>, 'name' | 'signer'>;
	/** Pass-through extras for the known-key-server path. */
	readonly known?: SealKnownKeyServerOptions;
	/** Override tag name. Defaults to `'seal'`. */
	readonly name?: string;
}

/** Resolve the seal mode from opts + ambient network. For Phase 2 the
 *  resolution is mode-only — once Phase 6 hooks default-resolution into
 *  `devstack(...)`, `'auto'` consults the merged Sui layer's network
 *  field. Until then `'auto'` defaults to `'local'`. */
const resolveMode = (opts: SealOptions): 'local' | 'known' => {
	if (opts.mode === 'local' || opts.mode === 'known') return opts.mode;
	return 'local';
};

/** Seal factory. Returns a Ref carrying the seal-key-server contract. */
export const Seal = (opts: SealOptions = {}): StackMember => {
	const mode = resolveMode(opts);
	if (mode === 'known') {
		return withSection(sealKnownKeyServer(opts.known ?? {}), 'service');
	}
	if (opts.signer === undefined) {
		throw new Error(
			'Seal({ mode: \'local\' }) requires a `signer:` ref. Pass an Account ref or switch to mode: \'known\'.',
		);
	}
	const localOpts: SealLocalKeygenOptions<string> = {
		signer: opts.signer,
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.local ?? {}),
	};
	return withSection(sealLocalKeygen(localOpts), 'service');
};
