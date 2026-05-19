// Coverage for the file-watcher filter (`compileWatchFilter`) and the
// always-on `DEFAULT_WATCH_EXCLUDES`.
//
// Why this matters: the build container bind-mounts the host source
// dir and lets `sui move build` rewrite `Move.lock`, populate `build/`,
// and write under `package_summaries/` on every publish. Those events
// flow through `fs.watch` and would trigger a full hot-restart cycle if
// not filtered — the restart would re-run the same publish that just
// produced the change, looping indefinitely on a single edit. Same
// story for `Codegen`'s atomic rename to `src/generated/` each cycle.
//
// The watch filter is the defensive boundary: the moment a new
// build-side artifact starts leaking into a watched tree, the symptom
// is "restart fires after every publish" — extending
// `DEFAULT_WATCH_EXCLUDES` or having the owning primitive declare a
// `!`-negation in its `watch:` array should be the fix.

import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	compileWatchFilter,
	flattenStackMembers,
	formatRestartCascade,
	formatShutdownAcquiringSummary,
	type DownstreamClosure,
	type StackMember,
	type WatchOwner,
} from './supervisor.js';
import { buildDepGraph, computeDownstreamClosure } from './dep-graph.js';
import type { TuiEntry } from './tui-state.js';

const abs = (rel: string): string => nodePath.resolve(process.cwd(), rel);

describe('compileWatchFilter — gitignore-style include + negation', () => {
	it('positive bare path: matches the dir itself AND descendants', () => {
		const filter = compileWatchFilter(['move/vault']);
		expect(filter(abs('move/vault'))).toBe(true);
		expect(filter(abs('move/vault/sources/foo.move'))).toBe(true);
		expect(filter(abs('move/vault/Move.toml'))).toBe(true);
	});

	it('positive bare path: does NOT match siblings or other trees', () => {
		const filter = compileWatchFilter(['move/vault']);
		expect(filter(abs('move/other'))).toBe(false);
		expect(filter(abs('src/index.ts'))).toBe(false);
	});

	it('default excludes win even when path is under a positive include', () => {
		// The Move.lock under move/vault matches both the positive include and
		// the **/Move.lock default exclude — exclude wins, so no restart.
		const filter = compileWatchFilter(['move/vault']);
		expect(filter(abs('move/vault/Move.lock'))).toBe(false);
		expect(filter(abs('move/vault/build/x.mv'))).toBe(false);
		expect(filter(abs('move/vault/package_summaries/address_mapping.json'))).toBe(false);
	});

	it('user negation: `!path/to/x` excludes that subtree from an outer positive include', () => {
		const filter = compileWatchFilter(['src', '!src/legacy']);
		expect(filter(abs('src/index.ts'))).toBe(true);
		expect(filter(abs('src/legacy/old.ts'))).toBe(false);
		expect(filter(abs('src/legacy'))).toBe(false);
	});

	it('Codegen-style negation-only declaration: contributes filter, not a watch root', () => {
		// A primitive may declare ONLY a negation (no positive). In isolation
		// this filter matches nothing (no positive includes), which mirrors
		// real composition: the negation only "does work" when SOME other
		// primitive provides a positive include whose tree overlaps.
		const negOnly = compileWatchFilter(['!src/generated']);
		expect(negOnly(abs('src/generated/foo.ts'))).toBe(false);
		expect(negOnly(abs('src/other/foo.ts'))).toBe(false);

		// Combined with another primitive's positive: the negation overrides.
		const combined = compileWatchFilter(['src', '!src/generated']);
		expect(combined(abs('src/index.ts'))).toBe(true);
		expect(combined(abs('src/generated/dapp-kit/foo.ts'))).toBe(false);
		expect(combined(abs('src/generated'))).toBe(false);
	});

	it('absolute paths: passed through unchanged', () => {
		const filter = compileWatchFilter(['/abs/move/vault']);
		expect(filter('/abs/move/vault/sources/foo.move')).toBe(true);
		expect(filter('/abs/other')).toBe(false);
	});

	it('anchored-anywhere glob (`**/*.move`): matches any depth', () => {
		// Glob patterns with meta chars contribute to the filter but not as
		// concrete watch roots; this test exercises the filter in isolation.
		const filter = compileWatchFilter(['**/*.move']);
		expect(filter(abs('move/vault/sources/foo.move'))).toBe(true);
		expect(filter(abs('a/b/c/d.move'))).toBe(true);
		expect(filter(abs('a/b/c/d.ts'))).toBe(false);
	});

	it('empty pattern set: nothing matches (positive-include required)', () => {
		// Defaults are excludes only; with no positive includes, every path
		// fails the "matches some include" check and no restart fires.
		const filter = compileWatchFilter([]);
		expect(filter(abs('any/path/foo.ts'))).toBe(false);
		expect(filter(abs('Move.lock'))).toBe(false);
	});
});

