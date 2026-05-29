// Faucet panel — request test SUI for any configured account or a pasted
// address. The request POSTs directly to the local faucet's gas endpoint
// (discovered from the projection's endpoint registry), not the GraphQL API.
//
// Honest scope: the only browser-reachable faucet is the Sui HTTP faucet's
// fixed-amount `/v2/gas` grant, which dispenses native SUI only and ignores the
// requested amount. WAL/DEEP are not browser-POSTable — WAL is acquired by
// swapping SUI through the walrus exchange object, DEEP via deepbook seeding —
// so their coin pills only appear when those plugins are present and, when
// selected, surface an honest "routed via <plugin>" note instead of a request
// that would 4xx. "Recent requests" is local session state (no server history).

import {
	type ChangeEvent,
	type FormEvent,
	type ReactNode,
	useMemo,
	useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PanelProps } from './types.ts';
import type { Endpoint, Projection } from '../lib/types.ts';
import { timeAgo, truncateMiddle } from '../lib/format.ts';
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

type RequestState = 'idle' | 'requesting' | 'success';

/** Why a request couldn't go through — drives the inline error banner + retry. */
type RequestError =
	| { readonly kind: 'exhausted'; readonly message: string }
	| { readonly kind: 'unreachable'; readonly message: string }
	| { readonly kind: 'body'; readonly message: string };

interface HistoryEntry {
	readonly id: number;
	readonly coin: string;
	readonly amount: string;
	readonly target: string;
	readonly at: number;
	readonly ok: boolean;
}

/** A selectable coin pill: SUI is browser-dispatchable; WAL/DEEP are plugin-gated. */
interface CoinOption {
	readonly symbol: string;
	/** True only for coins this panel can POST browser-direct (SUI). */
	readonly dispatchable: boolean;
	/** When non-dispatchable, an honest note about how it's actually acquired. */
	readonly note?: string;
}

/**
 * The canonical Sui HTTP faucet path is `/v2/gas`; older endpoints answered at
 * `/gas`. We normalise any already-suffixed base back to its root, then append
 * the modern path so discovery is correct regardless of how the URL was
 * registered (the projection registers the bare base URL).
 */
const gasUrl = (base: string): string => `${base.replace(/\/(v\d+\/)?gas\/?$/, '')}/v2/gas`;

const findFaucetEndpoint = (endpoints: ReadonlyArray<Endpoint>): Endpoint | null =>
	endpoints.find((e) => e.name.toLowerCase() === 'faucet') ??
	endpoints.find((e) => /faucet/i.test(e.name)) ??
	null;

/** True when any row/endpoint in the projection belongs to the named plugin. */
const hasPlugin = (projection: Projection, needle: string): boolean => {
	const re = new RegExp(needle, 'i');
	return (
		projection.rows.some((r) => re.test(r.key)) ||
		projection.endpoints.some((e) => re.test(e.pluginKey) || re.test(e.name))
	);
};

/**
 * The faucet-enabled coin set: SUI is always dispatchable; WAL/DEEP only appear
 * when their plugins are present, and are flagged non-dispatchable with an
 * honest note (no browser-POSTable faucet exists for them).
 */
const faucetCoins = (projection: Projection): ReadonlyArray<CoinOption> => {
	const coins: CoinOption[] = [{ symbol: 'SUI', dispatchable: true }];
	if (hasPlugin(projection, 'walrus'))
		coins.push({
			symbol: 'WAL',
			dispatchable: false,
			note: 'WAL is acquired by swapping SUI through the walrus exchange — not a browser faucet. Request SUI here, then exchange.',
		});
	if (hasPlugin(projection, 'deepbook'))
		coins.push({
			symbol: 'DEEP',
			dispatchable: false,
			note: 'DEEP is seeded by the deepbook plugin during boot — there is no browser-direct DEEP faucet.',
		});
	return coins;
};

let nextHistoryId = 1;

