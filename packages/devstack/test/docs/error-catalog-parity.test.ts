// Error-catalog doc-parity test (errors.mdx <-> each plugin's errors.ts).
//
// Why: the user-facing error catalog (`docs/content/devstack/errors.mdx`)
// plus the per-feature "Failure surface" sections enumerate the tagged
// errors a consumer can `Effect.catchTag(...)`. A previous revision of
// the catalog fabricated shapes that don't exist in source:
//   - `FaucetStrategyMissing` (the real missing-strategy error is the
//     substrate `StrategyNotFoundError`);
//   - Sui `SeedManifestMismatchError` / `SuiFundsReadyError` (the real
//     `SuiError` union is `SuiPluginError | SuiCliError | SuiConfigError
//     | ForkUnsupportedError`);
//   - `FaucetExhausted.kind: 'wall-clock' | 'attempts'` (the real field
//     is `attempts: number`, no `kind`);
//   - `FaucetBodyError.reason: '… | malformed-body | …'` (the real union
//     is `'failure-status' | 'invalid-json'`);
//   - `ActionError` phase `'parse'` (removed — `ActionPhase` is
//     `'discriminator' | 'build' | 'sign' | 'execute-failed' | 'verify'`).
// A copy-paster who wrote `catchTag('FaucetStrategyMissing', …)` or
// `err.kind === 'wall-clock'` got dead, never-firing, non-type-checking
// code. No test guarded the catalog, so the drift shipped.
//
// Source of truth: each plugin's `*_ERROR_TAGS` array (imported, so a
// rename breaks compilation here) plus the discriminator-union texts in
// the corresponding `errors.ts`. Doc surface: the `## <Plugin>` sections
// of `errors.mdx`. The two assertions are:
//   (1) Completeness + no-fabrication: the set of `_tag`-shaped tokens
//       this catalog documents equals the set of real exported tags
//       (union over every plugin + the one app-facing substrate tag).
//       This catches both a missing real tag AND an invented one.
//   (2) Discriminator parity: the high-risk discriminator unions the
//       catalog spells out (`FaucetBodyError.reason`, `ActionError`
//       phase) match the literal union extracted from source, and
//       `FaucetExhausted` is documented via `attempts`, not `kind`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACCOUNT_ERROR_TAGS } from '../../src/plugins/account/errors.ts';
import { ACTION_ERROR_TAGS } from '../../src/plugins/action/errors.ts';
import { COIN_ERROR_TAGS } from '../../src/plugins/coin/errors.ts';
import { DEEPBOOK_ERROR_TAGS } from '../../src/plugins/deepbook/errors.ts';
import type { FaucetError } from '../../src/plugins/faucet/errors.ts';
import { HOST_SERVICE_ERROR_TAGS } from '../../src/plugins/host-service/errors.ts';
import { PACKAGE_ERROR_TAGS } from '../../src/plugins/package/errors.ts';
import { SEAL_ERROR_TAGS } from '../../src/plugins/seal/errors.ts';
import { SUI_ERROR_TAGS } from '../../src/plugins/sui/errors.ts';
import { WALLET_ERROR_TAGS } from '../../src/plugins/wallet/errors.ts';
import { WALRUS_ERROR_TAGS } from '../../src/plugins/walrus/errors.ts';
import { StrategyNotFoundError } from '../../src/substrate/runtime/errors.ts';

const ERRORS_DOC = fileURLToPath(
	new URL('../../../docs/content/devstack/reference/errors.mdx', import.meta.url),
);
const FAUCET_DOC = fileURLToPath(
	new URL('../../../docs/content/devstack/configure/faucet.mdx', import.meta.url),
);
const ACTIONS_DOC = fileURLToPath(
	new URL('../../../docs/content/devstack/configure/actions.mdx', import.meta.url),
);

const FAUCET_ERRORS_SRC = fileURLToPath(
	new URL('../../src/plugins/faucet/errors.ts', import.meta.url),
);
const ACTION_ERRORS_SRC = fileURLToPath(
	new URL('../../src/plugins/action/errors.ts', import.meta.url),
);

// The faucet plugin (unlike its siblings) exposes no runtime
// `*_ERROR_TAGS` array — only the `FaucetError` union type. We declare
// the tag list here and pin it to source with `satisfies`: listing a
// fabricated tag (e.g. `FaucetStrategyMissing`) is a compile error, and
// the exhaustiveness check below catches a tag dropped from this list.
const FAUCET_ERROR_TAGS = [
	'FaucetUnreachable',
	'FaucetExhausted',
	'FaucetBodyError',
	'FaucetConfigError',
] as const satisfies ReadonlyArray<FaucetError['_tag']>;

