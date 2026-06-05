// Package detail — `usePackage(id)` for the on-chain modules + function
// signatures, enriched with the stack's `projection.packages` entry for the
// friendly name / publish source / upgrade-cap when this stack published it
// ("published by this stack" badge). A left module list drives the right
// functions table (visibility + entry + param count) for the selected module.
// Loading → `DetailSkeleton`; not-found → Banner.

import { useEffect, useState } from 'react';
import { truncateMiddle } from '../../lib/format.ts';
import type { Projection } from '../../lib/types.ts';
import type { ChainSource } from '../../lib/useChain.ts';
import { usePackage } from '../../lib/useChain.ts';
import type { PackageFunctionView } from '../../lib/explorerTypes.ts';
import {
	Badge,
	Banner,
	type Column,
	CopyChip,
	DataTable,
	Dot,
	EmptyState,
	Icon,
	Panel,
	SectionHead,
} from '../../ui/index.ts';
import { DetailSkeleton, ourPackage } from './ExplorerHome.tsx';

interface PackageDetailProps {
	readonly chain: ChainSource;
	readonly projection: Projection;
	readonly id: string;
}

const VISIBILITY_TOKEN: Record<string, string> = {
	public: 'tx-mid',
	friend: 'tx-mid',
	private: 'tx-lo',
	unknown: 'tx-lo',
};

export const PackageDetail = ({ chain, projection, id }: PackageDetailProps) => {
	const q = usePackage(chain, id);
	const [active, setActive] = useState<string | null>(null);

	const modules = q.data?.modules ?? [];

	// Default the selected module to the first one once data arrives.
	useEffect(() => {
		if (active === null && modules.length > 0) setActive(modules[0].name);
	}, [active, modules]);

	if (q.isLoading) return <DetailSkeleton />;
	if (q.isError)
		return (
			<Banner tone="danger" title="Package not found">
				No package with id <span className="mono">{truncateMiddle(id, 10, 6)}</span> exists on this
				node. Object ids that aren't packages won't resolve here.
			</Banner>
		);

	const pkg = q.data;
	if (!pkg)
		return (
			<Banner tone="warn" title="No data">
				The node returned no detail for this package.
			</Banner>
		);

	const mine = ourPackage(projection, pkg.id);
	const ours = mine?.kind === 'local';
	const name = mine?.name ?? truncateMiddle(pkg.id, 8, 6);
	const activeModule = modules.find((m) => m.name === active) ?? modules[0] ?? null;
	const fns = activeModule?.functions ?? [];

	const columns: ReadonlyArray<Column<PackageFunctionView>> = [
		{
			key: 'fn',
			header: 'Function',
			render: (f) => (
				<span className="mono" style={{ fontSize: 12.5, color: 'var(--c-blue)' }}>
					{f.name}
				</span>
			),
		},
		{
			key: 'visibility',
			header: 'Visibility',
			render: (f) => (
				<Badge
					style={{
						height: 19,
						fontSize: 10.5,
						color: f.isEntry
							? 'var(--c-yellow)'
							: `var(--${VISIBILITY_TOKEN[f.visibility] ?? 'tx-mid'})`,
					}}
				>
					{f.isEntry ? 'entry' : f.visibility}
				</Badge>
			),
		},
		{
			key: 'params',
			header: 'Params',
			align: 'right',
			render: (f) => (
				<span className="mono tnum" style={{ color: 'var(--tx-lo)' }}>
					{f.params}
				</span>
			),
			sortVal: (f) => f.params,
		},
	];

	return (
		<div className="col fade-up" style={{ gap: 18 }}>
			<Panel pad>
				<div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
					<div className="row" style={{ gap: 10 }}>
						<Dot token={ours ? 'blue' : 'white'} />
						<h3 style={{ fontSize: 16 }}>{name}</h3>
						{ours && (
							<Badge style={{ height: 19, fontSize: 10, color: 'var(--c-blue)' }}>
								published by this stack
							</Badge>
						)}
					</div>
					<CopyChip text={pkg.id} display={truncateMiddle(pkg.id, 10, 6)} />
				</div>
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))',
						gap: 14,
					}}
				>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Version</span>
						<span className="mono tnum" style={{ fontSize: 13 }}>
							{pkg.version != null ? `v${pkg.version}` : '—'}
						</span>
					</div>
					<div className="col" style={{ gap: 3 }}>
						<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Modules</span>
						<span className="mono tnum" style={{ fontSize: 13 }}>
							{modules.length}
						</span>
					</div>
					{mine?.upgradeCapId && (
						<div className="col" style={{ gap: 3 }}>
							<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Upgrade cap</span>
							<CopyChip
								text={mine.upgradeCapId}
								display={truncateMiddle(mine.upgradeCapId, 5, 3)}
							/>
						</div>
					)}
					{mine?.sourcePath && (
						<div className="col" style={{ gap: 3 }}>
							<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>Source</span>
							<span
								className="mono trunc"
								style={{ fontSize: 12, color: 'var(--tx-mid)', maxWidth: 220 }}
								title={mine.sourcePath}
							>
								{mine.sourcePath}
							</span>
						</div>
					)}
				</div>
			</Panel>

			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '200px 1fr',
					gap: 18,
					alignItems: 'start',
				}}
			>
				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '12px 14px' }}>
						<span className="eyebrow">Modules</span>
					</div>
					<div className="col" style={{ padding: '0 0 8px' }}>
						{modules.length === 0 && (
							<span style={{ padding: '4px 14px', color: 'var(--tx-dim)', fontSize: 12 }}>
								No modules.
							</span>
						)}
						{modules.map((m) => {
							const selected = activeModule?.name === m.name;
							return (
								<button
									key={m.name}
									type="button"
									onClick={() => setActive(m.name)}
									className="row"
									style={{
										gap: 8,
										padding: '8px 14px',
										background: selected ? 'var(--accent-soft)' : 'transparent',
										border: 'none',
										color: selected ? 'var(--tx-hi)' : 'var(--tx-mid)',
										fontFamily: 'var(--font-mono)',
										fontSize: 12.5,
										cursor: 'pointer',
										textAlign: 'left',
									}}
								>
									<Icon
										name="hash"
										size={13}
										style={{ color: selected ? 'var(--accent)' : 'var(--tx-dim)' }}
									/>
									<span className="trunc">{m.name}</span>
								</button>
							);
						})}
					</div>
				</Panel>

				<Panel style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '14px 18px' }}>
						<SectionHead
							title={activeModule ? `${activeModule.name} — functions` : 'Functions'}
							count={fns.length}
						/>
					</div>
					<DataTable
						columns={columns}
						rows={fns}
						rowKey={(f) => f.name}
						empty={<EmptyState icon="box" title="No public functions" />}
					/>
				</Panel>
			</div>
		</div>
	);
};
