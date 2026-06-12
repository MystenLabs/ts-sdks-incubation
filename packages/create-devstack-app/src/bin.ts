#!/usr/bin/env node
// `pnpm create @mysten-incubation/devstack-app <name>` →
// pnpm/npm look up `@mysten-incubation/create-devstack-app` and run this
// bin with `<name>` as the first positional argument.
//
// `bin.ts` owns the CLI shell: flag parsing, @clack/prompts for whatever the
// flags didn't answer, then one `scaffold(...)` call and the next steps.

import {
	cancel,
	intro,
	isCancel,
	log,
	multiselect,
	note,
	outro,
	select,
	text,
} from '@clack/prompts';
import pc from 'picocolors';

import { TEMPLATE_IDS, type TemplateId } from './render-config.js';
import { NAME_RE, scaffold } from './scaffold.js';
import { parseServiceList, SERVICE_IDS, SERVICES, type ServiceId } from './services.js';

const USAGE = `Usage: pnpm create @mysten-incubation/devstack-app [name] [options]

Arguments:
  [name]              App name. Lowercase, dash-separated, starts with a letter.
                      Prompted for when omitted.

Options:
  --template <id>     Template: app (React dapp) or ts (TypeScript only). Default: app.
  --services <list>   Comma-separated services to include (walrus,seal).
                      The sui localnet is always included. Skips the service prompt.
  --all               Include every service.
  --minimal           No optional services (sui localnet only).
  --yes               Non-interactive: accept defaults (app template, no services).
  --target-dir <dir>  Where to create the app directory. Default: current working directory.
  --no-install        Skip pnpm install.
  --no-git            Skip git init + initial commit.
  -h, --help          Show this help.
`;

const TEMPLATE_OPTIONS: Array<{ value: TemplateId; label: string }> = [
	{ value: 'app', label: 'Web dapp — React + dapp-kit + dev wallet (recommended)' },
	{ value: 'ts', label: 'TypeScript only — scripts and tests against the stack, no frontend' },
];

const SERVICES_PROMPT =
	'Local services? (sui localnet always included — each adds one line to devstack.config.ts)';

function usageError(message: string): number {
	process.stderr.write(`${message}\n`);
	return 2;
}

/** Unwrap a clack prompt result, exiting 130 on cancel (ctrl-c). */
function unwrap<T>(value: T | symbol): T {
	if (isCancel(value)) {
		cancel('Cancelled.');
		process.exit(130);
	}
	return value as T;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}

	let name: string | undefined;
	let targetDir: string | undefined;
	let templateFlag: string | undefined;
	let servicesFlag: string | undefined;
	let all = false;
	let minimal = false;
	let yes = false;
	let skipInstall = false;
	let skipGit = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const valueOf = (flag: string): string | undefined => {
			if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
			i += 1;
			return argv[i];
		};
		if (arg === '--target-dir' || arg.startsWith('--target-dir=')) {
			targetDir = valueOf('--target-dir');
			if (targetDir === undefined) return usageError('--target-dir requires a value');
		} else if (arg === '--template' || arg.startsWith('--template=')) {
			templateFlag = valueOf('--template');
			if (templateFlag === undefined) return usageError('--template requires a value');
		} else if (arg === '--services' || arg.startsWith('--services=')) {
			servicesFlag = valueOf('--services');
			if (servicesFlag === undefined) return usageError('--services requires a value');
		} else if (arg === '--all') {
			all = true;
		} else if (arg === '--minimal') {
			minimal = true;
		} else if (arg === '--yes') {
			yes = true;
		} else if (arg === '--no-install') {
			skipInstall = true;
		} else if (arg === '--no-git') {
			skipGit = true;
		} else if (arg.startsWith('--')) {
			return usageError(`unknown option: ${arg}`);
		} else if (name !== undefined) {
			return usageError(`unexpected positional argument: ${arg}`);
		} else {
			name = arg;
		}
	}

	if ([servicesFlag !== undefined, all, minimal].filter(Boolean).length > 1) {
		return usageError('--services, --all and --minimal are mutually exclusive');
	}
	const validTemplates = TEMPLATE_IDS as ReadonlyArray<string>;
	if (templateFlag !== undefined && !validTemplates.includes(templateFlag)) {
		return usageError(`unknown template '${templateFlag}'. Valid: ${TEMPLATE_IDS.join(', ')}.`);
	}
	if (name !== undefined && !NAME_RE.test(name)) {
		return usageError(
			`invalid app name '${name}'. Must match ${NAME_RE.source} (lowercase, dash-separated, starts with a letter).`,
		);
	}

	let services: ReadonlyArray<ServiceId> | undefined;
	if (servicesFlag !== undefined) {
		try {
			services = parseServiceList(servicesFlag);
		} catch (e) {
			return usageError((e as Error).message);
		}
	} else if (minimal) {
		services = [];
	} else if (all) {
		services = SERVICE_IDS;
	}

	const interactive = process.stdin.isTTY === true && !yes;
	if (!interactive && name === undefined) {
		if (argv.length === 0) {
			process.stdout.write(USAGE);
			return 1;
		}
		return usageError('app name is required');
	}

	intro(pc.inverse(' create-devstack-app '));

	if (name === undefined) {
		name = unwrap(
			await text({
				message: 'App name?',
				placeholder: 'my-app',
				validate: (value) =>
					NAME_RE.test(value ?? '')
						? undefined
						: 'lowercase, dash-separated, starts with a letter (e.g. my-app)',
			}),
		);
	}

	let template: TemplateId;
	if (templateFlag !== undefined) {
		template = templateFlag as TemplateId;
	} else if (!interactive) {
		template = 'app';
	} else {
		template = unwrap(
			await select<TemplateId>({
				message: 'What are you building?',
				options: TEMPLATE_OPTIONS,
			}),
		);
	}

	if (services === undefined) {
		if (!interactive) {
			services = [];
		} else {
			services = unwrap(
				await multiselect<ServiceId>({
					message: SERVICES_PROMPT,
					options: SERVICE_IDS.map((id) => ({
						value: id,
						label: SERVICES[id].label,
						hint: SERVICES[id].hint,
					})),
					required: false,
				}),
			);
		}
	}

	let result;
	try {
		result = await scaffold({
			name,
			targetDir,
			template,
			services,
			skipInstall,
			skipGit,
			log: (m) => log.step(m),
		});
	} catch (e) {
		log.error((e as Error).message);
		return 1;
	}

	const devExplainer =
		template === 'app'
			? 'boots localnet + services, publishes move/counter, generates src/generated/, starts vite'
			: 'boots localnet + services, publishes move/counter, generates src/generated/, prints the dashboard URL';
	const steps = [
		`cd ${name}`,
		...(result.installed ? [] : ['pnpm install']),
		`pnpm dev  ${pc.dim(`# ${devExplainer}`)}`,
		'',
		pc.dim('First boot pulls docker images — give it a few minutes.'),
		...(result.dockerOk
			? []
			: [pc.yellow(`Docker doesn't appear to be running — start Docker Desktop before pnpm dev.`)]),
	];
	note(steps.join('\n'), 'Next steps');
	outro(`${name} is ready at ${result.appDir}`);
	return 0;
}

main().then((code) => {
	process.exit(code);
});
