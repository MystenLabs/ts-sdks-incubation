// Span-attribute namespace discipline (STYLE_GUIDE §16).
//
// Plugin code MUST pass span-attribute keys through a namespace
// constant (`WalletSpans.token`, `SuiSpans.chain`, etc.) — never as
// a free-form string literal like `'wallet.token'`. Generic OTEL /
// engine keys (`http.method`, `server.address`, `error.code`,
// `devstack.app`) flow through `SpanAttr.*` from
// `substrate/runtime/observability/spans.ts`; plugin-domain keys
// live next to the plugin in `src/plugins/<name>/spans.ts`.
//
// The check finds calls to `Effect.annotateCurrentSpan`,
// `Effect.annotateLogs`, and `attributes:` inside a `withSpan` block,
// and fails on any plugin-prefixed string literal used as a key.
// Generic OTEL keys (matching one of the GENERIC_PREFIXES) are
// allowed; symbol-keyed entries (`[XxxSpans.foo]: ...`) are allowed.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const PLUGINS_ROOT = new URL('../../src/plugins/', import.meta.url).pathname;
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** Generic prefixes whose keys live in substrate `SpanAttr` (engine-
 *  dimensional + OTEL conventions). Free-form string literals matching
 *  one of these prefixes are allowed because the substrate's `SpanAttr`
 *  is the canonical namespace for them. */
const GENERIC_PREFIXES = [
	'devstack.',
	'http.',
	'server.',
	'error.',
	'process.exit.',
	'container.',
	'event.',
	'log.',
	'roster.',
	'stageAndSwap.',
] as const;

const PLUGIN_PREFIX_REGEX =
	/['"]((?:sui|walrus|seal|wallet|account|coin|package|faucet|deepbook|pyth|postgres|action)\.[a-zA-Z][a-zA-Z0-9._-]*)['"]/g;

const isGenericKey = (key: string): boolean =>
	GENERIC_PREFIXES.some((prefix) => key.startsWith(prefix));

const collectPluginFiles = (dir: string, acc: Array<string>): Array<string> => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			collectPluginFiles(full, acc);
		} else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			acc.push(full);
		}
	}
	return acc;
};

/** Project blocks containing `annotateCurrentSpan({ ... })` /
 *  `annotateLogs({ ... })` / `attributes: { ... }` and return their
 *  contents. Naive single-line + simple-multi-line scan — fine for the
 *  plugin code's actual usage shape. */
const extractKeyExpressionBlocks = (source: string): Array<string> => {
	const blocks: Array<string> = [];
	const patterns = [
		/annotateCurrentSpan\(\s*\{([^}]*)\}/g,
		/annotateLogs\(\s*\{([^}]*)\}/g,
		/attributes:\s*\{([^}]*)\}/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			blocks.push(match[1] ?? '');
		}
	}
	return blocks;
};

interface Offender {
	readonly path: string;
	readonly keys: ReadonlyArray<string>;
}

const findOffenders = (): Array<Offender> => {
	const files = collectPluginFiles(PLUGINS_ROOT, []);
	const offenders: Array<Offender> = [];
	for (const file of files) {
		// Skip spans.ts files themselves — they DEFINE the wire strings.
		if (file.endsWith('/spans.ts')) continue;
		const source = readFileSync(file, 'utf8');
		const blocks = extractKeyExpressionBlocks(source);
		const offendingKeys = new Set<string>();
		for (const block of blocks) {
			for (const match of block.matchAll(PLUGIN_PREFIX_REGEX)) {
				const key = match[1]!;
				if (isGenericKey(key)) continue;
				offendingKeys.add(key);
			}
		}
		if (offendingKeys.size > 0) {
			offenders.push({
				path: relative(REPO_ROOT, file).replace(/\\/g, '/'),
				keys: [...offendingKeys],
			});
		}
	}
	return offenders;
};

describe('plugin span-attribute namespace discipline', () => {
	it('plugin code MUST NOT pass plugin-prefixed string literals as span attribute keys', () => {
		const offenders = findOffenders();
		if (offenders.length > 0) {
			const report = offenders
				.map((entry) => `  - ${entry.path} uses literals: [${entry.keys.join(', ')}]`)
				.join('\n');
			throw new Error(
				`Span-attribute namespace violation (STYLE_GUIDE §16). The following ` +
					`plugin files pass plugin-prefixed string literals as attribute keys ` +
					`instead of routing through the per-plugin namespace ` +
					`(\`WalletSpans.token\`, \`SuiSpans.chain\`, etc.):\n${report}\n\n` +
					`Lift each literal into the plugin's \`spans.ts\` namespace and reference ` +
					`it as \`[XxxSpans.key]: value\`.`,
			);
		}
		expect(offenders).toEqual([]);
	});
});
