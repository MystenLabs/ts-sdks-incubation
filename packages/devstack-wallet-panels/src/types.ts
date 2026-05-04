// Local manifest typings. We deliberately don't import the full `Manifest`
// type from `@mysten-incubation/devstack` — that pulls Node-only build
// machinery into the type graph. Browser consumers care about the
// `services`, `accounts`, `packages`, and `coin.tokens` shapes, which are
// stable across schema versions, so we narrow to those.

export interface DevstackService {
	name: string;
	kind: string;
	url: string;
	port: number;
	endpointLabel?: string;
}

export interface DevstackAccount {
	name: string;
	address: string;
	role?: string;
	funded?: boolean;
}

export interface DevstackPackage {
	name: string;
	packageId: string;
	captured: Record<string, string>;
	deps?: Record<string, string>;
	network?: string;
	path?: string;
}

export interface DevstackToken {
	name: string;
	type: string;
	decimals: number;
	treasuryCapId?: string;
	metadataId?: string;
}

export interface DevstackManifest {
	app: string;
	network: string;
	emittedAt: string;
	registry: {
		services: DevstackService[];
		accounts: DevstackAccount[];
		packages: DevstackPackage[];
		coin?: { tokens?: DevstackToken[] };
		[namespace: string]: unknown;
	};
}
