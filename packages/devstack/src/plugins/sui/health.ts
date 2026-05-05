// JSON-RPC + faucet probes for the sui plugin. The gRPC path note
// (v2.LedgerService vs v2beta2.LedgerService) — see notes/friction.md
// "gRPC discoverability".

interface ProbeResult {
	ok: boolean;
	detail?: string;
}

export async function probeRpc(rpcUrl: string, timeoutMs = 2000): Promise<ProbeResult> {
	try {
		const res = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'sui_getChainIdentifier',
				params: [],
				id: 1,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
		const body = (await res.json()) as { result?: string };
		return { ok: true, detail: body.result !== undefined ? `chainId ${body.result}` : 'reachable' };
	} catch (err) {
		return { ok: false, detail: (err as Error).message };
	}
}

/**
 * Confirm sui-localnet has not pruned its checkpoint history. Walrus storage
 * nodes follow the chain from when they were registered onward via the v2
 * LedgerService `get_full_checkpoint` gRPC, and a localnet that prunes
 * checkpoints out from under them gets the storage node permanently stuck
 * (logs spam `Checkpoint <N> not found`, every blob write returns 400). The
 * devstack-managed sui image's entrypoint disables pruning on first boot,
 * but this check is the runtime fail-loud guard against a custom image, an
 * upstream sui change, or a hand-edited fullnode.yaml — `sui_getCheckpoint(1)`
 * returning NotFound is a one-line signal that the chain has begun pruning.
 */
export async function probeCheckpointRetention(
	rpcUrl: string,
	timeoutMs = 2000,
): Promise<ProbeResult> {
	try {
		const res = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'sui_getCheckpoint',
				params: ['1'],
				id: 1,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
		const body = (await res.json()) as {
			result?: { sequenceNumber?: string };
			error?: { message?: string };
		};
		if (body.error !== undefined) {
			return { ok: false, detail: `pruned (${body.error.message ?? 'no message'})` };
		}
		if (body.result?.sequenceNumber !== '1') {
			return {
				ok: false,
				detail: `checkpoint 1 missing — pruning likely active (walrus will fall behind)`,
			};
		}
		return { ok: true, detail: 'no pruning' };
	} catch (err) {
		return { ok: false, detail: (err as Error).message };
	}
}

export async function probeFaucet(faucetUrl: string, timeoutMs = 2000): Promise<ProbeResult> {
	try {
		const res = await fetch(faucetUrl, { signal: AbortSignal.timeout(timeoutMs) });
		// Faucet root may return 404 but anything <500 means the service is up.
		if (res.status >= 500) return { ok: false, detail: `HTTP ${res.status}` };
		return { ok: true, detail: 'reachable' };
	} catch (err) {
		return { ok: false, detail: (err as Error).message };
	}
}

/** Probe the GraphQL HTTP endpoint with the trivial `{ chainIdentifier }`
 * query. Bootstrap takes longer than RPC because the embedded indexer
 * has to come up first; we use this as the readiness gate after
 * `--with-graphql=...`. */
export async function probeGraphql(graphqlUrl: string, timeoutMs = 2000): Promise<ProbeResult> {
	try {
		const res = await fetch(graphqlUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: '{ chainIdentifier }' }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
		const body = (await res.json()) as { data?: { chainIdentifier?: string } };
		const id = body.data?.chainIdentifier;
		return { ok: true, detail: typeof id === 'string' ? `chainId ${id}` : 'reachable' };
	} catch (err) {
		return { ok: false, detail: (err as Error).message };
	}
}

