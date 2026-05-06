// `<DevstackProvider>` — root context for the React adapter.
//
// Apps wrap their tree (inside dapp-kit's providers) with this. The
// provider's only job is to make the manifest available to child
// hooks (`useDevstackDeployed`, plus anything reaching directly into
// `useDevstackContext`). Manifest is a localnet artifact; on
// testnet/mainnet apps either don't mount this provider OR pass
// `manifest={null}` so manifest-driven hooks behave gracefully.

import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import type { Manifest } from '../runtime/manifest-types.js';
import type { DevstackProviderState } from './types.js';

const DevstackContext = createContext<DevstackProviderState | null>(null);

export interface DevstackProviderProps {
	/** The hydrated manifest, typically `import { manifest } from
	 * 'virtual:devstack-manifest'`. Null is permitted for the pre-deploy
	 * state (no `localnet:up` has run yet); the in-tree
	 * `useDevstackDeployed` hook returns `false` for that case so
	 * consumers can render a not-ready state without crashing. */
	manifest: Manifest | null;
	children: ReactNode;
}

export function DevstackProvider(props: DevstackProviderProps): ReactElement {
	const value = useMemo<DevstackProviderState>(() => ({ manifest: props.manifest }), [
		props.manifest,
	]);
	return <DevstackContext.Provider value={value}>{props.children}</DevstackContext.Provider>;
}

export function useDevstackContext(): DevstackProviderState {
	const ctx = useContext(DevstackContext);
	if (ctx === null) {
		throw new Error(
			'useDevstackContext: <DevstackProvider> is missing from the tree. Wrap your app with ' +
				"<DevstackProvider manifest={manifest}> inside dapp-kit's providers.",
		);
	}
	return ctx;
}
