import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui, type SuiState } from './sui.js';

const env: Env = { appName: 'test', appDir: '/tmp/sui-test', network: 'localnet', stack: 'main' };

describe('sui (live networks — no Docker)', () => {
	it('mainnet stub publishes the well-known fullnode URL, no faucet', async () => {
		const node = sui.create({ network: 'mainnet' });
		const engine = new Engine({ stack: [node] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const state = engine.getState();
		const view = state.nodes.get('sui.mainnet');
		expect(view).toBeDefined();
		const suiState = view!.state as SuiState;
		expect(suiState.network).toBe('mainnet');
		expect(suiState.rpcUrl).toContain('mainnet.sui.io');
		expect(suiState.faucetUrl).toBeUndefined();
	});

	it('testnet stub publishes the testnet rpc + faucet', async () => {
		const node = sui.create({ network: 'testnet' });
		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('sui.testnet');
		const state = view!.state as SuiState;
		expect(state.rpcUrl).toContain('testnet.sui.io');
		expect(state.faucetUrl).toContain('faucet.testnet.sui.io');
	});

	it('devnet stub also exposes a faucet', async () => {
		const node = sui.create({ network: 'devnet' });
		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const state = engine.getState().nodes.get('sui.devnet')!.state as SuiState;
		expect(state.rpcUrl).toContain('devnet.sui.io');
		expect(state.faucetUrl).toContain('faucet.devnet.sui.io');
	});

	it('honors rpcUrl override on a live net', async () => {
		const node = sui.create({ network: 'testnet', rpcUrl: 'https://my-fullnode.example/rpc' });
		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const state = engine.getState().nodes.get('sui.testnet')!.state as SuiState;
		expect(state.rpcUrl).toBe('https://my-fullnode.example/rpc');
	});
});

describe('sui (localnet static — rpcUrl override skips Docker)', () => {
	it('localnet with rpcUrl override behaves like a stub', async () => {
		const node = sui.create({
			network: 'localnet',
			rpcUrl: 'http://10.0.0.1:9000',
			faucetUrl: 'http://10.0.0.1:9123',
		});
		const engine = new Engine({ stack: [node] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const state = engine.getState().nodes.get('sui.localnet')!.state as SuiState;
		expect(state.rpcUrl).toBe('http://10.0.0.1:9000');
		expect(state.faucetUrl).toBe('http://10.0.0.1:9123');
		// rpcUrl override skips the dockerContainer node entirely — no
		// container, no port allocation.
		expect(engine.getState().nodes.has('sui.localnet.container')).toBe(false);
		expect(engine.getState().nodes.has('ports')).toBe(false);
	});
});

describe('sui (static get accessors via __pluginId)', () => {
	it('sui.get("rpc") resolves to the running instance and projects the URL', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { rpc: sui.get('rpc') },
			start: async ({ deps: { rpc } }) => ({ url: rpc.url }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { url: string };
		expect(state.url).toContain('testnet.sui.io');
	});

	it('sui.get("network") projects the network discriminator', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { net: sui.get('network') },
			start: async ({ deps: { net } }) => ({ net: String(net) }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'devnet' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { net: string };
		expect(state.net).toBe('devnet');
	});

	it('sui.get("faucet") on mainnet throws when consumed', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { f: sui.get('faucet') },
			start: async ({ deps: { f } }) => ({ ok: f.url.length > 0 }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'mainnet' }), consumer] },
			{ env },
		);
		const result = await engine.runOnce();
		const errored = result.errored.find((e) => e.name === 'consumer');
		expect(errored).toBeDefined();
		expect(errored!.error.message).toMatch(/no faucet/);
	});

	it('rejects two `create` instances of the same schema in one stack', async () => {
		const a = sui.create({ network: 'testnet' });
		const b = sui.create({ network: 'mainnet' });
		expect(() => new Engine({ stack: [a, b] }, { env })).toThrow(/two instances/);
	});

	it('errors when a static get is used without a create() in the stack', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { rpc: sui.get('rpc') },
			start: async ({ deps: { rpc } }) => ({ url: rpc.url }),
		});
		expect(() => new Engine({ stack: [consumer] }, { env })).toThrow(/no instance/);
	});

	it('represents.endpoints projects an Endpoint for the TUI', async () => {
		const node = sui.create({ network: 'testnet' });
		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('sui.testnet')!;
		const endpoints = view.representations?.endpoints as { name: string; url: string }[];
		expect(endpoints).toBeDefined();
		expect(endpoints[0]?.name).toBe('sui-rpc');
	});
});

