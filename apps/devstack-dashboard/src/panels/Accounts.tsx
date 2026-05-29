// Accounts panel — the configured keypairs from the projection with their live
// on-chain SUI balance and funding status. Clicking a row opens an inline
// detail card: full address, balance, an on-demand chain balance check, and a
// jump to the faucet.
//
// Honest scope: the projection only carries the native SUI `balanceMist`; there
// is no per-coin registry here, so no DEEP/USDC rows are shown. The "Check
// balance" button reads the chain directly from the node over gRPC
// (`client.core.getBalance`), not via the control-plane API.

import { useState } from 'react';
import type { PanelProps } from './types.ts';
import type { AccountProjection } from '../lib/types.ts';
import { fundingDisplay } from '../lib/derive.ts';
import { mistToSui } from '../lib/format.ts';
import { chainClient, suiRpcUrl } from '../lib/chain.ts';
import { navigate } from '../lib/router.ts';
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
	JsonTree,
	Kpi,
	Panel,
} from '../ui/index.ts';

/** Sum of all known SUI balances (MIST), as a display SUI string. */
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

export const AccountsPanel = ({ projection }: PanelProps) => {
	const { accounts } = projection;
	const rpcUrl = suiRpcUrl(projection.endpoints);
	const [selected, setSelected] = useState<string | null>(null);
	const account = selected ? (accounts.find((a) => a.key === selected) ?? null) : null;

	const funded = accounts.filter((a) => ['funded', 'skipped'].includes(a.funding.status)).length;

	const columns: ReadonlyArray<Column<AccountProjection>> = [
		{
			key: 'account',
			header: 'Account',
			render: (a) => <span style={{ color: 'var(--c-magenta)', fontWeight: 550 }}>{a.name}</span>,
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
					<Badge style={{ height: 19, fontSize: 10.5 }}>{a.scheme}</Badge>
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
					{a.source === 'impersonate' ? 'impersonated' : (a.source ?? '—')}
				</Badge>
			),
		},
		{
			key: 'balance',
			header: 'Balance',
			align: 'right',
			render: (a) => <CoinAmount mist={a.funding.balanceMist} />,
			sortVal: (a) => {
				if (a.funding.balanceMist === null) return -1;
				try {
					return Number(BigInt(a.funding.balanceMist));
				} catch {
					return -1;
				}
			},
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
						Configured keypairs with their funding status and live native balance.
					</p>
				</div>
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
						<AccountDetail account={account} rpcUrl={rpcUrl} onClose={() => setSelected(null)} />
					)}
				</div>
			)}
		</div>
	);
};

// --- Detail card ------------------------------------------------------------

type BalanceState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'ok'; readonly data: unknown }
	| { readonly kind: 'error'; readonly message: string };

interface AccountDetailProps {
	readonly account: AccountProjection;
	/** The Sui node's gRPC base URL, or null when no node is in the stack. */
	readonly rpcUrl: string | null;
	readonly onClose: () => void;
}

const AccountDetail = ({ account, rpcUrl, onClose }: AccountDetailProps) => {
	const [balance, setBalance] = useState<BalanceState>({ kind: 'idle' });
	const fund = fundingDisplay(account.funding.status);

	const checkBalance = async () => {
		if (!account.address || !rpcUrl) return;
		setBalance({ kind: 'loading' });
		try {
			// Read the chain directly over gRPC — not via the control-plane API.
			const client = await chainClient(rpcUrl);
			const { balance: result } = await client.core.getBalance({ owner: account.address });
			setBalance({ kind: 'ok', data: result });
		} catch (err) {
			setBalance({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
		}
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

			<Panel pad style={{ background: 'var(--bg-elev)' }}>
				<div className="eyebrow" style={{ marginBottom: 8 }}>
					Balance
				</div>
				<div className="row between">
					<span className="row" style={{ gap: 6 }}>
						<Dot token={fund.token} pulse={account.funding.status === 'pending'} />
						<span style={{ fontSize: 12.5, color: `var(--c-${fund.token})` }}>{fund.label}</span>
					</span>
					<span className="row" style={{ gap: 7 }}>
						<CoinIcon symbol="SUI" size={18} />
						<CoinAmount mist={account.funding.balanceMist} />
					</span>
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

			<div className="col" style={{ gap: 8 }}>
				<Button
					sm
					icon="search"
					onClick={() => void checkBalance()}
					disabled={!account.address || !rpcUrl || balance.kind === 'loading'}
				>
					{balance.kind === 'loading' ? 'Checking…' : 'Check balance'}
				</Button>
				{balance.kind === 'ok' && (
					<div
						className="scroll-y"
						style={{
							maxHeight: 180,
							padding: '8px 10px',
							background: 'var(--bg-base)',
							borderRadius: 'var(--r-sm)',
						}}
					>
						<JsonTree data={balance.data} />
					</div>
				)}
				{balance.kind === 'error' && (
					<div style={{ fontSize: 12, color: 'var(--c-red)' }}>{balance.message}</div>
				)}
			</div>

			<Button variant="primary" icon="drop" onClick={() => navigate('faucet')}>
				Fund
			</Button>
		</Panel>
	);
};
