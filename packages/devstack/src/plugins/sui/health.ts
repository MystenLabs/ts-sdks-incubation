// JSON-RPC + faucet probes for the sui plugin. The gRPC path note
// (v2.LedgerService vs v2beta2.LedgerService) — see notes/friction.md
// "gRPC discoverability".

export interface ProbeResult {
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

export async function probeGrpc(rpcUrl: string, timeoutMs = 2000): Promise<ProbeResult> {
	const probeUrl = `${rpcUrl}/sui.rpc.v2.LedgerService/GetServiceInfo`;
	try {
		const res = await fetch(probeUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/grpc-web', 'x-grpc-web': '1' },
			body: new Uint8Array([0, 0, 0, 0, 0]),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status === 404) {
			return {
				ok: false,
				detail: 'HTTP 404 — wrong path? expected sui.rpc.v2.LedgerService',
			};
		}
		return { ok: true, detail: `HTTP ${res.status}` };
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

export async function waitForRpc(
	rpcUrl: string,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	await waitFor('RPC', rpcUrl, () => probeRpc(rpcUrl, 1500), opts);
}

export async function waitForFaucet(
	faucetUrl: string,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	await waitFor('faucet', faucetUrl, () => probeFaucet(faucetUrl, 1500), opts);
}

async function waitFor(
	label: string,
	url: string,
	probe: () => Promise<ProbeResult>,
	opts: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const intervalMs = opts.intervalMs ?? 500;
	const deadline = Date.now() + timeoutMs;
	let lastDetail = 'never reached';
	while (Date.now() < deadline) {
		const result = await probe();
		if (result.ok) return;
		lastDetail = result.detail ?? 'unknown';
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`${label} ${url} never came up: ${lastDetail}`);
}
