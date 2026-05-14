// Small, allocation-free Sui transaction utilities that recurred verbatim
// across example configs. Lives under `primitives/` so user configs can pull
// them from the package root without reaching into `publish-move`.

import type { SuiObjectChange } from './shared.js';

/**
 * Find a created object in a transaction's `objectChanges` whose Move type
 * ends with the given suffix. Returns the `objectId`, or `undefined` if no
 * match.
 *
 * Use this when the package id is unknown at config-write time but the
 * trailing `::module::Type` is stable.
 *
 * @example
 * ```ts
 * const lobbyId = pickCreatedByTypeSuffix(result.objectChanges, '::game::Lobby');
 * ```
 */
export const pickCreatedByTypeSuffix = (
	changes: ReadonlyArray<SuiObjectChange>,
	suffix: string,
): string | undefined => {
	for (const c of changes) {
		if (
			c.type === 'created' &&
			'objectType' in c &&
			typeof c.objectType === 'string' &&
			c.objectType.endsWith(suffix)
		) {
			return c.objectId;
		}
	}
	return undefined;
};

/**
 * Find a created object whose Move type contains the given substring. Useful
 * for generic types where the type-parameter list lives after a recognisable
 * head — `pickCreatedByTypeIncludes(changes, '::coin::TreasuryCap<')` matches
 * any `TreasuryCap<...>` without having to spell out the inner type.
 */
export const pickCreatedByTypeIncludes = (
	changes: ReadonlyArray<SuiObjectChange>,
	needle: string,
): string | undefined => {
	for (const c of changes) {
		if (
			c.type === 'created' &&
			'objectType' in c &&
			typeof c.objectType === 'string' &&
			c.objectType.includes(needle)
		) {
			return c.objectId;
		}
	}
	return undefined;
};