// Exhaustiveness: every member of the `FaucetError` union must appear in
// the list above. If a new tag is added to the union and not here, this
// assignment fails to type-check (the residual union is non-`never`).
type _FaucetTagsExhaustive =
	Exclude<FaucetError['_tag'], (typeof FAUCET_ERROR_TAGS)[number]> extends never
		? true
		: [
				'FAUCET_ERROR_TAGS is missing a FaucetError _tag',
				Exclude<FaucetError['_tag'], (typeof FAUCET_ERROR_TAGS)[number]>,
			];
const _faucetTagsExhaustive: _FaucetTagsExhaustive = true;
void _faucetTagsExhaustive;

// The single app-facing substrate tag the catalog documents in its
// `## Substrate` section. Pinned to the real class via `satisfies`: if
// `StrategyNotFoundError` is renamed (its `_tag` literal changes), this
// list stops type-checking, forcing the catalog + test to follow.
const SUBSTRATE_DOC_TAGS = ['StrategyNotFoundError'] as const satisfies ReadonlyArray<
	InstanceType<typeof StrategyNotFoundError>['_tag']
>;

// Every tagged-error `_tag` a consumer can legitimately catch and that
// the catalog therefore must enumerate (and must NOT invent beyond).
// `ForkIncompatibleError` is contributed by three plugins; the Set
// dedupes it. We import the arrays (not re-type them) so renaming a tag
// in source is a compile error here, and dropping one from `*_ERROR_TAGS`
// is caught by assertion (1).
const realTags = new Set<string>([
	...ACCOUNT_ERROR_TAGS,
	...ACTION_ERROR_TAGS,
	...COIN_ERROR_TAGS,
	...DEEPBOOK_ERROR_TAGS,
	...FAUCET_ERROR_TAGS,
	...HOST_SERVICE_ERROR_TAGS,
	...PACKAGE_ERROR_TAGS,
	...SEAL_ERROR_TAGS,
	...SUI_ERROR_TAGS,
	...WALLET_ERROR_TAGS,
	...WALRUS_ERROR_TAGS,
	...SUBSTRATE_DOC_TAGS,
]);

// A `_tag`-shaped identifier is PascalCase ending in one of the suffixes
// devstack uses for tagged errors. This is deliberately a SUPERSET
// matcher: it must catch a fabricated tag like `FaucetStrategyMissing`,
// `SeedManifestMismatchError`, or `SuiFundsReadyError` even though those
// are not real tags. We then diff the matched set against `realTags`.
// `Exhausted` is in the list precisely because `FaucetExhausted` (a real
// tag) does not end in `Error`; omitting it would let a fabricated
// `*Exhausted` tag slip past.
const TAG_SUFFIXES = [
	'Error',
	'Failed',
	'Timeout',
	'Missing',
	'Mismatch',
	'Unreachable',
	'Unsupported',
	'Exhausted',
] as const;
const TAG_TOKEN = new RegExp(`^[A-Z][A-Za-z0-9]*(?:${TAG_SUFFIXES.join('|')})$`);

