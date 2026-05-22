import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { deployment, isDeployed } from './lib/deployment.js';
import {
	bindingHealth,
	formatAge,
	formatNumber,
	formatPercent,
	marketLabel,
	marketRows,
	readMarketSnapshot,
	shortId,
	snapshotStatus,
	type MarketKey,
	type MarketSnapshot,
	type QueryProbe,
} from './lib/market.js';

const DEFAULT_MARKET: MarketKey = 'SUI_DBUSDC';

export function App() {
	const [selectedMarket, setSelectedMarket] = useState<MarketKey>(DEFAULT_MARKET);
	const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const selectedRow = useMemo(
		() => marketRows.find((row) => row.key === selectedMarket) ?? marketRows[0]!,
		[selectedMarket],
	);

	const refresh = useCallback(
		async ({ silent = false }: { silent?: boolean } = {}) => {
			if (!isDeployed) return;
			setError(null);
			if (!silent) setIsLoading(true);
			try {
				setSnapshot(await readMarketSnapshot(selectedMarket));
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!silent) setIsLoading(false);
			}
		},
		[selectedMarket],
	);

	useEffect(() => {
		let cancelled = false;
		if (!isDeployed) return;
		setError(null);
		setIsLoading(true);
		readMarketSnapshot(selectedMarket)
			.then((next) => {
				if (!cancelled) setSnapshot(next);
			})
			.catch((cause) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedMarket]);

	const status = snapshotStatus(snapshot);

	return (
		<div className="min-h-screen">
			<header className="border-b border-neutral-200 bg-white/90 px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950/90">
				<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
					<div className="flex items-center gap-3">
						<div className="grid size-10 place-items-center rounded-lg border border-emerald-500 bg-neutral-950 text-xs font-semibold text-emerald-300 shadow-sm shadow-emerald-900/20">
							DB
						</div>
						<div>
							<h1 className="text-xl font-semibold tracking-normal">
								DeepBook/Pyth Market Console
							</h1>
							<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
								<span className="font-mono">{selectedRow.key}</span>
								<span>{marketLabel(selectedRow)}</span>
								<StatusPill status={status} loading={isLoading} />
							</div>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => void refresh()}
							disabled={isLoading || !isDeployed}
							data-testid="refresh-market"
							className="h-10 rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 shadow-sm transition hover:border-neutral-500 disabled:cursor-not-allowed disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:border-neutral-500"
						>
							{isLoading ? 'Refreshing' : 'Refresh market'}
						</button>
					</div>
				</div>
			</header>

			<main className="mx-auto grid w-full max-w-7xl gap-4 px-5 py-5 lg:grid-cols-[320px_minmax(0,1fr)]">
				<aside className="space-y-4">
					<BindingPanel />
					<MarketList selectedMarket={selectedMarket} onSelect={setSelectedMarket} />
				</aside>

				<section className="space-y-4">
					{!isDeployed ? <NotDeployed /> : null}
					{error ? <ErrorBanner message={error} /> : null}
					<MarketOverview snapshot={snapshot} loading={isLoading} />
					<div className="grid gap-4 xl:grid-cols-2">
						<OrderBook snapshot={snapshot} />
						<PythPanel snapshot={snapshot} />
					</div>
				</section>
			</main>
		</div>
	);
}

function BindingPanel() {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Generated binding</h2>
				<span className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
					sui:testnet
				</span>
			</div>
			<div className="space-y-3 text-sm">
				<HealthRow label="Package" ok={bindingHealth.packageMatchesSdk} testId="binding-package">
					<span className="font-mono" data-testid="deepbook-package-id">
						{shortId(deployment.deepbook.packageId)}
					</span>
				</HealthRow>
				<HealthRow label="Registry" ok={bindingHealth.registryMatchesSdk} testId="binding-registry">
					<span className="font-mono" data-testid="deepbook-registry-id">
						{shortId(deployment.deepbook.registryId)}
					</span>
				</HealthRow>
				<HealthRow label="Pyth" ok={bindingHealth.pythMatchesSdk} testId="binding-pyth">
					<span className="font-mono" data-testid="pyth-state-id">
						{shortId(deployment.deepbook.pyth?.stateId ?? '0x0')}
					</span>
				</HealthRow>
			</div>
			<div className="mt-4 grid grid-cols-4 gap-1" aria-hidden="true">
				{marketRows.map((row, index) => (
					<div
						key={row.key}
						className="h-1.5 rounded-sm"
						style={{
							backgroundColor: ['#10b981', '#0ea5e9', '#f97316', '#6366f1'][index] ?? '#737373',
							opacity: 0.85,
						}}
					/>
				))}
			</div>
		</section>
	);
}

