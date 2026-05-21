// Trivial leaf plugin sample.
//
// A minimal `definePlugin` + one capability demonstration. The plugin
// name `keyval` is deliberately fictitious — no L2 service name leaks
// into the substrate; samples must read as generic to prove the
// substrate is name-free.

import { Effect } from 'effect';

import { capabilities } from '../api/define-capabilities.ts';
import { defineNodePlugin } from '../api/define-plugin.ts';
import { defineTag } from '../api/tag.ts';
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

/** Tag identifying the keyval plugin's resolved value. Built once at
 *  the plugin's barrel. */
export const KeyvalTag = defineTag<'keyval', KeyvalClient>('keyval', 'keyval');

/** Strategy capability key for the keyval ping gate — used by the
 *  composite sample to demonstrate strategy lookups across plugins
 *  without an explicit dep edge. */
export const KEYVAL_PING_GATE = 'gate:keyval-ping' as const;

/** Per-plugin strategy value shape. */
export interface KeyvalPingGateStrategy {
	readonly waitPingable: Effect.Effect<void>;
}

/** Plugin factory. Returns a `StackMember` whose generics are narrow:
 *  the tag, the (empty) consumes tuple, and the single-cap tuple. */
export function keyval() {
	const pingGate: StrategyContributorDecl<typeof KEYVAL_PING_GATE, KeyvalPingGateStrategy> = {
		kind: 'strategy-contributor',
		capabilityKey: KEYVAL_PING_GATE,
		strategy: { waitPingable: Effect.void },
		autoMounted: true,
	};

	return defineNodePlugin({
		provides: KeyvalTag,
		consumes: [] as const,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		acquire: () =>
			Effect.sync<KeyvalClient>(() => {
				throw new Error('keyval.acquire: not implemented yet (Phase 4)');
			}),
		capabilities: capabilities(pingGate),
	});
}
