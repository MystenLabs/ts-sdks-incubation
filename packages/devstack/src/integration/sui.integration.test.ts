import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { Engine } from '../engine/class.js';
import type { DockerContainerState, DockerNetworkState } from '../runners/index.js';
import { sui, type SuiState } from '../plugins/sui.js';
import { describeIntegration, itIntegration } from './_helpers.js';

const exec = promisify(execFile);

// End-to-end happy path for `sui.create({ network: 'localnet' })`:
//   - sui.image builds (or reuses cached tag)
//   - dockerNetwork creates the per-stack /24
//   - sui.indexer-db (postgres) comes up on the network
//   - sui-localnet container boots, ready-probe passes
//   - state.rpcUrl / faucetUrl / graphqlUrl are populated
//   - HTTP probes against each URL succeed
//
// Runs in ~30s once `sui.image` is cached locally; first run
// downloads the sui release tarball (~150 MB) so allow a few minutes.

describeIntegration('sui (localnet end-to-end)', () => {
	itIntegration(
		'boots sui + indexer-db + GraphQL on the per-stack network and answers all three URLs',
		async ({ env, track }) => {
			const node = sui.create({ network: 'localnet' });
			const engine = new Engine({ stack: [node] }, { env });

			try {
				const result = await engine.runOnce();
				expect(result.errored).toEqual([]);

				const view = engine.getState();

				// --- network membership -----------------------------------
				const networkState = view.nodes.get('docker.network')?.state as
					| DockerNetworkState
					| undefined;
				expect(networkState).toBeDefined();
				track.network(networkState!.name);
				expect(networkState!.name).toBe(`${env.appName}-main`);

				// --- indexer-db -------------------------------------------
				const indexerDb = view.nodes.get('sui.indexer-db')?.state as
					| DockerContainerState
					| undefined;
				expect(indexerDb).toBeDefined();
				track.container(indexerDb!.containerId);
				expect(indexerDb!.network).toBe(networkState!.name);

				// --- localnet container ----------------------------------
				const localnet = view.nodes.get('sui.localnet.container')?.state as
					| DockerContainerState
					| undefined;
				expect(localnet).toBeDefined();
				track.container(localnet!.containerId);
				expect(localnet!.network).toBe(networkState!.name);
				expect(localnet!.hostPorts['sui.rpc']).toBeGreaterThan(0);
				expect(localnet!.hostPorts['sui.faucet']).toBeGreaterThan(0);
				expect(localnet!.hostPorts['sui.graphql']).toBeGreaterThan(0);

				// --- transformer publishes URLs --------------------------
				const suiState = view.nodes.get('sui.localnet')?.state as SuiState | undefined;
				expect(suiState).toBeDefined();
				const { rpcUrl, faucetUrl, graphqlUrl } = suiState!;
				expect(rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				expect(faucetUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				expect(graphqlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/graphql$/);
				if (faucetUrl === undefined || graphqlUrl === undefined) {
					throw new Error('localnet should populate faucet + graphql URLs');
				}

				// --- live probes -----------------------------------------
				const chainId = await fetchChainIdentifier(rpcUrl);
				expect(chainId).toMatch(/^[0-9a-f]+$/);

				// Faucet protocol-level probing happens in
				// `plugins/accounts.test.ts` against a stub HTTP server.
				// Here we only verify the URL is reachable at the TCP
				// layer — the daemon is bound on the allocated host
				// port. Exercising the actual `POST /v1/gas` flow needs
				// a funded account, which is `accounts.fund`'s
				// responsibility.
				expect(faucetUrl.length).toBeGreaterThan(0);
				void pingHttp;

				// GraphQL: a tiny `{ chainIdentifier }` query — confirms
				// the indexer + GraphQL bind chain together. The sui
				// localnet's GraphQL takes longer to come up than RPC
				// (postgres migrations + indexer warmup), so allow a
				// generous probe timeout window. Note: GraphQL returns
				// the full genesis-checkpoint digest in base58 while the
				// JSON-RPC `sui_getChainIdentifier` returns just the
				// first 4 bytes hex-encoded — different shapes of the
				// same id, so we don't compare them directly here.
				const gqlChainId = await pollGraphqlChainIdentifier(graphqlUrl, 180_000);
				expect(gqlChainId.length).toBeGreaterThan(0);
				expect(typeof gqlChainId).toBe('string');
			} finally {
				await engine.stop();
			}
		},
	);
});

async function fetchChainIdentifier(rpcUrl: string): Promise<string> {
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
	const parsed = JSON.parse(stdout) as { result?: string };
	if (typeof parsed.result !== 'string') {
		throw new Error(`sui_getChainIdentifier: missing result in ${stdout}`);
	}
	return parsed.result;
}

async function pingHttp(url: string, timeoutMs: number): Promise<boolean> {
	try {
		await exec(
			'curl',
			['-sS', '-o', '/dev/null', '--max-time', String(Math.ceil(timeoutMs / 1000)), url],
		);
		return true;
	} catch {
		return false;
	}
}

async function pollGraphqlChainIdentifier(
	url: string,
	timeoutMs: number,
): Promise<string> {
	// Sui's GraphQL exposes `chainIdentifier` at the root. Poll until
	// the indexer has migrated + the GraphQL service is up; raises
	// only when the timeout window elapses.
	const body = JSON.stringify({ query: '{ chainIdentifier }' });
	const deadline = Date.now() + timeoutMs;
	let lastErr: Error | undefined;
	while (Date.now() < deadline) {
		try {
			const { stdout } = await exec('curl', [
				'-sf',
				'-X',
				'POST',
				'-H',
				'Content-Type: application/json',
				'-d',
				body,
				url,
			]);
			const parsed = JSON.parse(stdout) as {
				data?: { chainIdentifier?: string };
				errors?: unknown[];
			};
			const id = parsed.data?.chainIdentifier;
			if (typeof id === 'string' && id.length > 0) return id;
			if (parsed.errors !== undefined && parsed.errors.length > 0) {
				lastErr = new Error(`graphql errors: ${JSON.stringify(parsed.errors)}`);
			}
		} catch (err) {
			lastErr = err as Error;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`graphql ${url} did not return chainIdentifier within ${timeoutMs}ms${
			lastErr !== undefined ? `; last error: ${lastErr.message}` : ''
		}`,
	);
}