// Phase 5 (selective-restart diagnostic surface): the watch-fire log line
// should enumerate the downstream cascade and surface heavy-infra reboot
// costs. `formatRestartCascade` is the pure helper the watch fiber calls;
// these tests pin the rendered shape so a future log-format tweak can't
// silently drop the cascade enumeration or the cost warning.
const owner = (key: string, title: string, absolutePath = '/abs/dummy'): WatchOwner => ({
	key,
	title,
	absolutePath,
});

describe('formatRestartCascade — Phase 5 diagnostic surface', () => {
	it('enumerates downstream consumers when the closure is provided', () => {
		// `publish.vault` is owner; `codegen` + `dev` depend on it transitively.
		const closure: DownstreamClosure = new Map([['publish.vault', new Set(['codegen', 'dev'])]]);
		const { message, affected } = formatRestartCascade(
			[owner('publish.vault', 'publish.vault')],
			closure,
		);
		expect(message).toContain('owned by publish.vault');
		expect(message).toContain('2 downstream:');
		expect(message).toContain('codegen');
		expect(message).toContain('dev');
		expect(affected).toEqual(new Set(['publish.vault', 'codegen', 'dev']));
	});

	it('falls back to owner-only shape when closure is undefined (Phase 1 not wired)', () => {
		// Forward-compat: before P1 lands, the cascade enumeration is absent
		// — the line still attributes ownership but doesn't make up downstream
		// names. Affected-set carries only the owner.
		const { message, affected } = formatRestartCascade(
			[owner('publish.vault', 'publish.vault')],
			undefined,
		);
		expect(message).toContain('owned by publish.vault');
		expect(message).not.toContain('downstream');
		expect(affected).toEqual(new Set(['publish.vault']));
	});

	it('annotates Sui in the affected set with reboot-cost warning (R4 mitigation)', () => {
		// When the dep graph routes Sui downstream of a watched primitive,
		// the operator sees the cost up-front so the decision to roll
		// forward (or Ctrl-C + edit) is informed. The plan explicitly bans
		// an opt-out flag for this surface.
		const closure: DownstreamClosure = new Map([['publish.vault', new Set(['@devstack/SuiTag'])]]);
		const { message, affected } = formatRestartCascade(
			[owner('publish.vault', 'publish.vault')],
			closure,
		);
		expect(message).toContain('affected:');
		expect(message).toContain('Sui');
		expect(message).toContain('90s');
		expect(affected).toContain('@devstack/SuiTag');
	});

	it('skips the reboot-cost warning when no heavy infra is in the affected set', () => {
		// `codegen` and `dev` are per-cycle artifacts — no container teardown
		// cost worth surfacing. The diagnostic stays terse.
		const closure: DownstreamClosure = new Map([['publish.vault', new Set(['codegen', 'dev'])]]);
		const { message } = formatRestartCascade([owner('publish.vault', 'publish.vault')], closure);
		expect(message).not.toContain('affected:');
		expect(message).not.toContain('reboot expected');
	});

	it('unions cascade across multiple matched owners (overlap deduped)', () => {
		// Two primitives can watch overlapping directories; a single fs event
		// then attributes to both. The cascade union should de-dupe so the
		// log line and the TUI dim-animation signal don't double-count.
		const closure: DownstreamClosure = new Map([
			['publish.a', new Set(['shared-dep'])],
			['publish.b', new Set(['shared-dep'])],
		]);
		const { affected } = formatRestartCascade(
			[owner('publish.a', 'publish.a'), owner('publish.b', 'publish.b')],
			closure,
		);
		expect(affected).toEqual(new Set(['publish.a', 'publish.b', 'shared-dep']));
	});

	it('warns once for Walrus / Seal heavy-infra (same as Sui)', () => {
		// Each heavy primitive in the affected set surfaces; the warning
		// chain is collapsed via dedupe so two Seal keyservers in scope
		// don't spam the line.
		const closure: DownstreamClosure = new Map([
			[
				'publish.vault',
				new Set([
					'@devstack/WalrusNetworkTag',
					'@devstack/SealKeyServerTag',
					'@devstack/SealKeyManagerTag',
				]),
			],
		]);
		const { message } = formatRestartCascade([owner('publish.vault', 'publish.vault')], closure);
		expect(message).toContain('Walrus');
		expect(message).toContain('Seal');
		// Seal only renders once in the WARNING section even though both
		// keyserver + keymanager share the same cost annotation (the
		// downstream-enumeration list still names every consumer, so we
		// scope the dedupe check to the `affected:` suffix).
		const affectedSuffix = message.slice(message.indexOf('affected:'));
		const sealWarningOccurrences = (affectedSuffix.match(/Seal/g) ?? []).length;
		expect(sealWarningOccurrences).toBe(1);
	});
});

