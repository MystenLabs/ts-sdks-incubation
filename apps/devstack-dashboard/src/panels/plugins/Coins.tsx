// Coins plugin view — the coin registry + treasury-cap surface.
//
// Real data: `fetchCoinCaps(endpoint)` (control-plane GraphQL) gives each
// coin's full type, decimals, symbol, source, packageId, and treasuryCapId
// (the cap that *would* drive a mint). Per-coin metadata (name / icon-symbol)
// is read browser-direct from the chain via `useCoinMeta`. Total supply is read
// browser-direct from the coin's TreasuryCap object via `useTotalSupply`
// (`TreasuryCap<T>` wraps a `Supply<T>` whose `total_supply.value` is the minted
// base-unit total). Coins without a treasury cap keep an honest "—".
//
// Mint: the control-plane `mint` GraphQL mutation (`mintCoin` in `src/lib/api.ts`)
// mints with the in-process treasury-cap owner's signer and returns the real
// on-chain tx digest. The Mint form converts the entered whole-token amount to
// base units (× 10^decimals, via BigInt) and submits; on success it invalidates
// the coin's `useTotalSupply` query so the new supply shows. Coins without a
// treasury cap stay non-mintable (the backend returns ok:false either way).

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type CoinCap, mintCoin, restartPlugin } from '../../lib/api.ts';
import { toBaseUnits, truncateMiddle } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { useCoinCaps, useCoinMeta, useTotalSupply } from '../../lib/useChain.ts';
import { useToast } from '../../lib/toast.tsx';
import {
	Badge,
	Banner,
	type Column,
	CoinAmount,
	CoinIcon,
	CopyChip,
	DataTable,
	EmptyState,
	Field,
	Icon,
	NumberInput,
	Panel,
	SectionHead,
	Select,
	Tooltip,
} from '../../ui/index.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import type { Projection } from '../../lib/types.ts';
import { PluginScaffold, type PluginViewProps } from '../PluginPage.tsx';

export const CoinsView = ({
	row,
	pluginKey,
	endpoint,
	projection,
	refresh,
	chain,
}: PluginViewProps) => {
	const { success, error } = useToast();

	// Coin treasury-cap registry from the control plane, keyed per endpoint+network.
	const capsQuery = useCoinCaps(endpoint, chain.network);
	const caps: ReadonlyArray<CoinCap> = capsQuery.data ?? [];
	const loading = capsQuery.isLoading;
	const loadErr = capsQuery.isError
		? capsQuery.error instanceof Error
			? capsQuery.error.message
			: String(capsQuery.error)
		: null;

	const [mintFor, setMintFor] = useState<CoinCap | null>(null);
	const [busy, setBusy] = useState(false);

	const onRestart = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const result = await restartPlugin(endpoint, row?.key ?? pluginKey);
			if (result.ok) success(result.message ?? 'Coin plugin restart requested');
			else error(result.message ?? 'Coin plugin restart failed');
			await refresh();
		} catch (err) {
			error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<PluginScaffold
			label="Coins"
			icon="coins"
			row={row}
			token="yellow"
			subtitle="Coin registry · treasury caps."
			actions={
				<>
					<button className="btn btn-sm" disabled={busy} onClick={() => void onRestart()}>
						<Icon name="refresh" size={13} /> Restart
					</button>
					{row && (
						<button className="btn btn-sm btn-ghost" onClick={() => navigate('activity')}>
							Logs &amp; events
						</button>
					)}
				</>
			}
		>
			{loadErr ? (
				<Banner tone="danger" title="Coin registry unavailable">
					Couldn't load coin treasury caps from the control plane: {loadErr}
				</Banner>
			) : loading ? (
				<Panel pad>
					<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>Loading coin registry…</span>
				</Panel>
			) : caps.length === 0 ? (
				<Panel>
					<EmptyState
						icon="coins"
						title="No coins registered"
						hint="This stack hasn't registered any coin treasury caps yet."
					/>
				</Panel>
			) : (
				<>
					<Panel header={<SectionHead title="Coin registry" count={caps.length} />}>
						<CoinTable
							caps={caps}
							chain={chain}
							onMint={(cap) =>
								setMintFor((cur) => (cur?.fullCoinType === cap.fullCoinType ? null : cap))
							}
							activeMint={mintFor?.fullCoinType ?? null}
						/>
					</Panel>

					{mintFor && (
						<MintForm
							cap={mintFor}
							accounts={projection.accounts}
							endpoint={endpoint}
							chain={chain}
							onCancel={() => setMintFor(null)}
						/>
					)}
				</>
			)}
		</PluginScaffold>
	);
};