describe('sui (provides.full)', () => {
	it('exposes the full state for "I depend on this being up" patterns', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { sui: sui.get('full') },
			start: async ({ deps: { sui: s } }) => ({
				ok:
					typeof (s as SuiState).rpcUrl === 'string' && (s as SuiState).rpcUrl.length > 0,
			}),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { ok: boolean };
		expect(state.ok).toBe(true);
	});
});

describe('sui (localnet docker composition — no real Docker)', () => {
	// Verify the localnet schema instance composes the underlying
	// `dockerContainer` runner (rather than calling docker directly). The
	// graph must surface a `sui.localnet.container` producer alongside the
	// `sui.localnet` transformer; that's the structural contract any
	// snapshot / lifecycle pass relies on for uniform container discovery.
	it('builds a graph with sui.image + sui.localnet.container + sui.localnet + ports', () => {
		const node = sui.create({ network: 'localnet' });
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		// The transformer node is in the graph...
		expect(state.nodes.has('sui.localnet')).toBe(true);
		// ...along with the underlying dockerContainer runner...
		expect(state.nodes.has('sui.localnet.container')).toBe(true);
		// ...the dockerImage build the container chains its tag from...
		expect(state.nodes.has('sui.image')).toBe(true);
		// ...which auto-injects a Dep on the standard `ports` node.
		expect(state.nodes.has('ports')).toBe(true);
	});

	it('vendored docker context resolves to a real on-disk directory', () => {
		// `sui.image` resolves its build context via `import.meta.url` from
		// `sui.ts` — guard against the source-vs-built path drift that
		// would only surface at `docker build` time.
		const ctx = fileURLToPath(new URL('./sui/docker/', import.meta.url));
		expect(existsSync(ctx)).toBe(true);
		expect(existsSync(`${ctx}Dockerfile`)).toBe(true);
		expect(existsSync(`${ctx}entrypoint.sh`)).toBe(true);
	});

	it('skips sui.image when caller pins a pre-built image tag', () => {
		const node = sui.create({ network: 'localnet', image: 'mystenlabs/sui-tools:devnet' });
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('sui.localnet')).toBe(true);
		expect(state.nodes.has('sui.localnet.container')).toBe(true);
		// No dockerImage build when the caller has a pre-built tag.
		expect(state.nodes.has('sui.image')).toBe(false);
	});
});

describe('sui + manifest integration', () => {
	it('endpoints can flow through `represents` into a downstream consumer', async () => {
		// Synthetic manifest-like consumer that reads the schema's `full` Dep
		// and reads its representations to emit a manifest. This is the
		// representative pattern the real manifest plugin uses on `endpoints`.
		const consumer = define({
			name: 'consumer',
			deps: { sui: sui.get('full') },
			start: async ({ deps: { sui: s } }) => ({ rpc: (s as SuiState).rpcUrl }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'mainnet' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { rpc: string };
		expect(state.rpc).toContain('mainnet.sui.io');
	});

	it('can be combined with other Dep-producing nodes via shared `provides`', async () => {
		// Synthetic Endpoint producer plus sui's network to verify
		// fan-in patterns work across schema-instance + concrete-instance
		// Deps without name collisions.
		const localEndpoint = define<{ name: string; url: string }>({
			name: 'local-endpoint',
			provides: {
				endpoint: dep((s: { name: string; url: string }) => ({
					name: s.name,
					url: s.url,
					kind: 'rpc' as const,
				})),
			},
			start: async () => ({ name: 'extra-rpc', url: 'http://10.0.0.2:9001' }),
		});

		const consumer = define({
			name: 'consumer',
			deps: {
				suiNet: sui.get('network'),
				extra: localEndpoint.get('endpoint'),
			},
			start: async ({ deps }) => {
				const extra = deps.extra as { url: string };
				return { count: extra.url.length + String(deps.suiNet).length };
			},
		});

		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), consumer] },
			{ env },
		);
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
	});
});
