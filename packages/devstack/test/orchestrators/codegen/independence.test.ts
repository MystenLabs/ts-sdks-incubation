// Phase 1 guardrail tests — codegen / typecheck / build independence.
//
// The plan (notes/docs-and-api-restructure-plan.md, Phase 1) asserts three
// owner invariants that 0b made cleanly true (the `@devstack-dev` alias —
// the one thing that previously needed apply-before-tsc — is deleted):
//
//   (a) `devstack codegen` runs with NO running stack and NO prior
//       `devstack apply`. Codegen derives its committed-tree contributions
//       from config ALONE (each plugin's `staticCodegen` hook) and needs
//       only host `sui` for `move summary` — never a booted supervisor,
//       Docker, or live deployment.
//   (b) A clean tree type-checks + `vite build` is green with NO stack, NO
//       apply, and NO codegen re-run — the committed `src/generated` tree is
//       the ENTIRE type surface; ids/data resolve at runtime. The cheap,
//       non-flaky signal: the build path's deployment injection produces a
//       static literal (`null` when nothing is committed) and never reaches
//       into apply/boot/supervisor code.
//   (c) A build with NO injected deployment COMPILES (injects a literal
//       `null`) but throws `DevstackConfigMissingError` only at RUNTIME.
//
// Style note: the *strongest* end-to-end signal for (b) — a real `tsc -b` +
// `vite build` over a committed example with no stack — is exercised by the
// orchestrator (`pnpm --filter <example> typecheck` / `build`) and is too
// heavy / Docker-adjacent to pin as a fast unit. We encode the LIGHTER,
// load-bearing invariants here (the import graph carries no stack dependency;
// the build path injects a static literal; runtime load throws) and leave the
// full clean-build to CI's per-example typecheck. The boundary is intentional.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import * as ts from 'typescript';

import { deriveContributions } from '../../../src/cli/wirings/codegen.ts';
import { CONFIG_RUNTIME_SOURCE } from '../../../src/orchestrators/codegen/config-runtime.ts';
import { devstackVitePlugin } from '../../../src/build-integrations/vite/index.ts';
import type { AnyPlugin } from '../../../src/substrate/plugin.ts';
import type { CodegenableDecl } from '../../../src/contracts/codegenable.ts';
import { withTempRootAsync } from '../../helpers/with-temp-root.ts';

const HERE = resolve(import.meta.dirname, '../../..');

// ---------------------------------------------------------------------------
// (a) `devstack codegen` needs no stack / no apply.
// ---------------------------------------------------------------------------

describe('(a) codegen is stack-free and apply-free', () => {
	// Behavioral half: `deriveContributions` — the single seam the `codegen`
	// verb uses to turn the stack's members into committed-tree decls — is a
	// pure walk over each member's `staticCodegen()` hook. It performs NO
	// acquire / boot / supervise. A plain object carrying only a `staticCodegen`
	// function (NOT a live, started plugin) is enough to drive it, proving the
	// derivation never touches a running deployment.
	it('deriveContributions runs against unstarted plugin decls (no acquire/boot)', () => {
		// A minimal valid decl. `emit` is required by the contract but is never
		// invoked by `deriveContributions` (it only collects the decls).
		const noopEmit = (() => {
			throw new Error('emit must NOT run during derivation');
		}) as unknown as CodegenableDecl['emit'];
		const decl = (emitterName: string, outputPath: string): CodegenableDecl => ({
			kind: 'codegenable',
			emitterName,
			outputPath,
			emit: noopEmit,
		});
		// Fakes: only the field `deriveContributions` reads is present. Crucially
		// `start` is never called — if derivation booted the plugin this would
		// throw. A member WITHOUT `staticCodegen` is simply skipped.
		let started = false;
		const withCodegen = {
			staticCodegen: () => [decl('counter', 'counter.ts')],
			start: () => {
				started = true;
				throw new Error('codegen must NOT start/boot a plugin');
			},
		} as unknown as AnyPlugin;
		const liveOnly = {
			// No `staticCodegen` → live-only plugin (e.g. a service that resolves
			// at acquire time); derivation skips it rather than booting it.
			start: () => {
				started = true;
				throw new Error('codegen must NOT start/boot a plugin');
			},
		} as unknown as AnyPlugin;

		const decls = deriveContributions([withCodegen, liveOnly]);
		expect(started).toBe(false);
		expect(decls).toEqual([decl('counter', 'counter.ts')]);
	});

	// Structural half: the `codegen` verb wiring's import graph carries NO
	// runtime dependency on boot / supervisor / apply / Docker / snapshot.
	// (`SupervisedStack` is imported as a TYPE only — it is erased and never
	// boots anything.) This pins invariant (a) at the wiring level: a future
	// edit that made codegen depend on a booted stack would trip this guard.
	it('the codegen verb wiring imports no boot/apply/supervisor/docker runtime', () => {
		const src = readFileSync(join(HERE, 'src/cli/wirings/codegen.ts'), 'utf8');
		// `import { ... } from '...boot...'` etc. — value imports only. A
		// `import type { SupervisedStack }` line is allowed (type-erased).
		const valueImports = src
			.split('\n')
			.filter((l) => /^\s*import\b/.test(l) && !/^\s*import\s+type\b/.test(l));
		for (const forbidden of ['boot', 'supervis', 'snapshot', 'docker', 'apply.ts']) {
			const offending = valueImports.filter((l) => l.toLowerCase().includes(forbidden));
			expect(offending, `codegen must not value-import ${forbidden}`).toEqual([]);
		}
		// And the one mention of `SupervisedStack` is the type-only import.
		expect(src).toContain("import type { SupervisedStack }");
	});
});

