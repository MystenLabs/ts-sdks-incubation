// Post-scaffold "Next steps" text.
//
// Extracted from `bin.ts` as a pure, side-effect-free builder so the
// conditional branches — the install/codegen prompts, the git-sourced
// bindings note, and the Docker warning — are unit-testable without running a
// real scaffold. `bin.ts` joins the returned lines into the `note(...)` box.

import pc from 'picocolors';

import type { TemplateId } from './render-config.js';
import type { ScaffoldResult } from './scaffold.js';

/** Inputs the next-steps text depends on: the template (for the `pnpm dev`
 *  explainer) and the scaffold-step outcomes the conditional lines key off. */
export interface NextStepsInput {
	readonly name: string;
	readonly template: TemplateId;
	readonly result: Pick<ScaffoldResult, 'installed' | 'codegenRan' | 'dockerOk'>;
}

export function buildNextSteps({ name, template, result }: NextStepsInput): string[] {
	const devExplainer =
		template === 'app'
			? 'boots localnet + services, publishes move/counter, generates src/generated/, starts vite'
			: 'boots localnet + services, publishes move/counter, generates src/generated/, prints the dashboard URL';
	return [
		`cd ${name}`,
		...(result.installed ? [] : ['pnpm install']),
		// Codegen ran automatically only when install happened AND a host `sui`
		// CLI was present. Otherwise prompt for it — it needs the sui CLI.
		...(result.codegenRan
			? []
			: [
					`pnpm codegen  ${pc.dim('# emit src/generated/ bindings (needs the `sui` CLI on PATH)')}`,
				]),
		`pnpm dev  ${pc.dim(`# ${devExplainer}`)}`,
		'',
		...(result.codegenRan
			? []
			: [
					pc.dim('Git-sourced services (deepbook/pyth) finish their bindings on first `pnpm dev`.'),
				]),
		pc.dim('First boot pulls docker images — give it a few minutes.'),
		...(result.dockerOk
			? []
			: [pc.yellow(`Docker doesn't appear to be running — start Docker Desktop before pnpm dev.`)]),
	];
}
