// E2E harness coverage for router/codegen capability sink delivery.
//
// This deliberately uses the runBoot harness's stub Traefik container
// layer, fake router upstream resolver, and stub Move-codegen services.
// It proves harvested `routable` and `codegenable` capabilities travel
// through the shared production sink builder into injected services and
// temp output dirs; it does not claim real router network traffic.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import type { RoutableDecl } from '../../src/contracts/routable.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import { runBoot } from './boot-config-impl.ts';

interface SinkProofValue {
	readonly ready: true;
}

const routable: RoutableDecl = {
	kind: 'routable',
	endpointName: 'wallet-app',
	dispatchId: {
		compositeKey: 'sink-proof',
		role: 'api',
	},
	upstream: { type: 'host-loopback', port: 49152 },
	cors: true,
	wireProtocol: 'http',
};

const codegenable: CodegenableDecl<'sink-proof-config'> = {
	kind: 'codegenable',
	emitterName: 'sink-proof-config',
	outputPath: 'sink-proof/config.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('sinkProofConfig', {
				message: 'delivered-through-codegen-sink',
			});
			return ctx.done();
		}),
};

const sinkProofPlugin = definePlugin({
	id: 'sink-proof',
	kind: 'leaf-long-running',
	start: () => Effect.succeed({ ready: true } satisfies SinkProofValue),
	capabilities: [routable, codegenable] as const,
});

describe('runBoot router/codegen shared capability sink wiring', () => {
	it('delivers routable/codegenable capabilities to stub-backed sinks and temp outputs', async () => {
		const result = await runBoot({
			stack: {
				members: [sinkProofPlugin],
				options: { stackName: 'main' },
			},
			appName: 'harness-sinks',
			stackName: 'main',
			runCodegen: true,
		});

		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect(result.readyKeys).toEqual(['sink-proof#0']);

		expect(result.routerEndpoints).toHaveLength(1);
		expect(result.routerEndpoints[0]).toMatchObject({
			pluginKey: 'sink-proof#0',
			endpoint: {
				endpointName: 'wallet-app',
				hostname: 'api.harness-sinks.localhost',
				entrypointPort: 6173,
				url: 'http://api.harness-sinks.localhost:6173',
				wireProtocol: 'http',
			},
		});
		expect(result.routerAppliedRoutes).toHaveLength(1);
		expect(result.routerAppliedRoutes[0]?.upstreamUrl).toBe('http://127.0.0.1:49152');
		expect(result.routerDispatchDir).toMatch(/[/\\]dispatch$/);
		expect(result.routerDispatchDir.startsWith(result.runtimeRoot)).toBe(false);

		expect(result.codegenables).toEqual([
			{
				pluginKey: 'sink-proof#0',
				emitterName: 'sink-proof-config',
				outputPath: 'sink-proof/config.ts',
				sensitive: false,
			},
		]);
		expect(result.codegenRun).not.toBeNull();
		expect(result.codegenRun!.outputDir).toBe(result.codegenOutputDir);
		expect(result.codegenOutputDir.startsWith(result.runtimeRoot)).toBe(true);
		expect(result.codegenRun!.result.filesWritten).toContain(
			join(result.codegenOutputDir, 'sink-proof', 'config.ts'),
		);

		const generatedPath = join(result.codegenOutputDir, 'sink-proof', 'config.ts');
		expect(existsSync(generatedPath)).toBe(true);
		expect(readFileSync(generatedPath, 'utf8')).toContain('delivered-through-codegen-sink');
		expect(generatedPath.startsWith(result.runtimeRoot)).toBe(true);
	});
});
