// Type-discipline test for `bindings`. Phase 7 rebinds `bindings` to
// `LocalPackageShape` so a misconfigured caller wiring a known-package
// tag (which only satisfies `PackageShape` — no `sourcePath` to read)
// fails at compose time rather than at the first `sui move summary`
// invocation. The negative case is asserted via `@ts-expect-error` —
// if the compatibility ever regresses (e.g. someone widens the input
// shape back to `{packageId: string}` only), the directive stops firing
// and the file fails to compile, breaking `pnpm typecheck`.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { bindings } from './bindings.js';
import { makeTag } from '../advanced/tag.js';
import type { PackageShape } from '../services/package.js';

describe('bindings type discipline', () => {
	it('rejects packages that do not satisfy LocalPackageShape', () => {
		// Shape a `knownPackage`-style factory would produce: the universal
		// `PackageShape` only. Annotating the producer's return type widens
		// `upgradeCapId` so the error TS surfaces is specifically the
		// missing-`sourcePath` mismatch with `LocalPackageShape` (rather
		// than an incidental literal-type quirk on `upgradeCapId`).
		const knownOnlyTag = makeTag(
			'knownOnly',
			Effect.succeed<PackageShape>({
				name: 'knownOnly',
				packageId: '0x1',
				upgradeCapId: undefined,
			}),
		);
		// @ts-expect-error — `knownOnlyTag` provides only `PackageShape`
		// (no `sourcePath` / `mvrPlaceholder` / `captured`), so it cannot
		// satisfy `LocalPackageShape` and the compose-time signature on
		// `bindings.packages` must reject it.
		bindings({ packages: [knownOnlyTag], output: './out' });

		expect(true).toBe(true);
	});
});
