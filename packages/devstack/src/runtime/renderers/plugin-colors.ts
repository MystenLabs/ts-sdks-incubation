// Plugin → identity color. Sequential-by-encounter assignment over a
// curated palette so every plugin gets a distinct color until the
// palette wraps. Hashing was the natural reach but landed multiple
// 7-plugin apps on the same bucket — sequential gives 9 distinct
// identities before the first collision.
//
// `supervisor` is a special role (system messages, not a plugin) and
// stays uncolored (default fg) so it doesn't compete with plugin
// identities.

import type { Color } from '../ansi.js';

export type InkColor =
	| 'red'
	| 'green'
	| 'yellow'
	| 'blue'
	| 'magenta'
	| 'cyan'
	| 'gray'
	| 'redBright'
	| 'greenBright'
	| 'yellowBright'
	| 'blueBright'
	| 'magentaBright'
	| 'cyanBright';

/** 9-slot palette. Skips red (reserved for `failed`) and green
 * (reserved for `healthy`) so plugin identity never visually
 * collides with status semantics. Brights come after the bases so
 * the most-used plugins land on the most-distinct colors. */
const PALETTE_INK: InkColor[] = [
	'cyan',
	'magenta',
	'yellow',
	'blue',
	'cyanBright',
	'magentaBright',
	'yellowBright',
	'blueBright',
];

/** ANSI mirror of the ink palette for the plain renderer. */
const PALETTE_ANSI: Color[] = [
	'cyan',
	'magenta',
	'yellow',
	'blue',
	'brightCyan',
	'brightMagenta',
	// no brightYellow in the ANSI module; reuse yellow at the wrap
	// (keeps the two renderers in lockstep up through index 5).
	'yellow',
	'brightBlue',
];

/** Build a stable plugin → color map from a plugin-encounter order.
 * Callers pass the deduplicated list of plugins in the order they
 * first appear — actions list at supervisor start, plus any plugin
 * that later registers a service or logs a line. Returning a map
 * (rather than recomputing per-row) keeps lookups O(1) in the hot
 * render path. */
export function buildPluginColorMap(pluginsInOrder: string[]): {
	ink: Map<string, InkColor>;
	ansi: Map<string, Color>;
} {
	const ink = new Map<string, InkColor>();
	const ansi = new Map<string, Color>();
	let i = 0;
	for (const p of pluginsInOrder) {
		if (ink.has(p)) continue;
		if (p === 'supervisor') {
			ink.set(p, 'gray');
			ansi.set(p, 'gray');
			continue;
		}
		ink.set(p, PALETTE_INK[i % PALETTE_INK.length]!);
		ansi.set(p, PALETTE_ANSI[i % PALETTE_ANSI.length]!);
		i++;
	}
	return { ink, ansi };
}
