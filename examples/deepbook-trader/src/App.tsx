import { useMemo, useState } from 'react';
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import {
	deepbook as deepbookExtension,
	type CoinMap,
	type DeepbookPackageIds,
	type PoolMap,
} from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';

import { coins } from '@generated/coins.js';
import { config } from '@generated/config.js';
import { deepbook } from '@generated/deepbook.js';
import { accounts } from '@devstack-dev/accounts.js';
import { formatCoinAmount, parseCoinAmount, shortId } from './lib/format.js';
import { useCoinBalance, useSignAndExecute } from './lib/queries.js';

const SUI_SCALAR = 1_000_000_000;
const DEEP_SCALAR = 1_000_000;
const USDC_SCALAR = 1_000_000;
const DBTC_SCALAR = 100_000_000;
const DETH_SCALAR = 100_000_000;
const DEFAULT_POOL = 'DEEP_SUI';
const DEFAULT_TRADE_DIRECTION: TradeDirection = 'quote-to-base';
const network = config.networks[config.network];
const deepbookBindings = deepbook.deepbook;
const configuredPoolCount: number = deepbookBindings.pools.length;
const coinBindings = coins as Record<string, CoinBinding>;
const deepCoin = requireCoinBinding('DEEP', coinBindings.deep ?? coinBindings.DEEP);
const usdcCoin = requireCoinBinding(
	'USDC',
	coinBindings.dusdc ?? coinBindings.usdc ?? coinBindings.USDC,
);
const dbtcCoin = requireCoinBinding('DBTC', coinBindings.dbtc ?? coinBindings.DBTC);
const dethCoin = requireCoinBinding('DETH', coinBindings.deth ?? coinBindings.DETH);
const pythBindings = deepbookBindings.pyth as PythBinding | null;

type DemoCoinKey = 'SUI' | 'DEEP' | 'USDC' | 'DBTC' | 'DETH';
type TradeDirection = 'quote-to-base' | 'base-to-quote';

const COIN_SCALARS: Record<DemoCoinKey, number> = {
	SUI: SUI_SCALAR,
	DEEP: DEEP_SCALAR,
	USDC: USDC_SCALAR,
	DBTC: DBTC_SCALAR,
	DETH: DETH_SCALAR,
};

const demoCoinBindings: Record<DemoCoinKey, CoinBinding> = {
	SUI: coins.sui,
	DEEP: deepCoin,
	USDC: usdcCoin,
	DBTC: dbtcCoin,
	DETH: dethCoin,
};

interface DemoMarket {
	readonly pool: string;
	readonly base: DemoCoinKey;
	readonly quote: DemoCoinKey;
	readonly baseAmountRaw: bigint;
	readonly quoteAmountRaw: bigint;
}

const DEFAULT_MARKET: DemoMarket = {
	pool: DEFAULT_POOL,
	base: 'DEEP',
	quote: 'SUI',
	baseAmountRaw: 10_000_000n,
	quoteAmountRaw: 20_000_000n,
};

const DEMO_MARKETS: ReadonlyArray<DemoMarket> = [
	DEFAULT_MARKET,
	{
		pool: 'SUI_USDC',
		base: 'SUI',
		quote: 'USDC',
		baseAmountRaw: 1_000_000_000n,
		quoteAmountRaw: 10_000_000n,
	},
	{
		pool: 'DBTC_USDC',
		base: 'DBTC',
		quote: 'USDC',
		baseAmountRaw: 100_000n,
		quoteAmountRaw: 50_000_000n,
	},
	{
		pool: 'DETH_USDC',
		base: 'DETH',
		quote: 'USDC',
		baseAmountRaw: 1_000_000n,
		quoteAmountRaw: 25_000_000n,
	},
];

