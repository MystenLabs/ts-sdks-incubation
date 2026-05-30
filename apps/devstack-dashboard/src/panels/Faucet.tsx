// Faucet panel — request test coins for any configured account or a pasted
// address. Requests go through the control-plane `fund` GraphQL mutation,
// which reuses devstack's IN-PROCESS funding strategies (the same registry
// the boot-time account funding pass uses) and returns a REAL processed
// result (ok + detail) — not browser-only optimism.
//
// Honest scope per coin (driven by the backend `fundableCoins` query):
//   - SUI is the chain's fixed-amount faucet grant — it dispenses native SUI
//     and IGNORES any requested amount, so there is no amount input for SUI.
//   - WAL/DEEP route through an account-signed swap (SUI → WAL exchange /
//     DEEP_SUI pool). They honor an amount, but require the recipient to BE a
//     resolved account in the stack (the swap spends that account's own SUI).
//     They only appear when their plugin registered a funding strategy.
//
// "Recent requests" reflects the real mutation outcome (processed / failed +
// the backend detail); it is local session state (no server history).

import {
	type ChangeEvent,
	type FormEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PanelProps } from './types.ts';
import { fundAccount, type FundableCoin } from '../lib/api.ts';
import { useFundableCoins } from '../lib/useChain.ts';
import { truncateMiddle, timeAgo } from '../lib/format.ts';
import { useToast } from '../lib/toast.tsx';
import {
	Button,
	CoinIcon,
	Dot,
	EmptyState,
	Icon,
	Input,
	SectionHead,
	Select,
} from '../ui/index.ts';

const OTHER = '__other__';
const HEX_ADDRESS = /^0x[0-9a-fA-F]+$/;
const HISTORY_CAP = 20;
const QUICK_AMOUNTS = ['10', '100', '1000'] as const;

type RequestState = 'idle' | 'requesting';

interface HistoryEntry {
	readonly id: number;
	readonly coin: string;
	/** Displayed amount, or '—' for the fixed-amount SUI grant. */
	readonly amount: string;
	readonly target: string;
	readonly at: number;
	readonly ok: boolean;
	/** Backend detail (success summary or failure reason). */
	readonly detail: string;
}

let nextHistoryId = 1;

