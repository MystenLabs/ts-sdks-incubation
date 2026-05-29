// Accounts panel — the configured keypairs from the projection, with their live
// on-chain balances read browser-direct from the node (gRPC via react-query),
// not the control-plane API. The projection's `funding.balanceMist` is a stale
// snapshot from the last funding pass and is often null, so the Balance column
// and the detail drawer both fetch the *current* chain balance per address and
// fall back to the projection value only while the live read is loading.
//
// Clicking a row opens a right detail card: avatar, full address, the live SUI
// balance plus every other non-zero coin balance, an impersonation warning, and
// Fund / Explorer / Export actions. There is no dev-wallet integration yet, so
// the "Connect dev-wallet" button renders disabled with an honest note rather
// than faking a connection.

import { useState } from 'react';
import type { PanelProps } from './types.ts';
import type { AccountProjection } from '../lib/types.ts';
import type { BalanceView } from '../lib/explorerTypes.ts';
import { fundingDisplay } from '../lib/derive.ts';
import { mistToSui } from '../lib/format.ts';
import { type ChainSource, useBalances, useSuiBalance } from '../lib/useChain.ts';
import { useToast } from '../lib/toast.tsx';
import { gotoObject, navigate } from '../lib/router.ts';
import {
	AddressChip,
	Badge,
	Button,
	CoinAmount,
	CoinIcon,
	type Column,
	CopyChip,
	DataTable,
	Dot,
	EmptyState,
	FundingStatus,
	Icon,
	IconButton,
	Identicon,
	Kpi,
	Panel,
} from '../ui/index.ts';

const SUI_TYPE = '0x2::sui::SUI';

/** Symbol from a coin type's trailing `::SYMBOL`, upper-cased (`DEEP`, `WAL`…). */
const coinSymbol = (coinType: string): string => {
	const tail = coinType.split('::').pop() ?? coinType;
	return tail.toUpperCase();
};

/** Sum of the projection's last-known SUI balances (MIST) as a display string. */
const totalBalanceSui = (accounts: ReadonlyArray<AccountProjection>): string => {
	let total = 0n;
	let any = false;
	for (const a of accounts) {
		if (a.funding.balanceMist === null) continue;
		try {
			total += BigInt(a.funding.balanceMist);
			any = true;
		} catch {
			// Ignore unparseable balances.
		}
	}
	return any ? mistToSui(total) : '—';
};

export const AccountsPanel = ({ projection, chain }: PanelProps) => {
	const { accounts } = projection;
	const [selected, setSelected] = useState<string | null>(null);
	const account = selected ? (accounts.find((a) => a.key === selected) ?? null) : null;

	const funded = accounts.filter((a) => ['funded', 'skipped'].includes(a.funding.status)).length;

	const columns: ReadonlyArray<Column<AccountProjection>> = [
		{
			key: 'account',
			header: 'Account',
			render: (a) => (
				<span className="row" style={{ gap: 8 }}>
					<Identicon address={a.address ?? a.key} size={18} />
					<span style={{ color: 'var(--c-magenta)', fontWeight: 550 }}>{a.name}</span>
				</span>
			),
			sortVal: (a) => a.name,
		},
		{
			key: 'address',
			header: 'Address',
			render: (a) => <AddressChip address={a.address} />,
		},
		{
			key: 'scheme',
			header: 'Scheme',
			render: (a) =>
				a.scheme ? (
					<span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
						{a.scheme}
					</span>
				) : (
					<span style={{ color: 'var(--tx-dim)' }}>—</span>
				),
		},
		{
			key: 'source',
			header: 'Source',
			render: (a) => (
				<Badge
					style={{
						height: 19,
						fontSize: 10.5,
						color: a.source === 'impersonate' ? 'var(--c-yellow)' : 'var(--tx-mid)',
					}}
				>
					{a.source === 'impersonate' ? 'impersonate' : (a.source ?? '—')}
				</Badge>
			),
		},
		{
			key: 'balance',
			header: 'Balance',
			align: 'right',
			render: (a) => <LiveBalance chain={chain} account={a} />,
		},
		{
			key: 'funding',
			header: 'Funding',
			render: (a) => <FundingStatus funding={a.funding} />,
		},
		{
			key: 'wallet',
			header: 'Wallet',
			render: (a) =>
				a.walletVisible ? <Dot token="cyan" /> : <span style={{ color: 'var(--tx-dim)' }}>—</span>,
		},
	];

	return (
		<div className="col" style={{ gap: 16 }}>
			<div className="row between wrap" style={{ gap: 12 }}>
				<div>
					<h2 style={{ fontSize: 19 }}>Accounts &amp; Wallet</h2>
					<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
						Configured keypairs with live on-chain balances and funding status.
					</p>
				</div>
				{/* No dev-wallet integration exists yet — render the affordance honestly disabled. */}
				<span title="Dev-wallet connection isn't wired up yet">
					<Button variant="primary" sm icon="wallet" disabled>
						Connect dev-wallet
					</Button>
				</span>
			</div>

			{/* Lead stats */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
					gap: 14,
				}}
			>
				<Kpi label="Accounts" value={accounts.length} token="magenta" icon="wallet" />
				<Kpi
					label="Funded"
					value={`${funded}/${accounts.length}`}
					sub="funded"
					token="green"
					icon="check"
				/>
				<Kpi
					label="Total balance"
					value={totalBalanceSui(accounts)}
					sub="SUI"
					token="cyan"
					icon="coins"
				/>
			</div>

			{accounts.length === 0 ? (
				<Panel>
					<EmptyState
						icon="wallet"
						title="No accounts configured"
						hint="Accounts declared in the stack config appear here once the projection loads."
					/>
				</Panel>
			) : (
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: account ? '1fr 360px' : '1fr',
						gap: 18,
						alignItems: 'start',
					}}
				>
					<Panel style={{ overflow: 'hidden' }}>
						<DataTable
							columns={columns}
							rows={accounts}
							rowKey={(a) => a.key}
							activeKey={selected ?? undefined}
							onRowClick={(a) => setSelected((cur) => (cur === a.key ? null : a.key))}
						/>
					</Panel>

					{account && (
						<AccountDetail account={account} chain={chain} onClose={() => setSelected(null)} />
					)}
				</div>
			)}
		</div>
	);
};

