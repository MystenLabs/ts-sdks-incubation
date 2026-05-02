import { Transaction } from '@mysten/sui/transactions';
import { useState } from 'react';

import { deployment } from '../generated/deployment.js';
import * as connectFour from '../generated/sui/connect_four/game.js';
import { labelFor, shortAddress } from '../lib/format.js';
import { type ArenaGame, COLS, ROWS, useGame, useSignAndExecute } from '../lib/queries.js';
import { Board } from './Board.js';
import { Card } from './Card.js';

interface GameViewProps {
	gameId: string;
	self: string;
}

export function GameView({ gameId, self }: GameViewProps) {
	const game = useGame(gameId);
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['arena']],
	});
	const [error, setError] = useState<string | null>(null);

	if (game.isLoading) {
		return (
			<Card title="Game" subtitle="Loading…">
				<p className="text-sm text-neutral-500">Fetching game state…</p>
			</Card>
		);
	}
	const g = game.data;
	if (!g) {
		return (
			<Card title="Game" subtitle="Not found">
				<p className="text-sm text-neutral-500 font-mono break-all">{gameId}</p>
			</Card>
		);
	}

	const status = describeStatus(g, self, deployment.accounts);

	async function onDrop(column: number) {
		setError(null);
		try {
			const tx = new Transaction();
			connectFour.play({ arguments: [gameId, column] })(tx);
			await mutateAsync(tx);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<Card
			title="Connect Four"
			subtitle={status.label}
			right={
				<span className="text-xs text-neutral-500" data-testid="game-status">
					{status.right}
				</span>
			}
		>
			<Board game={g} self={self} onDrop={onDrop} disabled={isPending} />
			<div className="mt-3 grid grid-cols-2 gap-2 text-xs">
				<PlayerCell
					color="bg-rose-500"
					name={labelFor(g.playerA, deployment.accounts)}
					addr={g.playerA}
				/>
				<PlayerCell
					color="bg-amber-400"
					name={labelFor(g.playerB, deployment.accounts)}
					addr={g.playerB}
				/>
			</div>
			{error && (
				<p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="play-error">
					{error}
				</p>
			)}
		</Card>
	);
}

function PlayerCell({ color, name, addr }: { color: string; name: string | null; addr: string }) {
	return (
		<div className="flex items-center gap-2">
			<span className={`w-3 h-3 rounded-full ${color}`} />
			<span className="font-medium capitalize">{name ?? 'unknown'}</span>
			<span className="font-mono text-neutral-500">{shortAddress(addr)}</span>
		</div>
	);
}

function describeStatus(
	g: ArenaGame,
	self: string,
	accounts: Record<string, string>,
): { label: string; right: string } {
	if (g.winner) {
		const who = labelFor(g.winner, accounts) ?? shortAddress(g.winner);
		const verdict = g.winner === self ? 'you won' : `${who} wins`;
		return { label: `Game over — ${verdict}`, right: `${g.moves}/${COLS * ROWS} moves` };
	}
	if (g.moves >= COLS * ROWS) {
		return { label: 'Game over — draw', right: `${g.moves}/${COLS * ROWS} moves` };
	}
	const turnLabel =
		g.turn === self ? 'your turn' : `${labelFor(g.turn, accounts) ?? 'opponent'} thinking`;
	return { label: turnLabel, right: `${g.moves}/${COLS * ROWS} moves` };
}
