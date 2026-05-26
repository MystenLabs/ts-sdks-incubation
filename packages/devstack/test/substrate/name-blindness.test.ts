// Substrate name-blindness CI invariant.
//
// ARCHITECTURE.md §"Substrate name-blindness" requires substrate code
// (`src/substrate/**`) to NEVER mention plugin names — `sui`, `walrus`,
// `seal`, `wallet`, `account`, `coin`, `package`, `faucet`, `deepbook`,
// `pyth`, `postgres`, `action`, `host`. Two L1-adjacent helpers are
// documented exceptions (`sui-execute/`, `sui-move-build/`); a few
// other files are temporarily allowed pending Phase 5b/6 lifts. Every
// allow-listed file carries a TODO with the backlog item that will
// close it.
//
// The check strips line- and block-comments before matching so a
// documentation-only mention of "the wallet" in a header doesn't trip
// the alarm. It then scans the surviving code for `\bname\b`. False
// positives belong on the allowlist with a TODO; the bar to add a new
// entry is the same as adding to ARCHITECTURE.md's "Documented
// exceptions" list.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

const SUBSTRATE_ROOT = new URL('../../src/substrate/', import.meta.url).pathname;
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

const PLUGIN_NAMES = [
	'sui',
	'walrus',
	'seal',
	'wallet',
	'account',
	'coin',
	'package',
	'faucet',
	'deepbook',
	'pyth',
	'postgres',
	'action',
	'host',
] as const;

/** Files allowed to mention plugin names today.
 *
 *  Each entry MUST carry a reason — either a documented L1-adjacent
 *  exception (sui-execute / sui-move-build) or a TODO with the
 *  backlog item that will close it.
 *
 *  Note on `host`: the word `host` is overloaded — it appears in
 *  network-positional contexts (`host:port`, `hostname`, `host-gateway`)
 *  and as part of the `host-service` plugin name. Substrate primitives
 *  for host-side networking (`host-tree-tar`, `port-broker`,
 *  cross-process `host` fields) are NOT the host-service plugin and
 *  belong on the allowlist with a "network-host, not plugin-host"
 *  reason. */
const ALLOWED_FILES: ReadonlyArray<{
	readonly path: string;
	readonly reason: string;
}> = [
	{
		// ARCHITECTURE.md §"Substrate name-blindness" → "Documented exceptions"
		path: 'src/substrate/runtime/sui-execute/index.ts',
		reason: 'Documented L1-adjacent Sui helper (ARCHITECTURE.md §Substrate name-blindness).',
	},
	{
		// ARCHITECTURE.md §"Substrate name-blindness" → "Documented exceptions"
		path: 'src/substrate/runtime/sui-move-build/index.ts',
		reason:
			'Documented L1-adjacent Sui Move build helper (ARCHITECTURE.md §Substrate name-blindness).',
	},
	{
		// ChainOperation's `sui-tx` variant + import from `../sui-execute/`
		// is the substrate seam that consumes the sui-execute exception.
		// The variant literal IS the typed handshake into that helper.
		path: 'src/substrate/runtime/artifact-publisher/chain-operation.ts',
		reason:
			'Substrate seam consuming the sui-execute exception; `sui-tx` variant literal is the typed handshake.',
	},
	{
		// Barrel re-export of sui-execute + host-tree-tar (network-host, not
		// plugin-host).
		path: 'src/substrate/runtime/index.ts',
		reason: 'Barrel re-export of sui-execute (exception) + host-tree-tar (network-host).',
	},
	{
		// network-host fields (`hostname`, `host:port`); NOT the
		// host-service plugin.
		path: 'src/substrate/runtime/cross-process/command-channel/channel.ts',
		reason: 'network-host (hostname), not host-service plugin.',
	},
	{
		// `holder.host` is the cross-process roster's hostname field; NOT
		// the host-service plugin.
		path: 'src/substrate/runtime/cross-process/liveness.ts',
		reason: 'network-host (roster hostname field), not host-service plugin.',
	},
	{
		// `host-tree-tar` is the substrate primitive name for host-side
		// filesystem tar; NOT the host-service plugin.
		path: 'src/substrate/runtime/host-tree-tar/index.ts',
		reason: 'host-tree-tar primitive name (host filesystem), not host-service plugin.',
	},
	{
		// `host` parameter is the bind interface (`127.0.0.1` /
		// `0.0.0.0`); NOT the host-service plugin.
		path: 'src/substrate/runtime/port-broker/service.ts',
		reason: 'bind-interface host parameter, not host-service plugin.',
	},
	{
		// TODO(Phase 5b SpanAttr lift): split SpanAttr into substrate-owned
		// generic vocab + plugin-owned domain vocab; today the `SpanAttr`
		// constants hardcode `sui.*` / `walrus.*` / etc. keys.
		path: 'src/substrate/runtime/observability/spans.ts',
		reason: 'TODO Phase 5b: SpanAttr keys carry plugin-named fields; lift to plugin-owned vocab.',
	},
	{
		// TODO(Phase 5b projection lift): `account.updated` /
		// `package.updated` event variants name plugins; lift to a generic
		// `projection.updated` envelope.
		path: 'src/substrate/events.ts',
		reason:
			'TODO Phase 5b: account.updated / package.updated event names; lift to projection envelope.',
	},
	{
		// TODO(Phase 5b projection lift): `accounts: AccountProjection[]`,
		// `packages: PackageProjection[]`, branded `account/${...}` /
		// `package/${...}` keys on the projection.
		path: 'src/substrate/projection.ts',
		reason:
			'TODO Phase 5b: projection field set is plugin-aware; lift accounts/packages to neutral shape.',
	},
	{
		// TODO(Phase 5b projection lift): the projection persistence layer
		// inherits plugin names from `projection.ts`.
		path: 'src/substrate/runtime/projection/persisted.ts',
		reason:
			'TODO Phase 5b: projection persistence inherits account/package names from projection.ts.',
	},
	{
		// TODO(Phase 5b projection lift): the projection update reducer
		// inherits plugin names from `projection.ts`.
		path: 'src/substrate/runtime/projection/update.ts',
		reason:
			'TODO Phase 5b: projection reducer inherits account/package names from projection.ts.',
	},
	{
		// TODO(Phase 5b operational-endpoints lift): `faucetUrl: 'faucet'`
		// projects a plugin-named operational endpoint; the projection lift
		// will absorb the operational-endpoint naming alongside the rest.
		path: 'src/substrate/runtime/projection/operational-endpoints.ts',
		reason:
			'TODO Phase 5b: faucetUrl operational-endpoint name leaks faucet plugin; lifts with projection.',
	},
	{
		// Phase 6 split shipped: `pendingAccountProjection` still
		// inspects the branded `account/<name>` resource-id literal to
		// seed the AccountProjection row. Tracked at backlog item 33
		// (Phase 5b projection lift); the substrate `projection.updated`
		// event + L3 projection orchestrator will absorb this.
		path: 'src/substrate/runtime/supervisor/start-supervisor.ts',
		reason:
			'TODO backlog #33: pendingAccountProjection inspects account/<name> literal; lifts with projection orchestrator.',
	},
];