interface CoinTableProps {
	readonly caps: ReadonlyArray<CoinCap>;
	readonly chain: ChainSource;
	readonly onMint: (cap: CoinCap) => void;
	readonly activeMint: string | null;
}

const CoinTable = ({ caps, chain, onMint, activeMint }: CoinTableProps) => {
	const columns: ReadonlyArray<Column<CoinCap>> = [
		{
			key: 'coin',
			header: 'Coin',
			render: (c) => <CoinCell cap={c} chain={chain} />,
		},
		{
			key: 'type',
			header: 'Type',
			render: (c) => <CopyChip text={c.fullCoinType} display={c.fullCoinType} />,
		},
		{
			key: 'decimals',
			header: 'Decimals',
			align: 'right',
			width: 90,
			sortVal: (c) => c.decimals,
			render: (c) => (
				<span className="mono tnum" style={{ color: 'var(--tx-lo)' }}>
					{c.decimals}
				</span>
			),
		},
		{
			key: 'supply',
			header: 'Supply',
			align: 'right',
			width: 130,
			render: (c) => <SupplyCell cap={c} chain={chain} />,
		},
		{
			key: 'source',
			header: 'Source',
			width: 110,
			render: (c) => <Badge style={{ height: 19, fontSize: 10.5 }}>{c.source}</Badge>,
		},
		{
			key: 'treasury',
			header: 'Treasury cap',
			render: (c) =>
				c.treasuryCapId ? (
					<CopyChip text={c.treasuryCapId} display={truncateMiddle(c.treasuryCapId, 5, 3)} />
				) : (
					<span style={{ color: 'var(--tx-dim)' }}>—</span>
				),
		},
		{
			key: 'action',
			header: '',
			width: 110,
			render: (c) =>
				c.treasuryCapId ? (
					<button
						className={`btn btn-sm ${activeMint === c.fullCoinType ? 'btn-primary' : ''}`.trimEnd()}
						onClick={(e) => {
							e.stopPropagation();
							onMint(c);
						}}
					>
						<Icon name="coins" size={13} /> Mint
					</button>
				) : (
					<span style={{ color: 'var(--tx-dim)', fontSize: 11.5 }}>no cap</span>
				),
		},
	];
	return (
		<DataTable
			columns={columns}
			rows={caps}
			rowKey={(c) => c.fullCoinType}
			activeKey={activeMint ?? undefined}
		/>
	);
};

/** Coin glyph + symbol cell. Resolves the display symbol from chain metadata,
 *  falling back to the control-plane symbol (or the type's last segment). */
const CoinCell = ({ cap, chain }: { cap: CoinCap; chain: ChainSource }) => {
	const meta = useCoinMeta(chain, cap.fullCoinType);
	const fallback = cap.symbol ?? cap.fullCoinType.split('::').pop() ?? '?';
	const symbol = meta.data?.symbol ?? fallback;
	return (
		<span className="row" style={{ gap: 8 }}>
			<CoinIcon symbol={symbol} size={20} />
			<span style={{ fontWeight: 550 }}>{symbol}</span>
		</span>
	);
};