export function App() {
	const currentAccount = useCurrentAccount();
	const suiClient = useCurrentClient();
	const availableMarkets = useMemo(() => configuredDemoMarkets(), []);
	const [selectedPool, setSelectedPool] = useState(DEFAULT_POOL);
	const [tradeDirection, setTradeDirection] = useState<TradeDirection>(DEFAULT_TRADE_DIRECTION);
	const [amountInput, setAmountInput] = useState(() =>
		defaultTradeAmountInput(DEFAULT_MARKET, DEFAULT_TRADE_DIRECTION),
	);
	const selectedMarket =
		availableMarkets.find((market) => market.pool === selectedPool) ??
		availableMarkets[0] ??
		DEFAULT_MARKET;
	const suiBalance = useCoinBalance(currentAccount?.address, demoCoinBindings.SUI.fullCoinType);
	const deepBalance = useCoinBalance(currentAccount?.address, demoCoinBindings.DEEP.fullCoinType);
	const usdcBalance = useCoinBalance(currentAccount?.address, demoCoinBindings.USDC.fullCoinType);
	const dbtcBalance = useCoinBalance(currentAccount?.address, demoCoinBindings.DBTC.fullCoinType);
	const dethBalance = useCoinBalance(currentAccount?.address, demoCoinBindings.DETH.fullCoinType);
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
	const balances = {
		SUI: readBalanceRaw(suiBalance.data),
		DEEP: readBalanceRaw(deepBalance.data),
		USDC: readBalanceRaw(usdcBalance.data),
		DBTC: readBalanceRaw(dbtcBalance.data),
		DETH: readBalanceRaw(dethBalance.data),
	} satisfies Record<DemoCoinKey, bigint>;
	const balanceLoading = {
		SUI: suiBalance.isLoading,
		DEEP: deepBalance.isLoading,
		USDC: usdcBalance.isLoading,
		DBTC: dbtcBalance.isLoading,
		DETH: dethBalance.isLoading,
	} satisfies Record<DemoCoinKey, boolean>;
	const payCoin = tradeInputCoin(selectedMarket, tradeDirection);
	const receiveCoin = tradeOutputCoin(selectedMarket, tradeDirection);
	const parsedTradeAmount = useMemo(
		() => parseTradeAmountInput(amountInput, payCoin),
		[amountInput, payCoin],
	);
	const amountError =
		parsedTradeAmount.error ??
		(parsedTradeAmount.raw <= 0n ? 'Enter an amount greater than zero.' : undefined);
	const loadingBalanceError =
		currentAccount && !amountError && balanceLoading[payCoin]
			? `Loading ${payCoin} balance.`
			: undefined;
	const balanceError =
		currentAccount &&
		!amountError &&
		!loadingBalanceError &&
		balances[payCoin] < parsedTradeAmount.raw
			? `Not enough ${payCoin} in the connected account.`
			: undefined;
	const tradeFormError = amountError ?? loadingBalanceError ?? balanceError;
	const canSwap = Boolean(
		currentAccount &&
		deepbookClient &&
		!trade.isPending &&
		!tradeFormError &&
		parsedTradeAmount.raw > 0n,
	);

	const selectMarket = (pool: string) => {
		const market = availableMarkets.find((candidate) => candidate.pool === pool) ?? selectedMarket;
		setSelectedPool(pool);
		setAmountInput(defaultTradeAmountInput(market, tradeDirection));
	};

	const flipTradeDirection = () => {
		const nextDirection: TradeDirection =
			tradeDirection === 'quote-to-base' ? 'base-to-quote' : 'quote-to-base';
		setTradeDirection(nextDirection);
		setAmountInput(defaultTradeAmountInput(selectedMarket, nextDirection));
	};

	const submitSwap = () => {
		if (!currentAccount || !deepbookClient || !canSwap) return;
		const tx = new Transaction();
		const [baseCoin, quoteCoin, returnedDeepCoin] = tx.add(
			tradeDirection === 'base-to-quote'
				? deepbookClient.deepbook.deepBook.swapExactBaseForQuote({
						poolKey: selectedMarket.pool,
						amount: parsedTradeAmount.raw,
						deepAmount: 0n,
						minOut: 0n,
					})
				: deepbookClient.deepbook.deepBook.swapExactQuoteForBase({
						poolKey: selectedMarket.pool,
						amount: parsedTradeAmount.raw,
						deepAmount: 0n,
						minOut: 0n,
					}),
		);
		tx.transferObjects([baseCoin, quoteCoin, returnedDeepCoin], currentAccount.address);
		trade.reset();
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
									{network.mode}
								</span>
								<span className="font-mono" data-testid="localnet-chain">
									{shortId(network.chain, 8, 6)}
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
						balances={balances}
						selectedPool={selectedMarket.pool}
						loading={balanceLoading}
					/>
				</aside>

				<section className="space-y-4">
					<DeepBookStatus />
					<PricePanel />
					<TradePanel
						markets={availableMarkets}
						selectedMarket={selectedMarket}
						tradeDirection={tradeDirection}
						amountInput={amountInput}
						payCoin={payCoin}
						receiveCoin={receiveCoin}
						payBalance={balances[payCoin]}
						receiveBalance={balances[receiveCoin]}
						payBalanceLoading={balanceLoading[payCoin]}
						receiveBalanceLoading={balanceLoading[receiveCoin]}
						amountError={tradeFormError}
						onAmountInput={setAmountInput}
						onFlipDirection={flipTradeDirection}
						onSelectMarket={selectMarket}
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
			address:
				demoCoinBindings.DEEP.packageId ?? addressFromCoinType(demoCoinBindings.DEEP.fullCoinType),
			type: demoCoinBindings.DEEP.fullCoinType,
			scalar: DEEP_SCALAR,
		},
		SUI: {
			address: addressFromCoinType(demoCoinBindings.SUI.fullCoinType),
			type: demoCoinBindings.SUI.fullCoinType,
			scalar: SUI_SCALAR,
		},
		USDC: {
			address:
				demoCoinBindings.USDC.packageId ?? addressFromCoinType(demoCoinBindings.USDC.fullCoinType),
			type: demoCoinBindings.USDC.fullCoinType,
			scalar: USDC_SCALAR,
		},
		DBTC: {
			address:
				demoCoinBindings.DBTC.packageId ?? addressFromCoinType(demoCoinBindings.DBTC.fullCoinType),
			type: demoCoinBindings.DBTC.fullCoinType,
			scalar: DBTC_SCALAR,
		},
		DETH: {
			address:
				demoCoinBindings.DETH.packageId ?? addressFromCoinType(demoCoinBindings.DETH.fullCoinType),
			type: demoCoinBindings.DETH.fullCoinType,
			scalar: DETH_SCALAR,
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

function configuredDemoMarkets(): ReadonlyArray<DemoMarket> {
	const poolNames: ReadonlySet<string> = new Set(deepbookBindings.pools.map((pool) => pool.name));
	return DEMO_MARKETS.filter((market) => poolNames.has(market.pool));
}

function poolLabel(market: DemoMarket): string {
	return `${market.base} / ${market.quote}`;
}

function tradeInputCoin(market: DemoMarket, direction: TradeDirection): DemoCoinKey {
	return direction === 'base-to-quote' ? market.base : market.quote;
}

function tradeOutputCoin(market: DemoMarket, direction: TradeDirection): DemoCoinKey {
	return direction === 'base-to-quote' ? market.quote : market.base;
}

function tradeRouteLabel(market: DemoMarket, direction: TradeDirection): string {
	return `${tradeInputCoin(market, direction)} -> ${tradeOutputCoin(market, direction)}`;
}

function defaultTradeAmountRaw(market: DemoMarket, direction: TradeDirection): bigint {
	return direction === 'base-to-quote' ? market.baseAmountRaw : market.quoteAmountRaw;
}

function defaultTradeAmountInput(market: DemoMarket, direction: TradeDirection): string {
	return formatEditableCoinAmount(
		defaultTradeAmountRaw(market, direction),
		tradeInputCoin(market, direction),
	);
}

function formatEditableCoinAmount(raw: bigint, coin: DemoCoinKey): string {
	return formatCoinAmount(raw, COIN_SCALARS[coin], 9).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
}

function parseTradeAmountInput(
	input: string,
	coin: DemoCoinKey,
): { readonly raw: bigint; readonly error?: string } {
	try {
		return { raw: parseCoinAmount(input, COIN_SCALARS[coin]) };
	} catch (error) {
		return {
			raw: 0n,
			error: error instanceof Error ? error.message : 'Enter a valid amount.',
		};
	}
}

function connectedBalanceText(
	connectedAddress: string | undefined,
	raw: bigint,
	scalar: number,
	loading: boolean,
): string {
	if (!connectedAddress) return 'connect wallet';
	if (loading) return 'loading';
	return formatCoinAmount(raw, scalar, 4);
}

function tradeBalanceText(raw: bigint, coin: DemoCoinKey, loading: boolean): string {
	return `${loading ? 'loading' : formatCoinAmount(raw, COIN_SCALARS[coin], 4)} ${coin}`;
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
				<KeyValue label="RPC" value={network.rpc} testId="localnet-rpc" />
				<KeyValue label="Faucet" value={network.faucet ?? 'none'} testId="localnet-faucet" />
				<KeyValue label="GraphQL" value={network.graphql ?? 'none'} testId="localnet-graphql" />
			</div>
		</section>
	);
}

function WalletPanel({
	connectedAddress,
	balances,
	selectedPool,
	loading,
}: {
	connectedAddress: string | undefined;
	balances: Record<DemoCoinKey, bigint>;
	selectedPool: string;
	loading: Record<DemoCoinKey, boolean>;
}) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Connected balances</h2>
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
				<KeyValue
					label="Account"
					value={connectedAddress ?? 'not connected'}
					testId="active-address"
				/>
				<KeyValue label="Demo" value={accounts.trader.address} testId="trader-address" />
				<KeyValue
					label="SUI"
					value={connectedBalanceText(connectedAddress, balances.SUI, SUI_SCALAR, loading.SUI)}
					testId="sui-balance"
				/>
				<KeyValue
					label="USDC"
					value={connectedBalanceText(connectedAddress, balances.USDC, USDC_SCALAR, loading.USDC)}
					testId="usdc-balance"
				/>
				<KeyValue
					label="DEEP"
					value={connectedBalanceText(connectedAddress, balances.DEEP, DEEP_SCALAR, loading.DEEP)}
					testId="deep-balance"
				/>
				<KeyValue
					label="DBTC"
					value={connectedBalanceText(connectedAddress, balances.DBTC, DBTC_SCALAR, loading.DBTC)}
					testId="dbtc-balance"
				/>
				<KeyValue
					label="DETH"
					value={connectedBalanceText(connectedAddress, balances.DETH, DETH_SCALAR, loading.DETH)}
					testId="deth-balance"
				/>
				<KeyValue label="Pool" value={selectedPool} testId="deepbook-pool" />
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
				<StatusMetric
					label="Pools"
					value={String(configuredPoolCount)}
					testId="deepbook-pool-count"
				/>
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
	markets,
	selectedMarket,
	tradeDirection,
	amountInput,
	payCoin,
	receiveCoin,
	payBalance,
	receiveBalance,
	payBalanceLoading,
	receiveBalanceLoading,
	amountError,
	onAmountInput,
	onFlipDirection,
	onSelectMarket,
	connected,
	canSwap,
	pending,
	error,
	digest,
	onSwap,
}: {
	markets: ReadonlyArray<DemoMarket>;
	selectedMarket: DemoMarket;
	tradeDirection: TradeDirection;
	amountInput: string;
	payCoin: DemoCoinKey;
	receiveCoin: DemoCoinKey;
	payBalance: bigint;
	receiveBalance: bigint;
	payBalanceLoading: boolean;
	receiveBalanceLoading: boolean;
	amountError: string | undefined;
	onAmountInput: (amount: string) => void;
	onFlipDirection: () => void;
	onSelectMarket: (pool: string) => void;
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
						{connected
							? `Swap ${payCoin} from the connected account`
							: 'Connect a dev wallet account on localnet'}
					</p>
				</div>
				<span
					className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
					data-testid="selected-market"
				>
					{tradeRouteLabel(selectedMarket, tradeDirection)}
				</span>
			</div>
			<div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
				{markets.map((market) => {
					const active = market.pool === selectedMarket.pool;
					return (
						<button
							key={market.pool}
							type="button"
							aria-pressed={active}
							data-testid={`market-option-${market.pool}`}
							onClick={() => onSelectMarket(market.pool)}
							className={`min-h-16 rounded-md border px-3 py-2 text-left transition ${
								active
									? 'border-emerald-500 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100'
									: 'border-neutral-200 bg-white text-neutral-800 hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:border-neutral-700'
							}`}
						>
							<span className="block truncate font-mono text-xs">{market.pool}</span>
							<span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
								{poolLabel(market)}
							</span>
						</button>
					);
				})}
			</div>
			<div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr]">
				<label className="block">
					<span className="flex items-center justify-between gap-3 text-xs uppercase text-neutral-500 dark:text-neutral-400">
						<span>You pay</span>
						<span className="font-mono normal-case" data-testid="trade-pay-balance">
							{tradeBalanceText(payBalance, payCoin, payBalanceLoading)}
						</span>
					</span>
					<input
						type="text"
						inputMode="decimal"
						value={amountInput}
						onChange={(event) => onAmountInput(event.currentTarget.value)}
						disabled={pending}
						data-testid="trade-pay-amount"
						className="mt-1 h-11 w-full rounded-md border border-neutral-300 bg-white px-3 font-mono text-sm text-neutral-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-emerald-400 dark:disabled:bg-neutral-900"
					/>
				</label>
				<button
					type="button"
					onClick={onFlipDirection}
					disabled={pending}
					data-testid="trade-direction-toggle"
					className="mt-5 h-11 rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-700 transition hover:border-emerald-500 hover:text-emerald-700 disabled:text-neutral-400 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-emerald-400 dark:hover:text-emerald-300 lg:mt-auto"
				>
					Flip
				</button>
				<div>
					<span className="flex items-center justify-between gap-3 text-xs uppercase text-neutral-500 dark:text-neutral-400">
						<span>You receive</span>
						<span className="font-mono normal-case" data-testid="trade-receive-balance">
							{tradeBalanceText(receiveBalance, receiveCoin, receiveBalanceLoading)}
						</span>
					</span>
					<div
						className="mt-1 flex h-11 items-center rounded-md border border-neutral-300 bg-neutral-100 px-3 font-mono text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
						data-testid="trade-receive-preview"
					>
						Market fill in {receiveCoin}
					</div>
				</div>
			</div>
			<div className="mt-3 grid gap-3 lg:grid-cols-[1fr_160px]">
				<label className="block">
					<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">Route</span>
					<input
						type="text"
						value={tradeRouteLabel(selectedMarket, tradeDirection)}
						disabled
						data-testid="trade-market"
						className="mt-1 h-10 w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
					/>
				</label>
				<button
					type="button"
					disabled={!canSwap}
					data-testid="trade-submit"
					onClick={onSwap}
					className="mt-5 h-10 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white disabled:bg-neutral-400 lg:mt-auto"
				>
					{pending ? 'Swapping' : `Swap ${payCoin}`}
				</button>
			</div>
			{amountError ? (
				<p
					className="mt-3 text-xs text-amber-700 dark:text-amber-300"
					data-testid="trade-form-error"
				>
					{amountError}
				</p>
			) : null}
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

function StatusMetric({ label, value, testId }: { label: string; value: string; testId?: string }) {
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
