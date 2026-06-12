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

import type { ServiceId } from './services.js';

export type TemplateId = 'app' | 'ts';

export const TEMPLATE_IDS: ReadonlyArray<TemplateId> = ['app', 'ts'];

export function renderDevstackConfig(
	template: TemplateId,
	services: ReadonlySet<ServiceId>,
): string {
	const isApp = template === 'app';
	const hasWalrus = services.has('walrus');
	const hasSeal = services.has('seal');

	// Named imports from the devstack barrel, pre-sorted (case-insensitive,
	// matching the repo's import-sort style). Filtered, never re-ordered.
	const devstackImports: ReadonlyArray<string> = [
		'account',
		'dashboard',
		'defineDevstack',
		...(isApp ? ['HOST_SERVICE_PORT_TOKEN', 'hostService'] : []),
		'localPackage',
		...(hasSeal ? ['seal'] : []),
		'type Stack',
		'sui',
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

	// The selected services' stack roots, in render order. In the app
	// template these ride along on the host service's `after`; in the ts
	// template they are stack members directly (nothing else references the
	// seal key server, and `defineDevstack` only composes members plus
	// their transitive dependency refs).
	const serviceRoots: ReadonlyArray<string> = [
		...(hasWalrus ? ['storage'] : []),
		...(hasSeal ? ['sealKeyServer'] : []),
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
		'});',
		'',
		'export default stack;',
		'',
	);

	return lines.join('\n');
}
