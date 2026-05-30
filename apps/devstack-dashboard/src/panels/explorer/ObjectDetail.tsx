// Object detail — `useObject(id)` for the core record (id / version / type /
// owner / previous-tx / Move fields) plus `useDynamicFields(id)` for the
// dynamic-field table. The owner drills into its CONCRETE kind: an `AddressOwner`
// → the address view, an `ObjectOwner` → the owning object. Shared / Immutable /
// Unknown render as badges. Previous-tx drills into the transaction; each dynamic
// field drills into its child object. An object can itself OWN objects/coins
// (it can act as an owner), so — like an address — we show its owned objects +
// balances when it holds any. Packages published by this stack get an "ours"
// badge. Loading → `DetailSkeleton`; not-found → Banner.

import { useState } from 'react';
import { timeAgo, truncateMiddle } from '../../lib/format.ts';
import { gotoAddress, gotoObject, gotoTx } from '../../lib/router.ts';
import { suiGraphqlUrl, useAddressTransactions } from '../../lib/sui-graphql.ts';
import type { AddressTransaction, TxDirection } from '../../lib/sui-graphql.ts';
import type { Projection } from '../../lib/types.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import {
	useAddressBalances,
	useDynamicFields,
	useObject,
	useOwnedObjects,
} from '../../lib/useChain.ts';
import type {
	BalanceView,
	DynamicFieldView,
	ObjectOwnerView,
	OwnedObjectView,
} from '../../lib/explorerTypes.ts';
import { PackageDetail } from './PackageDetail.tsx';
import {
	Badge,
	Banner,
	CoinAmount,
	CoinIcon,
	type Column,
	CopyChip,
	DataTable,
	Dot,
	EmptyState,
	Icon,
	JsonTree,
	Panel,
	SectionHead,
	Segmented,
	SkeletonRows,
} from '../../ui/index.ts';
import { DetailSkeleton, isOurs } from './ExplorerHome.tsx';

