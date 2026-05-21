// Heartbeat indicator.
//
// Distilled/21-tui § Invariants: "Frame stability: rendering must
// short-circuit when nothing has changed." The heartbeat indicator
// gives the operator a visible signal that the renderer is alive
// even when the projection isn't ticking — without re-rendering the
// whole tree. It's a single character that cycles through a small
// alphabet on a clock; the dashboard places it in the header.
//
// We use `useEffect` + `setInterval` so the heartbeat doesn't depend
// on the projection at all. When the projection IS ticking, frames
// are driven by the SubscriptionRef subscription; the heartbeat
// continues to spin to give long-quiet-stack feedback.

import { Text } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';

import type { ColorToken } from './display-derivation.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export interface HeartbeatProps {
	/** Tick interval in ms. Default 120ms. */
	readonly intervalMs?: number;
	/** Color token. Default 'gray'. */
	readonly color?: ColorToken;
}

export const Heartbeat = ({
	intervalMs = 120,
	color = 'gray',
}: HeartbeatProps): React.JSX.Element => {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const id = setInterval(() => {
			setFrame((f) => (f + 1) % FRAMES.length);
		}, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return <Text color={color}>{FRAMES[frame]}</Text>;
};
