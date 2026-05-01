/// <reference types="vite/client" />

declare module 'virtual:devstack-keys' {
	export interface DevKey {
		label: string;
		secretKey: string;
	}
	export const devKeys: readonly DevKey[];
}

declare module 'virtual:devstack-manifest' {
	// Inlined to avoid pulling devstack's TS source through the app's
	// typecheck — see examples/wallet/src/vite-env.d.ts for the same pattern.
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
	export interface ManifestSealKeyServer {
		name: string;
		objectId: string;
		url: string;
		publicKey: string;
		sealPackageId: string;
	}
	export interface Manifest {
		app: string;
		network: 'localnet' | 'testnet' | 'mainnet';
		version: 2;
		emittedAt: string;
		registry: {
			tokens: unknown[];
			packages: ManifestPackage[];
			accounts: ManifestAccount[];
			services: ManifestService[];
			seal?: { keyServer?: ManifestSealKeyServer[] };
		};
	}
	export const manifest: Manifest;
}
