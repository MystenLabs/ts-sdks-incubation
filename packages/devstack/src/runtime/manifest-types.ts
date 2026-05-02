// Pure-type module for the Manifest schema. Lives separate from
// `manifest-writer.ts` so consumers (frontend, React adapter, vite
// plugin) can import the type without pulling node-fs into their type
// graph. The writer/reader files import from here too.

import type { Network } from '../core/types.js';

export interface Manifest {
	app: string;
	network: Network;
	emittedAt: string;
	registry: SerializedRegistry;
}

export interface SerializedRegistry {
	tokens: unknown[];
	packages: unknown[];
	accounts: unknown[];
	services: unknown[];
	[namespace: string]: unknown;
}
