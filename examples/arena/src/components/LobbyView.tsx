import { Transaction } from '@mysten/sui/transactions';
import { Card } from '../ui/Card.js';
import { useState } from 'react';

import { deployment } from '../lib/deployment.js';
import * as connectFour from '../generated/bindings/connect_four/game.js';
import { labelFor, shortAddress } from '../lib/format.js';
import { type ArenaLobby, useSignAndExecute } from '../lib/queries.js';

interface LobbyViewProps {
	lobby: ArenaLobby;
	self: string;
}

export function LobbyView({ lobby, self }: LobbyViewProps) {
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['arena']],
	});
	const [error, setError] = useState<string | null>(null);

	const isCreator = lobby.creator === self;
	const creatorLabel = labelFor(lobby.creator, deployment.accounts) ?? shortAddress(lobby.creator);

	async function onJoin() {
		setError(null);
		try {
			const tx = new Transaction();
			tx.add(connectFour.joinLobby({ arguments: [lobby.id] }));
			await mutateAsync(tx);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	if (isCreator) {
		return (
			<Card title="Open lobby" subtitle="Waiting for an opponent to join">
				<p className="text-sm text-neutral-500" data-testid="waiting">
					You opened this lobby ({shortAddress(lobby.id)}). Switch to the other dev wallet in
					another browser tab to join.
				</p>
			</Card>
		);
	}
	return (
		<Card
			title="Open lobby"
			subtitle={`${creatorLabel} is waiting for a challenger`}
			right={
				<span className="text-xs font-mono text-neutral-500" data-testid="lobby-id">
					{shortAddress(lobby.id)}
				</span>
			}
		>
			<button
				type="button"
				onClick={onJoin}
				data-testid="join-lobby"
				disabled={isPending}
				className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
			>
				{isPending ? 'Joining…' : 'Join lobby'}
			</button>
			{error && (
				<p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="join-error">
					{error}
				</p>
			)}
		</Card>
	);
}
