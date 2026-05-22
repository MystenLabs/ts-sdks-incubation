import { useMemo } from 'react';
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import {
	deepbook as deepbookExtension,
	type CoinMap,
	type DeepbookPackageIds,
	type PoolMap,
} from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';

import { accounts } from './generated/accounts.js';
import { coins } from './generated/coins.js';
import { deepbookBindings } from './generated/deepbook/deepbook.js';
import { suiNetwork } from './generated/sui/network.js';
import { formatCoinAmount, shortId } from './lib/format.js';
import { useCoinBalance, useSignAndExecute } from './lib/queries.js';

const SUI_COIN_TYPE = '0x2::sui::SUI';
const SUI_SCALAR = 1_000_000_000;
const DEEP_SCALAR = 1_000_000;
const USDC_SCALAR = 1_000_000;
const DEFAULT_POOL = 'DEEP_SUI';
const SWAP_QUOTE_AMOUNT_MIST = 20_000_000n;
const SWAP_QUOTE_AMOUNT = Number(SWAP_QUOTE_AMOUNT_MIST) / SUI_SCALAR;
const configuredPoolCount: number = deepbookBindings.pools.length;
const coinBindings = coins as Record<string, CoinBinding>;
const deepCoin = requireCoinBinding('DEEP', coinBindings.deep ?? coinBindings.DEEP);
const usdcCoin = requireCoinBinding(
	'USDC',
	coinBindings.dusdc ?? coinBindings.usdc ?? coinBindings.USDC,
);
const pythBindings = deepbookBindings.pyth as PythBinding | null;

export function App() {
	const currentAccount = useCurrentAccount();
	const suiClient = useCurrentClient();
	const suiBalance = useCoinBalance(currentAccount?.address, SUI_COIN_TYPE);
	const deepBalance = useCoinBalance(currentAccount?.address, deepCoin.fullCoinType);
	const usdcBalance = useCoinBalance(currentAccount?.address, usdcCoin.fullCoinType);
	const trade = useSignAndExecute({ invalidateKeys: [['balance'], ['coin-object']] });
	const deepbookClient = useMemo(() => {
		if (!currentAccount?.address || configuredPoolCount === 0) return null;
		return suiClient.$extend(
			deepbookExtension({
				address: currentAccount.address,
				packageIds: buildPackageIds(),
				coins: buildCoinMap(),
				pools: buildPoolMap(),
			}),
		);
	}, [suiClient, currentAccount?.address]);
	const suiBalanceRaw = readBalanceRaw(suiBalance.data);
	const deepBalanceRaw = readBalanceRaw(deepBalance.data);
	const usdcBalanceRaw = readBalanceRaw(usdcBalance.data);
	const canSwap = Boolean(currentAccount && deepbookClient && !trade.isPending);

	const submitSwap = () => {
		if (!currentAccount || !deepbookClient) return;
		const tx = new Transaction();
		const [quoteCoinInput] = tx.splitCoins(tx.gas, [tx.pure.u64(SWAP_QUOTE_AMOUNT_MIST)]);
		const [baseCoin, quoteCoin, deepCoin] = tx.add(
			deepbookClient.deepbook.deepBook.swapExactQuoteForBase({
				poolKey: DEFAULT_POOL,
				amount: SWAP_QUOTE_AMOUNT,
				deepAmount: 0,
				minOut: 0,
				quoteCoin: quoteCoinInput,
			}),
		);
		tx.transferObjects([baseCoin, quoteCoin, deepCoin], currentAccount.address);
		trade.mutate(tx);
	};

	return (
		<div className="min-h-screen">
			<header className="border-b border-neutral-200 bg-white/90 px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950/90">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
					<div className="flex items-center gap-3">
						<div className="grid size-10 place-items-center rounded-lg border border-emerald-500 bg-neutral-950 text-xs font-semibold text-emerald-300 shadow-sm shadow-emerald-900/20">
							DB
						</div>
						<div>
							<h1 className="text-xl font-semibold tracking-normal">DeepBook Trader</h1>
							<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
								<span className="font-mono" data-testid="localnet-mode">
									{suiNetwork.mode}
								</span>
								<span className="font-mono" data-testid="localnet-chain">
									{shortId(suiNetwork.chain, 8, 6)}
								</span>
								<span className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
									local DeepBook
								</span>
							</div>
						</div>
					</div>

					<div className="flex items-center gap-2">
						{currentAccount ? (
							<span
								className="hidden rounded-md border border-neutral-200 px-3 py-2 font-mono text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400 md:inline"
								data-testid="connected-address"
							>
								{shortId(currentAccount.address, 8, 6)}
							</span>
						) : null}
						<ConnectButton />
					</div>
				</div>
			</header>

			<main className="mx-auto grid w-full max-w-6xl gap-4 px-5 py-5 lg:grid-cols-[320px_minmax(0,1fr)]">
				<aside className="space-y-4">
					<LocalnetPanel />
					<WalletPanel
						connectedAddress={currentAccount?.address}
						suiBalanceRaw={suiBalanceRaw}
						deepBalanceRaw={deepBalanceRaw}
						usdcBalanceRaw={usdcBalanceRaw}
						loading={suiBalance.isLoading || deepBalance.isLoading || usdcBalance.isLoading}
					/>
				</aside>

				<section className="space-y-4">
					<DeepBookStatus />
					<PricePanel />
					<TradePanel
						connected={Boolean(currentAccount)}
						canSwap={canSwap}
						pending={trade.isPending}
						error={trade.error?.message}
						digest={trade.data?.digest}
						onSwap={submitSwap}
					/>
				</section>
			</main>
		</div>
	);
}