interface ObjectDetailProps {
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

/** Status dot colour for a transaction's execution outcome. */
const txStatusToken = (status: AddressTransaction['status']): 'green' | 'red' | 'dim' =>
	status === 'success' ? 'green' : status === 'failure' ? 'red' : 'dim';

const TX_DIRECTION_OPTIONS: ReadonlyArray<{ readonly value: TxDirection; readonly label: string }> =
	[
		{ value: 'sent', label: 'Sent' },
		{ value: 'received', label: 'Received' },
	];

const OwnerCell = ({ owner }: { readonly owner: ObjectOwnerView }) => {
	if ((owner.kind === 'AddressOwner' || owner.kind === 'ObjectOwner') && owner.address) {
		const addr = owner.address;
		// Concrete target: an AddressOwner is an address; an ObjectOwner is an object.
		const goto = owner.kind === 'AddressOwner' ? gotoAddress : gotoObject;
		return (
			<button
				type="button"
				onClick={() => goto(addr)}
				style={{
					background: 'none',
					border: 'none',
					padding: 0,
					color: 'var(--c-magenta)',
					fontSize: 12.5,
					fontFamily: 'var(--font-mono)',
					textAlign: 'left',
				}}
			>
				{truncateMiddle(addr, 8, 6)}
			</button>
		);
	}
	return <Badge style={{ height: 19, fontSize: 10.5 }}>{owner.kind}</Badge>;
};

export const ObjectDetail = ({ chain, projection, id }: ObjectDetailProps) => {
	const q = useObject(chain, id);
	const fields = useDynamicFields(chain, id);
	// An object can act as an owner — surface what it owns/holds, same as an address.
	const owned = useOwnedObjects(chain, id);
	const balances = useAddressBalances(chain, id);
	// An object id can also be a tx sender/affected party — read its history from
	// the node's Sui GraphQL (null endpoint → honest "unavailable", never faked).
	const graphqlUrl = suiGraphqlUrl(projection.endpoints);
	const [txDirection, setTxDirection] = useState<TxDirection>('sent');
	const txs = useAddressTransactions(graphqlUrl, id, txDirection);

	if (q.isLoading) return <DetailSkeleton />;
	if (q.isError)
		return (
			<Banner tone="danger" title="Object not found">
				No object with id <span className="mono">{truncateMiddle(id, 10, 6)}</span> exists on this
				node, or it has been deleted/pruned.
			</Banner>
		);

	const obj = q.data;
	if (!obj)
		return (
			<Banner tone="warn" title="No data">
				The node returned no detail for this object.
			</Banner>
		);

	// The id may resolve to a Move package fetched as an object (the gRPC
	// `objectType` for a package is the literal string `"package"`). Packages have
	// no Move-struct fields/owner to show — render the package view instead.
	if (obj.type === 'package')
		return <PackageDetail chain={chain} projection={projection} id={obj.id} />;

	const ours = isOurs(projection, obj.id);
	const dynRows: ReadonlyArray<DynamicFieldView> = fields.data ?? [];
	const ownedRows: ReadonlyArray<OwnedObjectView> = owned.data ?? [];
	const balanceRows: ReadonlyArray<BalanceView> = balances.data ?? [];
	const txRows: ReadonlyArray<AddressTransaction> = txs.data ?? [];

	const txColumns: ReadonlyArray<Column<AddressTransaction>> = [
		{
			key: 'digest',
			header: 'Digest',
			render: (t) => (
				<span className="row" style={{ gap: 7 }}>
					<Dot token={txStatusToken(t.status)} />
					<span className="mono" style={{ fontSize: 12, color: 'var(--c-cyan)' }}>
						{truncateMiddle(t.digest, 8, 6)}
					</span>
				</span>
			),
		},
		{
			key: 'kind',
			header: 'Kind',
			render: (t) => (
				<span
					className="trunc"
					style={{ fontSize: 11.5, color: 'var(--tx-mid)', maxWidth: 180 }}
					title={t.kind}
				>
					{t.kind.replace(/Transaction$/, '')}
				</span>
			),
		},
		{
			key: 'when',
			header: 'When',
			align: 'right',
			render: (t) => (
				<span className="tnum" style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
					{t.timestampMs === null ? '—' : timeAgo(t.timestampMs)}
				</span>
			),
			sortVal: (t) => t.timestampMs ?? 0,
		},
		{
			key: 'chev',
			header: '',
			width: 36,
			render: () => <Icon name="chevR" size={14} style={{ color: 'var(--tx-dim)' }} />,
		},
	];

	const ownedColumns: ReadonlyArray<Column<OwnedObjectView>> = [
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
			key: 'chev',
			header: '',
			width: 36,
			render: () => <Icon name="chevR" size={14} style={{ color: 'var(--tx-dim)' }} />,
		},
	];

