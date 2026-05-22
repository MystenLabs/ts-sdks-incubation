// Trivial leaf plugin sample.
//
// A minimal `definePlugin` + one capability demonstration. The plugin
// name `keyval` is deliberately fictitious — no L2 service name leaks
// into the substrate; samples must read as generic to prove the
// substrate is name-free.

import { Effect } from 'effect';

import { definePlugin, resource } from '../api/define-plugin.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';
import type { ProvidesWitness } from '../substrate/witness.ts';

/** The plugin's resolved-value shape. Plugin authors define their
 *  own; the substrate treats them opaquely.
 *
 *  Provides the `'keyval-local'` witness — the composite sample's
 *  `RequiresWitness<'keyval-local'>` is satisfied when this plugin is
 *  a stack member. */
export interface KeyvalClient extends ProvidesWitness<'keyval-local'> {
	readonly endpoint: string;
	readonly ping: () => Effect.Effect<void>;
}

/** Resource identifying the keyval plugin's resolved value. */
export const KeyvalResource = resource<'keyval', KeyvalClient>('keyval');

/** Strategy capability key for the keyval ping gate — used by the
 *  composite sample to demonstrate strategy lookups across plugins
 *  without an explicit dep edge. */
export const KEYVAL_PING_GATE = 'gate:keyval-ping' as const;

/** Per-plugin strategy value shape. */
export interface KeyvalPingGateStrategy {
	readonly waitPingable: Effect.Effect<void>;
}

/** Plugin factory. Returns a plugin resource ref with one static capability. */
export function keyval() {
	const pingGate: StrategyContributorDecl<typeof KEYVAL_PING_GATE, KeyvalPingGateStrategy> = {
		kind: 'strategy-contributor',
		capabilityKey: KEYVAL_PING_GATE,
		strategy: { waitPingable: Effect.void },
		autoMounted: true,
	};

	return definePlugin({
		id: KeyvalResource.id,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		start: () =>
			Effect.sync<KeyvalClient>(() => {
				throw new Error('keyval.start: not implemented yet (Phase 4)');
			}),
		capabilities: [pingGate] as const,
	});
}
