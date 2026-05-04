#!/usr/bin/env node
// `pnpm create @mysten-incubation/devstack-app <name>` →
// pnpm/npm look up `@mysten-incubation/create-devstack-app` and run this
// bin with `<name>` as the first positional argument.

import { scaffold } from './index.js';

const USAGE = `Usage: pnpm create @mysten-incubation/devstack-app <name> [options]

Arguments:
  <name>              App name. Lowercase, dash-separated, starts with a letter.

Options:
  --target-dir <dir>  Where to create the app directory. Default: current working directory.
  --no-install        Skip pnpm install.
  --no-git            Skip git init + initial commit.
  -h, --help          Show this help.
`;

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return argv.length === 0 ? 1 : 0;
	}

	let name: string | undefined;
	let targetDir: string | undefined;
	let skipInstall = false;
	let skipGit = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--target-dir') {
			i += 1;
			targetDir = argv[i];
			if (targetDir === undefined) {
				process.stderr.write('--target-dir requires a value\n');
				return 2;
			}
		} else if (arg === '--no-install') {
			skipInstall = true;
		} else if (arg === '--no-git') {
			skipGit = true;
		} else if (arg !== undefined && arg.startsWith('--')) {
			process.stderr.write(`unknown option: ${arg}\n`);
			return 2;
		} else if (arg !== undefined) {
			if (name !== undefined) {
				process.stderr.write(`unexpected positional argument: ${arg}\n`);
				return 2;
			}
			name = arg;
		}
	}

	if (name === undefined) {
		process.stderr.write('app name is required\n');
		process.stdout.write(USAGE);
		return 2;
	}

	try {
		await scaffold({ name, targetDir, skipInstall, skipGit });
		return 0;
	} catch (e) {
		process.stderr.write(`${(e as Error).message}\n`);
		return 1;
	}
}

main().then((code) => {
	process.exit(code);
});
