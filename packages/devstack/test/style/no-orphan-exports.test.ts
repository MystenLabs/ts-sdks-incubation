// Orphan-export guard (STYLE_GUIDE.md §5: "Code either WORKS or DOESN'T
// EXIST. No orphan exports waiting for a wiring layer.").
//
// This file enforces §5 with TWO complementary checks:
//
//   1. `no orphan barrel re-exports` — every NAMED RE-EXPORT a plugin /
//      orchestrator barrel publishes via `export { X } from './m.ts'`
//      (or `export type { X } from ...`) must be referenced somewhere in
//      the repo. (Original, narrow check — see its block below.)
//
//   2. `no orphan local exports` — every LOCALLY-DECLARED export
//      (`export const/function/class/interface/type/enum X`) anywhere
//      under `src/` whose SOLE textual occurrence across all of `src/` +
//      `test/` is its own declaration line is a true dead orphan: nothing
//      — not `defaultProbes`, not an internal caller, not a test, not a
//      barrel — references it. This is the broadened check: check (1)
//      only ever inspected re-export blocks, so a dead LEAF export that
//      no barrel re-exports (e.g. a `cli/doctor-probes.ts` probe, a stray
//      orchestrator error class) slipped through entirely. Check (2)
//      closes that gap — "flag any zero-reference export across
//      src/+test, not just barrel re-exports".
//
// WHY "sole textual occurrence" rather than "not imported through a
// barrel": an export that is USED INSIDE ITS OWN MODULE (a same-file
// helper that is also exported for typing/testing) has ≥2 occurrences
// and is NOT an orphan — only code that is never mentioned anywhere,
// including its own file body, is dead. This is exactly the signal the
// reviewer used to flag the three removed orphans (portProbe,
// SnapshotBootError, StartTimeProbeError): "sole repo occurrence is the
// definition line".
//
// FALSE-POSITIVE GUARD — public-API surface: a primitive that is
// deliberately published (re-exported all the way to a `package.json`
// entrypoint via `export {} from` / `export * from` / `export * as …
// from` chains) legitimately has no INTERNAL consumer, yet is not dead —
// it is the package's public API. Such modules are excluded from check
// (2) by walking the re-export graph from the declared public entry
// files and treating every reachable module as "public surface".
//
// KNOWN-UNCLEARED debt: the broadened check, run for the first time,
// surfaces a set of pre-existing single-occurrence exports that predate
// this guard (internal substrate/surface primitives never wired up). They
// are NOT public-API-reachable and are genuine §5 debt, but their
// deletion spans many modules and is out of scope for this change. They
// are pinned in `KNOWN_UNCLEARED_ORPHANS` so the gate is GREEN today and
// any NEW orphan of this class fails immediately. The allowlist is
// audited (every entry must STILL be an orphan) and capped (it can only
// shrink): wiring one up — or deleting it — forces removing its entry.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');
const SRC = join(packageRoot, 'src');
const TEST = join(packageRoot, 'test');

const collectFiles = (dir: string): string[] => {
	const out: string[] = [];
	const visit = (current: string): void => {
		let entries: ReadonlyArray<string>;
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				visit(full);
				continue;
			}
			if (!stat.isFile()) continue;
			if (!/\.(ts|tsx)$/.test(entry)) continue;
			out.push(full);
		}
	};
	visit(dir);
	return out;
};

// ---------------------------------------------------------------------------
// Check 1 — barrel re-export orphans (original, narrow, false-positive-safe).
// ---------------------------------------------------------------------------

