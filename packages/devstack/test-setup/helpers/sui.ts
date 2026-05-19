// Sui JSON-RPC helpers — thin wrappers around `fetch` for use in L3
// docker tests. Avoids dragging the full `@mysten/sui` client into
// test-only code; tests that need richer surfaces can construct their
// own client.
//
// Surface kept small: `getObject` (single-object fetch) + `getBalance`
// (per-coin balance for an owner). Both return the parsed JSON payload
// verbatim — the consumer asserts shape.

export interface GetObjectResult {
	readonly objectId: string;
	readonly type?: string;
	readonly owner?: unknown;
	readonly digest?: string;
	readonly content?: unknown;
}

export interface GetBalanceResult {
	readonly coinType: string;
	readonly coinObjectCount: number;
	readonly totalBalance: string;
}

/** GET an object by id via the sui-localnet RPC. `rpcUrl` is the
 *  `services.sui.rpc.url` from the manifest. */
export const getObject = async (
	rpcUrl: string,
	objectId: string,
	options: { showType?: boolean; showOwner?: boolean; showContent?: boolean } = {},
): Promise<GetObjectResult> => {
	const res = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'sui_getObject',
			params: [
				objectId,
				{
					showType: options.showType ?? true,
					showOwner: options.showOwner ?? true,
					showContent: options.showContent ?? false,
				},
			],
		}),
	});
	if (!res.ok) throw new Error(`getObject(${objectId}): RPC returned ${res.status}`);
	const body = (await res.json()) as {
		result?: { data?: GetObjectResult; error?: unknown };
		error?: unknown;
	};
	if (body.error !== undefined)
		throw new Error(`getObject(${objectId}): ${JSON.stringify(body.error)}`);
	if (body.result?.data === undefined) throw new Error(`getObject(${objectId}): no data`);
	return body.result.data;
};

/** GET an owner's balance for a coin type. Returns the raw RPC payload
 *  (`totalBalance` is a `u64` decimal string). */
export const getBalance = async (
	rpcUrl: string,
	owner: string,
	coinType: string,
): Promise<GetBalanceResult> => {
	const res = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'suix_getBalance',
			params: [owner, coinType],
		}),
	});
	if (!res.ok) throw new Error(`getBalance(${owner}, ${coinType}): RPC returned ${res.status}`);
	const body = (await res.json()) as { result?: GetBalanceResult; error?: unknown };
	if (body.error !== undefined)
		throw new Error(`getBalance(${owner}, ${coinType}): ${JSON.stringify(body.error)}`);
	if (body.result === undefined) throw new Error(`getBalance(${owner}, ${coinType}): no result`);
	return body.result;
};