function HealthRow({
	label,
	ok,
	testId,
	children,
}: {
	label: string;
	ok: boolean;
	testId: string;
	children: ReactNode;
}) {
	return (
		<div
			className="grid grid-cols-[82px_minmax(0,1fr)_64px] items-center gap-2"
			data-testid={testId}
		>
			<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">{label}</span>
			<div className="min-w-0 truncate">{children}</div>
			<span
				className={`rounded-md px-2 py-1 text-center text-xs ${
					ok
						? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
						: 'bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300'
				}`}
			>
				{ok ? 'match' : 'check'}
			</span>
		</div>
	);
}

function MarketList({
	selectedMarket,
	onSelect,
}: {
	selectedMarket: MarketKey;
	onSelect: (key: MarketKey) => void;
}) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<h2 className="mb-3 text-sm font-semibold">Markets</h2>
			<div className="space-y-2">
				{marketRows.map((row) => (
					<button
						key={row.key}
						type="button"
						onClick={() => onSelect(row.key)}
						data-testid={`pool-row-${row.key}`}
						className={`grid h-16 w-full grid-cols-[1fr_auto] items-center rounded-md border px-3 text-left transition ${
							row.key === selectedMarket
								? 'border-neutral-950 bg-neutral-950 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-950'
								: 'border-neutral-200 bg-white hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-600'
						}`}
					>
						<span>
							<span className="block text-sm font-medium">{marketLabel(row)}</span>
							<span className="block font-mono text-xs opacity-70">{row.key}</span>
						</span>
						<span className="font-mono text-xs opacity-70">{shortId(row.poolId, 6, 4)}</span>
					</button>
				))}
			</div>
		</section>
	);
}

function MarketOverview({
	snapshot,
	loading,
}: {
	snapshot: MarketSnapshot | null;
	loading: boolean;
}) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
				<div>
					<h2 className="text-sm font-semibold">Market proof</h2>
					<p
						className="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
						data-testid="market-proof-status"
					>
						{loading
							? 'Querying testnet'
							: snapshot
								? `${snapshotStatus(snapshot)} at ${new Date(snapshot.completedAt).toLocaleTimeString()}`
								: 'waiting'}
					</p>
				</div>
				{snapshot ? (
					<div className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
						{shortId(
							snapshot.poolId.status === 'ok' ? snapshot.poolId.value : snapshot.market.poolId,
						)}
					</div>
				) : null}
			</div>

			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				<ProbeMetric
					label="Mid price"
					probe={snapshot?.midPrice}
					format={(value) => `${formatNumber(value, 6)} ${snapshot?.market.quoteCoin ?? ''}`}
				/>
				<ProbeMetric
					label="Registered"
					probe={snapshot?.registered}
					format={(value) => (value ? 'yes' : 'no')}
				/>
				<ProbeMetric
					label="Taker fee"
					probe={snapshot?.tradeParams}
					format={(value) => formatPercent(value.takerFee)}
				/>
				<ProbeMetric
					label="Tick size"
					probe={snapshot?.bookParams}
					format={(value) => formatNumber(value.tickSize, 8)}
				/>
			</div>

			<div className="mt-4 grid gap-3 md:grid-cols-3">
				<ProbeMetric
					label="Base vault"
					probe={snapshot?.vaultBalances}
					format={(value) => `${formatNumber(value.base, 3)} ${snapshot?.market.baseCoin ?? ''}`}
				/>
				<ProbeMetric
					label="Quote vault"
					probe={snapshot?.vaultBalances}
					format={(value) => `${formatNumber(value.quote, 3)} ${snapshot?.market.quoteCoin ?? ''}`}
				/>
				<ProbeMetric
					label="Deep vault"
					probe={snapshot?.vaultBalances}
					format={(value) => `${formatNumber(value.deep, 3)} DEEP`}
				/>
			</div>
		</section>
	);
}

