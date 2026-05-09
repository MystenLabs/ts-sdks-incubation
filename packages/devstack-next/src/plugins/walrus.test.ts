import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Dep, Env, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from './sui.js';
import {
	parseDeployFile,
	renderWalrusProxyConfig,
	walrus,
	walrusProxy,
	walrusSeedWal,
	type WalrusNetworkState,
	type WalrusNodeState,
} from './walrus.js';

const env: Env = { appName: 'demo', appDir: '/tmp/walrus-test', network: 'localnet', stack: 'main' };

describe('walrus (no Docker — rpcUrls override)', () => {
	it('rejects nodeCount of 0', () => {
		expect(() => walrus({ nodeCount: 0 })).toThrow(/at least 1/);
	});

	it('rejects mismatched rpcUrls length', () => {
		expect(() => walrus({ nodeCount: 3, rpcUrls: ['a', 'b'] })).toThrow(
			/length .* must equal nodeCount/,
		);
	});

	it('builds N node producers + an aggregator', () => {
		const w = walrus({ rpcUrls: ['http://n0/', 'http://n1/', 'http://n2/'] });
		expect(w.nodes).toHaveLength(3);
		expect(w.nodes.map((n) => n.name)).toEqual([
			'walrus.node-0',
			'walrus.node-1',
			'walrus.node-2',
		]);
		expect(w.appNetwork.name).toBe('walrus.app-network');
	});

	it('aggregator publishes the URLs of every node', async () => {
		const w = walrus({ rpcUrls: ['http://n0:9000/', 'http://n1:9000/'] });
		const engine = new Engine({ stack: [w.appNetwork] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const network = engine.getState().nodes.get('walrus.app-network')!.state as WalrusNetworkState;
		expect(network.nodeCount).toBe(2);
		expect(network.urls.sort()).toEqual(['http://n0:9000/', 'http://n1:9000/']);
	});

	it('appNetwork pulls in every node transitively', async () => {
		const w = walrus({ rpcUrls: ['http://n0/', 'http://n1/'] });
		// Only push appNetwork; nodes resolve via deps.
		const engine = new Engine({ stack: [w.appNetwork] }, { env });
		await engine.runOnce();
		const state = engine.getState();
		expect(state.nodes.has('walrus.node-0')).toBe(true);
		expect(state.nodes.has('walrus.node-1')).toBe(true);
		expect(state.nodes.has('walrus.app-network')).toBe(true);
	});

	it('node.rpc Dep resolves to { url } per node', async () => {
		const w = walrus({ rpcUrls: ['http://n0/', 'http://n1/'] });
		const consumer = define({
			name: 'consumer',
			deps: { rpc0: w.nodes[0]!.get('rpc'), rpc1: w.nodes[1]!.get('rpc') },
			start: async ({ deps: { rpc0, rpc1 } }) => ({ a: rpc0.url, b: rpc1.url }),
		});
		const engine = new Engine({ stack: [w.appNetwork, consumer] }, { env });
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { a: string; b: string };
		expect(state.a).toBe('http://n0/');
		expect(state.b).toBe('http://n1/');
	});

	it('appNetwork.urls Dep projects the URL list', async () => {
		const w = walrus({ rpcUrls: ['http://n0/', 'http://n1/', 'http://n2/'] });
		const consumer = define({
			name: 'consumer',
			deps: { urls: w.appNetwork.get('urls') },
			start: async ({ deps: { urls } }) => ({ count: urls.length, joined: urls.join(',') }),
		});
		const engine = new Engine({ stack: [w.appNetwork, consumer] }, { env });
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as {
			count: number;
			joined: string;
		};
		expect(state.count).toBe(3);
		expect(state.joined).toContain('http://n0/');
	});

	it('node represents.endpoints projects an Endpoint', async () => {
		const w = walrus({ rpcUrls: ['http://n0/'] });
		const engine = new Engine({ stack: [w.appNetwork] }, { env });
		await engine.runOnce();
		const node0 = engine.getState().nodes.get('walrus.node-0')!;
		const endpoints = node0.representations?.endpoints as { name: string; url: string }[];
		expect(endpoints[0]?.name).toBe('walrus-node-0');
		expect(endpoints[0]?.url).toBe('http://n0/');
	});

	it('node state includes index + rpcUrl', async () => {
		const w = walrus({ rpcUrls: ['http://a/', 'http://b/'] });
		const engine = new Engine({ stack: [w.appNetwork] }, { env });
		await engine.runOnce();
		const node1 = engine.getState().nodes.get('walrus.node-1')!.state as WalrusNodeState;
		expect(node1.index).toBe(1);
		expect(node1.rpcUrl).toBe('http://b/');
	});
});

describe('walrus (graph composition — no real Docker)', () => {
	// Mirrors the sui-localnet test: verify the producers compose
	// dockerContainer rather than calling docker directly. The graph
	// surface must include `walrus.node-${i}.container` siblings so any
	// snapshot / lifecycle pass can walk them uniformly. The image
	// chain (`walrus.image.upstream` → `walrus.image`) appears alongside
	// when no `image:` override is supplied; the deploy chain
	// (`walrus.deploy` + `walrus.deploy.container`) appears whenever
	// not in `rpcUrls:` mode.
	it('container path: nodes + image chain + deploy chain + ports siblings', () => {
		const w = walrus({ nodeCount: 2 });
		// `register` is in the graph only when something pulls it in;
		// drop it on the stack alongside appNetwork to exercise both
		// chains.
		const engine = new Engine(
			{ stack: [sui.create({ network: 'localnet' }), w.appNetwork, w.register!] },
			{ env },
		);
		const state = engine.getState();
		expect(state.nodes.has('walrus.node-0')).toBe(true);
		expect(state.nodes.has('walrus.node-0.container')).toBe(true);
		expect(state.nodes.has('walrus.node-1')).toBe(true);
		expect(state.nodes.has('walrus.node-1.container')).toBe(true);
		expect(state.nodes.has('walrus.app-network')).toBe(true);
		expect(state.nodes.has('walrus.image')).toBe(true);
		expect(state.nodes.has('walrus.image.upstream')).toBe(true);
		expect(state.nodes.has('walrus.deploy')).toBe(true);
		expect(state.nodes.has('walrus.deploy.container')).toBe(true);
		expect(state.nodes.has('walrus.register')).toBe(true);
		expect(state.nodes.has('ports')).toBe(true);
		// The deploy container joins the per-(app, stack) docker network
		// (sui-localnet alias resolves into the bridge), so the singleton
		// `dockerNetwork` is pulled into the graph transitively.
		expect(state.nodes.has('docker.network')).toBe(true);
	});

	it('skips walrus.image* when caller pins a pre-built image tag', () => {
		const w = walrus({ nodeCount: 2, image: 'mystenlabs/walrus-service:latest' });
		const engine = new Engine(
			{ stack: [sui.create({ network: 'localnet' }), w.appNetwork] },
			{ env },
		);
		const state = engine.getState();
		expect(state.nodes.has('walrus.node-0.container')).toBe(true);
		expect(state.nodes.has('walrus.deploy.container')).toBe(true);
		expect(state.nodes.has('walrus.image')).toBe(false);
		expect(state.nodes.has('walrus.image.upstream')).toBe(false);
	});

	it('rpcUrls override skips docker — no .container or deploy nodes in the graph', () => {
		const w = walrus({ rpcUrls: ['http://x/', 'http://y/'] });
		const engine = new Engine({ stack: [w.appNetwork] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('walrus.node-0')).toBe(true);
		expect(state.nodes.has('walrus.node-0.container')).toBe(false);
		expect(state.nodes.has('walrus.node-1.container')).toBe(false);
		expect(state.nodes.has('walrus.image')).toBe(false);
		expect(state.nodes.has('walrus.deploy')).toBe(false);
		expect(state.nodes.has('walrus.deploy.container')).toBe(false);
		expect(state.nodes.has('ports')).toBe(false);
	});

	it('vendored docker context resolves to a real on-disk directory', () => {
		const ctx = fileURLToPath(new URL('./walrus/docker/', import.meta.url));
		expect(existsSync(ctx)).toBe(true);
		expect(existsSync(`${ctx}upstream.Dockerfile`)).toBe(true);
		expect(existsSync(`${ctx}wrapper.Dockerfile`)).toBe(true);
		expect(existsSync(`${ctx}deploy.sh`)).toBe(true);
		expect(existsSync(`${ctx}run.sh`)).toBe(true);
	});
});

describe('walrus parseDeployFile', () => {
	it('parses required + optional ids from the walrus-deploy summary', () => {
		const text = `package_id: 0xabc
system_object: 0xsys
staking_object: 0xstk
upgrade_manager_object: 0xupg
treasury_object: 0xtre
exchange_object: 0xex
extra_field: 0xignored
`;
		const ids = parseDeployFile(text);
		expect(ids.walrusPackageId).toBe('0xabc');
		expect(ids.systemObject).toBe('0xsys');
		expect(ids.stakingObject).toBe('0xstk');
		expect(ids.upgradeManagerObject).toBe('0xupg');
		expect(ids.treasuryObject).toBe('0xtre');
		expect(ids.exchangeObject).toBe('0xex');
	});

	it('omits optional ids when the summary lists `None`', () => {
		const text = `package_id: 0xabc
system_object: 0xsys
staking_object: 0xstk
exchange_object: None
`;
		const ids = parseDeployFile(text);
		expect(ids.exchangeObject).toBeUndefined();
		expect(ids.treasuryObject).toBeUndefined();
	});

	it('throws when a required id is missing', () => {
		const text = `package_id: 0xabc
system_object: 0xsys
`;
		expect(() => parseDeployFile(text)).toThrow(/staking_object/);
	});
});

describe('walrusSeedWal (graph composition — no real chain)', () => {
	function makeSignerNode(name: string) {
		interface SignerState {
			keypair: Ed25519Keypair;
		}
		const signerProvides = {
			signer: dep((s: SignerState) => s.keypair),
		} satisfies Provides<SignerState>;
		const node = define<SignerState, typeof signerProvides>({
			name: `test.signer.${name}`,
			provides: signerProvides,
			start: async () => ({ keypair: Ed25519Keypair.generate() }),
		});
		return node;
	}

	it('rejects an empty accounts list', () => {
		const w = walrus({ nodeCount: 1 });
		expect(() => walrusSeedWal({ exchange: w.exchange!, accounts: [] })).toThrow(
			/at least one account/,
		);
	});

	it('rejects duplicate account names', () => {
		const w = walrus({ nodeCount: 1 });
		const s1 = makeSignerNode('alice');
		const s2 = makeSignerNode('alice2');
		expect(() =>
			walrusSeedWal({
				exchange: w.exchange!,
				accounts: [
					{
						name: 'alice',
						signer: s1.get('signer') as unknown as Dep<unknown, Ed25519Keypair>,
					},
					{
						name: 'alice',
						signer: s2.get('signer') as unknown as Dep<unknown, Ed25519Keypair>,
					},
				],
			}),
		).toThrow(/duplicate account name "alice"/);
	});

	it('rejects non-positive paymentMist', () => {
		const w = walrus({ nodeCount: 1 });
		const s = makeSignerNode('a');
		expect(() =>
			walrusSeedWal({
				exchange: w.exchange!,
				accounts: [{ name: 'a', signer: s.get('signer') as unknown as Dep<unknown, Ed25519Keypair> }],
				paymentMist: 0n,
			}),
		).toThrow(/paymentMist must be positive/);
	});

	it('one runTransaction producer per account, named tx.walrus.seedWal.<name>', () => {
		const w = walrus({ nodeCount: 1 });
		const sP = makeSignerNode('publisher');
		const sM = makeSignerNode('minter');
		const seeds = walrusSeedWal({
			exchange: w.exchange!,
			accounts: [
				{
					name: 'publisher',
					signer: sP.get('signer') as unknown as Dep<unknown, Ed25519Keypair>,
				},
				{
					name: 'minter',
					signer: sM.get('signer') as unknown as Dep<unknown, Ed25519Keypair>,
				},
			],
		});
		expect(seeds).toHaveLength(2);
		expect(seeds[0]!.name).toBe('tx.walrus.seedWal.publisher');
		expect(seeds[1]!.name).toBe('tx.walrus.seedWal.minter');
	});

	it('per-account producer pulls walrus.exchange + sui + walrus.register into the graph transitively', () => {
		const w = walrus({ nodeCount: 1 });
		const sP = makeSignerNode('publisher');
		const seeds = walrusSeedWal({
			exchange: w.exchange!,
			accounts: [
				{
					name: 'publisher',
					signer: sP.get('signer') as unknown as Dep<unknown, Ed25519Keypair>,
				},
			],
		});
		// Only push the seed step + sui — every other walrus piece flows
		// in via Deps. Mirrors how a user would wire this in their
		// devstack config.
		const engine = new Engine(
			{ stack: [sui.create({ network: 'localnet' }), sP, ...seeds] },
			{ env },
		);
		const state = engine.getState();
		expect(state.nodes.has('tx.walrus.seedWal.publisher')).toBe(true);
		expect(state.nodes.has('walrus.exchange')).toBe(true);
		expect(state.nodes.has('walrus.register')).toBe(true);
		expect(state.nodes.has('walrus.deploy')).toBe(true);
		expect(state.nodes.has('sui.localnet')).toBe(true);
	});

	it('runsAs key per producer is the action name (per-account lock)', () => {
		const w = walrus({ nodeCount: 1 });
		const s = makeSignerNode('publisher');
		const [seed] = walrusSeedWal({
			exchange: w.exchange!,
			accounts: [
				{
					name: 'publisher',
					signer: s.get('signer') as unknown as Dep<unknown, Ed25519Keypair>,
				},
			],
		});
		const impl = seed as unknown as { runsAs?: string };
		expect(impl.runsAs).toBe('walrus.seedWal.publisher');
	});

	it('exchange producer is undefined in rpcUrls mode (no Docker → no register)', () => {
		const w = walrus({ rpcUrls: ['http://x/'] });
		expect(w.exchange).toBeUndefined();
		expect(w.register).toBeUndefined();
	});
});

describe('walrusProxy (graph composition + nginx config — no real chain)', () => {
	it('rejects an empty nodes array', () => {
		expect(() => walrusProxy({ nodes: [] })).toThrow(/at least one node/);
	});

	it('builds a graph node `walrus.proxy` backed by a sibling container', () => {
		const w = walrus({ nodeCount: 2 });
		const proxy = walrusProxy({ nodes: w.nodes });
		const engine = new Engine(
			{ stack: [sui.create({ network: 'localnet' }), w.appNetwork, proxy] },
			{ env },
		);
		const state = engine.getState();
		expect(state.nodes.has('walrus.proxy')).toBe(true);
		expect(state.nodes.has('walrus.proxy.container')).toBe(true);
		// dockerNetwork is pulled in transitively because the proxy joins it.
		expect(state.nodes.has('docker.network')).toBe(true);
	});

	it('represents.endpoints projects a walrus-proxy Endpoint', () => {
		// We can't actually run the proxy without docker, but we can check
		// the represents callback handles synthetic state — same pattern
		// the sui / walrus.node tests use to verify the projector.
		const synthetic = { url: 'http://127.0.0.1:7777', port: 7777 };
		const w = walrus({ nodeCount: 1 });
		const proxy = walrusProxy({ nodes: w.nodes });
		const impl = proxy as unknown as {
			represents?: { endpoints?: (s: unknown) => unknown[] };
		};
		const endpoints = impl.represents?.endpoints?.(synthetic) as
			| { name: string; url: string; kind?: string }[]
			| undefined;
		expect(endpoints).toEqual([
			{ name: 'walrus-proxy', url: 'http://127.0.0.1:7777', kind: 'walrus-proxy' },
		]);
	});
});

describe('renderWalrusProxyConfig (pure)', () => {
	it('emits one server block per node with the right vhost + upstream', () => {
		const config = renderWalrusProxyConfig({
			octet: 42,
			nodeIndices: [0, 1, 2],
			nodePort: 9185,
		});
		// Three vhost blocks.
		const serverCount = (config.match(/server\s*\{/g) ?? []).length;
		expect(serverCount).toBe(3);
		// Each vhost has the right Host + upstream IP.
		expect(config).toContain('server_name walrus-node-0.localhost');
		expect(config).toContain('proxy_pass http://10.42.0.10:9185');
		expect(config).toContain('server_name walrus-node-1.localhost');
		expect(config).toContain('proxy_pass http://10.42.0.11:9185');
		expect(config).toContain('server_name walrus-node-2.localhost');
		expect(config).toContain('proxy_pass http://10.42.0.12:9185');
		// Single shared listen port across all servers.
		expect((config.match(/listen 0\.0\.0\.0:9185/g) ?? []).length).toBe(3);
	});

	it('honors a non-default nodePort', () => {
		const config = renderWalrusProxyConfig({
			octet: 7,
			nodeIndices: [0],
			nodePort: 8080,
		});
		expect(config).toContain('listen 0.0.0.0:8080');
		expect(config).toContain('proxy_pass http://10.7.0.10:8080');
	});

	it('handles non-contiguous node indices (e.g. node-1 dropped from a committee)', () => {
		const config = renderWalrusProxyConfig({
			octet: 5,
			nodeIndices: [0, 2, 3],
			nodePort: 9185,
		});
		expect(config).toContain('server_name walrus-node-0.localhost');
		expect(config).not.toContain('server_name walrus-node-1.localhost');
		expect(config).toContain('server_name walrus-node-2.localhost');
		expect(config).toContain('server_name walrus-node-3.localhost');
	});
});

// Real-Docker exercises happen in `runners/docker-container.test.ts`; the
// walrus tests above cover wiring (graph composition, dep fan-in,
// represents) without pulling a real image, mirroring `plugins/sui.test.ts`.
