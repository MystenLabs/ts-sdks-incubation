// Ambient declaration for `virtual:devstack-manifest`. Apps reference
// this once via:
//
//   /// <reference types="@mysten-incubation/devstack/manifest" />
//
// in `src/vite-env.d.ts` (or any `.d.ts` picked up by tsconfig). The
// devstack vite plugin (`@mysten-incubation/devstack/vite`) supplies the
// runtime values; this file gives TypeScript the corresponding types.
//
// Mirrors `runtime/manifest-types.ts` — keep in sync. Re-declared here
// instead of imported because virtual modules can't be resolved through
// real package paths in a `declare module` block.

declare module 'virtual:devstack-manifest' {
	export interface ManifestPackage {
		name: string;
		packageId: string;
		captured: Record<string, string>;
		deps?: Record<string, string>;
		sourceDigest?: string;
		chainId?: string;
		network: 'localnet' | 'testnet' | 'mainnet';
	}
	export interface ManifestAccount {
		name: string;
		address: string;
		role?: string;
		funded?: boolean;
	}
	export interface ManifestService {
		name: string;
		kind: string;
		url: string;
		port: number;
		endpointLabel?: string;
	}
	export interface ManifestSharedObject {
		name: string;
		objectId: string;
		objectType: string;
	}
	export interface ManifestToken {
		name: string;
		[key: string]: unknown;
	}
	export interface Manifest {
		app: string;
		network: 'localnet' | 'testnet' | 'mainnet';
		version: 2;
		emittedAt: string;
		registry: {
			tokens: ManifestToken[];
			packages: ManifestPackage[];
			accounts: ManifestAccount[];
			services: ManifestService[];
			[namespace: string]: unknown;
		};
	}
	export const manifest: Manifest;
}