export const FaucetPanel = ({ projection, chain, refresh }: PanelProps) => {
	const toast = useToast();
	const queryClient = useQueryClient();
	const faucet = useMemo(() => findFaucetEndpoint(projection.endpoints), [projection.endpoints]);
	const coins = useMemo(() => faucetCoins(projection), [projection]);

	const fundable = useMemo(
		() => projection.accounts.filter((a) => a.address !== null),
		[projection.accounts],
	);

	const [target, setTarget] = useState<string>(() => fundable[0]?.key ?? OTHER);
	const [otherAddress, setOtherAddress] = useState('');
	const [coin, setCoin] = useState('SUI');
	const [amount, setAmount] = useState('100');
	const [state, setState] = useState<RequestState>('idle');
	const [error, setError] = useState<RequestError | null>(null);
	const [history, setHistory] = useState<ReadonlyArray<HistoryEntry>>([]);

	const selectedCoin = coins.find((c) => c.symbol === coin) ?? coins[0];

	const usingOther = target === OTHER || fundable.length === 0;
	const recipient = usingOther
		? otherAddress.trim()
		: (fundable.find((a) => a.key === target)?.address ?? '');
	const recipientName = usingOther
		? truncateMiddle(otherAddress.trim())
		: (fundable.find((a) => a.key === target)?.name ?? recipient);

	const recipientValid = HEX_ADDRESS.test(recipient);
	const canRequest =
		faucet !== null &&
		recipientValid &&
		selectedCoin.dispatchable &&
		state !== 'requesting';

	const request = async (e: FormEvent) => {
		e.preventDefault();
		if (!canRequest || !faucet) return;
		setState('requesting');
		setError(null);

		const url = gasUrl(faucet.url);
		let ok = false;
		let nextError: RequestError | null = null;
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ FixedAmountRequest: { recipient } }),
			});
			if (res.ok) {
				ok = true;
			} else if (res.status === 429) {
				nextError = {
					kind: 'exhausted',
					message: 'Faucet exhausted or rate-limited (429) — wait a moment, then retry.',
				};
			} else {
				const detail = await res.text().catch(() => '');
				nextError = {
					kind: 'body',
					message: `Faucet returned HTTP ${res.status}${detail ? ` — ${detail.slice(0, 140)}` : ''}`,
				};
			}
		} catch {
			nextError = {
				kind: 'unreachable',
				message: `Faucet unreachable at ${url} — is the stack running?`,
			};
		}

		setHistory((h) =>
			[
				{ id: nextHistoryId++, coin, amount, target: recipientName, at: Date.now(), ok },
				...h,
			].slice(0, HISTORY_CAP),
		);

		if (ok) {
			toast.success(`Dispensed SUI → ${recipientName}`);
			setState('success');
			// Nudge a balance refresh: the projection funding view + any cached
			// browser-direct balance reads for this network.
			await refresh();
			void queryClient.invalidateQueries({ queryKey: ['chain', chain.network, 'balances'] });
			void queryClient.invalidateQueries({ queryKey: ['chain', chain.network, 'suiBalance'] });
			window.setTimeout(() => setState('idle'), 1600);
		} else {
			toast.error(nextError?.message ?? 'Faucet request failed');
			setError(nextError);
			setState('idle');
		}
	};

	if (!faucet) {
		return (
			<div className="col" style={{ gap: 16 }}>
				<Header />
				<div className="panel">
					<EmptyState
						icon="drop"
						title="No faucet endpoint"
						hint="The running stack does not expose a faucet endpoint, so requests cannot be dispatched."
					/>
				</div>
			</div>
		);
	}

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
					</div>

					<div className="col" style={{ gap: 7 }}>
						<span className="eyebrow">Coin</span>
						<div className="row wrap" style={{ gap: 8 }}>
							{coins.map((c) => {
								const active = c.symbol === coin;
								return (
									<Button
										key={c.symbol}
										type="button"
										sm
										onClick={() => {
											setCoin(c.symbol);
											setError(null);
										}}
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
							{selectedCoin.dispatchable
								? 'The local faucet dispenses a fixed-amount native SUI grant.'
								: selectedCoin.note}
						</span>
					</div>

					<div className="col" style={{ gap: 7 }}>
						<span className="eyebrow">Amount</span>
						<div className="row" style={{ gap: 8 }}>
							<Input
								type="number"
								className="mono"
								value={amount}
								onChange={(e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
								style={{ width: 140 }}
							/>
							<div className="row" style={{ gap: 6 }}>
								{QUICK_AMOUNTS.map((v) => (
									<Button key={v} type="button" sm variant="ghost" onClick={() => setAmount(v)}>
										{v}
									</Button>
								))}
							</div>
						</div>
						<span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
							The Sui faucet is fixed-amount — this value is informational.
						</span>
					</div>

					{error && (
						<ErrorBanner error={error} onRetry={state === 'requesting' ? undefined : request} />
					)}

					<Button
						type="submit"
						variant="primary"
						disabled={!canRequest}
						style={{ height: 38 }}
					>
						{state === 'requesting' ? (
							<>
								<span className="dot dot-white dot-pulse" /> Requesting…
							</>
						) : state === 'success' ? (
							<>
								<Icon name="check" size={15} /> Dispensed
							</>
						) : selectedCoin.dispatchable ? (
							<>
								<Icon name="drop" size={15} /> Request {selectedCoin.symbol}
							</>
						) : (
							<>
								<Icon name="drop" size={15} /> {selectedCoin.symbol} not browser-dispatchable
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
							hint="Dispatched faucet requests from this session appear here."
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
									<tr key={h.id}>
										<td className="mono">{h.coin}</td>
										<td className="mono tnum">{h.amount}</td>
										<td>
											<span style={{ color: 'var(--c-magenta)', fontSize: 12.5 }}>{h.target}</span>
										</td>
										<td style={{ color: 'var(--tx-lo)', fontSize: 12 }}>{timeAgo(h.at)} ago</td>
										<td>
											<Dot token={h.ok ? 'green' : 'red'} />
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

/** Per-design inline error banner with a retry affordance. */
const ErrorBanner = ({
	error,
	onRetry,
}: {
	readonly error: RequestError;
	readonly onRetry?: (e: FormEvent) => void | Promise<void>;
}): ReactNode => {
	const label =
		error.kind === 'exhausted'
			? 'Faucet exhausted'
			: error.kind === 'unreachable'
				? 'Faucet unreachable'
				: 'Faucet error';
	return (
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
					<span style={{ fontWeight: 560, fontSize: 13, color: 'var(--c-red)' }}>{label}</span>
				</span>
				{onRetry && (
					<Button type="button" sm variant="ghost" onClick={(e) => void onRetry(e as FormEvent)}>
						<Icon name="refresh" size={13} /> Retry
					</Button>
				)}
			</div>
			<span style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>{error.message}</span>
		</div>
	);
};

const Header = () => (
	<div>
		<h2 style={{ fontSize: 19 }}>Faucet</h2>
		<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
			Dispense test SUI to any configured account or a pasted address.
		</p>
	</div>
);
