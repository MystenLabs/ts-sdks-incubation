// The renderer is the ONE generated file in a scaffolded app — lock its
// output. Exact strings for the empty + all-services corners of each
// template; structural assertions (markers present/absent, import hygiene)
// for every one of the 4 service combos × 2 templates.

import { describe, expect, it } from 'vitest';

import { renderDevstackConfig, TEMPLATE_IDS, type TemplateId } from '../src/render-config.js';
import { SERVICE_IDS, type ServiceId } from '../src/services.js';

const ALL_COMBOS: ReadonlyArray<ReadonlyArray<ServiceId>> = [
	[],
	['walrus'],
	['seal'],
	['deepbook'],
	['pyth'],
	['walrus', 'seal'],
	['seal', 'deepbook'],
	['deepbook', 'pyth'],
	['walrus', 'seal', 'deepbook', 'pyth'],
];

const HEADER = [
	'// This file defines the local development stack for this app. Each service',
	'// is one factory call; `defineDevstack` wires the referenced members together.',
	'// `pnpm dev` boots the stack and regenerates typed clients in src/generated/.',
];

const NODE_IMPORTS = [
	"import { dirname, resolve } from 'node:path';",
	"import { fileURLToPath } from 'node:url';",
];

const APP_ALL = [
	...HEADER,
	'',
	...NODE_IMPORTS,
	'',
	'import {',
	'\taccount,',
	'\tdashboard,',
	'\tDEEP_PRICE_FEED_ID,',
	'\tdeepbook,',
	'\tdefineDevstack,',
	'\tHOST_SERVICE_PORT_TOKEN,',
	'\thostService,',
	'\tlocalPackage,',
	'\tseal,',
	'\ttype Stack,',
	'\tsui,',
	'\tSUI_PRICE_FEED_ID,',
	'\twalCoin,',
	'\twallet,',
	'\twalrus,',
	"} from '@mysten-incubation/devstack';",
	'',
	'const HERE = dirname(fileURLToPath(import.meta.url));',
	'',
	'const localnet = sui();',
	'const storage = walrus({ local: { nodeCount: 1 } });',
	"const alice = account('alice', {",
	"\tkind: 'ephemeral',",
	'\tfunding: [',
	"\t\t{ coin: 'sui', amount: 1_000_000_000n },",
	'\t\t{ coin: walCoin(storage), amount: 500_000_000n },',
	'\t],',
	'});',
	"const counter = localPackage('counter', {",
	"\tsourcePath: resolve(HERE, 'move/counter'),",
	'\tpublisher: alice,',
	'});',
	"const sealSigner = account('seal_signer', {",
	"\tkind: 'ephemeral',",
	"\tfunding: [{ coin: 'sui', amount: 1_000_000_000n }],",
	'});',
	"const sealKeyServer = seal({ mode: 'local-keygen', signer: sealSigner });",
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
	'const devWallet = wallet({ accounts: [alice, sealSigner] });',
	'const app = hostService({',
	"\tname: 'app',",
	'\tscript: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,',
	'\tcwd: HERE,',
	'\tport: 5179,',
	"\tready: { kind: 'http' },",
	'\tafter: [localnet, counter, devWallet, storage, sealKeyServer, dex],',
	'});',
	'',
	'const stack: Stack = defineDevstack({',
	'\tmembers: [localnet, app, dashboard()],',
	'\t// `pnpm dev` boots this primary stack (codegen → src/generated);',
	'\t// `pnpm test:e2e` boots an isolated `test` stack so tests run in',
	'\t// parallel without clobbering it.',
	"\tstackName: 'dev',",
	'});',
	'',
	'export default stack;',
	'',
].join('\n');

const APP_NONE = [
	...HEADER,
	'',
	...NODE_IMPORTS,
	'',
	'import {',
	'\taccount,',
	'\tdashboard,',
	'\tdefineDevstack,',
	'\tHOST_SERVICE_PORT_TOKEN,',
	'\thostService,',
	'\tlocalPackage,',
	'\ttype Stack,',
	'\tsui,',
	'\twallet,',
	"} from '@mysten-incubation/devstack';",
	'',
	'const HERE = dirname(fileURLToPath(import.meta.url));',
	'',
	'const localnet = sui();',
	"const alice = account('alice', {",
	"\tkind: 'ephemeral',",
	"\tfunding: [{ coin: 'sui', amount: 1_000_000_000n }],",
	'});',
	"const counter = localPackage('counter', {",
	"\tsourcePath: resolve(HERE, 'move/counter'),",
	'\tpublisher: alice,',
	'});',
	'const devWallet = wallet({ accounts: [alice] });',
	'const app = hostService({',
	"\tname: 'app',",
	'\tscript: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,',
	'\tcwd: HERE,',
	'\tport: 5179,',
	"\tready: { kind: 'http' },",
	'\tafter: [localnet, counter, devWallet],',
	'});',
	'',
	'const stack: Stack = defineDevstack({',
	'\tmembers: [localnet, app, dashboard()],',
	'\t// `pnpm dev` boots this primary stack (codegen → src/generated);',
	'\t// `pnpm test:e2e` boots an isolated `test` stack so tests run in',
	'\t// parallel without clobbering it.',
	"\tstackName: 'dev',",
	'});',
	'',
	'export default stack;',
	'',
].join('\n');

