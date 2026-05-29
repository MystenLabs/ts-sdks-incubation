// Config inspector panel — read-only view of resolved identity, the current
// lifecycle cycle, and the live endpoint + package registries.
//
// Honest port of the handoff's Config screen: every value is sourced from the
// real projection. The handoff's invented identity fields (mode / chainId /
// version / workdir) aren't on the wire `Identity`, so this surfaces only the
// fields devstack actually projects (app / stack / network), plus a Cycle panel
// and the package registry the handoff lacked.

import { labelForRow } from '../lib/derive.ts';
import { clockTime, displayHost, timeAgo, truncateMiddle } from '../lib/format.ts';
import type { Endpoint, PackageProjection } from '../lib/types.ts';
import {
	AddressChip,
	Badge,
	type Column,
	CopyChip,
	DataTable,
	DefList,
	DefRow,
	EmptyState,
	EndpointLink,
	Panel,
	SectionHead,
} from '../ui/index.ts';
import type { PanelProps } from './types.ts';

const endpointColumns: ReadonlyArray<Column<Endpoint>> = [
	{
		key: 'name',
		header: 'Name',
		sortVal: (e) => e.name,
		render: (e) => <span style={{ fontWeight: 530 }}>{e.name}</span>,
	},
	{
		key: 'plugin',
		header: 'Plugin',
		render: (e) => (
			<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
				{e.pluginKey}
			</span>
		),
	},
	{
		key: 'protocol',
		header: 'Protocol',
		render: (e) => <Badge style={{ height: 18, fontSize: 10.5 }}>{e.wireProtocol}</Badge>,
	},
	{
		key: 'url',
		header: 'URL',
		render: (e) => (
			<div className="row" style={{ gap: 7 }}>
				<EndpointLink endpoint={e} />
				<CopyChip text={e.url} display={displayHost(e)} />
			</div>
		),
	},
	{
		key: 'registered',
		header: 'Registered',
		width: 90,
		sortVal: (e) => e.registeredAt,
		render: (e) => (
			<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-dim)' }}>
				{timeAgo(e.registeredAt)}
			</span>
		),
	},
];

const packageColumns: ReadonlyArray<Column<PackageProjection>> = [
	{
		key: 'name',
		header: 'Name',
		render: (p) => <span style={{ fontWeight: 530 }}>{labelForRow(p.name)}</span>,
	},
	{
		key: 'packageId',
		header: 'Package ID',
		render: (p) => <AddressChip address={p.packageId} />,
	},
	{
		key: 'kind',
		header: 'Kind',
		render: (p) => (
			<Badge
				style={{
					height: 18,
					fontSize: 10.5,
					color: p.kind === 'local' ? 'var(--c-blue)' : 'var(--tx-mid)',
				}}
			>
				{p.kind}
			</Badge>
		),
	},
	{
		key: 'upgradeCap',
		header: 'Upgrade cap',
		render: (p) =>
			p.upgradeCapId ? (
				<AddressChip address={p.upgradeCapId} />
			) : (
				<span style={{ color: 'var(--tx-dim)' }}>—</span>
			),
	},
	{
		key: 'source',
		header: 'Source',
		render: (p) =>
			p.sourcePath ? (
				<span
					className="mono trunc"
					title={p.sourcePath}
					style={{
						fontSize: 11.5,
						color: 'var(--tx-dim)',
						maxWidth: 220,
						display: 'inline-block',
					}}
				>
					{truncateMiddle(p.sourcePath, 14, 18)}
				</span>
			) : (
				<span style={{ color: 'var(--tx-dim)' }}>—</span>
			),
	},
];

export const ConfigPanel = ({ projection }: PanelProps) => {
	const { identity, cycle, endpoints, packages, lastEvent } = projection;

	return (
		<div className="col" style={{ gap: 18 }}>
			<div>
				<h2 style={{ fontSize: 19 }}>Config inspector</h2>
				<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
					Resolved identity &amp; registries. Read-only, live-updating.
				</p>
			</div>

			{/* identity + cycle */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
					gap: 18,
					alignItems: 'start',
				}}
			>
				<Panel pad>
					<SectionHead title="Identity" />
					<DefList>
						<DefRow label="app">
							<CopyChip text={identity.app} display={identity.app} />
						</DefRow>
						<DefRow label="stack">
							<CopyChip text={identity.stack} display={identity.stack} />
						</DefRow>
						<DefRow label="network">
							<CopyChip text={identity.network} display={identity.network} />
						</DefRow>
					</DefList>
				</Panel>

				<Panel pad>
					<SectionHead title="Cycle" />
					<DefList>
						<DefRow label="id">
							<span className="mono" style={{ fontSize: 12, color: 'var(--tx-hi)' }}>
								#{cycle.id}
							</span>
						</DefRow>
						<DefRow label="phase">
							<Badge style={{ height: 19, fontSize: 11 }}>{cycle.phase}</Badge>
						</DefRow>
						<DefRow label="started">
							<span className="mono" style={{ fontSize: 12, color: 'var(--tx-hi)' }}>
								{clockTime(cycle.startedAt)} · {timeAgo(cycle.startedAt)}
							</span>
						</DefRow>
						<DefRow label="last event">
							<span className="mono" style={{ fontSize: 12, color: 'var(--tx-hi)' }}>
								{lastEvent ? `#${lastEvent.seq} · ${timeAgo(lastEvent.at)}` : '—'}
							</span>
						</DefRow>
					</DefList>
				</Panel>
			</div>

			{/* endpoint registry */}
			<Panel header={<SectionHead title="Endpoint registry" count={endpoints.length} />}>
				<DataTable
					columns={endpointColumns}
					rows={endpoints}
					rowKey={(e) => e.endpointKey}
					empty={<EmptyState icon="plug" title="No endpoints registered" />}
				/>
			</Panel>

			{/* package registry */}
			<Panel header={<SectionHead title="Packages" count={packages.length} />}>
				<DataTable
					columns={packageColumns}
					rows={packages}
					rowKey={(p) => p.packageId}
					empty={<EmptyState icon="box" title="No packages published" />}
				/>
			</Panel>
		</div>
	);
};
