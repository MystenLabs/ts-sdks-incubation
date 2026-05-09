#!/usr/bin/env node
// `devstack-next` — CLI entry point.
//
// TS loading: Node 24+ strips TypeScript annotations natively (no
// transform — just removes `: Type` / `import type` / etc. at parse
// time). The user's `devstack.config.ts` loads via plain dynamic
// `import()` from `loadConfigAndEnv`. Requires Node >= 24; older
// versions throw `ERR_UNKNOWN_FILE_EXTENSION` on `.ts`. The
// package.json `engines.node` reflects this floor.

const USAGE = `devstack-next <command> [options]

Commands:
  up                Long-running supervisor: read prior snapshot, run
                    one cycle, idle until SIGINT. Auto-saves a snapshot
                    at each cycle:end.
  apply             Single-cycle reconcile against the current stack.
                    Writes a snapshot and exits.
  status            Read-only print of the on-disk snapshot. Doesn't
                    construct an engine.
  snapshot          Capture / restore labeled snapshots
                    (save | restore | list | delete).
  reset             Stop snapshot-managed containers / processes
                    and clear per-stack on-disk state.
  doctor            Preflight checks (docker daemon, sui CLI,
                    snapshot host-port conflicts).

Run \`devstack-next <command> --help\` for command-specific options.
`;

export async function main(argv: readonly string[]): Promise<number> {
	const verb = argv[0];
	if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
		process.stdout.write(USAGE);
		return verb === undefined ? 1 : 0;
	}
	const subArgv = argv.slice(1);
	switch (verb) {
		case 'up': {
			const mod = await import('./up.js');
			return mod.main(subArgv);
		}
		case 'apply': {
			const mod = await import('./apply.js');
			return mod.main(subArgv);
		}
		case 'status': {
			const mod = await import('./status.js');
			return mod.main(subArgv);
		}
		case 'snapshot': {
			const mod = await import('./snapshot.js');
			return mod.main(subArgv);
		}
		case 'reset': {
			const mod = await import('./reset.js');
			return mod.main(subArgv);
		}
		case 'doctor': {
			const mod = await import('./doctor.js');
			return mod.main(subArgv);
		}
		default:
			process.stderr.write(`unknown command '${verb}'\n${USAGE}`);
			return 1;
	}
}

// Only run when invoked as the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err) => {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
			process.exit(1);
		});
}
