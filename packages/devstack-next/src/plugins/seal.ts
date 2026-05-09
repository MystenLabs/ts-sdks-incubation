import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { defineSchema, type SchemaInstanceConfig } from '../factories/define-schema.js';
import { dockerContainer } from '../runners/docker-container.js';
import type { Endpoint } from '../shapes/index.js';

const DEFAULT_SEAL_IMAGE = 'mystenlabs/seal-key-server:latest';
const DEFAULT_KEY_SERVER_CONTAINER_PORT = 2024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface SealOptions {
	/** Override the key-server image. Default
	 * `mystenlabs/seal-key-server:latest`. */
	image?: string;
	/** Container port the key-server binds inside the container. Host
	 * port is allocated. Default 2024 (upstream's default). */
	containerPort?: number;
	/** Ready-probe timeout for the key-server. Default 60s. */
	readyTimeoutMs?: number;
	/** Skip Docker entirely — point the producer at an externally-managed
	 * key server. Mirrors the `sui({ rpcUrl })` escape hatch. */
	url?: string;
}

export interface SealState {
	url: string;
	managed: boolean;
}

const provides = {
	keyServer: dep((s: SealState) => ({ url: s.url })),
	url: dep((s: SealState) => s.url),
	full: dep((s: SealState) => s),
} satisfies Provides<SealState>;

// `seal` schema. `seal.create({})` returns a single producer:
//   - Default → a pure transformer that depends on a private
//     `dockerContainer({...})` running the seal key-server. Plugin code
//     never calls docker directly; the runner handles spawn + ready
//     probe + warm-restart liveness, exposing `provides.state` /
//     `provides.hostPort` for the transformer to project a clean
//     SealState.
//   - `url` override → a stub producer that just publishes the supplied
//     URL. Used when the key server is managed externally (or in tests).
//
// Both branches expose the same `provides`: keyServer ({ url }), url
// (string), full (state) — so consumer code is mode-agnostic.
//
// Static use: `seal.get('keyServer')` returns a Dep with `__pluginId`;
// the engine binds it to the running instance at graph-build time.
export const seal = defineSchema<SealOptions, SealState, typeof provides>({
	id: 'seal',
	provides,
	create: (opts): SchemaInstanceConfig<SealState, typeof provides, any> => {
		if (opts.url !== undefined) return staticInstance(opts.url);
		return managedInstance(opts);
	},
});

function managedInstance(
	opts: SealOptions,
): SchemaInstanceConfig<SealState, typeof provides, any> {
	const image = opts.image ?? DEFAULT_SEAL_IMAGE;
	const containerPort = opts.containerPort ?? DEFAULT_KEY_SERVER_CONTAINER_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

	const container = dockerContainer({
		name: 'seal.key-server.container',
		runsAs: 'seal',
		image,
		ports: [{ slot: 'seal.key-server', containerPort }],
		readyTimeoutMs,
	});

	return {
		name: 'seal.key-server',
		deps: { hostPort: container.get('hostPort', { slot: 'seal.key-server' }) },
		start: async ({ deps: { hostPort } }): Promise<SealState> => ({
			url: `http://127.0.0.1:${hostPort}`,
			managed: true,
		}),
		represents: {
			endpoints: (s: SealState): Endpoint[] => [
				{ name: 'seal-key-server', url: s.url, kind: 'seal-key-server' },
			],
		},
	};
}

function staticInstance(url: string): SchemaInstanceConfig<SealState, typeof provides, any> {
	return {
		name: 'seal.key-server',
		start: async (): Promise<SealState> => ({ url, managed: false }),
		represents: {
			endpoints: (s: SealState): Endpoint[] => [
				{ name: 'seal-key-server', url: s.url, kind: 'seal-key-server' },
			],
		},
	};
}
