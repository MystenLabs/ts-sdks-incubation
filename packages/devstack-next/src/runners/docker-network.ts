import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

const exec = promisify(execFile);

export interface DockerNetworkState {
	/** Docker network name. Default `<env.appName>-<env.stack>`. */
	name: string;
	/** `/24` CIDR pinned at create time so containers can claim fixed IPs. */
	subnet: string;
	/** Second octet of the subnet, exposed for plugins that compose
	 * fixed-IP addresses against the same network (`10.<octet>.0.<idx>`). */
	octet: number;
	createdAt: number;
}

const networkProvides = {
	name: dep((s: DockerNetworkState) => s.name),
	subnet: dep((s: DockerNetworkState) => s.subnet),
	octet: dep((s: DockerNetworkState) => s.octet),
	full: dep((s: DockerNetworkState) => s),
} satisfies Provides<DockerNetworkState>;

// `dockerNetwork` — singleton standard graph node (mirrors the `ports`
// pattern). Owns a per-(app, stack) docker bridge network with a stable
// `/24` IPAM pin so sibling containers in the same stack can resolve
// each other by `--network-alias` without leaking through host ports.
//
// The network's name (`<appName>-<stack>`) and subnet (deterministic per-
// (app, stack) `/24`) are derived from `env` at start-time. Plugins
// reference `dockerNetwork.get('name')` as a Dep on their containers'
// `network:` field; the engine pulls this node into the graph
// transitively whenever any consumer references it. No-docker stacks
// (e.g. live-net `sui` stubs, walrus's `rpcUrls:` mode) don't reference
// it, so the graph stays clean for tests + frontend-only flows.
//
// Consumers join via the new `network` / `networkAlias` / `ip` fields
// on `dockerContainer` and `dockerOneShot`, threaded into `docker run`
// as `--network <name>`, `--network-alias <alias>`, `--ip <addr>`.
//
// Lifecycle: start ensures the network exists with the expected subnet
// (recreates if subnet drifted across runs); shutdown removes it. The
// engine's stop iterates handlers in reverse-topo order so attached
// containers are removed before the network is torn down.
export const dockerNetwork = define<DockerNetworkState, typeof networkProvides>({
	name: 'docker.network',
	provides: networkProvides,
	inputs: ({ env }) => deriveNetworkSpec(env),
	start: async ({ env, prior, log, onShutdown }) => {
		const spec = deriveNetworkSpec(env);
		const existing = await inspectNetwork(spec.name);
		if (existing && existing.subnet === spec.subnet) {
			log(`reusing network ${spec.name} (subnet ${spec.subnet})`);
		} else {
			if (existing) {
				log(`network ${spec.name} subnet drift (${existing.subnet} → ${spec.subnet}); recreating`);
				await tryRemoveNetwork(spec.name, log);
			}
			await createNetwork(spec.name, spec.subnet);
			log(`created network ${spec.name} (subnet ${spec.subnet})`);
		}
		onShutdown(async () => {
			await tryRemoveNetwork(spec.name, log);
		});
		const createdAt = prior?.name === spec.name ? prior.createdAt : Date.now();
		return { ...spec, createdAt };
	},
});

interface NetworkSpec {
	name: string;
	subnet: string;
	octet: number;
}

function deriveNetworkSpec(env: { appName: string; stack?: string }): NetworkSpec {
	const stack = env.stack ?? 'main';
	const octet = dockerNetworkOctet(env.appName, stack);
	return {
		name: `${env.appName}-${stack}`,
		subnet: `10.${octet}.0.0/24`,
		octet,
	};
}

/** Deterministic per-(app, stack) octet ∈ [1, 250]. The per-stack `/24`
 * needs predictable second-octets for fixed-IP committee members
 * (walrus storage nodes); using a single shared `10.0.0.0/24` would
 * collide whenever two devstack apps run concurrently. Hashing
 * `appName/stack` into the second-octet space gives ~250 per-host
 * slots before any pigeonhole collision. Octet 0 is reserved (default
 * docker bridges); 251–255 stay free for ad-hoc user networks. */
export function dockerNetworkOctet(appName: string, stack: string): number {
	let h = 0;
	const s = `${appName}/${stack}`;
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) >>> 0;
	}
	return (h % 250) + 1;
}

async function inspectNetwork(name: string): Promise<{ subnet: string } | undefined> {
	try {
		const { stdout } = await exec('docker', [
			'network',
			'inspect',
			'--format',
			'{{json .IPAM.Config}}',
			name,
		]);
		const config = JSON.parse(stdout.trim()) as Array<{ Subnet?: string }> | null;
		const subnet = config?.[0]?.Subnet;
		return { subnet: subnet ?? '' };
	} catch {
		return undefined;
	}
}

async function createNetwork(name: string, subnet: string): Promise<void> {
	await exec('docker', ['network', 'create', '--subnet', subnet, name]);
}

async function tryRemoveNetwork(name: string, log: (line: string) => void): Promise<void> {
	try {
		await exec('docker', ['network', 'rm', name]);
	} catch (err) {
		// `network rm` fails with "active endpoints" if any container is
		// still attached. The engine's reverse-topo shutdown order normally
		// removes containers first, but a process killed mid-cycle (or a
		// container whose --rm cleanup is still pending) can race here.
		// Log + leave the network for the next cycle to reuse — `docker
		// network prune` cleans anything stranded between sessions.
		log(`docker network rm ${name} failed: ${(err as Error).message}`);
	}
}
