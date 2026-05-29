import { truncateMiddle } from '../lib/format.ts';
import { AddressChip } from './AddressChip.tsx';
import { CopyChip } from './CopyChip.tsx';

/** Gas cost breakdown for a transaction (all values in MIST). */
export interface TxGas {
	readonly computation: number;
	readonly storage: number;
	readonly rebate: number;
	readonly budget: number;
	readonly price: number;
}

/** A single balance delta for an owner within a transaction's effects. */
export interface TxBalanceChange {
	/** Owning address. */
	readonly owner: string;
	/** Optional friendly account name. */
	readonly name?: string;
	/** Coin type / symbol label. */
	readonly coin: string;
	/** Signed amount (positive = credit, negative = debit). */
	readonly amount: number;
}

/** A single object change within a transaction's effects. */
export interface TxObjectChange {
	/** Change kind, drives the badge color. */
	readonly kind: 'created' | 'mutated' | 'deleted' | 'wrapped' | string;
	/** Object id. */
	readonly id: string;
	/** Fully-qualified object type. */
	readonly type: string;
}

/** Transaction effects consumed by {@link TxEffectsView}. */
export interface TxEffects {
	readonly gas: TxGas;
	readonly balanceChanges: ReadonlyArray<TxBalanceChange>;
	readonly objectChanges: ReadonlyArray<TxObjectChange>;
}

export interface TxEffectsViewProps {
	/** The transaction whose effects to render. */
	readonly tx: TxEffects;
}

/** kind → semantic color token for object-change badges. */
const OBJECT_CHANGE_TOKEN: Record<string, string> = {
	created: 'green',
	mutated: 'yellow',
	deleted: 'red',
};

/**
 * Transaction effects view: a gas-cost breakdown grid, a balance-changes table,
 * and an object-changes table. Used by the Explorer transaction detail panel.
 */
export const TxEffectsView = ({ tx }: TxEffectsViewProps) => {
	const gasTotal = tx.gas.computation + tx.gas.storage - tx.gas.rebate;
	const gasCells: ReadonlyArray<readonly [string, number, string | null]> = [
		['Computation', tx.gas.computation, 'cyan'],
		['Storage', tx.gas.storage, 'blue'],
		['Rebate', -tx.gas.rebate, 'green'],
		['Budget', tx.gas.budget, null],
		['Price', tx.gas.price, null],
	];
	return (
		<div className="col" style={{ gap: 16 }}>
			{/* gas breakdown */}
			<div className="panel panel-pad">
				<div className="eyebrow" style={{ marginBottom: 12 }}>
					Gas
				</div>
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))',
						gap: 14,
					}}
				>
					{gasCells.map(([label, value, token]) => (
						<div key={label} className="col" style={{ gap: 3 }}>
							<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>{label}</span>
							<span
								className="mono tnum"
								style={{ fontSize: 14, color: token ? `var(--c-${token})` : 'var(--tx-hi)' }}
							>
								{value < 0 ? '−' : ''}
								{Math.abs(value).toLocaleString()}
							</span>
						</div>
					))}
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Total</span>
						<span className="mono tnum" style={{ fontSize: 14, fontWeight: 600 }}>
							{gasTotal.toLocaleString()}
						</span>
					</div>
				</div>
			</div>

			{/* balance changes */}
			<div className="panel" style={{ overflow: 'hidden' }}>
				<div className="panel-pad" style={{ padding: '12px 16px' }}>
					<div className="eyebrow">Balance changes</div>
				</div>
				<table className="tbl">
					<thead>
						<tr>
							<th>Owner</th>
							<th>Coin</th>
							<th>Amount</th>
						</tr>
					</thead>
					<tbody>
						{tx.balanceChanges.map((b, i) => (
							<tr key={i}>
								<td>
									<AddressChip address={b.owner} name={b.name} />
								</td>
								<td className="mono" style={{ fontSize: 12 }}>
									{b.coin}
								</td>
								<td
									className="mono tnum"
									style={{ color: b.amount >= 0 ? 'var(--c-green)' : 'var(--c-red)' }}
								>
									{b.amount >= 0 ? '+' : '−'}
									{Math.abs(b.amount).toLocaleString()}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* object changes */}
			<div className="panel" style={{ overflow: 'hidden' }}>
				<div className="panel-pad" style={{ padding: '12px 16px' }}>
					<div className="eyebrow">Object changes</div>
				</div>
				<table className="tbl">
					<thead>
						<tr>
							<th>Change</th>
							<th>Object</th>
							<th>Type</th>
						</tr>
					</thead>
					<tbody>
						{tx.objectChanges.map((o, i) => {
							const token = OBJECT_CHANGE_TOKEN[o.kind] ?? 'cyan';
							return (
								<tr key={i}>
									<td>
										<span
											className="badge"
											style={{ height: 19, fontSize: 10.5, color: `var(--c-${token})` }}
										>
											{o.kind}
										</span>
									</td>
									<td>
										<CopyChip text={o.id} display={truncateMiddle(o.id, 7, 4)} />
									</td>
									<td
										className="mono trunc"
										style={{ fontSize: 11.5, color: 'var(--tx-lo)', maxWidth: 240 }}
									>
										{o.type}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
};
