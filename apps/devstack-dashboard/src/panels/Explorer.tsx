// Explorer panel — a suiscan-style browser over the local node, reading chain
// data directly in the browser via the `useChain` hooks (gRPC over the stack's
// `rpc` endpoint). The page header carries a global search input that resolves
// a digest / object id / address / package id to the right detail view, plus a
// connection banner when the node is unreachable.
//
// The sub-view (home vs tx/object/package detail) is read from the `explorer`
// route's `param` via `parseExplorerView`; the `goto*` helpers navigate between
// them, and `<Breadcrumbs>` reflects the trail. Detail components fetch their
// own data and render a `DetailSkeleton` while loading, an honest Banner/
// EmptyState on not-found/error.

import { useState } from 'react';
import { looksLikeId, truncateMiddle } from '../lib/format.ts';
import { gotoExplorer, gotoObject, gotoTx, parseExplorerView, useRoute } from '../lib/router.ts';
import { useChainHead } from '../lib/useChain.ts';
import { Banner, Breadcrumbs, type BreadcrumbItem, Icon } from '../ui/index.ts';
import { ExplorerHome } from './explorer/ExplorerHome.tsx';
import { ObjectDetail } from './explorer/ObjectDetail.tsx';
import { PackageDetail } from './explorer/PackageDetail.tsx';
import { TxDetail } from './explorer/TxDetail.tsx';
import type { PanelProps } from './types.ts';

// A digest is base58 (no `0x`), an object/package id / address is `0x…`. We
// route `0x…`-shaped input to the object view (objects, addresses, and packages
// all share the id shape; the object view degrades to not-found honestly and
// packages are reachable from the home list), everything else to the tx view.
const resolveSearch = (raw: string): void => {
	const q = raw.trim();
	if (!q) return;
	if (looksLikeId(q)) gotoObject(q);
	else gotoTx(q);
};

export const ExplorerPanel = ({ projection, chain }: PanelProps) => {
	const route = useRoute();
	const view = parseExplorerView(route.param);
	const [search, setSearch] = useState('');

	// Reachability: the head query is the cheapest liveness probe. Disabled (no
	// rpcUrl) is treated as unreachable for the banner.
	const head = useChainHead(chain);
	const unreachable = chain.rpcUrl === null || head.isError;

	const crumbs: BreadcrumbItem[] = [
		{ label: 'Explorer', onClick: view.kind !== 'home' ? gotoExplorer : undefined },
	];
	if (view.kind === 'tx')
		crumbs.push({ label: 'Transaction' }, { label: truncateMiddle(view.id, 6, 4) });
	if (view.kind === 'object')
		crumbs.push({ label: 'Object' }, { label: truncateMiddle(view.id, 6, 4) });
	if (view.kind === 'package')
		crumbs.push({ label: 'Package' }, { label: truncateMiddle(view.id, 6, 4) });

	return (
		<div className="col" style={{ gap: 18 }}>
			<div className="row between wrap" style={{ gap: 12 }}>
				<div>
					<h2 style={{ fontSize: 19 }}>Sui Explorer</h2>
					{view.kind === 'home' ? (
						<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
							Browser-side explorer over the local node — reads the stack's gRPC endpoint directly.
						</p>
					) : (
						<div style={{ marginTop: 6 }}>
							<Breadcrumbs items={crumbs} />
						</div>
					)}
				</div>
				<div
					className="row"
					style={{
						gap: 8,
						background: 'var(--bg-panel)',
						border: '1px solid var(--line)',
						borderRadius: 'var(--r-sm)',
						padding: '0 12px',
						height: 34,
						width: 320,
						maxWidth: '100%',
					}}
				>
					<Icon name="search" size={15} style={{ color: 'var(--tx-lo)' }} />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								resolveSearch(search);
								setSearch('');
							}
						}}
						placeholder="Digest · object · address · package…"
						style={{
							background: 'transparent',
							border: 'none',
							outline: 'none',
							color: 'var(--tx-hi)',
							fontSize: 12.5,
							flex: 1,
							fontFamily: 'var(--font-mono)',
						}}
					/>
				</div>
			</div>

			{unreachable && (
				<Banner tone="danger" title="Node unreachable">
					{chain.rpcUrl === null
						? 'No gRPC endpoint is registered for this stack yet — chain reads are unavailable.'
						: 'Could not reach the local node over gRPC. Retrying in the background.'}
				</Banner>
			)}

			{view.kind === 'tx' ? (
				<TxDetail chain={chain} digest={view.id} />
			) : view.kind === 'object' ? (
				<ObjectDetail chain={chain} projection={projection} id={view.id} />
			) : view.kind === 'package' ? (
				<PackageDetail chain={chain} projection={projection} id={view.id} />
			) : (
				<ExplorerHome chain={chain} projection={projection} unreachable={unreachable} />
			)}
		</div>
	);
};