function ProbeMetric<T>({
	label,
	probe,
	format,
}: {
	label: string;
	probe: QueryProbe<T> | undefined;
	format: (value: T) => string;
}) {
	const isError = probe?.status === 'error';
	return (
		<div className="min-h-20 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
			<div className="text-xs uppercase text-neutral-500 dark:text-neutral-400">{label}</div>
			<div
				className={`mt-2 break-words text-lg font-semibold ${isError ? 'text-orange-700 dark:text-orange-300' : ''}`}
			>
				{probe === undefined ? '...' : probe.status === 'ok' ? format(probe.value) : 'unavailable'}
			</div>
			{isError ? (
				<div
					className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400"
					title={probe.message}
				>
					{probe.message}
				</div>
			) : null}
		</div>
	);
}

function OrderBook({ snapshot }: { snapshot: MarketSnapshot | null }) {
	const book = snapshot?.orderBook;
	const maxQuantity =
		book?.status === 'ok'
			? Math.max(1, ...book.value.bid_quantities, ...book.value.ask_quantities)
			: 1;

	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-sm font-semibold">Order book ticks</h2>
				<span className="text-xs text-neutral-500 dark:text-neutral-400">
					{snapshot ? marketLabel(snapshot.market) : DEFAULT_MARKET}
				</span>
			</div>
			{book?.status === 'ok' ? (
				<div className="grid gap-4 md:grid-cols-2">
					<BookSide
						label="Bids"
						prices={book.value.bid_prices}
						quantities={book.value.bid_quantities}
						maxQuantity={maxQuantity}
						colorClass="bg-emerald-500"
					/>
					<BookSide
						label="Asks"
						prices={book.value.ask_prices}
						quantities={book.value.ask_quantities}
						maxQuantity={maxQuantity}
						colorClass="bg-orange-500"
					/>
				</div>
			) : (
				<div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
					{book?.status === 'error' ? book.message : '...'}
				</div>
			)}
		</section>
	);
}

function BookSide({
	label,
	prices,
	quantities,
	maxQuantity,
	colorClass,
}: {
	label: string;
	prices: ReadonlyArray<number>;
	quantities: ReadonlyArray<number>;
	maxQuantity: number;
	colorClass: string;
}) {
	return (
		<div>
			<div className="mb-2 text-xs uppercase text-neutral-500 dark:text-neutral-400">{label}</div>
			<div className="space-y-2">
				{prices.slice(0, 6).map((price, index) => {
					const quantity = quantities[index] ?? 0;
					const width = `${Math.max(4, Math.min(100, (quantity / maxQuantity) * 100))}%`;
					return (
						<div
							key={`${label}-${price}-${index}`}
							className="grid grid-cols-[80px_minmax(0,1fr)_80px] items-center gap-2 text-xs"
						>
							<span className="font-mono">{formatNumber(price, 6)}</span>
							<div className="h-2 rounded-sm bg-neutral-200 dark:bg-neutral-800">
								<div className={`h-2 rounded-sm ${colorClass}`} style={{ width }} />
							</div>
							<span className="truncate text-right font-mono">{formatNumber(quantity, 3)}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function PythPanel({ snapshot }: { snapshot: MarketSnapshot | null }) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-sm font-semibold">Pyth price objects</h2>
				<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
					{snapshot ? shortId(snapshot.pythStateId) : '...'}
				</span>
			</div>
			<div className="space-y-3">
				{snapshot?.pythPrices.length ? (
					snapshot.pythPrices.map((probe, index) => (
						<div
							key={probe.status === 'ok' ? probe.value.coinKey : `pyth-error-${index}`}
							className="rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900"
						>
							{probe.status === 'ok' ? (
								<div className="grid grid-cols-[64px_minmax(0,1fr)_72px] items-center gap-3 text-sm">
									<span className="font-semibold">{probe.value.coinKey}</span>
									<span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
										{shortId(probe.value.priceInfoObjectId)}
									</span>
									<span className="text-right text-xs text-neutral-500 dark:text-neutral-400">
										{formatAge(probe.value.ageSeconds)}
									</span>
								</div>
							) : (
								<div className="text-sm text-orange-700 dark:text-orange-300">{probe.message}</div>
							)}
						</div>
					))
				) : (
					<div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
						...
					</div>
				)}
			</div>
		</section>
	);
}

function StatusPill({ status, loading }: { status: string; loading: boolean }) {
	const label = loading ? 'querying' : status;
	const color =
		status === 'live'
			? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
			: status === 'partial'
				? 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
				: status === 'offline'
					? 'bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300'
					: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300';
	return <span className={`rounded-md px-2 py-1 text-xs ${color}`}>{label}</span>;
}

function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200">
			{message}
		</div>
	);
}

function NotDeployed() {
	return (
		<div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200">
			No generated DeepBook binding was found.
		</div>
	);
}