	const columns: ReadonlyArray<Column<DynamicFieldView>> = [
		{
			key: 'name',
			header: 'Name',
			render: (f) => (
				<span className="mono trunc" style={{ fontSize: 12, maxWidth: 160 }}>
					{f.name}
				</span>
			),
		},
		{
			key: 'type',
			header: 'Type',
			render: (f) => (
				<span
					className="mono trunc"
					style={{ fontSize: 11.5, color: 'var(--tx-lo)', maxWidth: 150 }}
				>
					{f.type}
				</span>
			),
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
						{ours && <Dot token="blue" />}
						<CopyChip text={obj.id} display={truncateMiddle(obj.id, 10, 6)} />
						{ours && (
							<Badge style={{ height: 19, fontSize: 10, color: 'var(--c-blue)' }}>
								published by this stack
							</Badge>
						)}
					</div>
					<Badge style={{ height: 22, fontSize: 11 }}>v{obj.version}</Badge>
				</div>
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))',
						gap: 14,
					}}
				>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Type</span>
						<span
							className="mono trunc"
							style={{ fontSize: 12.5, color: 'var(--c-blue)', maxWidth: 320 }}
							title={obj.type}
						>
							{obj.type}
						</span>
					</div>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Owner</span>
						<span style={{ fontSize: 12.5 }}>
							<OwnerCell owner={obj.owner} />
						</span>
					</div>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Previous tx</span>
						{obj.previousTx ? (
							<button
								type="button"
								onClick={() => gotoTx(obj.previousTx as string)}
								style={{
									background: 'none',
									border: 'none',
									padding: 0,
									color: 'var(--c-cyan)',
									fontSize: 12.5,
									fontFamily: 'var(--font-mono)',
									textAlign: 'left',
								}}
							>
								{truncateMiddle(obj.previousTx, 8, 6)}
							</button>
						) : (
							<span style={{ fontSize: 12.5, color: 'var(--tx-lo)' }}>—</span>
						)}
					</div>
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
				<Panel pad>
					<div className="eyebrow" style={{ marginBottom: 10 }}>
						Fields
					</div>
					<div className="logbox" style={{ maxHeight: 320 }}>
						{obj.fields ? (
							<JsonTree data={obj.fields} />
						) : (
							<span style={{ color: 'var(--tx-dim)', fontSize: 11.5 }}>
								No decoded Move content (package or wrapped object).
							</span>
						)}
					</div>
				</Panel>

				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '12px 16px' }}>
						<SectionHead title="Dynamic fields" count={dynRows.length} />
					</div>
					{fields.isLoading ? (
						<SkeletonRows rows={4} cols={2} />
					) : (
						<DataTable
							columns={columns}
							rows={dynRows}
							rowKey={(f) => f.id}
							onRowClick={(f) => gotoObject(f.id)}
							empty={<EmptyState icon="box" title="No dynamic fields" />}
						/>
					)}
				</Panel>
			</div>

			{/* Object-as-owner: an object can own objects / hold coins. Only shown
			    when it actually owns ≥1 object or holds a balance, to avoid an empty
			    section on the common leaf object. */}
			{(owned.isLoading || ownedRows.length > 0 || balanceRows.length > 0) && (
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
							<SkeletonRows rows={4} cols={3} />
						) : (
							<DataTable
								columns={ownedColumns}
								rows={ownedRows}
								rowKey={(o) => o.id}
								onRowClick={(o) => gotoObject(o.id)}
								empty={<EmptyState icon="box" title="No owned objects" />}
							/>
						)}
					</Panel>

					{balanceRows.length > 0 && (
						<Panel pad>
							<div className="eyebrow" style={{ marginBottom: 10 }}>
								Balances
							</div>
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
						</Panel>
					)}
				</div>
			)}

			<Panel style={{ overflow: 'hidden' }}>
				<div className="panel-pad row between wrap" style={{ padding: '12px 18px', gap: 12 }}>
					<SectionHead title="Transactions" count={graphqlUrl ? txRows.length : undefined} />
					{graphqlUrl && (
						<Segmented
							options={TX_DIRECTION_OPTIONS}
							value={txDirection}
							onChange={setTxDirection}
						/>
					)}
				</div>
				{graphqlUrl === null ? (
					<div className="panel-pad" style={{ padding: '4px 18px 16px' }}>
						<span style={{ fontSize: 12, color: 'var(--tx-dim)' }}>
							Transaction history unavailable (no GraphQL endpoint on this stack).
						</span>
					</div>
				) : txs.isLoading ? (
					<SkeletonRows rows={5} cols={3} />
				) : (
					<DataTable
						columns={txColumns}
						rows={txRows}
						rowKey={(t) => t.digest}
						onRowClick={(t) => gotoTx(t.digest)}
						empty={
							<EmptyState
								icon="box"
								title={
									txDirection === 'sent'
										? 'No transactions sent from this object'
										: 'No transactions affecting this object'
								}
							/>
						}
					/>
				)}
			</Panel>
		</div>
	);
};
