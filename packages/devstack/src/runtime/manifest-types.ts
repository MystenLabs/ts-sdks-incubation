// Pure-type module for the Manifest schema. Lives separate from
// `manifest-writer.ts` so consumers (frontend, React adapter, vite
// plugin) can import the type without pulling node-fs into their type
// graph. The writer/reader files import from here too.

import type { Network } from '../core/types.js';

/**
 * Manifest schema version. Widened to `1 | 2` to make room for future
 * migrations — current writers always emit `2`. `readManifestWithMigration`
 * is the consumer-facing entry that takes a versioned manifest and returns
 * the current shape (running through any registered migrations on the way).
 */
export type ManifestVersion = 1 | 2;

export interface Manifest {
	app: string;
	network: Network;
	version: ManifestVersion;
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