function buildPackageIds(): DeepbookPackageIds {
	return {
		DEEPBOOK_PACKAGE_ID: deepbookBindings.packageId,
		REGISTRY_ID: deepbookBindings.registryId,
		DEEP_TREASURY_ID: deepbookBindings.deepTreasuryId ?? '',
	};
}

function buildCoinMap(): CoinMap {
	return {
		DEEP: {
			address: deepCoin.packageId ?? addressFromCoinType(deepCoin.fullCoinType),
			type: deepCoin.fullCoinType,
			scalar: DEEP_SCALAR,
		},
		SUI: {
			address: addressFromCoinType(coins.sui.fullCoinType),
			type: coins.sui.fullCoinType,
			scalar: SUI_SCALAR,
		},
		USDC: {
			address: usdcCoin.packageId ?? addressFromCoinType(usdcCoin.fullCoinType),
			type: usdcCoin.fullCoinType,
			scalar: USDC_SCALAR,
		},
	};
}

function buildPoolMap(): PoolMap {
	return Object.fromEntries(
		deepbookBindings.pools.map((pool) => [
			pool.name,
			{ address: pool.poolId, baseCoin: pool.base, quoteCoin: pool.quote },
		]),
	);
}

function addressFromCoinType(coinType: string): string {
	return coinType.split('::')[0] ?? '';
}

function LocalnetPanel() {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Local stack</h2>
				<span className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
					localnet
				</span>
			</div>
			<div className="space-y-3 text-sm">
				<KeyValue label="RPC" value={suiNetwork.rpcUrl} testId="localnet-rpc" />
				<KeyValue label="Faucet" value={suiNetwork.faucetUrl ?? 'none'} testId="localnet-faucet" />
				<KeyValue
					label="GraphQL"
					value={suiNetwork.graphqlUrl ?? 'none'}
					testId="localnet-graphql"
				/>
			</div>
		</section>
	);
}

function WalletPanel({
	connectedAddress,
	suiBalanceRaw,
	deepBalanceRaw,
	usdcBalanceRaw,
	loading,
}: {
	connectedAddress: string | undefined;
	suiBalanceRaw: bigint;
	deepBalanceRaw: bigint;
	usdcBalanceRaw: bigint;
	loading: boolean;
}) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Wallet</h2>
				<span
					className={`rounded-md px-2 py-1 text-xs ${
						connectedAddress
							? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
							: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
					}`}
				>
					{connectedAddress ? 'connected' : 'idle'}
				</span>
			</div>
			<div className="space-y-3 text-sm">
				<KeyValue label="Trader" value={accounts.trader.address} testId="trader-address" />
				<KeyValue
					label="Active"
					value={connectedAddress ?? 'not connected'}
					testId="active-address"
				/>
				<KeyValue
					label="SUI"
					value={loading ? 'loading' : formatCoinAmount(suiBalanceRaw, SUI_SCALAR, 4)}
					testId="sui-balance"
				/>
				<KeyValue
					label="DEEP"
					value={loading ? 'loading' : formatCoinAmount(deepBalanceRaw, DEEP_SCALAR, 4)}
					testId="deep-balance"
				/>
				<KeyValue
					label="USDC"
					value={loading ? 'loading' : formatCoinAmount(usdcBalanceRaw, USDC_SCALAR, 4)}
					testId="usdc-balance"
				/>
				<KeyValue label="Pool" value={DEFAULT_POOL} testId="deepbook-pool" />
			</div>
		</section>
	);
}

function DeepBookStatus() {
	return (
		<section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950 shadow-sm dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
			<div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
				<div>
					<h2 className="text-sm font-semibold">DeepBook localnet</h2>
					<p className="mt-1 text-xs text-emerald-800 dark:text-emerald-200">
						Boot publishes local DeepBook, creates local pools, and generates SDK bindings for this
						app.
					</p>
				</div>
				<span
					className="rounded-md bg-white px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100"
					data-testid="deepbook-local-status"
				>
					configured
				</span>
			</div>
			<div className="grid gap-3 md:grid-cols-3">
				<StatusMetric label="Package" value={shortId(deepbookBindings.packageId, 8, 6)} />
				<StatusMetric label="Pools" value={String(configuredPoolCount)} testId="deepbook-pool-count" />
				<StatusMetric label="Pyth" value={`${pythBindings?.feeds.length ?? 0} feeds`} />
			</div>
		</section>
	);
}

