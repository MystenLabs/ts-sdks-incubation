// Account(name, opts?) — single-named account factory. Replaces the
// `accounts({alice: {...}, bob: {...}})` shape with one factory call
// per named account, returning a typed Ref usable directly as a signer
// in `Package` / `Action` / `Wallet`.
//
// Phase 2 delegates to `accounts({[name]: opts})` and picks the single
// resulting tag back out; the underlying behavior (faucet funding,
// disk-keystore persistence, keystore/env/inline sources) is unchanged.

import { accounts, type AccountSpec } from '../primitives/accounts.js';
import { withSection } from './ref.js';

/** Factory for a single named account. The returned Ref is both an
 *  Effect Layer (composed into the merged stack by `devstack(...)`) and
 *  an Effect tag (`yield* alice` returns the resolved `Account`).
 *
 *  Default source: `'ephemeral-funded'` — generate a fresh keypair,
 *  persist it under `.devstack/stacks/<stack>/.keys/<name>.key`, and
 *  request faucet funding. Pass `{ from: 'env', key: '...' }` or
 *  `{ from: 'keystore', alias: '...' }` for non-localnet stacks. */
export const Account = <const N extends string>(name: N, opts?: AccountSpec) => {
	const handle = accounts({ [name]: opts ?? {} } as Record<N, AccountSpec>);
	const tag = handle[name];
	return withSection(tag, 'account');
};
