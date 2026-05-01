/// <reference types="vite/client" />

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
			arena?: { sharedObjects?: ManifestSharedObject[] };
		};
	}
	export const manifest: Manifest;
}
