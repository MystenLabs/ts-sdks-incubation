// Faucet panel — request test SUI for any configured account or a pasted
// address. The request POSTs directly to the local faucet's gas endpoint
// (discovered from the projection's endpoint registry), not the GraphQL API.
//
// Honest scope: the local devstack faucet is fixed-amount and dispenses native
// SUI only — the projection exposes no coin registry. So the coin selector
// shows a single SUI pill and the amount quick-chips are informational. "Recent
// requests" is local session state (no server-side history feed).

import { type ChangeEvent, type FormEvent, useMemo, useState } from 'react';
import type { PanelProps } from './types.ts';
import type { Endpoint } from '../lib/types.ts';
import { timeAgo, truncateMiddle } from '../lib/format.ts';
import { useToast } from '../lib/toast.tsx';
import { Button, Dot, EmptyState, Icon, Input, SectionHead, Select } from '../ui/index.ts';

const OTHER = '__other__';
const HEX_ADDRESS = /^0x[0-9a-fA-F]+$/;
const HISTORY_CAP = 20;

type RequestState = 'idle' | 'requesting' | 'success';

interface HistoryEntry {
	readonly id: number;
	readonly coin: string;
	readonly amount: string;
	readonly target: string;
	readonly at: number;
	readonly ok: boolean;
}

/** Build the gas request URL from a faucet endpoint base, per the task spec. */
const gasUrl = (base: string): string => `${base.replace(/\/(v2\/)?gas\/?$/, '')}/gas`;

const findFaucetEndpoint = (endpoints: ReadonlyArray<Endpoint>): Endpoint | null =>
	endpoints.find((e) => /faucet/i.test(e.name)) ?? null;

let nextHistoryId = 1;

export const FaucetPanel = ({ projection, refresh }: PanelProps) => {
	const toast = useToast();
	const faucet = useMemo(() => findFaucetEndpoint(projection.endpoints), [projection.endpoints]);

	const fundable = useMemo(
		() => projection.accounts.filter((a) => a.address !== null),
		[projection.accounts],
	);

	const [target, setTarget] = useState<string>(() => fundable[0]?.key ?? OTHER);
	const [otherAddress, setOtherAddress] = useState('');
	const [amount, setAmount] = useState('100');
	const [state, setState] = useState<RequestState>('idle');
	const [history, setHistory] = useState<ReadonlyArray<HistoryEntry>>([]);

	const usingOther = target === OTHER || fundable.length === 0;
	const recipient = usingOther
		? otherAddress.trim()
		: (fundable.find((a) => a.key === target)?.address ?? '');
	const recipientName = usingOther
		? truncateMiddle(otherAddress.trim())
		: (fundable.find((a) => a.key === target)?.name ?? recipient);

	const recipientValid = HEX_ADDRESS.test(recipient);

	const request = async (e: FormEvent) => {
		e.preventDefault();
		if (!faucet || !recipientValid || state === 'requesting') return;
		setState('requesting');

		let ok = false;
		let message = `Dispensed SUI → ${recipientName}`;
		try {
			const res = await fetch(gasUrl(faucet.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ FixedAmountRequest: { recipient } }),
			});
			if (res.ok) {
				ok = true;
			} else if (res.status === 429) {
				message = 'Faucet rate-limited (429) — wait before requesting again';
			} else {
				message = `Faucet returned HTTP ${res.status}`;
			}
		} catch {
			message = `Faucet unreachable at ${gasUrl(faucet.url)}`;
		}

		setHistory((h) =>
			[
				{ id: nextHistoryId++, coin: 'SUI', amount, target: recipientName, at: Date.now(), ok },
				...h,
			].slice(0, HISTORY_CAP),
		);

		if (ok) {
			toast.success(message);
			setState('success');
			await refresh();
			window.setTimeout(() => setState('idle'), 1600);
		} else {
			toast.error(message);
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
							<Button
								type="button"
								sm
								style={{
									borderColor: 'var(--accent)',
									color: 'var(--accent)',
									background: 'var(--accent-soft)',
								}}
							>
								<span className="mono">◎</span> SUI
							</Button>
						</div>
						<span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
							SUI only — other coins need the coin plugin's registry.
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
								{['1', '10', '100'].map((v) => (
									<Button key={v} type="button" sm variant="ghost" onClick={() => setAmount(v)}>
										{v}
									</Button>
								))}
							</div>
						</div>
						<span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>
							The local faucet is fixed-amount — this value is informational.
						</span>
					</div>

					<Button
						type="submit"
						variant="primary"
						disabled={state === 'requesting' || !recipientValid}
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
						) : (
							<>
								<Icon name="drop" size={15} /> Request SUI
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

const Header = () => (
	<div>
		<h2 style={{ fontSize: 19 }}>Faucet</h2>
		<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
			Dispense test SUI to any configured account or a pasted address.
		</p>
	</div>
);
