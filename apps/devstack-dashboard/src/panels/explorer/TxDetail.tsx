// Transaction detail — `useTransaction(digest)` mapped into a status/kind
// header, a sender / timestamp / checkpoint grid, the shared `<TxEffectsView>`
// (gas breakdown + balance/object changes; every object change is copyable and
// the sender drills into its object), an events list via `<JsonTree>`, and the
// programmable-transaction command summary. Loading → `DetailSkeleton`;
// not-found / error → an honest Banner.

import { timeAgo, truncateMiddle } from '../../lib/format.ts';
import { gotoAddress } from '../../lib/router.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import { useTransaction } from '../../lib/useChain.ts';
import { Badge, Banner, CopyChip, Dot, JsonTree, Panel, TxEffectsView } from '../../ui/index.ts';
import { DetailSkeleton } from './ExplorerHome.tsx';

interface TxDetailProps {
	readonly chain: ChainSource;
	readonly digest: string;
}

export const TxDetail = ({ chain, digest }: TxDetailProps) => {
	const q = useTransaction(chain, digest);

	if (q.isLoading) return <DetailSkeleton />;
	if (q.isError)
		return (
			<Banner tone="danger" title="Transaction not found">
				No transaction with digest <span className="mono">{truncateMiddle(digest, 10, 6)}</span> was
				found on this node. It may be from a different network or not yet executed.
			</Banner>
		);

	const tx = q.data;
	if (!tx)
		return (
			<Banner tone="warn" title="No data">
				The node returned no detail for this digest.
			</Banner>
		);

	const ok = tx.status === 'success';

	return (
		<div className="col fade-up" style={{ gap: 18 }}>
			<Panel pad>
				<div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
					<div className="row" style={{ gap: 10 }}>
						<Badge
							style={{
								borderColor: `color-mix(in oklab, var(--c-${ok ? 'green' : 'red'}) 36%, var(--line-strong))`,
							}}
						>
							<Dot token={ok ? 'green' : 'red'} />
							<span style={{ color: `var(--c-${ok ? 'green' : 'red'})`, fontSize: 11.5 }}>
								{tx.status}
							</span>
						</Badge>
						<Badge style={{ height: 22, fontSize: 11 }}>{tx.kind}</Badge>
					</div>
					<CopyChip text={tx.digest} display={truncateMiddle(tx.digest, 10, 6)} />
				</div>
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))',
						gap: 14,
					}}
				>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Sender</span>
						{tx.sender ? (
							<button
								type="button"
								className="row"
								onClick={() => gotoAddress(tx.sender as string)}
								style={{ background: 'none', border: 'none', padding: 0, gap: 6 }}
							>
								<span className="mono" style={{ color: 'var(--c-magenta)', fontSize: 12.5 }}>
									{truncateMiddle(tx.sender, 8, 6)}
								</span>
							</button>
						) : (
							<span style={{ fontSize: 13, color: 'var(--tx-lo)' }}>—</span>
						)}
					</div>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Timestamp</span>
						<span style={{ fontSize: 13 }}>
							{tx.timestampMs != null ? `${timeAgo(tx.timestampMs)} ago` : '—'}
						</span>
					</div>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Checkpoint</span>
						<span className="mono tnum" style={{ fontSize: 13, color: 'var(--c-cyan)' }}>
							{tx.checkpoint != null ? tx.checkpoint.toLocaleString() : '—'}
						</span>
					</div>
				</div>
			</Panel>

			<TxEffectsView tx={tx.effects} />

			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1fr 1fr',
					gap: 18,
					alignItems: 'start',
				}}
			>
				<Panel pad>
					<div className="eyebrow" style={{ marginBottom: 10 }}>
						Events
					</div>
					{tx.events.length === 0 ? (
						<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>No events emitted.</span>
					) : (
						<div className="col" style={{ gap: 14 }}>
							{tx.events.map((e, i) => (
								<div key={i} className="col" style={{ gap: 8 }}>
									<span className="mono trunc" style={{ fontSize: 12.5, color: 'var(--c-blue)' }}>
										{e.type}
									</span>
									<div className="logbox">
										{e.fields ? (
											<JsonTree data={e.fields} />
										) : (
											<span style={{ color: 'var(--tx-dim)', fontSize: 11.5 }}>
												No decoded fields.
											</span>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</Panel>
				<Panel pad>
					<div className="eyebrow" style={{ marginBottom: 10 }}>
						Programmable transaction
					</div>
					{tx.commands.length === 0 ? (
						<span style={{ color: 'var(--tx-dim)', fontSize: 12.5 }}>No commands.</span>
					) : (
						<div className="col" style={{ gap: 4 }}>
							{tx.commands.map((c, i) => (
								<div key={i} className="row" style={{ gap: 9 }}>
									<span
										className="mono"
										style={{ fontSize: 11, color: 'var(--tx-dim)', minWidth: 18 }}
									>
										{i}
									</span>
									<span className="mono" style={{ fontSize: 12, color: 'var(--tx-hi)' }}>
										{c}
									</span>
								</div>
							))}
						</div>
					)}
				</Panel>
			</div>
		</div>
	);
};
