import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';

import { accounts } from './generated/accounts.js';
import { coins } from './generated/coins.js';
import { suiNetwork } from './generated/sui/network.js';
import { formatCoinAmount, shortId } from './lib/format.js';
import { useCoinBalance } from './lib/queries.js';

const SUI_COIN_TYPE = '0x2::sui::SUI';
const SUI_SCALAR = 1_000_000_000;
const DEEP_SCALAR = 1_000_000;

export function App() {
	const currentAccount = useCurrentAccount();
	const suiBalance = useCoinBalance(currentAccount?.address, SUI_COIN_TYPE);
	const deepBalance = useCoinBalance(currentAccount?.address, coins.deep.fullCoinType);
	const suiBalanceRaw = readBalanceRaw(suiBalance.data);
	const deepBalanceRaw = readBalanceRaw(deepBalance.data);

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
								<span className="rounded-md bg-orange-50 px-2 py-1 text-orange-700 dark:bg-orange-950 dark:text-orange-300">
									local deployment pending
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
						loading={suiBalance.isLoading || deepBalance.isLoading}
					/>
				</aside>

				<section className="space-y-4">
					<DeepBookStatus />
					<TradePanel connected={Boolean(currentAccount)} />
				</section>
			</main>
		</div>
	);
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
				<KeyValue label="GraphQL" value={suiNetwork.graphqlUrl ?? 'none'} testId="localnet-graphql" />
			</div>
		</section>
	);
}

function WalletPanel({
	connectedAddress,
	suiBalanceRaw,
	deepBalanceRaw,
	loading,
}: {
	connectedAddress: string | undefined;
	suiBalanceRaw: bigint;
	deepBalanceRaw: bigint;
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
				<KeyValue label="Alice" value={accounts.alice.address} testId="alice-address" />
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
				<KeyValue label="DEEP type" value={coins.deep.fullCoinType} testId="deep-coin-type" />
			</div>
		</section>
	);
}

function DeepBookStatus() {
	return (
		<section className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-orange-900 shadow-sm dark:border-orange-900 dark:bg-orange-950 dark:text-orange-100">
			<div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
				<div>
					<h2 className="text-sm font-semibold">DeepBook localnet</h2>
					<p className="mt-1 text-xs text-orange-800 dark:text-orange-200">
						The example no longer points at public testnet. Alice is funded with local SUI
						and local DEEP; local DeepBook pools and Pyth still need first-class devstack
						support before swaps can run.
					</p>
				</div>
				<span
					className="rounded-md bg-white px-2 py-1 text-xs font-medium text-orange-700 dark:bg-orange-900 dark:text-orange-100"
					data-testid="deepbook-local-status"
				>
					unavailable
				</span>
			</div>
			<div className="grid gap-3 md:grid-cols-3">
				<StatusMetric label="Package" value="not deployed" />
				<StatusMetric label="Pools" value="0 local pools" />
				<StatusMetric label="Pyth" value="not configured" />
			</div>
		</section>
	);
}

function TradePanel({ connected }: { connected: boolean }) {
	return (
		<section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
			<div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
				<div>
					<h2 className="text-sm font-semibold">Trade ticket</h2>
					<p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
						{connected
							? 'Wallet connected on localnet'
							: 'Connect a dev wallet account on localnet'}
					</p>
				</div>
				<span className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
					SUI + DEEP funded
				</span>
			</div>
			<div className="grid gap-3 lg:grid-cols-[1fr_120px_160px]">
				<label className="block">
					<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">Market</span>
					<input
						type="text"
						value="local DeepBook unavailable"
						disabled
						className="mt-1 h-10 w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
					/>
				</label>
				<label className="block">
					<span className="text-xs uppercase text-neutral-500 dark:text-neutral-400">Amount</span>
					<input
						type="text"
						value="0"
						disabled
						className="mt-1 h-10 w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 font-mono text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
					/>
				</label>
				<button
					type="button"
					disabled
					data-testid="trade-submit"
					className="mt-5 h-10 rounded-md bg-neutral-400 px-4 text-sm font-semibold text-white lg:mt-auto"
				>
					Swap unavailable
				</button>
			</div>
		</section>
	);
}

function StatusMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-h-16 rounded-md border border-orange-200 bg-white p-3 dark:border-orange-900 dark:bg-orange-900">
			<div className="text-xs uppercase text-orange-700 dark:text-orange-200">{label}</div>
			<div className="mt-2 break-words text-sm font-semibold">{value}</div>
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