// --- Live balance cell ------------------------------------------------------

interface LiveBalanceProps {
	readonly chain: ChainSource;
	readonly account: AccountProjection;
}

/**
 * Table Balance cell: the live SUI balance read browser-direct from the node
 * (react-query, deduped/cached by `[network, suiBalance, owner]`). While the
 * read is loading it falls back to the projection's last-known `balanceMist`,
 * so the column is never blank for an already-funded account.
 */
const LiveBalance = ({ chain, account }: LiveBalanceProps) => {
	const query = useSuiBalance(chain, account.address);
	const mist = query.data ?? account.funding.balanceMist;
	return <CoinAmount mist={mist} />;
};

// --- Detail card ------------------------------------------------------------

interface AccountDetailProps {
	readonly account: AccountProjection;
	readonly chain: ChainSource;
	readonly onClose: () => void;
}

const AccountDetail = ({ account, chain, onClose }: AccountDetailProps) => {
	const toast = useToast();
	const fund = fundingDisplay(account.funding.status);
	const suiQuery = useSuiBalance(chain, account.address);
	const balancesQuery = useBalances(chain, account.address);

	const suiMist = suiQuery.data ?? account.funding.balanceMist;
	// Other non-zero coins (everything but native SUI), if the node returned any.
	const otherCoins: ReadonlyArray<BalanceView> = (balancesQuery.data ?? []).filter(
		(b) => b.coinType !== SUI_TYPE,
	);

	const onExport = (): void => {
		// Export remains guarded to ephemeral keypairs only (see Faucet/handoff).
		toast.info('Export guarded — ephemeral keypairs only');
	};

	return (
		<Panel className="panel-pad fade-up col" style={{ gap: 16, position: 'sticky', top: 0 }}>
			<div className="row between">
				<div className="row" style={{ gap: 9 }}>
					<Identicon address={account.address ?? account.key} size={36} />
					<div>
						<div style={{ fontWeight: 560, color: 'var(--c-magenta)' }}>{account.name}</div>
						<span className="mono" style={{ fontSize: 11, color: 'var(--tx-lo)' }}>
							{account.scheme ?? 'no scheme'}
						</span>
					</div>
				</div>
				<IconButton icon="x" label="Close detail" onClick={onClose} />
			</div>

			<CopyChip text={account.address ?? '—'} display={account.address ?? '—'} />

			{/* Balances — live SUI + every other non-zero coin the node reports. */}
			<Panel pad style={{ background: 'var(--bg-elev)' }}>
				<div className="row between" style={{ marginBottom: 8 }}>
					<span className="eyebrow">Balances</span>
					<span className="row" style={{ gap: 6 }}>
						<Dot token={fund.token} pulse={account.funding.status === 'pending'} />
						<span style={{ fontSize: 11.5, color: `var(--c-${fund.token})` }}>
							{account.funding.status === 'funded' ? `✓ ${fund.label}` : fund.label}
						</span>
					</span>
				</div>
				<div className="col" style={{ gap: 7 }}>
					<div className="row between">
						<span className="row" style={{ gap: 7 }}>
							<CoinIcon symbol="SUI" size={18} />
							<span className="mono" style={{ fontSize: 12 }}>SUI</span>
						</span>
						<CoinAmount mist={suiMist} />
					</div>
					{otherCoins.map((b) => {
						const symbol = coinSymbol(b.coinType);
						return (
							<div key={b.coinType} className="row between">
								<span className="row" style={{ gap: 7 }}>
									<CoinIcon symbol={symbol} size={18} />
									<span className="mono" style={{ fontSize: 12 }}>{symbol}</span>
								</span>
								<CoinAmount mist={b.balance} symbol={symbol} />
							</div>
						);
					})}
					{balancesQuery.isLoading && otherCoins.length === 0 && (
						<span style={{ fontSize: 11.5, color: 'var(--tx-dim)' }}>Loading balances…</span>
					)}
					{balancesQuery.isError && (
						<span style={{ fontSize: 11.5, color: 'var(--c-red)' }}>
							Couldn't read balances from the node.
						</span>
					)}
				</div>
			</Panel>

			{account.source === 'impersonate' && (
				<Panel
					className="panel-pad row"
					style={{
						gap: 8,
						borderColor: 'color-mix(in oklab, var(--c-yellow) 34%, var(--line))',
						background: 'color-mix(in oklab, var(--c-yellow) 7%, transparent)',
						fontSize: 12.5,
						color: 'var(--tx-mid)',
					}}
				>
					<Icon name="alert" size={14} style={{ color: 'var(--c-yellow)', flex: 'none' }} />
					Impersonated account — no signing key. Reads only.
				</Panel>
			)}

			<div className="row" style={{ gap: 8 }}>
				<Button variant="primary" className="grow" icon="drop" onClick={() => navigate('faucet')}>
					Fund
				</Button>
				<Button
					disabled={!account.address}
					onClick={() => account.address && gotoObject(account.address)}
				>
					View on explorer
				</Button>
			</div>

			<Button variant="danger" sm onClick={onExport}>
				Export keypair
			</Button>
		</Panel>
	);
};
