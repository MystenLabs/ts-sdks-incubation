// Cycle-phase → semantic color token. Mirrors the design handoff's
// `PHASE_TOKEN`, narrowed to the real `CyclePhase` union.

import type { StatusToken } from '../lib/derive.ts';
import type { CyclePhase } from '../lib/types.ts';

const PHASE_TOKEN: Record<CyclePhase, StatusToken> = {
	booting: 'cyan',
	running: 'green',
	restarting: 'yellow',
	'shutting-down': 'red',
};

export const phaseToken = (phase: CyclePhase): StatusToken => PHASE_TOKEN[phase];
