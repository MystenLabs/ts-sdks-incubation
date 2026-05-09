import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { defineSchema, type SchemaInstanceConfig } from '../factories/define-schema.js';
import { dockerContainer } from '../runners/docker-container.js';
import type { Endpoint } from '../shapes/index.js';

const exec = promisify(execFile);

export type SuiNetwork = 'localnet' | 'testnet' | 'mainnet' | 'devnet';

export interface SuiOptions {
	network: SuiNetwork;
	/** Pre-built localnet image. Default: `mystenlabs/sui-tools:devnet`. */
	image?: string;
	/** Override RPC URL — point at an externally-managed sui node instead
	 * of spawning a container. Localnet only (live nets always use this). */
	rpcUrl?: string;
	/** Override faucet URL. Localnet only — live nets resolve from the
	 * network name. */
	faucetUrl?: string;
	/** Container ready-probe timeout. Localnet only. Default 60s. */
	readyTimeoutMs?: number;
}

export interface SuiState {
	rpcUrl: string;
	/** Set on localnet + testnet/devnet; absent on mainnet. */
	faucetUrl?: string;
	network: SuiNetwork;
}

const provides = {
	rpc: dep((s: SuiState) => ({ url: s.rpcUrl })),
	faucet: dep((s: SuiState) => {
		if (s.faucetUrl === undefined) {
			throw new Error(`sui (${s.network}): no faucet on this network`);
		}
		return { url: s.faucetUrl };
	}),
	network: dep((s: SuiState) => s.network),
	full: dep((s: SuiState) => s),
} satisfies Provides<SuiState>;

const PUBLIC_RPC: Record<Exclude<SuiNetwork, 'localnet'>, string> = {
	mainnet: 'https://fullnode.mainnet.sui.io:443',
	testnet: 'https://fullnode.testnet.sui.io:443',
	devnet: 'https://fullnode.devnet.sui.io:443',
};
const PUBLIC_FAUCET: Partial<Record<SuiNetwork, string>> = {
	testnet: 'https://faucet.testnet.sui.io',
	devnet: 'https://faucet.devnet.sui.io',
};

const DEFAULT_LOCALNET_IMAGE = 'mystenlabs/sui-tools:devnet';

// `sui` schema. `sui.create({ network })` returns a Producer:
//   - localnet → a pure transformer Producer that depends on a private
//     `dockerContainer({...})` node for the actual container lifecycle.
//     Plugin code never calls `docker` directly; the runner handles spawn,
//     ready probing, warm-restart liveness, shutdown registration, and
//     puts a `DockerContainerState`-shaped node into the graph that any
//     snapshot / lifecycle pass can discover uniformly. Consumer URLs
//     resolve to `http://127.0.0.1:<host-port>` from the container's
//     allocated host ports.
//   - testnet/mainnet/devnet → a stub Producer that just publishes the
//     well-known fullnode URL (no Docker, no ports).
//
// Both branches expose the same `provides` (rpc, faucet, network, full)
// so consumer code is network-agnostic. The faucet recipe throws on
// mainnet (no public faucet) — matches the actual capability.
//
// Static use:
//   const cfg = defineDevstackConfig({
//     stack: [
//       sui.create({ network: 'localnet' }),
//       manifest({ endpoints: [sui.get('endpoint-as-shape')] }),
//     ],
//   });
//
// `sui.get('rpc')` returns a static Dep with `__pluginId` — the engine
// resolves it to the running instance at graph build time. No need to
// thread the producer through.
export const sui = defineSchema<SuiOptions, SuiState, typeof provides>({
	id: 'sui',
	provides,
	create: (opts): SchemaInstanceConfig<SuiState, typeof provides, any> => {
		if (opts.network === 'localnet') return localnetInstance(opts);
		return liveInstance(opts);
	},
});

function localnetInstance(
	opts: SuiOptions,
): SchemaInstanceConfig<SuiState, typeof provides, any> {
	// Caller provided an external rpcUrl: skip Docker, just publish URLs.
	if (opts.rpcUrl !== undefined) {
		return staticInstance(opts);
	}
	const image = opts.image ?? DEFAULT_LOCALNET_IMAGE;
	const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;

	const container = dockerContainer({
		name: 'sui.localnet.container',
		runsAs: 'sui',
		image,
		args: [
			'sui-test-validator',
			'--fullnode-rpc-port',
			'9000',
			'--faucet-port',
			'9123',
			'--with-faucet',
		],
		ports: [
			{ slot: 'sui.rpc', containerPort: 9000 },
			{ slot: 'sui.faucet', containerPort: 9123 },
		],
		readyTimeoutMs,
		readyProbe: async ({ hostPorts }) => {
			const port = hostPorts['sui.rpc'];
			if (port === undefined) return false;
			return probeSuiRpc(`http://127.0.0.1:${port}`);
		},
	});

	return {
		name: 'sui.localnet',
		deps: {
			rpcPort: container.get('hostPort', { slot: 'sui.rpc' }),
			faucetPort: container.get('hostPort', { slot: 'sui.faucet' }),
		},
		start: async ({ deps: { rpcPort, faucetPort } }): Promise<SuiState> => ({
			rpcUrl: `http://127.0.0.1:${rpcPort}`,
			faucetUrl: `http://127.0.0.1:${faucetPort}`,
			network: 'localnet',
		}),
		represents: {
			endpoints: (s: SuiState): Endpoint[] => {
				const out: Endpoint[] = [{ name: 'sui-rpc', url: s.rpcUrl, kind: 'rpc' }];
				if (s.faucetUrl !== undefined) {
					out.push({ name: 'sui-faucet', url: s.faucetUrl, kind: 'faucet' });
				}
				return out;
			},
		},
	};
}

function liveInstance(
	opts: SuiOptions,
): SchemaInstanceConfig<SuiState, typeof provides, any> {
	if (opts.network === 'localnet') {
		throw new Error('liveInstance: not callable with localnet');
	}
	const rpcUrl = opts.rpcUrl ?? PUBLIC_RPC[opts.network];
	const faucetUrl = opts.faucetUrl ?? PUBLIC_FAUCET[opts.network];
	return {
		name: `sui.${opts.network}`,
		start: async (): Promise<SuiState> => {
			const state: SuiState = { rpcUrl, network: opts.network };
			if (faucetUrl !== undefined) state.faucetUrl = faucetUrl;
			return state;
		},
		represents: {
			endpoints: (s: SuiState): Endpoint[] => [{ name: 'sui-rpc', url: s.rpcUrl, kind: 'rpc' }],
		},
	};
}

function staticInstance(
	opts: SuiOptions,
): SchemaInstanceConfig<SuiState, typeof provides, any> {
	const rpcUrl = opts.rpcUrl;
	if (rpcUrl === undefined) throw new Error('staticInstance: rpcUrl is required');
	return {
		name: `sui.${opts.network}`,
		start: async (): Promise<SuiState> => {
			const state: SuiState = { rpcUrl, network: opts.network };
			if (opts.faucetUrl !== undefined) state.faucetUrl = opts.faucetUrl;
			return state;
		},
	};
}

async function probeSuiRpc(rpcUrl: string): Promise<boolean> {
	try {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			method: 'sui_getChainIdentifier',
			params: [],
			id: 1,
		});
		const { stdout } = await exec('curl', [
			'-sf',
			'-X',
			'POST',
			'-H',
			'Content-Type: application/json',
			'-d',
			body,
			rpcUrl,
		]);
		return stdout.includes('result');
	} catch {
		return false;
	}
}
