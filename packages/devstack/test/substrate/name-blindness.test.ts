// Substrate name-blindness CI invariant.
//
// ARCHITECTURE.md §"Substrate name-blindness" requires substrate code
// (`src/substrate/**`) to NEVER mention plugin names — `sui`, `walrus`,
// `seal`, `wallet`, `account`, `coin`, `package`, `faucet`, `deepbook`,
// `pyth`, `postgres`, `action`, `host`. A small permanent allowlist
// covers (a) network-host overloads (NOT the plugin-host), (b) substrate
// field shapes that name plugin-domain values by design (projection
// field set, supervisor's branded account-resource-id literal). Each
// entry carries a reason.
//
// The check strips line- and block-comments before matching so a
// documentation-only mention of "the wallet" in a header doesn't trip
// the alarm. It then scans the surviving code for `\bname\b`. False
// positives belong on the allowlist with a permanent `reason:` naming
// the architecture exception (substrate field shape, network-host
// overload, branded resource-id literal, L1-adjacent helper); the bar
// to add a new entry is the same as adding to ARCHITECTURE.md's
// "Documented exceptions" list.

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

/** Files allowed to mention plugin names. Each entry carries a reason:
 *  documented L1-adjacent exception, network-host overload (NOT the
 *  plugin-host), or substrate field shape that names plugin-domain
 *  values by design.
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
		// `HOST_GATEWAY_EXTRA_HOSTS` exposes Docker's `host.docker.internal`
		// → `host-gateway` token — refers to the container-runtime
		// host-gateway concept, NOT the host-service plugin.
		path: 'src/substrate/runtime/host-gateway.ts',
		reason: 'Docker host.docker.internal/host-gateway token, not host-service plugin.',
	},
	{
		// `host: 'server.address'` is the OTEL semantic convention
		// constant, not the host-service plugin name.
		path: 'src/substrate/runtime/observability/log-attrs.ts',
		reason: 'OTEL "server.address" key alias (network-host), not host-service plugin.',
	},
	{
		// `'capturing-host-tree'` is a snapshot-progress phase label that
		// refers to the host-side filesystem tar (substrate primitive
		// `host-tree-tar`), not the host-service plugin.
		path: 'src/substrate/events.ts',
		reason:
			'capturing-host-tree progress phase = host-tree-tar primitive, not host-service plugin.',
	},
	{
		// `accounts: AccountProjection[]`, `packages: PackageProjection[]`,
		// branded `account/${...}` / `package/${...}` keys on the
		// projection — substrate field shape that names plugin-domain
		// values by design.
		path: 'src/substrate/projection.ts',
		reason: 'Projection field set names account/package plugin-domain shapes by design.',
	},
	{
		// Projection persistence inherits plugin-named field shapes from
		// `projection.ts`.
		path: 'src/substrate/runtime/projection/persisted.ts',
		reason: 'Projection persistence inherits account/package shapes from projection.ts.',
	},
	{
		// Projection update reducer dispatches on the kind→decoder
		// registry; `account` and `package` are the two registered kinds
		// today.
		path: 'src/substrate/runtime/projection/update.ts',
		reason: 'Projection reducer dispatches on registered account/package decoder kinds.',
	},
	{
		// `faucetUrl: 'faucet'` projects an operational-endpoint name;
		// the operational-endpoint table names the plugins it surfaces.
		path: 'src/substrate/runtime/projection/operational-endpoints.ts',
		reason: 'Operational-endpoint table surfaces faucetUrl as a named plugin endpoint.',
	},
	{
		// `pendingAccountProjection` inspects the branded `account/<name>`
		// resource-id literal to seed the AccountProjection row.
		path: 'src/substrate/runtime/supervisor/start-supervisor.ts',
		reason: 'pendingAccountProjection inspects the branded account/<name> resource-id literal.',
	},
];

const ALLOWED_PATHS = new Set(ALLOWED_FILES.map((entry) => entry.path));

/** Strip line and block comments. Naive but sufficient — substrate
 *  code uses real comments, not multi-line string contents that look
 *  like comments. */
const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

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
					`with a \`reason:\` naming the architecture exception. Substrate ` +
					`name-blindness has documented permanent exceptions (see ARCHITECTURE.md ` +
					`§"Substrate name-blindness").`,
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

// Substrate Sui-SDK blindness CI invariant.
//
// The substrate (`src/substrate/**`) must name no plugin AND import no
// Sui SDK. The Sui-named SDK-boundary helpers were hoisted to
// `plugins/sui/{exec,move,ledger}` in the simplification (ARCHITECTURE.md
// §"Substrate name-blindness"), so substrate code has no remaining reason
// to reach for `@mysten/sui*` or a `TransactionBuilder`. This guard fails
// the moment one is re-introduced — the exact regression that would let a
// Sui leak back into the substrate.
//
// There is NO allowlist: a Sui import in substrate is never legitimate.
// Comments are stripped first so a doc-only mention of the SDK in a
// header does not trip the alarm.
const SUI_SDK_PATTERNS: ReadonlyArray<{ readonly label: string; readonly regex: RegExp }> = [
	{ label: '@mysten/sui', regex: /@mysten\/sui(\b|\/)/ },
	{ label: 'TransactionBuilder', regex: /\bTransactionBuilder\b/ },
];

const findSuiImportingFiles = (): Array<{ path: string; matches: Array<string> }> => {
	const files = collectSubstrateFiles(SUBSTRATE_ROOT, []);
	const offenders: Array<{ path: string; matches: Array<string> }> = [];
	for (const file of files) {
		const repoRel = relative(REPO_ROOT, file).replace(/\\/g, '/');
		const stripped = stripComments(readFileSync(file, 'utf8'));
		const matches = SUI_SDK_PATTERNS.filter((p) => p.regex.test(stripped)).map((p) => p.label);
		if (matches.length > 0) {
			offenders.push({ path: repoRel, matches });
		}
	}
	return offenders;
};

describe('substrate Sui-SDK blindness', () => {
	it('substrate code MUST NOT import @mysten/sui or name a TransactionBuilder', () => {
		const offenders = findSuiImportingFiles();
		if (offenders.length > 0) {
			const report = offenders
				.map((entry) => `  - ${entry.path} matches: [${entry.matches.join(', ')}]`)
				.join('\n');
			throw new Error(
				`Substrate Sui-SDK leak. The following files reach for the Sui SDK ` +
					`(@mysten/sui*, TransactionBuilder):\n${report}\n\n` +
					`The substrate is Sui-blind — there is NO allowlist. Move the ` +
					`SDK-touching logic into a plugin (canonical home: ` +
					`plugins/sui/{exec,move,ledger}) and have substrate hold the result ` +
					`opaquely.`,
			);
		}
		expect(offenders).toEqual([]);
	});
});