export const FaucetPanel = ({ projection, chain, endpoint, refresh }: PanelProps) => {
	const toast = useToast();
	const queryClient = useQueryClient();

	// Real fundable-coin set from the backend: SUI (fixed-amount) always, plus
	// WAL/DEEP when their plugin registered a funding strategy.
	const coinsQuery = useFundableCoins(endpoint, chain.network);
	const coins = useMemo<ReadonlyArray<FundableCoin>>(
		() => coinsQuery.data ?? [],
		[coinsQuery.data],
	);

	const fundable = useMemo(
		() => projection.accounts.filter((a) => a.address !== null),
		[projection.accounts],
	);

	const [target, setTarget] = useState<string>(() => fundable[0]?.key ?? OTHER);
	const [otherAddress, setOtherAddress] = useState('');
	const [coinType, setCoinType] = useState<string | null>(null);
	const [amount, setAmount] = useState('100');
	const [state, setState] = useState<RequestState>('idle');
	const [history, setHistory] = useState<ReadonlyArray<HistoryEntry>>([]);

	// Default the selected coin to the first fundable one once it loads.
	useEffect(() => {
		if (coinType === null && coins.length > 0) setCoinType(coins[0]!.coinType);
	}, [coinType, coins]);

	const selectedCoin = coins.find((c) => c.coinType === coinType) ?? coins[0] ?? null;

	const usingOther = target === OTHER || fundable.length === 0;
	const recipient = usingOther
		? otherAddress.trim()
		: (fundable.find((a) => a.key === target)?.address ?? '');
	const recipientName = usingOther
		? truncateMiddle(otherAddress.trim())
		: (fundable.find((a) => a.key === target)?.name ?? recipient);

	const recipientValid = HEX_ADDRESS.test(recipient);
	const amountValid = !selectedCoin?.honorsAmount || /^\d+$/.test(amount.trim());
	const canRequest =
		selectedCoin !== null && recipientValid && amountValid && state !== 'requesting';

	const request = async (e: FormEvent) => {
		e.preventDefault();
		if (!canRequest || selectedCoin === null) return;
		setState('requesting');

		// SUI is fixed-amount — send no amount. WAL/DEEP honor the amount.
		const amountBaseUnits = selectedCoin.honorsAmount ? amount.trim() : undefined;
		let result: { ok: boolean; detail: string };
		try {
			result = await fundAccount(endpoint, {
				recipient,
				coinType: selectedCoin.coinType,
				...(amountBaseUnits !== undefined ? { amountBaseUnits } : {}),
			});
		} catch (cause) {
			result = { ok: false, detail: `request failed: ${String(cause)}` };
		}

		setHistory((h) =>
			[
				{
					id: nextHistoryId++,
					coin: selectedCoin.symbol,
					amount: selectedCoin.honorsAmount ? amount.trim() : '—',
					target: recipientName,
					at: Date.now(),
					ok: result.ok,
					detail: result.detail,
				},
				...h,
			].slice(0, HISTORY_CAP),
		);

		if (result.ok) {
			toast.success(`${selectedCoin.symbol} → ${recipientName}`);
			// Refresh the target's balance: the projection funding view + any
			// cached browser-direct balance reads for this network.
			await refresh();
			void queryClient.invalidateQueries({ queryKey: ['chain', chain.network, 'balances'] });
			void queryClient.invalidateQueries({ queryKey: ['chain', chain.network, 'suiBalance'] });
		} else {
			toast.error(result.detail || `${selectedCoin.symbol} request failed`);
		}
		setState('idle');
	};

	if (coinsQuery.isLoading) {
		return (
			<div className="col" style={{ gap: 16 }}>
				<Header />
				<div className="panel">
					<EmptyState icon="drop" title="Loading faucet…" hint="Resolving fundable coins." />
				</div>
			</div>
		);
	}

	if (coins.length === 0) {
		return (
			<div className="col" style={{ gap: 16 }}>
				<Header />
				<div className="panel">
					<EmptyState
						icon="drop"
						title="No fundable coins"
						hint="The running stack has no faucet or funding strategy registered, so requests cannot be dispatched."
					/>
				</div>
			</div>
		);
	}

	const lastFailure = history.find((h) => !h.ok) ?? null;

	return (
		<div className="col" style={{ gap: 16 }}>
			<Header />
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
					gap: 18,
					alignItems: 'start',
				}}
			>
				<form className="panel panel-pad col" style={{ gap: 16 }} onSubmit={request}>
					<div className="col" style={{ gap: 7 }}>
						<span className="eyebrow">Target</span>
						<Select
							value={target}
							onChange={(e: ChangeEvent<HTMLSelectElement>) => setTarget(e.target.value)}
						>
							{fundable.map((a) => (
								<option key={a.key} value={a.key}>
									{a.name} — {truncateMiddle(a.address ?? '')}
								</option>
							))}
							<option value={OTHER}>Other address…</option>
						</Select>
						{usingOther && (
							<Input
								className="mono"
								value={otherAddress}
								onChange={(e: ChangeEvent<HTMLInputElement>) => setOtherAddress(e.target.value)}
								placeholder="0x… recipient address"
								aria-invalid={otherAddress.length > 0 && !recipientValid}
								style={
									otherAddress.length > 0 && !recipientValid
										? { borderColor: 'color-mix(in oklab, var(--c-red) 50%, var(--line))' }
										: undefined
								}
							/>
						)}
						{selectedCoin?.requiresAccountSigner && usingOther && (
							<span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
								{selectedCoin.symbol} funding spends the recipient account's own SUI, so the
								recipient must be a configured account — pasted addresses will be rejected.
							</span>
						)}
					</div>

					<div className="col" style={{ gap: 7 }}>
						<span className="eyebrow">Coin</span>
						<div className="row wrap" style={{ gap: 8 }}>
							{coins.map((c) => {
								const active = c.coinType === selectedCoin?.coinType;
								return (
									<Button
										key={c.coinType}
										type="button"
										sm
										onClick={() => setCoinType(c.coinType)}
										style={
											active
												? {
														borderColor: 'var(--accent)',
														color: 'var(--accent)',
														background: 'var(--accent-soft)',
													}
												: undefined
										}
									>
										<CoinIcon symbol={c.symbol} size={16} /> {c.symbol}
									</Button>
								);
							})}
						</div>
						<span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
							{selectedCoin === null
								? null
								: selectedCoin.honorsAmount
									? `${selectedCoin.symbol} is funded by an on-chain swap from the recipient account's SUI.`
									: 'The Sui faucet dispenses a fixed-amount native SUI grant (amount is not configurable).'}
						</span>
					</div>

					{selectedCoin?.honorsAmount && (
						<div className="col" style={{ gap: 7 }}>
							<span className="eyebrow">Amount (base units)</span>
							<div className="row" style={{ gap: 8 }}>
								<Input
									type="number"
									className="mono"
									value={amount}
									onChange={(e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
									aria-invalid={!amountValid}
									style={{
										width: 140,
										...(amountValid
											? {}
											: { borderColor: 'color-mix(in oklab, var(--c-red) 50%, var(--line))' }),
									}}
								/>
								<div className="row" style={{ gap: 6 }}>
									{QUICK_AMOUNTS.map((v) => (
										<Button key={v} type="button" sm variant="ghost" onClick={() => setAmount(v)}>
											{v}
										</Button>
									))}
								</div>
							</div>
						</div>
					)}

					{lastFailure && state !== 'requesting' && (
						<ErrorBanner detail={lastFailure.detail} onRetry={request} />
					)}

					<Button type="submit" variant="primary" disabled={!canRequest} style={{ height: 38 }}>
						{state === 'requesting' ? (
							<>
								<span className="dot dot-white dot-pulse" /> Requesting…
							</>
						) : (
							<>
								<Icon name="drop" size={15} /> Request {selectedCoin?.symbol ?? 'coin'}
							</>
						)}
					</Button>
				</form>

				<div className="panel" style={{ overflow: 'hidden' }}>
					<div className="panel-pad" style={{ padding: '14px 18px' }}>
						<SectionHead title="Recent requests" count={history.length} />
					</div>
					{history.length === 0 ? (
						<EmptyState
							icon="clock"
							title="No requests yet"
							hint="Dispatched faucet requests from this session appear here with their processed outcome."
						/>
					) : (
						<table className="tbl">
							<thead>
								<tr>
									<th>Coin</th>
									<th>Amount</th>
									<th>Target</th>
									<th>When</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{history.map((h) => (
									<tr key={h.id} title={h.detail}>
										<td className="mono">{h.coin}</td>
										<td className="mono tnum">{h.amount}</td>
										<td>
											<span style={{ color: 'var(--c-magenta)', fontSize: 12.5 }}>{h.target}</span>
										</td>
										<td style={{ color: 'var(--tx-lo)', fontSize: 12 }}>{timeAgo(h.at)} ago</td>
										<td>
											<span className="row" style={{ gap: 6, alignItems: 'center' }}>
												<Dot token={h.ok ? 'green' : 'red'} />
												<span style={{ fontSize: 11, color: 'var(--tx-lo)' }}>
													{h.ok ? 'processed' : 'failed'}
												</span>
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>
		</div>
	);
};

/** Inline error banner carrying the backend failure detail + a retry. */
const ErrorBanner = ({
	detail,
	onRetry,
}: {
	readonly detail: string;
	readonly onRetry: (e: FormEvent) => void | Promise<void>;
}): ReactNode => (
	<div
		className="panel panel-pad col"
		style={{
			gap: 6,
			borderColor: 'color-mix(in oklab, var(--c-red) 36%, var(--line))',
			background: 'color-mix(in oklab, var(--c-red) 7%, var(--bg-elev))',
		}}
	>
		<div className="row between">
			<span className="row" style={{ gap: 8 }}>
				<Icon name="alert" size={14} style={{ color: 'var(--c-red)' }} />
				<span style={{ fontWeight: 560, fontSize: 13, color: 'var(--c-red)' }}>Request failed</span>
			</span>
			<Button type="button" sm variant="ghost" onClick={(e) => void onRetry(e as FormEvent)}>
				<Icon name="refresh" size={13} /> Retry
			</Button>
		</div>
		<span style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>{detail}</span>
	</div>
);

const Header = () => (
	<div>
		<h2 style={{ fontSize: 19 }}>Faucet</h2>
		<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
			Dispense test coins to any configured account or a pasted address — processed in-process by
			the stack's funding strategies.
		</p>
	</div>
);
