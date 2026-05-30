import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, SubscriptionRef } from 'effect';
import { emptyProjection } from '../../substrate/runtime/projection/state-ref.ts';
import { emptyControlPlaneDomain } from '../../substrate/runtime/control-plane/domain.ts';
import { emptyDashboardDomain } from './domain.ts';
import type { EngineCommand } from '../../substrate/events.ts';
import { makeDashboardListener } from './server.ts';

// Exercises the full API + server path the way it runs in production:
// Pothos schema → graphql-yoga → node:http. Executing through HTTP (rather
// than importing `graphql`'s `execute` directly) also sidesteps vitest's
// ESM/CJS dual-realm hazard for the single `graphql` instance.

let server: Server;
let baseUrl: string;
let assetsDir: string;
const recorded: EngineCommand[] = [];

// Stand up a fake built SPA so the static-serving path is exercised the way
// the bundled UI runs in production, without depending on a real `vite build`.
const ROOT_DIV = '<div id="root"></div>';
const INDEX_HTML = `<!doctype html><html><head>\
<script type="module" crossorigin src="/assets/index-abc123.js"></script></head>\
<body>${ROOT_DIV}</body></html>`;
const ASSET_JS = 'console.log("dashboard");';

beforeAll(async () => {
	assetsDir = mkdtempSync(join(tmpdir(), 'devstack-dashboard-ui.'));
	mkdirSync(join(assetsDir, 'assets'), { recursive: true });
	writeFileSync(join(assetsDir, 'index.html'), INDEX_HTML, 'utf8');
	writeFileSync(join(assetsDir, 'assets', 'index-abc123.js'), ASSET_JS, 'utf8');

	const state = Effect.runSync(SubscriptionRef.make(emptyProjection()));
	server = createServer(
		makeDashboardListener({
			assetsDir,
			context: {
				state,
				publishCommand: (command) =>
					Effect.sync(() => {
						recorded.push(command);
					}),
				domain: emptyControlPlaneDomain,
				pluginDomain: emptyDashboardDomain,
			},
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(assetsDir, { recursive: true, force: true });
});

const gql = async (query: string) => {
	const res = await fetch(`${baseUrl}/graphql`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query }),
	});
	return res.json() as Promise<{ data?: Record<string, unknown>; errors?: unknown }>;
};

describe('dashboard http server (Pothos schema + yoga)', () => {
	it('serves the built SPA index.html at /', async () => {
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const body = await res.text();
		expect(body).toContain('<div id="root">');
		expect(body).toContain('/assets/index-abc123.js');
	});

	it('serves built assets with the correct content-type', async () => {
		const res = await fetch(`${baseUrl}/assets/index-abc123.js`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/javascript');
		expect(await res.text()).toContain('dashboard');
	});

	it('falls back to index.html for client-side routes (SPA fallback)', async () => {
		const res = await fetch(`${baseUrl}/services/some-deep/route`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(await res.text()).toContain('<div id="root">');
	});

	it('rejects path-traversal attempts by falling back to index.html', async () => {
		const res = await fetch(`${baseUrl}/../../package.json`);
		expect(res.status).toBe(200);
		// Never the traversed file: either index.html or a 404, never JSON.
		expect(res.headers.get('content-type')).not.toContain('application/json');
	});

	it('answers control/observability queries', async () => {
		const body = await gql(
			'{ ping state { cycle { phase } summary { total health } services { key } } }',
		);
		expect(body.errors).toBeUndefined();
		expect(body.data?.ping).toBe('pong');
		// `state` is a typed StackState object.
		expect(body.data?.state).toMatchObject({
			cycle: { phase: 'booting' },
			summary: { total: 0, health: 'empty' },
			services: [],
		});
	});

	it('maps mutations to engine commands', async () => {
		recorded.length = 0;
		// Mutations return a typed CommandResult ({ ok, command }).
		const restart = await gql('mutation { restart { ok command } }');
		expect(restart.errors).toBeUndefined();
		expect(restart.data?.restart).toEqual({ ok: true, command: 'stack.restart' });

		// captureSnapshot takes its args via the with-input wrapper.
		const snap = await gql('mutation { captureSnapshot(input: { name: "s1" }) { ok command } }');
		expect(snap.errors).toBeUndefined();
		expect(snap.data?.captureSnapshot).toEqual({ ok: true, command: 'snapshot.capture' });

		expect(recorded).toEqual([{ tag: 'stack.restart' }, { tag: 'snapshot.capture', name: 's1' }]);
	});
});

describe('dashboard http server (UI bundle absent → API test page fallback)', () => {
	let fbServer: Server;
	let fbUrl: string;

	beforeAll(async () => {
		// Point at a dir with no index.html so the UI is considered unavailable.
		const emptyDir = mkdtempSync(join(tmpdir(), 'devstack-dashboard-empty.'));
		const state = Effect.runSync(SubscriptionRef.make(emptyProjection()));
		fbServer = createServer(
			makeDashboardListener({
				assetsDir: emptyDir,
				context: {
					state,
					publishCommand: () => Effect.void,
					domain: emptyControlPlaneDomain,
					pluginDomain: emptyDashboardDomain,
				},
			}),
		);
		await new Promise<void>((resolve) => fbServer.listen(0, '127.0.0.1', resolve));
		const { port } = fbServer.address() as AddressInfo;
		fbUrl = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => fbServer.close(() => resolve()));
	});

	it('serves the API test page at / when no UI is bundled', async () => {
		const res = await fetch(`${fbUrl}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(await res.text()).toContain('devstack dashboard');
	});

	it('keeps /graphql working without a UI bundle', async () => {
		const res = await fetch(`${fbUrl}/graphql`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query: '{ ping }' }),
		});
		const body = (await res.json()) as { data?: { ping?: string } };
		expect(body.data?.ping).toBe('pong');
	});
});