const ALLOWED_PATHS = new Set(ALLOWED_FILES.map((entry) => entry.path));

/** Strip line and block comments. Naive but sufficient — substrate
 *  code uses real comments, not multi-line string contents that look
 *  like comments. */
const stripComments = (source: string): string =>
	source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, ' ');

const collectSubstrateFiles = (dir: string, acc: Array<string>): Array<string> => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			collectSubstrateFiles(full, acc);
		} else if (entry.endsWith('.ts')) {
			acc.push(full);
		}
	}
	return acc;
};

const PLUGIN_NAME_REGEX = new RegExp(`\\b(${PLUGIN_NAMES.join('|')})\\b`);

const findOffendingFiles = (): Array<{ path: string; matches: Array<string> }> => {
	const files = collectSubstrateFiles(SUBSTRATE_ROOT, []);
	const offenders: Array<{ path: string; matches: Array<string> }> = [];
	for (const file of files) {
		const repoRel = relative(REPO_ROOT, file).replace(/\\/g, '/');
		if (ALLOWED_PATHS.has(repoRel)) continue;
		const stripped = stripComments(readFileSync(file, 'utf8'));
		const matches = new Set<string>();
		for (const line of stripped.split('\n')) {
			const m = line.match(PLUGIN_NAME_REGEX);
			if (m !== null) matches.add(m[1]!);
		}
		if (matches.size > 0) {
			offenders.push({ path: repoRel, matches: [...matches] });
		}
	}
	return offenders;
};

describe('substrate name-blindness', () => {
	it('substrate code MUST NOT mention plugin names outside documented exceptions', () => {
		const offenders = findOffendingFiles();
		if (offenders.length > 0) {
			const report = offenders
				.map((entry) => `  - ${entry.path} matches: [${entry.matches.join(', ')}]`)
				.join('\n');
			throw new Error(
				`Substrate name-blindness violation. The following files mention plugin names ` +
					`(${PLUGIN_NAMES.join(', ')}) and are not on the allowlist:\n${report}\n\n` +
					`Either remove the mention (preferred) or add the file to ALLOWED_FILES ` +
					`with a TODO referencing the backlog item that will close it.`,
			);
		}
		expect(offenders).toEqual([]);
	});

	it('the allowlist itself stays small + accountable', () => {
		// Every allowlist entry must carry a non-empty reason.
		for (const entry of ALLOWED_FILES) {
			expect(entry.reason.length).toBeGreaterThan(0);
		}
		// Cap the allowlist at the current set so silent growth surfaces
		// in review. Bump only with explicit ARCHITECTURE.md +
		// STYLE_GUIDE rationale.
		expect(ALLOWED_FILES.length).toBeLessThanOrEqual(15);
	});
});
