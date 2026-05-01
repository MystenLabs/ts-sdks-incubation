/// <reference types="vite/client" />

declare module 'virtual:devstack-keys' {
	export interface DevKey {
		label: string;
		secretKey: string;
	}
	export const devKeys: readonly DevKey[];
}

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
	export interface ManifestToken {
		name: string;
		type: string;
		decimals: number;
		treasuryCapId?: string;
		metadataId?: string;
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
		};
	}
	export const manifest: Manifest;
}