// Parse the named symbols of every `export { ... } from '...'` /
// `export type { ... } from '...'` re-export block in a barrel. The
// exported name is what survives an `X as Y` alias (`Y`).
const RE_EXPORT_BLOCK = /export\s*(type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;

const parseReExports = (barrelBody: string): ReadonlyArray<string> => {
	const symbols: string[] = [];
	for (const match of barrelBody.matchAll(RE_EXPORT_BLOCK)) {
		const block = match[2] ?? '';
		for (const rawPart of block.split(',')) {
			const part = rawPart.trim().replace(/^type\s+/, '');
			if (part === '') continue;
			const aliasMatch = part.match(/\s+as\s+([A-Za-z_$][\w$]*)/);
			const name = aliasMatch?.[1] ?? part.replace(/\s+as\s+.*/, '').trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) symbols.push(name);
		}
	}
	return symbols;
};

const collectBarrels = (): ReadonlyArray<string> => {
	const barrels: string[] = [];
	for (const group of ['plugins', 'orchestrators'] as const) {
		const groupDir = join(SRC, group);
		let names: ReadonlyArray<string>;
		try {
			names = readdirSync(groupDir);
		} catch {
			continue;
		}
		for (const name of names) {
			const barrel = join(groupDir, name, 'index.ts');
			try {
				if (statSync(barrel).isFile()) barrels.push(barrel);
			} catch {
				// not a barrel-bearing directory
			}
		}
	}
	return barrels;
};

// ---------------------------------------------------------------------------
// Check 2 — broadened local-export orphans.
// ---------------------------------------------------------------------------

// Locally-declared, named, value-or-type exports. `export { … } from`
// re-export blocks and `export default` are intentionally NOT matched —
// the leading keyword set (const/let/var/function/class/interface/type/
// enum) only fires on a declaration that introduces a NEW binding name.
const LOCAL_EXPORT_DECL =
	/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

// Resolve a relative module specifier to an on-disk source file the same
// way the bundler would (explicit file, then `.ts`/`.tsx`, then
// `/index.{ts,tsx}`).
const resolveSpecifier = (fromFile: string, spec: string): string | null => {
	if (!spec.startsWith('.')) return null;
	const base = resolve(dirname(fromFile), spec);
	if (existsSync(base) && statSync(base).isFile()) return base;
	for (const ext of ['.ts', '.tsx']) {
		if (existsSync(base + ext)) return base + ext;
	}
	for (const idx of ['/index.ts', '/index.tsx']) {
		if (existsSync(base + idx)) return base + idx;
	}
	return null;
};

// `export {…} from '…'`, `export * from '…'`, `export * as NS from '…'`
// (with or without a `type` modifier) — the re-export edges that
// transitively publish a module's surface.
const RE_EXPORT_EDGE =
	/export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;

// Source files reachable from the declared `package.json` public
// entrypoints by following re-export edges. Symbols declared in these
// files are the published API surface and are exempt from the
// internal-reference requirement.
const PUBLIC_ENTRY_FILES = [
	'src/index.ts',
	'src/build-integrations/vitest/index.ts',
	'src/build-integrations/vitest/setup.ts',
	'src/build-integrations/playwright/index.ts',
	'src/build-integrations/playwright/global-setup.ts',
	'src/build-integrations/runtime/index.ts',
];

const collectPublicReachableFiles = (): ReadonlySet<string> => {
	const reachable = new Set<string>();
	const stack = PUBLIC_ENTRY_FILES.map((rel) => join(packageRoot, rel)).filter((f) =>
		existsSync(f),
	);
	while (stack.length > 0) {
		const file = stack.pop()!;
		if (reachable.has(file)) continue;
		reachable.add(file);
		const body = readFileSync(file, 'utf8');
		for (const match of body.matchAll(RE_EXPORT_EDGE)) {
			const target = resolveSpecifier(file, match[1]!);
			if (target !== null) stack.push(target);
		}
	}
	return reachable;
};