const TS_ALL = [
	...HEADER,
	'',
	...NODE_IMPORTS,
	'',
	'import {',
	'\taccount,',
	'\tdashboard,',
	'\tDEEP_PRICE_FEED_ID,',
	'\tdeepbook,',
	'\tdefineDevstack,',
	'\tlocalPackage,',
	'\tseal,',
	'\ttype Stack,',
	'\tsui,',
	'\tSUI_PRICE_FEED_ID,',
	'\twalCoin,',
	'\twalrus,',
	"} from '@mysten-incubation/devstack';",
	'',
	'const HERE = dirname(fileURLToPath(import.meta.url));',
	'',
	'const localnet = sui();',
	'const storage = walrus({ local: { nodeCount: 1 } });',
	"const alice = account('alice', {",
	"\tkind: 'ephemeral',",
	'\tfunding: [',
	"\t\t{ coin: 'sui', amount: 1_000_000_000n },",
	'\t\t{ coin: walCoin(storage), amount: 500_000_000n },',
	'\t],',
	'});',
	"const counter = localPackage('counter', {",
	"\tsourcePath: resolve(HERE, 'move/counter'),",
	'\tpublisher: alice,',
	'});',
	"const sealSigner = account('seal_signer', {",
	"\tkind: 'ephemeral',",
	"\tfunding: [{ coin: 'sui', amount: 1_000_000_000n }],",
	'});',
	"const sealKeyServer = seal({ mode: 'local-keygen', signer: sealSigner });",
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
	'',
	'const stack: Stack = defineDevstack({',
	'\tmembers: [localnet, counter, storage, sealKeyServer, dex, dashboard()],',
	'\t// `pnpm dev` boots this primary stack (codegen → src/generated);',
	'\t// `pnpm test:e2e` boots an isolated `test` stack so tests run in',
	'\t// parallel without clobbering it.',
	"\tstackName: 'dev',",
	'});',
	'',
	'export default stack;',
	'',
].join('\n');

const TS_NONE = [
	...HEADER,
	'',
	...NODE_IMPORTS,
	'',
	'import {',
	'\taccount,',
	'\tdashboard,',
	'\tdefineDevstack,',
	'\tlocalPackage,',
	'\ttype Stack,',
	'\tsui,',
	"} from '@mysten-incubation/devstack';",
	'',
	'const HERE = dirname(fileURLToPath(import.meta.url));',
	'',
	'const localnet = sui();',
	"const alice = account('alice', {",
	"\tkind: 'ephemeral',",
	"\tfunding: [{ coin: 'sui', amount: 1_000_000_000n }],",
	'});',
	"const counter = localPackage('counter', {",
	"\tsourcePath: resolve(HERE, 'move/counter'),",
	'\tpublisher: alice,',
	'});',
	'',
	'const stack: Stack = defineDevstack({',
	'\tmembers: [localnet, counter, dashboard()],',
	'\t// `pnpm dev` boots this primary stack (codegen → src/generated);',
	'\t// `pnpm test:e2e` boots an isolated `test` stack so tests run in',
	'\t// parallel without clobbering it.',
	"\tstackName: 'dev',",
	'});',
	'',
	'export default stack;',
	'',
].join('\n');

/** Named imports of the `@mysten-incubation/devstack` block, in file order. */
function devstackImportsOf(output: string): string[] {
	const match = output.match(/import \{\n([^}]*)\} from '@mysten-incubation\/devstack';/);
	expect(match).not.toBeNull();
	return match![1]!
		.split('\n')
		.map((line) => line.trim().replace(/,$/, ''))
		.filter((line) => line !== '');
}

describe('renderDevstackConfig — exact output', () => {
	it('app template, all services', () => {
		expect(renderDevstackConfig('app', new Set(SERVICE_IDS))).toBe(APP_ALL);
	});

	it('app template, no services', () => {
		expect(renderDevstackConfig('app', new Set())).toBe(APP_NONE);
	});

	it('ts template, all services', () => {
		expect(renderDevstackConfig('ts', new Set(SERVICE_IDS))).toBe(TS_ALL);
	});

	it('ts template, no services', () => {
		expect(renderDevstackConfig('ts', new Set())).toBe(TS_NONE);
	});
});

