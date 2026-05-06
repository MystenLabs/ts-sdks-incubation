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
  up [config]                  Long-running supervisor (localnet only):
                               reconcile + watch Move sources.
  apply [config] [--target]    Single-cycle reconcile against active stack or --target.
                               Runs Build/Publish/Register/Seed/Emit; skips Service.
  deploy <config> --network    Live-network deploy: Build + Publish + Register +
                               Seed (live-net) + Emit. No Service.
  codegen [config] [--target]  Re-emit codegen against the prior manifest (read-only).
  down [config]                Stop the active stack's containers (volumes preserved).
  reset [config] --yes         Wipe the active stack — containers, volumes, host state.
                               Pass --stack <name> to target a specific stack.
                               Pass --images to additionally drop every cached
                               devstack-built image (GLOBAL — affects all apps).
  stack list|new|use|down|drop Manage named per-app stacks.
  snapshot save|restore|list|rm|hash
                               Capture / restore named snapshots of a stack.
  console [config] [--target]  REPL with manifest, client, accounts pre-bound.

Run 'devstack <command> --help' for command-specific options where supported.
`;

const DOWN_USAGE = `devstack down [config] [--stack <name>]

Stop the active stack's containers; volumes and host state are preserved.
Subsequent \`devstack up\` resumes them. Targets the active stack by default;
pass \`--stack <name>\` to operate on a specific named stack.
`;

const RESET_USAGE = `devstack reset [config] --yes [--stack <name>] [--images] [--dry-run]

Wipe the active stack: stop and remove every container, drop volumes, and
delete the per-stack \`.devstack/stacks/<stack>/\` directory.

  --yes        Required — without it, no destructive action runs.
  --stack <n>  Target a specific stack instead of the active one.
  --images     Additionally drop every cached devstack-built image (sui,
               walrus, seal, upstream-source). GLOBAL — affects all apps
               sharing the docker engine. Pair with \`--dry-run\` first.
  --dry-run    Print what would be removed without removing anything.
`;

async function main(): Promise<number> {
	const verb = process.argv[2];
	if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
		process.stdout.write(USAGE);
		return verb === undefined ? 1 : 0;
	}
	// Verb-specific help: route `down --help` / `reset --help` to focused
	// USAGE strings instead of `stack`'s generic dump (those verbs delegate
	// to `stack` internally — the user shouldn't see `stack`'s subcommand
	// list when they asked about `reset`).
	const wantsHelp = (n: number): boolean => {
		const arg = process.argv[n];
		return arg === '--help' || arg === '-h';
	};
	if (verb === 'down' && wantsHelp(3)) {
		process.stdout.write(DOWN_USAGE);
		return 0;
	}
	if (verb === 'reset' && wantsHelp(3)) {
		process.stdout.write(RESET_USAGE);
		return 0;
	}
	const { expandEqualsForms } = await import('./args.js');
	const argv = expandEqualsForms(process.argv.slice(3));
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
		case 'snapshot': {
			const mod = await import('./snapshot.js');
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