// Phase D (`notes/parallel-graph-resolution.md` §6.4) lifts composites'
// parallelizable inner siblings (`upstreamImage`, `moveSource`,
// `sealImage`, `sourceFetch`) to top-level via `__extraMembers`. The
// flatten happens once at compose time so the dep graph, watch-set
// aggregation, seed pass, and topo scheduler all see the same canonical
// member set.
// Tests treat StackMember as a structural record; the `__layer` field is
// load-bearing only at compose time (`composeStackLayer` reads each
// member's layer slice), not for `flattenStackMembers` / `buildDepGraph`
// which read only `__extraMembers`, `key`, `__upstreamKeys`. Mint
// `Partial<StackMember>`-shaped records and cast through `unknown` to
// satisfy the readonly invariants on the public interface without
// inventing a fake `__layer`.
const fakeMember = (m: Partial<StackMember>): StackMember => m as unknown as StackMember;

describe('flattenStackMembers — Phase D composite restructure', () => {
	it("expands a composite's __extraMembers to top-level after the parent", () => {
		const upstreamImage = fakeMember({ key: 'walrus.image.upstream' });
		const moveSource = fakeMember({ key: 'walrus.move-source' });
		const composite = fakeMember({
			key: 'walrusLocalCluster',
			__extraMembers: [upstreamImage, moveSource],
		});
		const out = flattenStackMembers([composite]);
		// Order: composite first, then extras in declaration order. The
		// topo scheduler doesn't care about input order (Kahn-style
		// emission), but downstream consumers — duplicate-key guard, seed
		// pass, the TUI dep-tree — read input order, so the helper is
		// deterministic about it.
		expect(out.map((m) => m.key)).toEqual([
			'walrusLocalCluster',
			'walrus.image.upstream',
			'walrus.move-source',
		]);
	});

	it('walks nested __extraMembers (composite inside __extraMembers)', () => {
		// Defensive: if a future composite contributes another composite
		// in its extras, the flatten reaches the inner siblings too. Pre-
		// fix this would have stopped at the first level and the deeper
		// siblings would have been invisible to the dep graph.
		const innerLeaf = fakeMember({ key: 'inner.leaf' });
		const innerComposite = fakeMember({
			key: 'inner.composite',
			__extraMembers: [innerLeaf],
		});
		const outerComposite = fakeMember({
			key: 'outer.composite',
			__extraMembers: [innerComposite],
		});
		const out = flattenStackMembers([outerComposite]);
		expect(out.map((m) => m.key)).toEqual(['outer.composite', 'inner.composite', 'inner.leaf']);
	});

	it('lifted siblings participate in buildDepGraph + downstream closure', () => {
		// End-to-end: a composite that lifts an inner image tag and
		// declares it in __upstreamKeys should resolve the upstream edge
		// against the lifted sibling. Without the flatten, the lifted
		// sibling wouldn't be in the graph and `buildDepGraph` would
		// drop the upstream reference as dangling.
		const upstreamImage = fakeMember({ key: 'walrus.image.upstream' });
		const composite = fakeMember({
			key: 'walrusLocalCluster',
			__extraMembers: [upstreamImage],
			__upstreamKeys: ['walrus.image.upstream'],
		});
		const flat = flattenStackMembers([composite]);
		const graph = buildDepGraph(flat);
		// The composite's upstream edge resolves; the image is a leaf.
		expect(graph.get('walrusLocalCluster')?.upstreamKeys).toEqual(['walrus.image.upstream']);
		expect(graph.get('walrus.image.upstream')?.upstreamKeys).toEqual([]);
		// Downstream closure: editing the image cascades to the composite.
		const closure = computeDownstreamClosure(graph);
		expect(Array.from(closure.get('walrus.image.upstream') ?? [])).toEqual(['walrusLocalCluster']);
	});

	it('returns a leaf member unchanged (no __extraMembers)', () => {
		const leaf = fakeMember({ key: 'sui' });
		expect(flattenStackMembers([leaf]).map((m) => m.key)).toEqual(['sui']);
	});

	it('preserves member ordering for non-composite siblings', () => {
		// A flat stack of three leaves should round-trip identically —
		// flatten is the identity on a stack with no __extraMembers.
		const stack = [
			fakeMember({ key: 'sui' }),
			fakeMember({ key: 'postgres' }),
			fakeMember({ key: 'walrus' }),
		];
		expect(flattenStackMembers(stack).map((m) => m.key)).toEqual(['sui', 'postgres', 'walrus']);
	});
});

