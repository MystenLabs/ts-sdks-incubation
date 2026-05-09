import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import { sui } from './sui.js';
import {
	parseDeployFile,
	walrus,
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

// Real-Docker exercises happen in `runners/docker-container.test.ts`; the
// walrus tests above cover wiring (graph composition, dep fan-in,
// represents) without pulling a real image, mirroring `plugins/sui.test.ts`.
