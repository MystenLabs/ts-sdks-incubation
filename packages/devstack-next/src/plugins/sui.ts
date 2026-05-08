import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { defineSchema, type SchemaInstanceConfig } from '../factories/define-schema.js';
import type { Endpoint } from '../shapes/index.js';
import { ports } from '../standard/ports.js';

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
	/** Set on localnet only. Lets `stop()` tear the container down. */
	containerId?: string;
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
//   - localnet → a container-spawning Producer with auto-deps on the
//     standard `ports` graph node for rpc + faucet slots. Consumer URLs
//     resolve to `http://127.0.0.1:<host-port>`.
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
//       codegen({ endpoints: [sui.get('endpoint-as-shape')] }),
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
	const deps: LocalnetDeps = {
		rpcPort: ports.get('allocate', { slot: 'sui.rpc' }),
		faucetPort: ports.get('allocate', { slot: 'sui.faucet' }),
	};

	return {
		name: 'sui.localnet',
		runsAs: 'sui',
		deps,
		start: async ({ deps: { rpcPort, faucetPort }, prior, log, onShutdown }) => {
			if (prior?.containerId && (await containerIsRunning(prior.containerId))) {
				log(`reusing running sui localnet container ${short(prior.containerId)}`);
				onShutdown(async () => {
					if (await containerIsRunning(prior.containerId!)) {
						await dockerRm(prior.containerId!, log);
					}
				});
				return prior;
			}

			const args = [
				'run',
				'-d',
				'--rm',
				'-p',
				`${rpcPort}:9000`,
				'-p',
				`${faucetPort}:9123`,
				image,
				'sui-test-validator',
				'--fullnode-rpc-port',
				'9000',
				'--faucet-port',
				'9123',
				'--with-faucet',
			];
			log(`docker ${args.join(' ')}`);
			const { stdout } = await exec('docker', args);
			const containerId = stdout.trim();

			onShutdown(async () => {
				if (await containerIsRunning(containerId)) {
					await dockerRm(containerId, log);
				}
			});

			const rpcUrl = `http://127.0.0.1:${rpcPort}`;
			const ok = await waitForReady(() => probeSuiRpc(rpcUrl), readyTimeoutMs, 250);
			if (!ok) {
				await dockerRm(containerId, log);
				throw new Error(
					`sui.localnet: RPC at ${rpcUrl} did not become ready within ${readyTimeoutMs}ms`,
				);
			}

			return {
				rpcUrl,
				faucetUrl: `http://127.0.0.1:${faucetPort}`,
				network: 'localnet',
				containerId,
			};
		},
		stop: async ({ state, log }) => {
			if (state?.containerId && (await containerIsRunning(state.containerId))) {
				log(`stopping sui localnet ${short(state.containerId)}`);
				await dockerRm(state.containerId, log);
			}
		},
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

interface LocalnetDeps {
	rpcPort: ReturnType<typeof ports.get<'allocate'>>;
	faucetPort: ReturnType<typeof ports.get<'allocate'>>;
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

async function containerIsRunning(containerId: string): Promise<boolean> {
	try {
		const { stdout } = await exec('docker', [
			'inspect',
			'-f',
			'{{.State.Running}}',
			containerId,
		]);
		return stdout.trim() === 'true';
	} catch {
		return false;
	}
}

async function dockerRm(containerId: string, log: (line: string) => void): Promise<void> {
	try {
		await exec('docker', ['rm', '-f', containerId]);
	} catch (err) {
		log(`docker rm -f ${short(containerId)} failed: ${(err as Error).message}`);
	}
}

async function waitForReady(
	probe: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (await probe()) return true;
		} catch {
			// keep polling — sui RPC commonly errors before localnet boot completes
		}
		await sleep(intervalMs);
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(id: string): string {
	return id.slice(0, 12);
}
