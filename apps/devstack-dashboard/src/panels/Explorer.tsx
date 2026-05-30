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
import {
	gotoAddress,
	gotoExplorer,
	gotoObject,
	gotoPackage,
	gotoTx,
	parseExplorerView,
	useRoute,
} from '../lib/router.ts';
import { resolveEntity } from '../lib/chain.ts';
import { useChainHead } from '../lib/useChain.ts';
import { Banner, Breadcrumbs, type BreadcrumbItem, Dot, Icon } from '../ui/index.ts';
import { AddressDetail } from './explorer/AddressDetail.tsx';
import { ExplorerHome } from './explorer/ExplorerHome.tsx';
import { ObjectDetail } from './explorer/ObjectDetail.tsx';
import { PackageDetail } from './explorer/PackageDetail.tsx';
import { TxDetail } from './explorer/TxDetail.tsx';
import type { PanelProps } from './types.ts';

/** Human label for a detail view's entity kind (breadcrumb trail). */
const KIND_LABEL: Record<string, string> = {
	tx: 'Transaction',
	object: 'Object',
	package: 'Package',
	address: 'Address',
};

export const ExplorerPanel = ({ projection, chain }: PanelProps) => {
	const route = useRoute();
	const view = parseExplorerView(route.param);
	const [search, setSearch] = useState('');
	// Search RESOLVES the ambiguous `0x…` id BEFORE navigating, so it always lands
	// on the concrete kind (object / package / address) rather than a generic
	// resolving route. `resolving` flags the brief probe so the input shows an
	// inline "resolving…" state instead of feeling unresponsive on a slow node.
	const [resolving, setResolving] = useState(false);

	// Reachability: the head query is the cheapest liveness probe. Disabled (no
	// rpcUrl) is treated as unreachable for the banner.
	const head = useChainHead(chain);
	const unreachable = chain.rpcUrl === null || head.isError;

	// A transaction digest is base58 (no `0x`); an object / package / address id is
	// `0x…` and indistinguishable by format. A base58 digest navigates straight to
	// the tx view. A `0x…` id (or a coin type / struct tag whose leading segment is
	// a `0x…` package id) is PROBED first via `resolveEntity`, then routed to the
	// concrete kind — search never lands on a generic resolving route.
	const resolveSearch = async (raw: string): Promise<void> => {
		const q = raw.trim();
		if (!q) return;
		const head = q.includes('::') ? q.split('::')[0] : q;
		if (!looksLikeId(head)) {
			gotoTx(q);
			return;
		}
		if (chain.rpcUrl === null) {
			// No node to probe — fall back to the address view (the safe terminal kind).
			gotoAddress(head);
			return;
		}
		setResolving(true);
		try {
			const kind = await resolveEntity(chain.rpcUrl, head);
			if (kind === 'package') gotoPackage(head);
			else if (kind === 'object') gotoObject(head);
			else gotoAddress(head);
		} catch {
			// `resolveEntity` is guarded and shouldn't throw, but degrade to address.
			gotoAddress(head);
		} finally {
			setResolving(false);
		}
	};

	const onSearch = (): void => {
		const q = search;
		setSearch('');
		void resolveSearch(q);
	};

	const crumbs: BreadcrumbItem[] = [
		{ label: 'Explorer', onClick: view.kind !== 'home' ? gotoExplorer : undefined },
	];
	if (view.kind !== 'home')
		crumbs.push(
			{ label: KIND_LABEL[view.kind] ?? 'Detail' },
			{ label: truncateMiddle(view.id, 6, 4) },
		);

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
							if (e.key === 'Enter' && !resolving) onSearch();
						}}
						disabled={resolving}
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
					{resolving && (
						<span className="row" style={{ gap: 6, flex: 'none' }}>
							<Dot token="cyan" pulse />
							<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>resolving…</span>
						</span>
					)}
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
			) : view.kind === 'address' ? (
				<AddressDetail chain={chain} projection={projection} id={view.id} />
			) : (
				<ExplorerHome chain={chain} projection={projection} unreachable={unreachable} />
			)}
		</div>
	);
};
