// Object detail — `useObject(id)` for the core record (id / version / type /
// owner / previous-tx / Move fields) plus `useDynamicFields(id)` for the
// dynamic-field table. AddressOwner drills into the owner object; Shared /
// Immutable / Unknown render as badges. Previous-tx drills into the transaction;
// each dynamic field drills into its child object. Packages published by this
// stack get an "ours" badge. Loading → `DetailSkeleton`; not-found → Banner.

import { truncateMiddle } from '../../lib/format.ts';
import { gotoObject, gotoTx } from '../../lib/router.ts';
import type { Projection } from '../../lib/types.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import { useDynamicFields, useObject } from '../../lib/useChain.ts';
import type { DynamicFieldView, ObjectOwnerView } from '../../lib/explorerTypes.ts';
import {
	Badge,
	Banner,
	type Column,
	CopyChip,
	DataTable,
	Dot,
	EmptyState,
	Icon,
	JsonTree,
	Panel,
	SectionHead,
	SkeletonRows,
} from '../../ui/index.ts';
import { DetailSkeleton, isOurs } from './ExplorerHome.tsx';

interface ObjectDetailProps {
	readonly chain: ChainSource;
	readonly projection: Projection;
	readonly id: string;
}

const OwnerCell = ({ owner }: { readonly owner: ObjectOwnerView }) => {
	if ((owner.kind === 'AddressOwner' || owner.kind === 'ObjectOwner') && owner.address) {
		const addr = owner.address;
		return (
			<button
				type="button"
				onClick={() => gotoObject(addr)}
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
	return (
		<Badge style={{ height: 19, fontSize: 10.5 }}>{owner.kind}</Badge>
	);
};

export const ObjectDetail = ({ chain, projection, id }: ObjectDetailProps) => {
	const q = useObject(chain, id);
	const fields = useDynamicFields(chain, id);

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

	const ours = isOurs(projection, obj.id);
	const dynRows: ReadonlyArray<DynamicFieldView> = fields.data ?? [];

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
				<span className="mono trunc" style={{ fontSize: 11.5, color: 'var(--tx-lo)', maxWidth: 150 }}>
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
		</div>
	);
};