// Pre-existing single-occurrence exports that predate this guard. Each is
// a genuine §5 orphan (zero references, not public-API-reachable) whose
// removal is out of scope for the change that introduced this check. The
// audit below FAILS if any entry stops being an orphan (wired up OR
// deleted) — so the list can only shrink, and silent drift is impossible.
//
// Format: `${srcRelativePath}#${exportedName}`.
const KNOWN_UNCLEARED_ORPHANS: ReadonlySet<string> = new Set<string>([
	'orchestrators/codegen/manifest-bridge.ts#projectPluginSlice',
	'orchestrators/codegen/manifest-bridge.ts#projectEndpoints',
	'orchestrators/snapshot/pending-marker.ts#RestorePendingDocumentV2',
	'plugins/sui/mode/fork.ts#FORK_UPSTREAM_TO_KNOWN_NETWORK',
	'primitives/artifact-publisher.ts#LENIENT_RETRY_PROFILE',
	'substrate/events.ts#EngineEventTag',
	'substrate/events.ts#EngineCommandTag',
	'substrate/runtime/cross-process/snapshot-reservation.ts#peekReservation',
	'substrate/runtime/lifecycle/state-machine.ts#__LifecycleTableShape',
	'substrate/runtime/lifecycle/state-machine.ts#isTerminal',
	'substrate/runtime/lifecycle/watch-attribution.ts#attributeFire',
	'substrate/runtime/projection/state-ref.ts#__NoDisplayVocab',
	'substrate/runtime/projection/update.ts#bumpCycle',
	'substrate/runtime/projection/update.ts#declareRow',
	'substrate/runtime/projection/update.ts#dropRow',
	'substrate/runtime/projection/update.ts#declarePackage',
	'substrate/runtime/projection/update.ts#__capacities',
	'surfaces/cli/commands/index.ts#VerbRunner',
	'surfaces/cli/flags.ts#EnvVarName',
	'surfaces/cli/output.ts#alreadyReported',
	'surfaces/tui/display-derivation.ts#__TuiDisplayVocabClean',
	'surfaces/tui/errors.ts#subscriptionLost',
]);

interface LocalExport {
	readonly file: string; // absolute
	readonly rel: string; // src-relative (POSIX-ish, matches collectFiles join)
	readonly name: string;
}

const collectLocalExports = (srcFiles: ReadonlyArray<string>): ReadonlyArray<LocalExport> => {
	const out: LocalExport[] = [];
	const seen = new Set<string>();
	for (const file of srcFiles) {
		const body = readFileSync(file, 'utf8');
		const rel = file.slice(SRC.length + 1);
		for (const match of body.matchAll(LOCAL_EXPORT_DECL)) {
			const name = match[1]!;
			const key = `${rel}#${name}`;
			if (seen.has(key)) continue; // one entry per (file, name)
			seen.add(key);
			out.push({ file, rel, name });
		}
	}
	return out;
};

// True iff `name` occurs (as a whole word) exactly once across the whole
// corpus — i.e. only at its own declaration. Short-circuits at 2.
const occursOnlyOnce = (
	name: string,
	corpus: ReadonlyArray<readonly [string, string]>,
): boolean => {
	const wordRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
	let total = 0;
	for (const [, body] of corpus) {
		const matched = body.match(wordRegex);
		if (matched !== null) total += matched.length;
		if (total > 1) return false;
	}
	return total <= 1;
};

describe('no orphan barrel re-exports', () => {
	// All source + test bodies, read once, used as the reference corpus.
	const corpus = [...collectFiles(SRC), ...collectFiles(TEST)].map(
		(file) => [file, readFileSync(file, 'utf8')] as const,
	);
	const barrels = collectBarrels();

	it('discovers plugin + orchestrator barrels', () => {
		expect(barrels.length).toBeGreaterThan(0);
	});

	for (const barrel of barrels) {
		const rel = barrel.slice(packageRoot.length + 1);
		const barrelBody = readFileSync(barrel, 'utf8');
		const symbols = parseReExports(barrelBody);
		if (symbols.length === 0) continue;

		it(`${rel}: every re-exported symbol is referenced somewhere`, () => {
			const orphans: string[] = [];
			for (const symbol of symbols) {
				const wordRegex = new RegExp(`\\b${symbol}\\b`);
				let referenced = false;
				for (const [file, body] of corpus) {
					if (file === barrel) continue; // don't let the re-export keep itself alive
					if (wordRegex.test(body)) {
						referenced = true;
						break;
					}
				}
				if (!referenced) orphans.push(symbol);
			}
			expect(orphans, `Orphan re-exports in ${rel}: ${JSON.stringify(orphans)}`).toEqual([]);
		});
	}
});