/**
 * Total-supply cell. When the coin has a treasury cap, reads its real minted
 * total browser-direct from the TreasuryCap object (`useTotalSupply`) and scales
 * it by the coin's decimals via `CoinAmount`. Without a cap the supply is genuinely
 * unknowable from the chain reads available, so an honest "—" is shown.
 */
const SupplyCell = ({ cap, chain }: { cap: CoinCap; chain: ChainSource }) => {
	const supply = useTotalSupply(chain, cap.treasuryCapId ?? null);
	if (!cap.treasuryCapId) {
		return (
			<Tooltip label="No treasury cap for this coin — total supply isn't readable.">
				<span style={{ color: 'var(--tx-dim)' }}>—</span>
			</Tooltip>
		);
	}
	if (supply.isLoading) return <span style={{ color: 'var(--tx-dim)' }}>…</span>;
	if (supply.isError || supply.data == null) {
		return (
			<Tooltip label="Couldn't read total supply from the treasury cap object.">
				<span style={{ color: 'var(--tx-dim)' }}>—</span>
			</Tooltip>
		);
	}
	const symbol = cap.symbol ?? cap.fullCoinType.split('::').pop() ?? '';
	return <CoinAmount mist={supply.data} decimals={cap.decimals} symbol={symbol} />;
};

interface MintFormProps {
	readonly cap: CoinCap;
	readonly accounts: Projection['accounts'];
	readonly endpoint: string;
	readonly chain: ChainSource;
	readonly onCancel: () => void;
}

const MintForm = ({ cap, accounts, endpoint, chain, onCancel }: MintFormProps) => {
	const { success, error } = useToast();
	const queryClient = useQueryClient();
	const named = useMemo(() => accounts.filter((a) => a.address), [accounts]);
	const [recipient, setRecipient] = useState(named[0]?.address ?? '');
	const [amount, setAmount] = useState(1000);
	const [minting, setMinting] = useState(false);
	const symbol = cap.symbol ?? cap.fullCoinType.split('::').pop() ?? 'coin';

	const canSubmit = !minting && recipient !== '' && Number.isInteger(amount) && amount > 0;

	const onMint = async () => {
		if (!canSubmit) return;
		setMinting(true);
		try {
			const result = await mintCoin(endpoint, {
				coinType: cap.fullCoinType,
				recipient,
				amountBaseUnits: toBaseUnits(amount, cap.decimals),
			});
			if (result.ok) {
				success(
					`Minted ${amount.toLocaleString()} ${symbol}${result.digest ? ` · ${result.digest}` : ''}`,
				);
				// Supply only moves on mint/burn — refresh the coin's total-supply read.
				await queryClient.invalidateQueries({
					queryKey: ['chain', chain.network, 'totalSupply', cap.treasuryCapId ?? null],
				});
				onCancel();
			} else {
				error(result.detail);
			}
		} catch (err) {
			error(err instanceof Error ? err.message : String(err));
		} finally {
			setMinting(false);
		}
	};

	return (
		<Panel pad className="fade-up" style={{ maxWidth: 480 }}>
			<SectionHead title={`Mint ${symbol}`} />
			<div className="col" style={{ gap: 12 }}>
				<Field label="Recipient">
					<Select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
						{named.length === 0 && <option value="">No funded accounts</option>}
						{named.map((a) => (
							<option key={a.key} value={a.address ?? ''}>
								{a.name} · {truncateMiddle(a.address ?? '')}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Amount" hint={`Whole ${symbol} (scaled by ${cap.decimals} decimals)`}>
					<NumberInput value={amount} min={0} onChange={setAmount} disabled={minting} />
				</Field>

				<div className="row" style={{ gap: 8 }}>
					<button
						className="btn btn-primary grow"
						disabled={!canSubmit}
						onClick={() => void onMint()}
					>
						{minting ? 'Minting…' : `Mint ${amount.toLocaleString()} ${symbol}`}
					</button>
					<button className="btn" onClick={onCancel} disabled={minting}>
						Cancel
					</button>
				</div>
			</div>
		</Panel>
	);
};
