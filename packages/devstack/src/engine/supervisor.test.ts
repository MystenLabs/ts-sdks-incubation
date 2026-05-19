// Coverage for the file-watcher filter (`compileWatchFilter` + the back-compat
// `isIgnoredWatchPath` shim) and the always-on `DEFAULT_WATCH_EXCLUDES`.
//
// Why this matters: the Stage-2 build container bind-mounts the host source
// dir and lets `sui move build` rewrite `Move.lock`, populate `build/`, and
// write under `package_summaries/` on every publish. Those file-change events
// flow through `fs.watch` and would trigger a full hot-restart cycle if not
// filtered — the restart would re-run the same publish that just produced the
// change, looping indefinitely on a single edit. Same story for `Codegen`'s
// atomic rename to `src/generated/` each cycle.
//
// The watch filter is the defensive boundary: the moment a new build-side
// artifact starts leaking into a watched tree, the symptom is "restart fires
// after every publish" — extending `DEFAULT_WATCH_EXCLUDES` or having the
// owning primitive declare a `!`-negation in its `watch:` array should be the
// fix.

import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	compileWatchFilter,
	formatRestartCascade,
	isIgnoredWatchPath,
	type DownstreamClosure,
	type WatchOwner,
} from './supervisor.js';

const abs = (rel: string): string => nodePath.resolve(process.cwd(), rel);

describe('isIgnoredWatchPath — back-compat default-excludes check', () => {
	it('ignores Move.lock — rewritten by sui move build on every invocation', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/Move.lock')).toBe(true);
		expect(isIgnoredWatchPath('/abs/path/Move.lock')).toBe(true);
	});

	it('ignores Move.lock.new — the awk scrub stages this before atomic rename', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/Move.lock.new')).toBe(true);
	});

	it('ignores `build/` — sui move build output dir, regenerated every run', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/build/x.mv')).toBe(true);
		expect(isIgnoredWatchPath('move/mock_usdc/build/bytecode_modules/foo.mv')).toBe(true);
	});

	it('ignores `package_summaries/` — sui move build rewrites address_mapping.json there each run', () => {
		// Without this, `publishMove`'s `watch: [options.path]` declaration loops:
		// publish → writes package_summaries/address_mapping.json → fs.watch fires →
		// hot-restart → republish → loop.
		expect(isIgnoredWatchPath('move/vault/package_summaries/address_mapping.json')).toBe(true);
		expect(isIgnoredWatchPath('move/vault/package_summaries/root_package_metadata.json')).toBe(
			true,
		);
		expect(isIgnoredWatchPath('move/vault/package_summaries/sui/something.json')).toBe(true);
	});

	it('ignores `.devstack/` — devstack state dir (snapshots, state-store, locks)', () => {
		expect(isIgnoredWatchPath('.devstack/stacks/default/state.json')).toBe(true);
		expect(isIgnoredWatchPath('.devstack/snapshot/snapshot.json')).toBe(true);
	});

	it('ignores `generated/` — Codegen atomic-renames staging → generated each cycle', () => {
		// `Codegen({})` defaults to `./src/generated`; if a watched path is an
		// ancestor, the atomic rename surfaces as an fs event → hot-restart →
		// re-codegen → loop.
		expect(isIgnoredWatchPath('src/generated/dapp-kit/foo.ts')).toBe(true);
		expect(isIgnoredWatchPath('src/generated/bindings/vault/vault.ts')).toBe(true);
	});

	it('ignores node_modules and .git anywhere in the path', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/node_modules/pkg/index.js')).toBe(true);
		expect(isIgnoredWatchPath('repo/.git/HEAD')).toBe(true);
	});

	it('ignores editor swap / backup files (.swp, .swx, ~ suffix)', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/sources/.foo.move.swp')).toBe(true);
		expect(isIgnoredWatchPath('move/mock_usdc/sources/foo.move~')).toBe(true);
	});

	it('does NOT ignore actual Move source — `.move` files are the change we want to react to', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/sources/mock_usdc.move')).toBe(false);
		expect(isIgnoredWatchPath('/abs/path/sources/foo.move')).toBe(false);
	});

	it('does NOT ignore Move.toml — user-authored manifest, real edits trigger republish', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/Move.toml')).toBe(false);
	});

	it('does NOT ignore arbitrary files that happen to share a prefix', () => {
		// `Move.locked.txt` is not Move.lock; the glob is anchored on `Move.lock`.
		expect(isIgnoredWatchPath('move/mock_usdc/Move.locked.txt')).toBe(false);
		// `build-config.json` is not under a `build/` directory.
		expect(isIgnoredWatchPath('move/mock_usdc/build-config.json')).toBe(false);
	});
});

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
