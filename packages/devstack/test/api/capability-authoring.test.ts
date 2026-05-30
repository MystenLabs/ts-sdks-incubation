import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	capability,
	capabilitySink,
	codegenable,
	defineCapability,
	type CapabilityDecl,
	type CodegenEmitContext,
} from '../../src/index.ts';

declare module '../../src/index.ts' {
	interface DevstackCapabilityRegistry {
		readonly 'custom-health': {
			readonly url: string;
			readonly intervalMs?: number;
		};
	}
}

const health = capability('custom-health', {
	url: 'http://127.0.0.1:3000/health',
	intervalMs: 250,
});

export const _registeredCapability: CapabilityDecl<'custom-health'> = health;
export const _registeredKind: 'custom-health' = health.kind;
export const _registeredUrl: string = health.url;
export const _registeredInterval: number | undefined = health.intervalMs;

const customHealth = defineCapability('custom-health');

export const _registeredFromBuilder = customHealth({
	url: 'http://127.0.0.1:3000/health',
});

// @ts-expect-error -- registered custom capabilities require their augmented payload shape
export const _registeredMissingRequiredRefused = customHealth({
	intervalMs: 500,
});

export const _registeredExtraFieldRefused = customHealth({
	url: 'http://127.0.0.1:3000/health',
	// @ts-expect-error -- registered custom capabilities reject undeclared payload fields
	timeoutMs: 1_000,
});

export const _customHealthSink = capabilitySink('custom-health', (decl, ctx) => {
	const kind: 'custom-health' = decl.kind;
	const url: string = decl.url;
	const intervalMs: number | undefined = decl.intervalMs;
	const pluginKey = ctx.pluginKey;

	// @ts-expect-error -- sink callbacks receive the registered payload, not an open object
	void decl.timeoutMs;

	void kind;
	void url;
	void intervalMs;
	void pluginKey;

	return Effect.void;
});

export const _openExtensionCapability = capability('third-party-open-extension', {
	label: 'unregistered capability kinds remain structural',
});

export const _codegenWriterCapability = codegenable({
	emitterName: 'custom-codegen',
	outputPath: 'custom.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			const typedCtx: CodegenEmitContext = ctx;
			typedCtx.exportConst('customCodegen', { ok: true });
			typedCtx.importStatement('import type { URL } from "node:url";');
			return typedCtx.done();
		}),
});

export const _rawCodegenReturnRefused = codegenable({
	emitterName: 'raw-codegen-return',
	outputPath: 'raw.ts',
	// @ts-expect-error -- codegen emitters must write through ctx and return ctx.done()
	emit: () => Effect.succeed({ rawReturn: true }),
});

describe('custom capability authoring', () => {
	it('keeps the runtime capability shape structural', () => {
		expect(health).toEqual({
			kind: 'custom-health',
			url: 'http://127.0.0.1:3000/health',
			intervalMs: 250,
		});
		expect(_openExtensionCapability.kind).toBe('third-party-open-extension');
	});
});