function PricePanel() {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Oracle prices</h2>
				<span
					className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
					data-testid="pyth-feed-count"
				>
					{pythBindings?.feeds.length ?? 0} feeds
				</span>
			</div>
			<div className="grid gap-3 md:grid-cols-3">
				{(pythBindings?.feeds ?? []).map((feed) => (
					<div
						key={feed.symbol}
						className="min-h-16 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
					>
						<div className="text-xs uppercase text-neutral-500 dark:text-neutral-400">
							{feed.symbol}
						</div>
						<div className="mt-2 text-sm font-semibold" data-testid={`pyth-price-${feed.symbol}`}>
							{formatPythPrice(feed)}
						</div>
						<div className="mt-1 truncate font-mono text-xs text-neutral-500" title={feed.feedId}>
							{shortId(feed.priceInfoObjectId, 8, 6)}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function TradePanel({
	connected,
	canSwap,
	pending,
	error,
	digest,
	onSwap,
}: {
	connected: boolean;
	canSwap: boolean;
	pending: boolean;
	error: string | undefined;
	digest: string | undefined;
	onSwap: () => void;
}) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
				<div>
					<h2 className="text-sm font-semibold">Trade ticket</h2>
					<p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
						{connected ? 'Swap SUI for local DEEP' : 'Connect a dev wallet account on localnet'}
					</p>
				</div>
				<span className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
					{DEFAULT_POOL}
				</span>
			</div>
			<div className="grid gap-3 lg:grid-cols-[1fr_120px_160px]">
				<label className="block">
					<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">Market</span>
					<input
						type="text"
						value="SUI -> DEEP"
						disabled
						className="mt-1 h-10 w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
					/>
				</label>
				<label className="block">
					<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">SUI</span>
					<input
						type="text"
						value={String(SWAP_QUOTE_AMOUNT)}
						disabled
						className="mt-1 h-10 w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 font-mono text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
					/>
				</label>
				<button
					type="button"
					disabled={!canSwap}
					data-testid="trade-submit"
					onClick={onSwap}
					className="mt-5 h-10 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white disabled:bg-neutral-400 lg:mt-auto"
				>
					{pending ? 'Swapping' : 'Swap'}
				</button>
			</div>
			{digest ? (
				<p
					className="mt-3 font-mono text-xs text-emerald-700 dark:text-emerald-300"
					data-testid="trade-digest"
					title={digest}
				>
					{shortId(digest, 10, 8)}
				</p>
			) : null}
			{error ? (
				<p className="mt-3 text-xs text-red-600 dark:text-red-300" data-testid="trade-error">
					{error}
				</p>
			) : null}
		</section>
	);
}

function StatusMetric({
	label,
	value,
	testId,
}: {
	label: string;
	value: string;
	testId?: string;
}) {
	return (
		<div className="min-h-16 rounded-md border border-emerald-200 bg-white p-3 dark:border-emerald-900 dark:bg-emerald-900">
			<div className="text-xs uppercase text-emerald-700 dark:text-emerald-200">{label}</div>
			<div className="mt-2 break-words text-sm font-semibold" data-testid={testId}>
				{value}
			</div>
		</div>
	);
}

function KeyValue({ label, value, testId }: { label: string; value: string; testId: string }) {
	return (
		<div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
			<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">{label}</span>
			<span className="truncate font-mono text-xs" title={value} data-testid={testId}>
				{value}
			</span>
		</div>
	);
}

function readBalanceRaw(balance: unknown): bigint {
	if (typeof balance !== 'object' || balance === null) return 0n;
	const record = balance as { balance?: unknown; addressBalance?: unknown };
	const value = record.balance ?? record.addressBalance ?? 0;
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return BigInt(value);
	if (typeof value === 'string' && value.length > 0) return BigInt(value);
	return 0n;
}

function formatPythPrice(feed: PythFeedBinding): string {
	const value = Number(feed.price) * 10 ** feed.expo;
	return `$${value.toLocaleString(undefined, {
		minimumFractionDigits: value < 1 ? 4 : 2,
		maximumFractionDigits: value < 1 ? 4 : 2,
	})}`;
}

interface CoinBinding {
	readonly fullCoinType: string;
	readonly packageId?: string;
}

function requireCoinBinding(label: string, binding: CoinBinding | undefined): CoinBinding {
	if (binding === undefined) {
		throw new Error(`Generated ${label} coin binding is missing.`);
	}
	return binding;
}

interface PythFeedBinding {
	readonly symbol: string;
	readonly feedId: string;
	readonly priceInfoObjectId: string;
	readonly price: string;
	readonly expo: number;
}

interface PythBinding {
	readonly packageId: string | null;
	readonly stateId: string | null;
	readonly wormholeStateId: string | null;
	readonly feeds: ReadonlyArray<PythFeedBinding>;
}
