import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useEffect, useState } from 'react';

import {
	buildCreateManagerTx,
	buildDepositAndOrderTx,
	DEMO_ORDER,
	getPool,
	readMidPrice,
} from '../lib/deepbook.js';
import { useSignAndExecute, waitForCreatedObjectId } from '../lib/sign.js';
import { Panel, PanelButton } from '../ui/Panel.js';

const poolInfo = getPool();

/**
 * DeepBook panel: show the seeded DEEP/SUI pool and let the connected
 * dev-wallet account place a small resting bid against it. The flow runs
 * two transactions (create BalanceManager, then deposit SUI + place order)
 * and surfaces the order transaction digest as proof the order hit the pool.
 */
export function DeepbookPanel({ connected }: { connected: boolean }) {
	const account = useCurrentAccount();
	const client = useCurrentClient();
	const { mutateAsync } = useSignAndExecute({ invalidateKeys: [['balance']] });

	const [midPrice, setMidPrice] = useState<number | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		readMidPrice(client)
			.then((price) => {
				if (!cancelled) setMidPrice(price);
			})
			.catch(() => {
				if (!cancelled) setMidPrice(null);
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	async function onPlaceOrder() {
		if (account === null) return;
		setError(null);
		setResult(null);
		setBusy(true);
		try {
			// Tx 1 — create + share a BalanceManager, capture its object id.
			const create = await mutateAsync(buildCreateManagerTx(client, account.address));
			const managerId = await waitForCreatedObjectId(client, create.digest);
			if (managerId === null) {
				throw new Error('createAndShareBalanceManager did not create an object');
			}

			// Tx 2 — deposit SUI and place the resting bid.
			const order = await mutateAsync(
				buildDepositAndOrderTx({
					suiClient: client,
					address: account.address,
					balanceManagerAddress: managerId,
					clientOrderId: String(Date.now()),
				}),
			);
			setResult(order.digest);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const disabled = !connected || busy;

	return (
		<Panel
			title="DeepBook"
			subtitle="Place a resting bid on the seeded DEEP/SUI pool"
			connected={connected}
			error={error}
		>
			<div className="space-y-3">
				<dl className="space-y-1 text-xs" data-testid="deepbook-pool">
					<div className="flex justify-between gap-2">
						<dt className="text-neutral-500">Pool</dt>
						<dd className="font-mono">
							{poolInfo.base} / {poolInfo.quote}
						</dd>
					</div>
					<div className="flex justify-between gap-2">
						<dt className="text-neutral-500">Pool id</dt>
						<dd className="font-mono truncate max-w-[60%]" title={poolInfo.poolId}>
							{poolInfo.poolId}
						</dd>
					</div>
					<div className="flex justify-between gap-2">
						<dt className="text-neutral-500">Package</dt>
						<dd className="font-mono truncate max-w-[60%]" title={poolInfo.packageId}>
							{poolInfo.packageId}
						</dd>
					</div>
					<div className="flex justify-between gap-2">
						<dt className="text-neutral-500">Mid price</dt>
						<dd className="font-mono" data-testid="deepbook-mid-price">
							{midPrice === null ? 'no book yet' : midPrice.toFixed(4)}
						</dd>
					</div>
				</dl>

				<p className="text-xs text-neutral-500">
					Places a {DEMO_ORDER.quantity} {poolInfo.base} bid at {DEMO_ORDER.price} {poolInfo.quote}{' '}
					(rests below market — proves the order reaches the pool).
				</p>

				<PanelButton testid="deepbook-place-order" disabled={disabled} onClick={onPlaceOrder}>
					{busy ? 'Placing order…' : 'Place order'}
				</PanelButton>

				{result !== null && (
					<p className="text-sm break-all">
						Order accepted:{' '}
						<span className="font-mono" data-testid="deepbook-order-result">
							{result}
						</span>
					</p>
				)}
			</div>
		</Panel>
	);
}