// ---------------------------------------------------------------------------
// (b) + (c) — the build path injects a static literal; runtime load throws.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	'DEVSTACK_STACK',
	'DEVSTACK_STATE_DIR',
	'DEVSTACK_RUNTIME_ROOT',
	'DEVSTACK_MANIFEST_PATH',
	'DEVSTACK_DEPLOYMENT_FILE',
	'VITEST',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** Transpile the emitted `config-runtime` source and evaluate it against the
 *  given `__DEVSTACK_DEPLOYMENT__` global — the SAME mechanism the build bakes
 *  into the app. Returns the module's runtime resolvers. */
const evalRuntime = (injected: unknown) => {
	const js = ts.transpileModule(CONFIG_RUNTIME_SOURCE, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const exports: Record<string, unknown> = {};
	const sandbox = { exports, module: { exports }, __DEVSTACK_DEPLOYMENT__: injected };
	createContext(sandbox);
	runInContext(js, sandbox);
	return sandbox.module.exports as {
		loadDeployment: () => unknown;
		DevstackConfigMissingError: new (detail: string) => Error;
	};
};

describe('(b) the build path needs no stack, no apply, no live deployment', () => {
	// A production `build` with NO committed `deployments` and NO live stack
	// resolves the injected deployment to the static literal `null`. The build
	// completes (esbuild-valid `define`); nothing reaches into apply/boot.
	it('command "build" with no committed deployment + no stack injects a static null literal', () =>
		withTempRootAsync('devstack-independence', async (tmp) => {
			const patch = await devstackVitePlugin().config({ root: tmp }, { command: 'build' });
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).toBe('null');
			// A `null` literal is esbuild-valid and carries no runtime-global
			// expression — the bundle ships without a live RPC / dev-wallet.
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).not.toContain('__DEVSTACK_DEPLOYMENT_LIVE__');
		}));

	// The Vite plugin's verbatim source carries no value import of the boot /
	// supervisor / apply runtime — the build never executes stack code.
	it('the vite build integration imports no boot/apply/supervisor runtime', () => {
		const src = readFileSync(join(HERE, 'src/build-integrations/vite/index.ts'), 'utf8');
		const valueImports = src
			.split('\n')
			.filter((l) => /^\s*import\b/.test(l) && !/^\s*import\s+type\b/.test(l));
		for (const forbidden of ['boot', 'supervis', 'snapshot', '/apply']) {
			const offending = valueImports.filter((l) => l.toLowerCase().includes(forbidden));
			expect(offending, `vite build must not value-import ${forbidden}`).toEqual([]);
		}
	});
});

describe('(c) no-deployment build compiles but throws only at runtime', () => {
	// The two halves, pinned together:
	//  - BUILD half: with nothing committed/live, the build injects the literal
	//    `null` — it does NOT throw at config/define time.
	//  - RUNTIME half: evaluating the emitted resolver against that injected
	//    `null` throws `DevstackConfigMissingError` the moment the app reads the
	//    deployment — never at build/typecheck.
	it('build injects null (no throw) while loadDeployment(null) throws DevstackConfigMissingError', () =>
		withTempRootAsync('devstack-independence', async (tmp) => {
			// BUILD half — the define is a plain `null` literal; producing it did
			// not throw.
			const patch = await devstackVitePlugin().config({ root: tmp }, { command: 'build' });
			const injectedLiteral = patch.define.__DEVSTACK_DEPLOYMENT__ ?? '<undefined>';
			expect(injectedLiteral).toBe('null');

			// RUNTIME half — the app evaluates the emitted resolver against EXACTLY
			// that injected value. The throw is deferred to the access, not the
			// build: importing the module is fine; only `loadDeployment()` fails.
			const injected = JSON.parse(injectedLiteral) as null;
			const rt = evalRuntime(injected);
			expect(() => rt.loadDeployment()).toThrow(rt.DevstackConfigMissingError);
		}));

	it('the DevstackConfigMissingError message stays actionable (dev + prod guidance)', () => {
		const rt = evalRuntime(null);
		let message = '';
		try {
			rt.loadDeployment();
		} catch (e) {
			message = (e as Error).message;
		}
		// Actionable: names the dev path (`devstack up`) AND the prod path
		// (committed `deployments/<net>.ts`) so docs need not narrate it.
		expect(message).toContain('devstack up');
		expect(message).toContain('deployments/');
	});
});
