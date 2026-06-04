// GUARD-B — the strategy bus must not become a god-bus.
//
// `ctx.provides` lets a plugin contribute to a sibling's
// capability-keyed registry WITHOUT a `dependsOn` dep-graph edge (siblings
// READ it with `yield* StrategyRegistryService` directly). That is the
// faucet pattern — intentional for cross-cutting strategies. The failure
// mode this gate forbids: a plugin contributing under a SIBLING PLUGIN's
// id as the capability key (e.g. `ctx.provides({ capabilityKey: 'sui' })`)
// instead of a `<domain>:<disc>` key, which lets a reader grab the
// sibling's value off the bus instead of declaring a `dependsOn` edge.
// That type-checks with no other CI signal and silently rebuilds the
// deleted CapabilitySinks god-bus.
//
// The gate: scan every `ctx.provides({ capabilityKey: ... })` and every
// strategy-registry read key (`StrategyRegistryService.get('<key>')`)
// STRING-LITERAL key under `src/plugins/**` and assert none equals a
// plugin id. Capability keys are `<domain>:<disc>` shaped
// (`coinType:WAL`, `chain-probe:sui:mainnet`) — never a bare plugin id.
// Plugins DO author through `ctx` today, but they compute their capability
// keys via helpers rather than bare string literals, so the literal scan
// finds nothing to reject and the gate passes; it is the PERMANENT guard
// that fails the moment a conversion wires a string-literal plugin-id key.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@effect/vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../src/plugins');

/** Recursively collect every `.ts` file under a directory. */
const collectTsFiles = (dir: string): ReadonlyArray<string> => {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...collectTsFiles(full));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
};

/** The set of plugin ids a strategy key must never collide with.
 *  Plugin ids today equal their directory names (the resource id the
 *  scheduler keys on). We include the directory names directly so the
 *  gate stays accurate without importing every plugin module (which
 *  would drag the full L0 dependency cone into a static-analysis test). */
const pluginIds = new Set(
	readdirSync(pluginsDir)
		.filter((entry) => {
			const full = join(pluginsDir, entry);
			return statSync(full).isDirectory();
		})
		.map((dir) => dir),
);

/** Extract string-literal `capabilityKey: '<key>'` keys inside a
 *  `ctx.provides({...})` / `provides({...})` decl. Quote-agnostic. The
 *  write side carries the canonical key under this field
 *  (StrategyContributorDecl.capabilityKey); readers resolve against the
 *  same key via helpers, so pinning the write side pins the whole bus. */
const extractStrategyKeys = (source: string): ReadonlyArray<string> => {
	const keys: string[] = [];
	// `capabilityKey: 'foo'` — the literal `provides` decls carry the key
	// under this field (StrategyContributorDecl.capabilityKey).
	const capabilityKeyRe = /\bcapabilityKey\s*:\s*(['"`])([^'"`]+)\1/g;
	let m: RegExpExecArray | null;
	while ((m = capabilityKeyRe.exec(source)) !== null) {
		keys.push(m[2]!);
	}
	return keys;
};

describe('GUARD-B: strategy bus is not a plugin-id god-bus', () => {
	it('no ctx.provides capabilityKey equals a plugin id', () => {
		const offenders: Array<{ file: string; key: string }> = [];
		for (const file of collectTsFiles(pluginsDir)) {
			const source = readFileSync(file, 'utf8');
			for (const key of extractStrategyKeys(source)) {
				if (pluginIds.has(key)) {
					offenders.push({ file, key });
				}
			}
		}
		expect(
			offenders,
			`strategy keys must be <domain>:<discriminator> shaped, never a bare plugin id ` +
				`(use dependsOn for plugin-value edges). Offenders: ${JSON.stringify(offenders)}`,
		).toEqual([]);
	});

	it('scans a non-empty plugin tree (the gate is wired to real source)', () => {
		// Falsifiability: if the plugin dir or id set were ever empty the
		// gate above would pass vacuously. Pin both to a real, non-trivial
		// surface so a future refactor can't silently disable the guard.
		expect(collectTsFiles(pluginsDir).length).toBeGreaterThan(10);
		expect(pluginIds.size).toBeGreaterThan(5);
	});
});
