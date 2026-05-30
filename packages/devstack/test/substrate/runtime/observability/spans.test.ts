// `spanWithLabels` bakes the canonical identity attribute footprint
// onto every wrapped span — `devstack.app` + `devstack.stack` pulled
// from the ambient `IdentityContext`, plus `devstack.plugin` from the
// caller-supplied label. Dashboards filter / group by `[plugin]`, so
// the helper has to set the attribute on every span that flows
// through it. This test pins that contract at the span-attribute
// level — if a future refactor stops reading IdentityContext, or
// stops baking one of the canonical keys, this test catches it.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../../src/substrate/brand.ts';
import {
	SpanAttr,
	spanWithLabels,
} from '../../../../src/substrate/runtime/observability/index.ts';
import { layerIdentity } from '../../../../src/substrate/runtime/paths.ts';

describe('spanWithLabels', () => {
	it.effect('bakes app/stack/plugin from IdentityContext + labels onto the span', () =>
		Effect.gen(function* () {
			const span = yield* Effect.currentSpan.pipe(
				spanWithLabels(
					'test.span',
					{ plugin: pluginKey('sui'), endpoint: 'rpc', op: 'boot' },
					{ extraKey: 'extra-value' },
				),
			);

			expect(span.name).toBe('test.span');
			expect(span.attributes.get(SpanAttr.app)).toBe('test-app');
			expect(span.attributes.get(SpanAttr.stack)).toBe('test-stack');
			expect(span.attributes.get(SpanAttr.plugin)).toBe('sui');
			expect(span.attributes.get(SpanAttr.endpointKey)).toBe('rpc');
			expect(span.attributes.get(SpanAttr.op)).toBe('boot');
			// `extras` keys flow through verbatim — callers can still
			// attach per-call attributes on top of the canonical footprint.
			expect(span.attributes.get('extraKey')).toBe('extra-value');
		}).pipe(
			Effect.provide(
				layerIdentity({
					app: appName('test-app'),
					stack: stackName('test-stack'),
					chain: chainId('sui:test'),
				}),
			),
		),
	);
});