// Pull every backtick-quoted `\`SomeTag\`` token from the catalog. The
// catalog always wraps a tag in backticks (it is inline code), so this
// avoids matching prose words and the descriptive sentence text. We only
// treat a backtick run as a tag when the WHOLE run is a single tag-shaped
// identifier — this rejects phase-union spans like `'a' | 'b'`.
const documentedTags = (docText: string): Set<string> => {
	const found = new Set<string>();
	for (const run of docText.matchAll(/`([^`\n]+)`/g)) {
		const segment = run[1];
		if (segment === undefined) continue;
		const trimmed = segment.trim();
		if (TAG_TOKEN.test(trimmed)) found.add(trimmed);
	}
	return found;
};

// Extract a string-literal union (`'a' | 'b' | 'c'`) reachable from
// `anchor` in source text. Used to pin discriminator slots without
// re-typing them in the test.
const literalUnionAfter = (source: string, anchor: RegExp): Set<string> => {
	const at = source.search(anchor);
	if (at === -1) {
		throw new Error(`anchor ${anchor} not found — source shape changed, update this test.`);
	}
	const tail = source.slice(at);
	// Stop at the first `;` (end of the type/union declaration).
	const end = tail.indexOf(';');
	const region = end === -1 ? tail : tail.slice(0, end);
	const literals = [...region.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
	return new Set(literals);
};

describe('Error catalog parity (errors.mdx <-> plugin errors.ts)', () => {
	const catalog = readFileSync(ERRORS_DOC, 'utf8');

	it('documents exactly the real tagged-error set — no missing, no fabricated tag', () => {
		const docTags = documentedTags(catalog);

		const fabricated = [...docTags].filter((t) => !realTags.has(t)).sort();
		expect(
			fabricated,
			`errors.mdx (${ERRORS_DOC}) documents tag(s) that no plugin's \`*_ERROR_TAGS\` exports. ` +
				`Either the tag was invented (delete it from the catalog) or it was renamed in source. ` +
				`Known fabrications this test exists to block: FaucetStrategyMissing (use the substrate ` +
				`StrategyNotFoundError), SeedManifestMismatchError / SuiFundsReadyError (not real Sui tags).`,
		).toEqual([]);

		const undocumented = [...realTags].filter((t) => !docTags.has(t)).sort();
		expect(
			undocumented,
			`Real tagged error(s) exported from a plugin's \`*_ERROR_TAGS\` but absent from the catalog ` +
				`(${ERRORS_DOC}). Every catchable tag must appear in the error catalog.`,
		).toEqual([]);
	});

	it('FaucetBodyError.reason union in the catalog matches faucet/errors.ts', () => {
		const realReasons = literalUnionAfter(
			readFileSync(FAUCET_ERRORS_SRC, 'utf8'),
			/readonly reason:/,
		);
		// 'failure-status' | 'invalid-json' — and explicitly NOT 'malformed-body'.
		expect(realReasons).toEqual(new Set(['failure-status', 'invalid-json']));
		for (const reason of realReasons) {
			expect(
				catalog,
				`FaucetBodyError reason '${reason}' is in source but not documented in ${ERRORS_DOC}.`,
			).toContain(`'${reason}'`);
		}
		// The fabricated reason must not reappear in either catalog page.
		expect(catalog, 'catalog reintroduced the fabricated FaucetBodyError reason').not.toContain(
			'malformed-body',
		);
	});

	it('ActionError phase union in the catalog matches action/errors.ts (no resurrected "parse")', () => {
		const realPhases = literalUnionAfter(
			readFileSync(ACTION_ERRORS_SRC, 'utf8'),
			/export type ActionPhase =/,
		);
		expect(realPhases).toEqual(
			new Set(['discriminator', 'build', 'sign', 'execute-failed', 'verify']),
		);
		expect(realPhases.has('parse'), 'ActionPhase must not include parse').toBe(false);

		// The catalog's ActionError line must list exactly the real phases.
		const actionLine = catalog
			.split('\n')
			.find((l) => l.includes('discriminator') && l.includes('execute-failed'));
		expect(actionLine, 'could not find the ActionError phase line in errors.mdx').toBeDefined();
		for (const phase of realPhases) {
			expect(actionLine, `ActionError phase '${phase}' missing from catalog line`).toContain(
				`'${phase}'`,
			);
		}
		expect(
			actionLine,
			'catalog ActionError line resurrected the removed parse phase',
		).not.toContain("'parse'");
	});

	it('FaucetExhausted is documented via attempts, not a nonexistent kind discriminator', () => {
		const faucetDoc = readFileSync(FAUCET_DOC, 'utf8');
		// `FaucetExhausted` has `attempts: number` and NO `kind`. The catalog
		// must not advertise a `kind` field for it, and the catch-example must
		// not branch on `err.kind` (a TS error + always-falsy at runtime).
		for (const [path, text] of [
			[ERRORS_DOC, catalog],
			[FAUCET_DOC, faucetDoc],
		] as const) {
			const faucetSection = text.slice(text.indexOf('FaucetExhausted'));
			expect(
				faucetSection,
				`FaucetExhausted should be documented with the real \`attempts\` field in ${path}.`,
			).toContain('attempts');
		}
		// No page may show `kind: 'wall-clock' | 'attempts'` or `err.kind ===`.
		expect(catalog, 'errors.mdx still advertises a FaucetExhausted.kind field').not.toMatch(
			/FaucetExhausted[^\n]*kind:/,
		);
		expect(
			catalog,
			'errors.mdx catch-example still branches on the nonexistent err.kind',
		).not.toContain('err.kind');
	});

	it('the missing-strategy tag is the substrate StrategyNotFoundError, never a Faucet* tag', () => {
		const faucetDoc = readFileSync(FAUCET_DOC, 'utf8');
		const actionsDoc = readFileSync(ACTIONS_DOC, 'utf8');
		for (const [path, text] of [
			[ERRORS_DOC, catalog],
			[FAUCET_DOC, faucetDoc],
			[ACTIONS_DOC, actionsDoc],
		] as const) {
			expect(
				text,
				`${path} references the fabricated FaucetStrategyMissing tag — the real one is the ` +
					`substrate StrategyNotFoundError.`,
			).not.toContain('FaucetStrategyMissing');
		}
		// The catalog must actually document the real substrate tag.
		expect(
			catalog,
			`errors.mdx must document the substrate StrategyNotFoundError (the real missing-strategy tag).`,
		).toContain('StrategyNotFoundError');
	});
});
