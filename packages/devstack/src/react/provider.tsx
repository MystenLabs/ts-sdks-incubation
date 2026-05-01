// `<DevstackProvider>` — root context for the React adapter.
//
// Apps wrap their tree (inside dapp-kit's providers) with this. Hooks
// downstream consume the manifest + codegen modules from here. One
// context object so siblings don't re-render on unrelated updates;
// manifest/packages are usually stable for the lifetime of the page.

import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import type { Manifest } from '../runtime/manifest-types.js';
import type { CodegenModule, DevstackProviderState } from './types.js';

const DevstackContext = createContext<DevstackProviderState | null>(null);

export interface DevstackProviderProps {
	/** The hydrated manifest, typically `import { manifest } from
	 * 'virtual:devstack-manifest'`. Null is permitted for the pre-deploy
	 * state (no `<localnet:up>` has run yet); hooks that need the manifest
	 * throw with an actionable error in that case. */
	manifest: Manifest | null;
	/** Map from registry-package name → codegen module imported by the
	 * app. The keys MUST match the names registered in
	 * `manifest.registry.packages` (e.g. `'connect_four'`, `'mock_usdc'`).
	 */
	packages?: Record<string, CodegenModule>;
	children: ReactNode;
}

export function DevstackProvider(props: DevstackProviderProps): ReactElement {
	const value = useMemo<DevstackProviderState>(
		() => ({ manifest: props.manifest, packages: props.packages ?? {} }),
		[props.manifest, props.packages],
	);
	return <DevstackContext.Provider value={value}>{props.children}</DevstackContext.Provider>;
}

export function useDevstackContext(): DevstackProviderState {
	const ctx = useContext(DevstackContext);
	if (ctx === null) {
		throw new Error(
			'useDevstackContext: <DevstackProvider> is missing from the tree. Wrap your app with ' +
				"<DevstackProvider manifest={manifest} packages={...}> inside dapp-kit's providers.",
		);
	}
	return ctx;
}

export function useDevstackManifest(): Manifest {
	const { manifest } = useDevstackContext();
	if (manifest === null) {
		throw new Error(
			'useDevstackManifest: no manifest available — has `pnpm localnet:up` been run? ' +
				'The Vite plugin emits a stub manifest before first run; gate UI on `manifest.app !== ""`.',
		);
	}
	return manifest;
}
