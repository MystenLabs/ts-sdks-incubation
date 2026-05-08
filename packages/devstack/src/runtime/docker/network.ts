// Per-(app, stack) docker-network management. Each app+stack gets a
// dedicated bridge network so services on the same stack can resolve
// each other by name without colliding with sibling stacks.

import { dockerRun } from './run.js';

/** Docker network name for an `(app, stack)` pair. Convention:
 * `<appName>-<stack>-net`. Plugins that attach a container via
 * `runContainer({ network: ... })` should pipe this through so all
 * containers in the same stack share a network and can resolve each
 * other by `--network-alias`. */
export const appNetworkName = (appName: string, stack: string): string =>
	`${appName}-${stack}-net`;

interface EnsureNetworkOptions {
	name: string;
	/** CIDR, e.g. `'10.0.0.0/24'`. Required on first create when fixed-IP
	 * containers need to land on predictable addresses (walrus's testbed
	 * uses 10.0.0.10–13). Ignored on subsequent calls when the network
	 * already exists. */
	subnet?: string;
}

export async function ensureNetwork(opts: EnsureNetworkOptions): Promise<void> {
	const inspect = await dockerRun({ command: ['network', 'inspect', opts.name] });
	if (inspect.code === 0) return;
	const args = ['network', 'create'];
	if (opts.subnet !== undefined) args.push('--subnet', opts.subnet);
	args.push(opts.name);
	const result = await dockerRun({ command: args });
	if (result.code !== 0) {
		throw new Error(`docker network create ${opts.name} failed: ${result.stderr.trim()}`);
	}
}

type DockerNetworkProbe =
	| { kind: 'missing' }
	| { kind: 'no-subnet' }
	| { kind: 'subnet'; cidr: string };

/** Probes the named docker network and reports its first IPAM subnet
 * if any. `missing` = network doesn't exist; `no-subnet` = network
 * exists but has no IPAM-pinned subnet (so docker picked one
 * dynamically); `subnet` = network exists with an explicit pin.
 *
 * Used as a `getStatus` probe for actions that pin a subnet — they
 * compare `cidr` to their expected value before declaring `ok: true`. */
export async function dockerNetworkSubnet(name: string): Promise<DockerNetworkProbe> {
	const result = await dockerRun({
		command: ['network', 'inspect', '--format', '{{json .IPAM.Config}}', name],
	});
	if (result.code !== 0) return { kind: 'missing' };
	try {
		const config = JSON.parse(result.stdout.trim()) as Array<{ Subnet?: string }> | null;
		const subnet = config?.[0]?.Subnet;
		return subnet === undefined ? { kind: 'no-subnet' } : { kind: 'subnet', cidr: subnet };
	} catch {
		return { kind: 'no-subnet' };
	}
}

export async function removeNetwork(name: string): Promise<void> {
	const result = await dockerRun({ command: ['network', 'rm', name] });
	if (result.code !== 0 && !/(network not found|No such network)/i.test(result.stderr)) {
		throw new Error(`docker network rm ${name} failed: ${result.stderr.trim()}`);
	}
}
