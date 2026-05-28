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
 *  contents. Walks the source with a depth counter so blocks containing
 *  nested `{...}` (structured payload values, inline object literals)
 *  are captured in full — the earlier `\{([^}]*)\}` regex silently
 *  skipped any block with a brace before the closing one. */
const extractKeyExpressionBlocks = (source: string): Array<string> => {
	const blocks: Array<string> = [];
	const openers: ReadonlyArray<{ readonly pattern: RegExp }> = [
		{ pattern: /annotateCurrentSpan\(\s*\{/g },
		{ pattern: /annotateLogs\(\s*\{/g },
		{ pattern: /attributes:\s*\{/g },
	];
	for (const { pattern } of openers) {
		pattern.lastIndex = 0;
		while (pattern.exec(source) !== null) {
			const inner = readBalancedBraceBody(source, pattern.lastIndex);
			if (inner !== null) blocks.push(inner);
		}
	}
	return blocks;
};

/** Starting AFTER an opening `{`, scan forward counting nested braces
 *  while ignoring braces that appear inside string / template /
 *  comment lexemes. Returns the substring between the matched braces,
 *  or `null` if no balanced close is found (malformed source). */
const readBalancedBraceBody = (source: string, start: number): string | null => {
	let depth = 1;
	let i = start;
	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1] ?? '';
		// Line comment — skip to end-of-line.
		if (ch === '/' && next === '/') {
			while (i < source.length && source[i] !== '\n') i += 1;
			continue;
		}
		// Block comment — skip to */
		if (ch === '/' && next === '*') {
			i += 2;
			while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
			i += 2;
			continue;
		}
		// String / template — skip through, honoring backslash escapes.
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			i += 1;
			while (i < source.length) {
				if (source[i] === '\\') {
					i += 2;
					continue;
				}
				if (source[i] === quote) {
					i += 1;
					break;
				}
				// Template substitution `${...}` — skip a balanced inner.
				if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
					i += 2;
					let innerDepth = 1;
					while (i < source.length && innerDepth > 0) {
						if (source[i] === '{') innerDepth += 1;
						else if (source[i] === '}') innerDepth -= 1;
						i += 1;
					}
					continue;
				}
				i += 1;
			}
			continue;
		}
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i);
		}
		i += 1;
	}
	return null;
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

describe('plugin span-attribute namespace discipline — extractor', () => {
	it('captures blocks that contain nested object literals', () => {
		const source = `
			Effect.annotateCurrentSpan({
				'wallet.token': value,
				meta: { nested: 'ok' },
			});
		`;
		const blocks = extractKeyExpressionBlocks(source);
		expect(blocks.length).toBe(1);
		expect(blocks[0]).toContain("'wallet.token'");
		expect(blocks[0]).toContain("nested: 'ok'");
	});

	it('honors string-literal braces (does not split inside template strings)', () => {
		const source = `
			Effect.annotateCurrentSpan({
				'sui.chain': \`prefix \${value}-suffix\`,
				note: '} not a close }',
			});
		`;
		const blocks = extractKeyExpressionBlocks(source);
		expect(blocks.length).toBe(1);
		expect(blocks[0]).toContain("'sui.chain'");
		expect(blocks[0]).toContain('not a close');
	});

	it('captures attributes blocks with nested objects on multiple lines', () => {
		const source = `
			withSpan('foo', {
				attributes: {
					'walrus.aggregator': { url, port },
					'walrus.publisher': otherValue,
				},
			})
		`;
		const blocks = extractKeyExpressionBlocks(source);
		expect(blocks.some((b) => b.includes("'walrus.publisher'"))).toBe(true);
	});
});

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