describe('renderDevstackConfig — every template × service combo', () => {
	for (const template of TEMPLATE_IDS) {
		for (const combo of ALL_COMBOS) {
			const title = `${template} + [${combo.join(', ') || 'none'}]`;
			it(title, () => {
				const out = renderDevstackConfig(template as TemplateId, new Set(combo));
				const hasWalrus = combo.includes('walrus');
				const hasSeal = combo.includes('seal');
				const hasPyth = combo.includes('pyth');
				// `pyth` implies `deepbook` (see normalizeServices).
				const hasDeepbook = combo.includes('deepbook') || hasPyth;

				// Core shape, always.
				expect(out.startsWith('// This file defines the local development stack')).toBe(true);
				expect(out).toContain('const localnet = sui();');
				expect(out).toContain("const counter = localPackage('counter', {");
				expect(out).toContain("\tsourcePath: resolve(HERE, 'move/counter'),");
				expect(out).toContain("const alice = account('alice', {");
				expect(out).toContain('export default stack;');
				// Tabs only, single trailing newline.
				expect(/^ /m.test(out)).toBe(false);
				expect(out.endsWith('\n')).toBe(true);
				expect(out.endsWith('\n\n')).toBe(false);
				expect(out).toContain("stackName: 'dev',");

				// Service markers appear exactly when selected — and never as
				// dead imports/identifiers when not.
				if (hasWalrus) {
					expect(out).toContain('const storage = walrus({ local: { nodeCount: 1 } });');
					expect(out).toContain('{ coin: walCoin(storage), amount: 500_000_000n },');
				} else {
					expect(out).not.toContain('walrus');
					expect(out).not.toContain('walCoin');
					expect(out).not.toContain('storage');
				}
				if (hasSeal) {
					expect(out).toContain("const sealSigner = account('seal_signer', {");
					expect(out).toContain(
						"const sealKeyServer = seal({ mode: 'local-keygen', signer: sealSigner });",
					);
				} else {
					expect(out).not.toContain('seal');
				}
				if (hasDeepbook) {
					expect(out).toContain("const deepbookPublisher = account('deepbook_publisher', {");
					expect(out).toContain("const deepbookPackage = localPackage('deepbook', {");
					if (hasPyth) {
						expect(out).toContain("const pythPackage = localPackage('pyth', {");
						expect(out).toContain('\t\tpackage: pythPackage,');
						expect(out).toContain('feedId: DEEP_PRICE_FEED_ID');
						expect(out).toContain('feedId: SUI_PRICE_FEED_ID');
					} else {
						expect(out).toContain(
							"const dex = deepbook({ mode: 'local', publisher: deepbookPublisher, package: deepbookPackage });",
						);
						expect(out).not.toContain('pyth');
					}
				} else {
					expect(out).not.toContain('deepbook');
					expect(out).not.toContain('pyth');
				}

				const serviceRoots = [
					...(hasWalrus ? ['storage'] : []),
					...(hasSeal ? ['sealKeyServer'] : []),
					...(hasDeepbook ? ['dex'] : []),
				];
				if (template === 'app') {
					const accounts = hasSeal ? 'alice, sealSigner' : 'alice';
					expect(out).toContain(`const devWallet = wallet({ accounts: [${accounts}] });`);
					const after = ['localnet', 'counter', 'devWallet', ...serviceRoots].join(', ');
					expect(out).toContain(`\tafter: [${after}],`);
					expect(out).toContain('\tmembers: [localnet, app, dashboard()],');
					expect(out).toContain('port: 5179');
					expect(out).toContain('HOST_SERVICE_PORT_TOKEN');
				} else {
					expect(out).not.toContain('hostService');
					expect(out).not.toContain('wallet');
					expect(out).not.toContain('HOST_SERVICE_PORT_TOKEN');
					const members = ['localnet', 'counter', ...serviceRoots, 'dashboard()'].join(', ');
					expect(out).toContain(`\tmembers: [${members}],`);
				}

				// Import hygiene: every imported symbol is used in the body.
				const importBlockEnd = out.indexOf("} from '@mysten-incubation/devstack';");
				const body = out.slice(importBlockEnd);
				for (const entry of devstackImportsOf(out)) {
					const symbol = entry.replace(/^type /, '');
					expect(body).toContain(symbol);
				}
			});
		}
	}
});