// Phase 3.4 (`notes/long-acquire-progress.md`): on SIGTERM the supervisor
// must emit a summary of every tag still in `acquiring` so the operator
// knows WHAT was mid-flight when teardown began. The pre-fix failure mode
// — `force-killed 0 container(s)` reads as "everything was clean" when the
// truth is "we never finished `docker pull` and no container had spawned
// yet" — was reproduced verbatim by an operator in 2026-05-19 against
// `examples/fork-greeting`. `formatShutdownAcquiringSummary` is the pure
// helper the signal handler calls; these tests pin the rendered shape so a
// future format tweak can't silently drop the per-tag phase enumeration or
// the "(no phase)" fallback (the load-bearing distinction between "we know
// what step it's on" and "we don't").
const entry = (key: string, status: TuiEntry['status'], phase?: string): TuiEntry => ({
	key,
	kind: 'other',
	status,
	...(phase !== undefined ? { phase } : {}),
});

describe('formatShutdownAcquiringSummary — Phase 3.4 SIGTERM summary', () => {
	it('returns empty string when no tag is acquiring', () => {
		// Empty summary = "skip the summary line" — caller must not emit a
		// preamble with zero rows. Keeps the normal-shutdown path (where
		// every tag had time to reach `ready` before the signal) silent so
		// we don't add noise to the well-behaved case.
		const out = formatShutdownAcquiringSummary([
			entry('sui.fork.image', 'ready'),
			entry('walrus.local', 'ready'),
		]);
		expect(out).toBe('');
	});

	it('returns empty string for an empty entry list', () => {
		// Defensive: even before any primitive has registered (engine state
		// still pristine), the helper must not panic. Same "skip the line"
		// contract.
		expect(formatShutdownAcquiringSummary([])).toBe('');
	});

	it('lists each acquiring tag with its phase', () => {
		const out = formatShutdownAcquiringSummary([
			entry('sui.fork.image', 'acquiring', 'pulling 4/12 layers'),
			entry('walrus.contracts.publish', 'acquiring', 'publish-tx'),
		]);
		expect(out).toContain('2 tag(s) still acquiring');
		expect(out).toContain('sui.fork.image');
		expect(out).toContain('phase=pulling 4/12 layers');
		expect(out).toContain('walrus.contracts.publish');
		expect(out).toContain('phase=publish-tx');
	});

	it('renders "(no phase)" for an acquiring tag whose phase is not set', () => {
		// Phase-less primitives (no `setPhase` call yet) still appear in
		// the summary — operator sees "we got far enough to start it" vs
		// "tag was never reached", which is exactly what they need to
		// distinguish a stuck pull from a stuck genesis.
		const out = formatShutdownAcquiringSummary([entry('seal.local.keygen', 'acquiring')]);
		expect(out).toContain('seal.local.keygen');
		expect(out).toContain('(no phase)');
		expect(out).not.toContain('phase=');
	});

	it('filters out non-acquiring entries', () => {
		// Mixed-state stack: only the `acquiring` rows surface; `ready`,
		// `pending`, `failed`, `stopping`, `stopped` are noise from the
		// operator's perspective at shutdown.
		const out = formatShutdownAcquiringSummary([
			entry('sui', 'ready'),
			entry('walrus', 'acquiring', 'pulling 2/3 layers'),
			entry('seal', 'pending'),
			entry('codegen', 'failed'),
			entry('indexer', 'stopping'),
			entry('postgres', 'stopped'),
		]);
		expect(out).toContain('1 tag(s) still acquiring');
		expect(out).toContain('walrus');
		expect(out).not.toContain('sui');
		expect(out).not.toContain('seal');
		expect(out).not.toContain('codegen');
		expect(out).not.toContain('indexer');
		expect(out).not.toContain('postgres');
	});

	it('aligns the phase column across rows with different key lengths', () => {
		// Eyes scan the `phase=` column when there's more than one row —
		// the helper pads keys to the max key length so the column stays
		// visually anchored. Without padding, a 30-char key next to a
		// 6-char key would push the `phase=` field around and the
		// at-a-glance read suffers.
		const out = formatShutdownAcquiringSummary([
			entry('sui.fork.image', 'acquiring', 'pulling'),
			entry('walrus.contracts.publish', 'acquiring', 'publish-tx'),
			entry('seal.local.keygen', 'acquiring'),
		]);
		const lines = out.split('\n').filter((l) => l.startsWith('  - '));
		expect(lines.length).toBe(3);
		// Each row's `phase=` (or `(no phase)`) field should appear at the
		// SAME column index. Compute the post-key offset and assert
		// equality across the three rows.
		const phaseIndices = lines.map((l) => {
			const idx = l.indexOf('phase=');
			return idx >= 0 ? idx : l.indexOf('(no phase)');
		});
		expect(phaseIndices[0]).toBe(phaseIndices[1]);
		expect(phaseIndices[1]).toBe(phaseIndices[2]);
	});

	it('uses the default preamble for the first-SIGTERM line', () => {
		// First-signal path: "shutdown initiated" — clearly distinct from
		// the second-signal force-kill line so a log scraper can grep
		// either form without false matches.
		const out = formatShutdownAcquiringSummary([entry('sui', 'acquiring', 'pulling')]);
		expect(out.startsWith('devstack: shutdown initiated.')).toBe(true);
	});

	it('respects a custom preamble for the second-SIGTERM line', () => {
		// Second-signal path: the supervisor passes a different preamble so
		// the operator can tell the two-message contexts apart (the second
		// summary is a re-emit of the first-signal snapshot, not a fresh
		// read).
		const out = formatShutdownAcquiringSummary(
			[entry('sui', 'acquiring', 'pulling')],
			'devstack: at first signal,',
		);
		expect(out.startsWith('devstack: at first signal,')).toBe(true);
		expect(out).not.toContain('shutdown initiated');
	});

	it('terminates the summary block with a trailing newline', () => {
		// Concatenation hygiene: the second-signal message glues
		// `force-killed N container(s) … exiting.\n` + summary together —
		// without a trailing newline on the summary, the operator's shell
		// prompt would land on the same line as the last "- seal.…" entry.
		const out = formatShutdownAcquiringSummary([entry('sui', 'acquiring', 'pulling')]);
		expect(out.endsWith('\n')).toBe(true);
	});
});
