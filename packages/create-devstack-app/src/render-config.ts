// Renders the scaffolded app's `devstack.config.ts` — the ONE generated file.
// Everything else in a scaffolded app is copied verbatim from `templates/`.
//
// Output is straight-line code in repo style (tabs, single quotes,
// semicolons, sorted imports), assembled line-by-line so every
// (template × services) combination emits exactly the imports and
// declarations it uses — no dead imports, no placeholder comments.
//
// Factory call shapes are ported verbatim from the proven previous template
// config; do not invent options here without checking the devstack API.

import { normalizeServices, type ServiceId } from './services.js';

export type TemplateId = 'app' | 'ts';

export const TEMPLATE_IDS: ReadonlyArray<TemplateId> = ['app', 'ts'];

export function renderDevstackConfig(
	template: TemplateId,
	services: ReadonlySet<ServiceId>,
): string {
	const isApp = template === 'app';
	// `pyth` implies `deepbook` — normalize so the two render consistently
	// regardless of how the set was assembled.
	const resolved = normalizeServices(services);
	const hasWalrus = resolved.has('walrus');
	const hasSeal = resolved.has('seal');
	const hasDeepbook = resolved.has('deepbook');
	const hasPyth = resolved.has('pyth');

	// Named imports from the devstack barrel, pre-sorted (case-insensitive,
	// matching the repo's import-sort style). Filtered, never re-ordered.
	const devstackImports: ReadonlyArray<string> = [
		'account',
		'dashboard',
		...(hasPyth ? ['DEEP_PRICE_FEED_ID'] : []),
		...(hasDeepbook ? ['deepbook'] : []),
		'defineDevstack',
		...(isApp ? ['HOST_SERVICE_PORT_TOKEN', 'hostService'] : []),
		'localPackage',
		...(hasSeal ? ['seal'] : []),
		'type Stack',
		'sui',
		...(hasPyth ? ['SUI_PRICE_FEED_ID'] : []),
		...(hasWalrus ? ['walCoin'] : []),
		...(isApp ? ['wallet'] : []),
		...(hasWalrus ? ['walrus'] : []),
	];

	const lines: string[] = [
		'// This file defines the local development stack for this app. Each service',
		'// is one factory call; `defineDevstack` wires the referenced members together.',
		'// `pnpm dev` boots the stack and regenerates typed clients in src/generated/.',
		'',
		"import { dirname, resolve } from 'node:path';",
		"import { fileURLToPath } from 'node:url';",
		'',
		'import {',
		...devstackImports.map((name) => `\t${name},`),
		"} from '@mysten-incubation/devstack';",
		'',
		'const HERE = dirname(fileURLToPath(import.meta.url));',
		'',
		'const localnet = sui();',
	];

	if (hasWalrus) {
		lines.push(
			'const storage = walrus({ local: { nodeCount: 1 } });',
			"const alice = account('alice', {",
			"\tkind: 'ephemeral',",
			'\tfunding: [',
			"\t\t{ coin: 'sui', amount: 1_000_000_000n },",
			'\t\t{ coin: walCoin(storage), amount: 500_000_000n },',
			'\t],',
			'});',
		);
	} else {
		lines.push(
			"const alice = account('alice', {",
			"\tkind: 'ephemeral',",
			"\tfunding: [{ coin: 'sui', amount: 1_000_000_000n }],",
			'});',
		);
	}

	lines.push(
		"const counter = localPackage('counter', {",
		"\tsourcePath: resolve(HERE, 'move/counter'),",
		'\tpublisher: alice,',
		'});',
	);

	if (hasSeal) {
		lines.push(
			"const sealSigner = account('seal_signer', {",
			"\tkind: 'ephemeral',",
			"\tfunding: [{ coin: 'sui', amount: 1_000_000_000n }],",
			'});',
			"const sealKeyServer = seal({ mode: 'local-keygen', signer: sealSigner });",
		);
	}

	if (hasDeepbook) {
		// DeepBook's Move package is pulled from upstream (no vendored tree) and
		// the pool list is omitted, so `deepbook(...)` synthesizes a default
		// DEEP/SUI pool. The publisher needs ample SUI for the publish + pool
		// creation gas. See examples/deepbook-trader for multi-pool + Pyth.
		lines.push(
			"const deepbookPublisher = account('deepbook_publisher', {",
			"\tkind: 'ephemeral',",
			"\tfunding: [{ coin: 'sui', amount: 1_000_000_000_000n }],",
			'});',
			"const deepbookPackage = localPackage('deepbook', {",
			'\tgit: {',
			"\t\turl: 'https://github.com/MystenLabs/deepbookv3.git',",
			"\t\tsubdir: 'packages/deepbook',",
			"\t\trev: 'main',",
			'\t},',
			'\tpublisher: deepbookPublisher,',
			'\tcapture: {',
			"\t\tregistryId: '::registry::Registry',",
			"\t\tadminCapId: '::registry::DeepbookAdminCap',",
			'\t},',
			'});',
		);
		if (hasPyth) {
			// Local mock Pyth: publish the sandbox package from git, then feed
			// DEEP + SUI prices for the default pool. The deepbook publisher
			// doubles as the feed pusher.
			lines.push(
				"const pythPackage = localPackage('pyth', {",
				'\tgit: {',
				"\t\turl: 'https://github.com/MystenLabs/deepbook-sandbox.git',",
				"\t\tsubdir: 'sandbox/packages/pyth',",
				"\t\trev: 'main',",
				'\t},',
				'\tpublisher: deepbookPublisher,',
				'});',
				'const dex = deepbook({',
				"\tmode: 'local',",
				'\tpublisher: deepbookPublisher,',
				'\tpackage: deepbookPackage,',
				'\tpyth: {',
				'\t\tpackage: pythPackage,',
				'\t\tpusher: deepbookPublisher,',
				'\t\tfeeds: [',
				"\t\t\t{ symbol: 'DEEP', feedId: DEEP_PRICE_FEED_ID, initialPrice: 2_000_000n, expo: -8 },",
				"\t\t\t{ symbol: 'SUI', feedId: SUI_PRICE_FEED_ID, initialPrice: 345_000_000n, expo: -8 },",
				'\t\t],',
				'\t},',
				'});',
			);
		} else {
			lines.push(
				"const dex = deepbook({ mode: 'local', publisher: deepbookPublisher, package: deepbookPackage });",
			);
		}
	}

	// The selected services' stack roots, in render order. In the app
	// template these ride along on the host service's `after`; in the ts
	// template they are stack members directly (nothing else references the
	// seal key server, and `defineDevstack` only composes members plus
	// their transitive dependency refs).
	const serviceRoots: ReadonlyArray<string> = [
		...(hasWalrus ? ['storage'] : []),
		...(hasSeal ? ['sealKeyServer'] : []),
		...(hasDeepbook ? ['dex'] : []),
	];

	if (isApp) {
		const walletAccounts = hasSeal ? 'alice, sealSigner' : 'alice';
		const after = ['localnet', 'counter', 'devWallet', ...serviceRoots];
		lines.push(
			`const devWallet = wallet({ accounts: [${walletAccounts}] });`,
			'const app = hostService({',
			"\tname: 'app',",
			'\tscript: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,',
			'\tcwd: HERE,',
			'\tport: 5179,',
			"\tready: { kind: 'http' },",
			`\tafter: [${after.join(', ')}],`,
			'});',
		);
	}

	const members = isApp
		? ['localnet', 'app', 'dashboard()']
		: ['localnet', 'counter', ...serviceRoots, 'dashboard()'];

	lines.push(
		'',
		'const stack: Stack = defineDevstack({',
		`\tmembers: [${members.join(', ')}],`,
		'\t// `pnpm dev` boots this primary stack (codegen → src/generated);',
		'\t// `pnpm test:e2e` boots an isolated `test` stack so tests run in',
		'\t// parallel without clobbering it.',
		"\tstackName: 'dev',",
		'});',
		'',
		'export default stack;',
		'',
	);

	return lines.join('\n');
}
