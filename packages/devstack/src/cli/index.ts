#!/usr/bin/env node
// `devstack` — main CLI dispatcher.
//
// Routes the first argv to a subcommand module. Each module exports a
// `main(argv)` that handles its own arg parsing and returns an exit code.
//
// TS loading: Node 24+ strips TypeScript annotations natively (no
// transform — just removes `: Type` / `import type` / etc. at parse
// time). The user's `devstack.config.ts` loads via plain dynamic
// `import()` from `loadConfig`. Requires Node >= 24; older versions
// throw `ERR_UNKNOWN_FILE_EXTENSION` on `.ts`. The package.json
// `engines.node` reflects this floor.

const USAGE = `devstack <command> [options]

Commands:
  up [config]                  Long-running supervisor: reconcile + watch
                               Move sources. Pass --once to reconcile and exit.
  apply [config] [--target]    Single-cycle reconcile against active stack or --target.
  deploy <config> --network    Live-network deploy slice (skip Service; keep Build).
  codegen [config] [--target]  Re-emit codegen against the prior manifest (read-only).
  down [config]                Stop the active stack's containers (volumes preserved).
  reset [config] --yes         Wipe the active stack — containers, volumes, host state.
                               Pass --stack <name> to target a specific stack.
  stack list|new|use|down|drop Manage named per-app stacks.
  console [config] [--target]  REPL with manifest, client, accounts pre-bound.

Run 'devstack <command> --help' for command-specific options where supported.
`;

async function main(): Promise<number> {
	const verb = process.argv[2];
	if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
		process.stdout.write(USAGE);
		return verb === undefined ? 1 : 0;
	}
	const argv = process.argv.slice(3);
	switch (verb) {
		case 'up': {
			const mod = await import('./up.js');
			return mod.main(argv);
		}
		case 'apply': {
			const mod = await import('./apply.js');
			return mod.main(argv);
		}
		case 'codegen': {
			const mod = await import('./codegen.js');
			return mod.main(argv);
		}
		case 'deploy': {
			const mod = await import('./deploy.js');
			return mod.main(argv);
		}
		case 'stack': {
			const mod = await import('./stack.js');
			return mod.main(argv);
		}
		case 'down': {
			const mod = await import('./stack.js');
			return mod.main(['down', ...argv]);
		}
		case 'reset': {
			const mod = await import('./stack.js');
			return mod.main(['drop', '--force', ...argv]);
		}
		case 'console': {
			const mod = await import('./console.js');
			return mod.main(argv);
		}
		default:
			process.stderr.write(`unknown command '${verb}'\n${USAGE}`);
			return 1;
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
