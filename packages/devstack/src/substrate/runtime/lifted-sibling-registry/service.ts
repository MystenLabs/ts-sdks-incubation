// Lifted-sibling registry implementation.
//
// In-memory, per-stack. Architecture § lifted-sibling dedup:
// identical `(plugin, kind, scope, inputHash)` is first-wins; same
// `(plugin, kind, scope)` with a different `inputHash` is REFUSED.
//
// Compile-time refusal for the literal-hash regime lives in
// `substrate/lifted-sibling.ts`. The runtime refusal here is
// defense-in-depth for the runtime-computed-hash regime (e.g. SHA
// of a Move.toml read at acquire time), and is also the only
// enforcement path for composites assembled dynamically.

import { Context, Effect, Layer, Ref } from 'effect';

import type {
	LiftedSiblingRegistration,
	LiftedSiblingRegistry,
} from '../../../primitives/lifted-sibling.ts';
import type { LiftedSiblingKey } from '../../lifted-sibling.ts';
import type { AnyPlugin } from '../../plugin.ts';

/** Group key — the dedup discriminator. Two keys with the same
 *  group dedup if hashes match, conflict if they don't. */
const groupKeyOf = (key: LiftedSiblingKey): string => `${key.plugin}|${key.kind}|${key.scope}`;

/** In-memory entry. Holds the original key (for `list`), the
 *  member that registered it, and the hash for conflict detection. */
interface Entry {
	readonly key: LiftedSiblingKey;
	readonly member: AnyPlugin;
	readonly hash: string;
}

/** The state shape — group key → first-winning entry. */
type State = ReadonlyMap<string, Entry>;

export class LiftedSiblingRegistryService extends Context.Service<
	LiftedSiblingRegistryService,
	LiftedSiblingRegistry
>()('@devstack-rewrite/substrate/LiftedSiblingRegistry') {}

/**
 * Layer. Scope-local: one registry per stack scope; parallel stacks
 * NEVER share, satisfying the architecture's "scope-local, never
 * module-level" rule.
 */
export const layerLiftedSiblingRegistry: Layer.Layer<LiftedSiblingRegistryService> = Layer.effect(
	LiftedSiblingRegistryService,
	Effect.gen(function* () {
		const state = yield* Ref.make<State>(new Map());

		const register: LiftedSiblingRegistry['register'] = (key, factory) =>
			Effect.gen(function* () {
				const group = groupKeyOf(key);
				const hash = key.inputHash as unknown as string;
				const result = yield* Ref.modify<State, LiftedSiblingRegistration>(state, (current) => {
					const existing = current.get(group);
					if (!existing) {
						const next = new Map(current);
						next.set(group, { key, member: factory, hash });
						return [{ result: 'registered', member: factory }, next];
					}
					if (existing.hash === hash) {
						// First-wins dedup. Architecture
						// promises the new member is dropped and
						// the existing resolved value is reused.
						return [{ result: 'deduped', existing: existing.member }, current];
					}
					// Conflict: same group, different hash.
					// Caller surfaces as a typed error via the
					// `LiftedSiblingConflict` shape.
					return [
						{
							result: 'conflict',
							conflict: {
								_tag: 'LiftedSiblingConflict',
								groupKey: group,
								existingHash: existing.hash,
								attemptedHash: hash,
							},
						},
						current,
					];
				});
				return result;
			}).pipe(
				Effect.withSpan('substrate.liftedSibling.register', {
					attributes: {
						plugin: key.plugin,
						kind: key.kind,
						scope: key.scope,
					},
				}),
			);

		const list: LiftedSiblingRegistry['list'] = () =>
			Effect.gen(function* () {
				const current = yield* Ref.get(state);
				const out: LiftedSiblingKey[] = [];
				for (const entry of current.values()) out.push(entry.key);
				return out;
			});

		return LiftedSiblingRegistryService.of({ register, list });
	}),
);
