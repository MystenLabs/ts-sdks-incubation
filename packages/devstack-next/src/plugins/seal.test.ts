import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Dep, Env, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from './sui.js';
import { seal, sealLocalnet, type SealState } from './seal.js';

const env: Env = { appName: 'demo', appDir: '/tmp/seal-test', network: 'localnet', stack: 'main' };

describe('seal (url override — no Docker)', () => {
	it('publishes the supplied url and marks state as unmanaged', async () => {
		const node = seal.create({ url: 'https://my-key-server.example/seal' });
		const engine = new Engine({ stack: [node] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const state = engine.getState().nodes.get('seal.key-server')!.state as SealState;
		expect(state.url).toBe('https://my-key-server.example/seal');
		expect(state.managed).toBe(false);
	});

	it('skips the dockerContainer node when url is set', () => {
		const node = seal.create({ url: 'https://x/' });
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('seal.key-server')).toBe(true);
		expect(state.nodes.has('seal.key-server.container')).toBe(false);
		expect(state.nodes.has('ports')).toBe(false);
	});

	it('represents.endpoints projects an Endpoint', async () => {
		const node = seal.create({ url: 'https://x/' });
		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('seal.key-server')!;
		const endpoints = view.representations?.endpoints as { name: string; url: string }[];
		expect(endpoints[0]?.name).toBe('seal-key-server');
		expect(endpoints[0]?.url).toBe('https://x/');
	});
});

describe('seal (graph composition — managed mode, no real Docker)', () => {
	it('builds graph with seal.image + seal.key-server.container + seal.key-server + ports', () => {
		const node = seal.create({});
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('seal.key-server')).toBe(true);
		expect(state.nodes.has('seal.key-server.container')).toBe(true);
		// Image build chains content-addressed via dockerImage.
		expect(state.nodes.has('seal.image')).toBe(true);
		expect(state.nodes.has('ports')).toBe(true);
	});

	it('skips seal.image when caller pins a pre-built image tag', () => {
		const node = seal.create({ image: 'mystenlabs/seal-key-server:devnet' });
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('seal.key-server')).toBe(true);
		expect(state.nodes.has('seal.key-server.container')).toBe(true);
		// No dockerImage build when the caller has a pre-built tag.
		expect(state.nodes.has('seal.image')).toBe(false);
	});

	it('vendored docker context resolves to a real on-disk directory', () => {
		// `seal.image` resolves its build context via `import.meta.url`
		// from `seal.ts` — guard against the source-vs-built path drift
		// that would only surface at `docker build` time.
		const ctx = fileURLToPath(new URL('./seal/docker/', import.meta.url));
		expect(existsSync(ctx)).toBe(true);
		expect(existsSync(`${ctx}Dockerfile`)).toBe(true);
	});
});

describe('seal (static get accessors via __pluginId)', () => {
	it('seal.get("keyServer") resolves the running instance and projects { url }', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { ks: seal.get('keyServer') },
			start: async ({ deps: { ks } }) => ({ url: ks.url }),
		});
		const engine = new Engine(
			{ stack: [seal.create({ url: 'https://k/' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { url: string };
		expect(state.url).toBe('https://k/');
	});

	it('seal.get("url") projects the bare URL string', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { url: seal.get('url') },
			start: async ({ deps: { url } }) => ({ raw: url }),
		});
		const engine = new Engine(
			{ stack: [seal.create({ url: 'https://k/' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { raw: string };
		expect(state.raw).toBe('https://k/');
	});

	it('rejects two `create` instances of the same schema in one stack', () => {
		const a = seal.create({ url: 'https://a/' });
		const b = seal.create({ url: 'https://b/' });
		expect(() => new Engine({ stack: [a, b] }, { env })).toThrow(/two instances/);
	});

	it('errors when a static get is used without a create() in the stack', () => {
		const consumer = define({
			name: 'consumer',
			deps: { ks: seal.get('keyServer') },
			start: async ({ deps: { ks } }) => ({ url: ks.url }),
		});
		expect(() => new Engine({ stack: [consumer] }, { env })).toThrow(/no instance/);
	});
});

describe('sealLocalnet (graph composition — no real chain)', () => {
	// `sealLocalnet({...})` exposes a `publish` + `register` pair on top
	// of the existing `seal` schema. Verify both producers compose into
	// the graph alongside seal's key-server, the source gitFetch, and
	// the implicit sui dep.
	function makeOps() {
		// Synthetic signer producer matches the accountPool pattern.
		interface SignerState {
			keypair: Ed25519Keypair;
		}
		const signerProvides = {
			signer: dep((s: SignerState) => s.keypair),
		} satisfies Provides<SignerState>;
		const signerNode = define<SignerState, typeof signerProvides>({
			name: 'test.signer',
			provides: signerProvides,
			start: async () => ({ keypair: Ed25519Keypair.generate() }),
		});
		const signerDep = signerNode.get('signer') as unknown as Dep<unknown, Ed25519Keypair>;
		const ops = sealLocalnet({ signer: signerDep, publicKeyHex: '0xdeadbeef' });
		return { signerNode, ops };
	}

	it('publish + register + source siblings appear with sui + seal pulled in', () => {
		const { signerNode, ops } = makeOps();
		const engine = new Engine(
			{
				stack: [
					sui.create({ network: 'localnet', rpcUrl: 'http://stub/' }),
					seal.create({ url: 'https://stub/' }),
					signerNode,
					ops.publish,
					ops.register,
				],
			},
			{ env },
		);
		const state = engine.getState();
		expect(state.nodes.has('publish.seal')).toBe(true);
		expect(state.nodes.has('seal.register')).toBe(true);
		expect(state.nodes.has('seal.source')).toBe(true);
		expect(state.nodes.has('seal.key-server')).toBe(true);
		expect(state.nodes.has('sui.localnet')).toBe(true);
	});

	it('register depends on publish, sui rpc, and seal key-server', () => {
		const { signerNode, ops } = makeOps();
		const engine = new Engine(
			{
				stack: [
					sui.create({ network: 'localnet', rpcUrl: 'http://stub/' }),
					seal.create({ url: 'https://stub/' }),
					signerNode,
					ops.register,
				],
			},
			{ env },
		);
		// Engine pulls in the right transitive nodes via deps.
		const state = engine.getState();
		expect(state.nodes.has('publish.seal')).toBe(true);
		expect(state.nodes.has('seal.source')).toBe(true);
		expect(state.nodes.has('seal.key-server')).toBe(true);
	});
});

describe('seal (provides.full)', () => {
	it('exposes the full state for "I depend on this being up" patterns', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { s: seal.get('full') },
			start: async ({ deps: { s } }) => ({
				ok: typeof (s as SealState).url === 'string' && (s as SealState).url.length > 0,
			}),
		});
		const engine = new Engine(
			{ stack: [seal.create({ url: 'https://x/' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { ok: boolean };
		expect(state.ok).toBe(true);
	});
});
