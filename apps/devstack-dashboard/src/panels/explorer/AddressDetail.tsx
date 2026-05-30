// Address detail — the view for a bare account address (no object/package at the
// id). Shows the address's owned objects (`useOwnedObjects`, each row drills into
// its object), its per-coin balances (`useAddressBalances`), and — when the
// address matches a configured stack account (`projection.accounts`) — that
// account's name prominently ("alice") so known accounts are recognized on sight.
// Loading → `DetailSkeleton`; an unreadable/empty address still renders honestly
// (an address that has never been touched simply owns nothing).

import { truncateMiddle } from '../../lib/format.ts';
import { gotoObject } from '../../lib/router.ts';
import type { Projection } from '../../lib/types.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import { useAddressBalances, useOwnedObjects } from '../../lib/useChain.ts';
import type { BalanceView, OwnedObjectView } from '../../lib/explorerTypes.ts';
import {
	Badge,
	CoinAmount,
	CoinIcon,
	type Column,
	CopyChip,
	DataTable,
	EmptyState,
	Icon,
	Identicon,
	Panel,
	SectionHead,
	SkeletonRows,
} from '../../ui/index.ts';

interface AddressDetailProps {
	readonly chain: ChainSource;
	readonly projection: Projection;
	readonly id: string;
}

/** Symbol from a coin type's trailing `::SYMBOL`, upper-cased (`DEEP`, `WAL`…). */
const coinSymbol = (coinType: string): string => {
	const tail = coinType.split('::').pop() ?? coinType;
	return tail.toUpperCase();
};

/** Short Move type label (`Coin<SUI>` → struct + first type arg tail). */
const typeLabel = (type: string): string => {
	const struct = type.split('<')[0];
	const tail = struct.split('::').slice(-2).join('::');
	return tail || struct || type;
};

export const AddressDetail = ({ chain, projection, id }: AddressDetailProps) => {
	const owned = useOwnedObjects(chain, id);
	const balances = useAddressBalances(chain, id);

	// Recognize known stack accounts so "alice" is shown instead of a bare 0x….
	const account = projection.accounts.find((a) => a.address === id) ?? null;

	const ownedRows: ReadonlyArray<OwnedObjectView> = owned.data ?? [];
	const balanceRows: ReadonlyArray<BalanceView> = balances.data ?? [];

	const columns: ReadonlyArray<Column<OwnedObjectView>> = [
		{
			key: 'id',
			header: 'Object',
			render: (o) => (
				<span className="mono" style={{ fontSize: 12, color: 'var(--c-cyan)' }}>
					{truncateMiddle(o.id, 8, 6)}
				</span>
			),
		},
		{
			key: 'type',
			header: 'Type',
			render: (o) => (
				<span
					className="mono trunc"
					style={{ fontSize: 11.5, color: 'var(--c-blue)', maxWidth: 220 }}
					title={o.type}
				>
					{typeLabel(o.type)}
				</span>
			),
		},
		{
			key: 'version',
			header: 'Version',
			align: 'right',
			render: (o) => (
				<span className="mono tnum" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
					v{o.version}
				</span>
			),
			sortVal: (o) => Number(o.version),
		},
		{
			key: 'chev',
			header: '',
			width: 36,
			render: () => <Icon name="chevR" size={14} style={{ color: 'var(--tx-dim)' }} />,
		},
	];

	return (
		<div className="col fade-up" style={{ gap: 18 }}>
			<Panel pad>
				<div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
					<div className="row" style={{ gap: 10 }}>
						<Identicon address={id} size={28} />
						<div className="col" style={{ gap: 2 }}>
							{account ? (
								<>
									<span style={{ fontSize: 15, fontWeight: 560, color: 'var(--c-magenta)' }}>
										{account.name}
									</span>
									<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>configured account</span>
								</>
							) : (
								<span style={{ fontSize: 13, color: 'var(--tx-mid)' }}>Address</span>
							)}
						</div>
					</div>
					<CopyChip text={id} display={truncateMiddle(id, 10, 6)} />
				</div>
			</Panel>

			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1.3fr 1fr',
					gap: 18,
					alignItems: 'start',
				}}
			>
				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '14px 18px' }}>
						<SectionHead title="Owned objects" count={ownedRows.length} />
					</div>
					{owned.isLoading ? (
						<SkeletonRows rows={5} cols={3} />
					) : (
						<DataTable
							columns={columns}
							rows={ownedRows}
							rowKey={(o) => o.id}
							onRowClick={(o) => gotoObject(o.id)}
							empty={<EmptyState icon="box" title="No owned objects" />}
						/>
					)}
				</Panel>

				<Panel pad>
					<div className="eyebrow" style={{ marginBottom: 10 }}>
						Balances
					</div>
					{balances.isLoading ? (
						<span style={{ fontSize: 11.5, color: 'var(--tx-dim)' }}>Loading balances…</span>
					) : balanceRows.length === 0 ? (
						<span style={{ fontSize: 12.5, color: 'var(--tx-dim)' }}>
							No coin balances held by this address.
						</span>
					) : (
						<div className="col" style={{ gap: 7 }}>
							{balanceRows.map((b) => {
								const symbol = coinSymbol(b.coinType);
								return (
									<div key={b.coinType} className="row between">
										<span className="row" style={{ gap: 7 }}>
											<CoinIcon symbol={symbol} size={18} />
											<span className="mono" style={{ fontSize: 12 }}>
												{symbol}
											</span>
										</span>
										<CoinAmount mist={b.balance} symbol={symbol} />
									</div>
								);
							})}
						</div>
					)}
				</Panel>
			</div>
		</div>
	);
};