describe('no orphan local exports', () => {
	const srcFiles = collectFiles(SRC);
	// The corpus EXCLUDES this test module itself: every name on the
	// `KNOWN_UNCLEARED_ORPHANS` list appears here as a string literal
	// (`'…#isTerminal'`), and `\bisTerminal\b` matches inside that string
	// (the `#` is a word boundary). Counting those would make every
	// allowlisted orphan look "referenced" (count ≥ 2), zeroing the orphan
	// set and tripping the staleness audit. The guard must not keep its
	// own subjects alive — mirror the barrel check's self-exclusion.
	const SELF = 'no-orphan-exports.test.ts';
	const corpus = [...srcFiles, ...collectFiles(TEST)]
		.filter((file) => !file.endsWith(SELF))
		.map((file) => [file, readFileSync(file, 'utf8')] as const);
	const publicReachable = collectPublicReachableFiles();
	const localExports = collectLocalExports(srcFiles);

	// Every src-relative path that is reachable from a public entrypoint,
	// for exemption from the internal-reference requirement.
	const publicRel = new Set(
		[...publicReachable].map((f) => (f.startsWith(SRC) ? f.slice(SRC.length + 1) : f)),
	);

	it('scans a non-trivial set of local exports', () => {
		expect(localExports.length).toBeGreaterThan(100);
	});

	it('resolves the public-API entry closure', () => {
		// The root barrel must resolve; if entry resolution silently broke,
		// every internal-only file would look "public" and the check would
		// go inert.
		expect(publicReachable.size).toBeGreaterThan(0);
		expect(publicRel.has('index.ts')).toBe(true);
	});

	// Compute the live orphan set once and reuse for both assertions.
	const orphans = localExports.filter(
		(e) => !publicRel.has(e.rel) && occursOnlyOnce(e.name, corpus),
	);
	const orphanKeys = new Set(orphans.map((e) => `${e.rel}#${e.name}`));

	it('no NEW orphan local export (zero references across src/+test) is introduced', () => {
		const unexpected = orphans
			.filter((e) => !KNOWN_UNCLEARED_ORPHANS.has(`${e.rel}#${e.name}`))
			.map((e) => `${e.rel}#${e.name}`);
		expect(
			unexpected,
			`These exports are referenced NOWHERE in src/+test (their only ` +
				`occurrence is their own declaration). Per STYLE_GUIDE §5, either ` +
				`wire them up or delete them — do not leave an orphan waiting for a ` +
				`wiring layer. If one is a deliberate, soon-to-be-wired public ` +
				`primitive, re-export it from a package.json entrypoint instead:\n` +
				JSON.stringify(unexpected, null, 2),
		).toEqual([]);
	});

	it('the KNOWN_UNCLEARED_ORPHANS allowlist stays accurate (can only shrink)', () => {
		// Any allowlisted entry that is no longer an orphan (it got wired up,
		// renamed, or deleted) must be removed from the allowlist — otherwise
		// the list rots and masks a future real orphan reusing the name.
		const stale = [...KNOWN_UNCLEARED_ORPHANS].filter((key) => !orphanKeys.has(key));
		expect(
			stale,
			`These allowlist entries are no longer orphans (wired up or removed). ` +
				`Delete them from KNOWN_UNCLEARED_ORPHANS:\n${JSON.stringify(stale, null, 2)}`,
		).toEqual([]);
		// Hard cap so the debt list can never silently grow past its
		// introduction size; new orphans must be fixed, not appended.
		expect(KNOWN_UNCLEARED_ORPHANS.size).toBeLessThanOrEqual(23);
	});
});
