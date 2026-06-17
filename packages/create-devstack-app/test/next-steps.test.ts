import { describe, expect, it } from 'vitest';

import { buildNextSteps } from '../src/next-steps.js';

/** Build a steps string for a result, defaulting every outcome to the
 *  "happy" value so each test flips just the one flag it cares about. */
const steps = (
	over: Partial<{ installed: boolean; codegenRan: boolean; dockerOk: boolean }> = {},
	template: 'app' | 'ts' = 'app',
	name = 'my-app',
): string =>
	buildNextSteps({
		name,
		template,
		result: { installed: true, codegenRan: true, dockerOk: true, ...over },
	}).join('\n');

describe('buildNextSteps', () => {
	it('always leads with `cd <name>` and a `pnpm dev`', () => {
		const out = steps({}, 'app', 'cool-app');
		expect(out).toContain('cd cool-app');
		expect(out).toContain('pnpm dev');
	});

	it('the fully-happy path omits install/codegen prompts, the git note, and the docker warning', () => {
		const out = steps({ installed: true, codegenRan: true, dockerOk: true });
		expect(out).not.toContain('pnpm install');
		expect(out).not.toContain('pnpm codegen');
		expect(out).not.toContain('deepbook/pyth');
		expect(out).not.toContain("Docker doesn't appear");
	});

	it('prompts `pnpm install` only when install was skipped', () => {
		expect(steps({ installed: false })).toContain('pnpm install');
		expect(steps({ installed: true })).not.toContain('pnpm install');
	});

	it('prompts `pnpm codegen` + the git-sourced note only when codegen did not run', () => {
		const skipped = steps({ codegenRan: false });
		expect(skipped).toContain('pnpm codegen');
		expect(skipped).toContain('deepbook/pyth');
		const ran = steps({ codegenRan: true });
		expect(ran).not.toContain('pnpm codegen');
		expect(ran).not.toContain('deepbook/pyth');
	});

	it('warns about Docker only when the preflight failed', () => {
		expect(steps({ dockerOk: false })).toContain("Docker doesn't appear");
		expect(steps({ dockerOk: true })).not.toContain("Docker doesn't appear");
	});

	it('the `pnpm dev` explainer differs by template (vite for app, dashboard URL for ts)', () => {
		expect(steps({}, 'app')).toContain('starts vite');
		expect(steps({}, 'ts')).toContain('prints the dashboard URL');
	});
});
