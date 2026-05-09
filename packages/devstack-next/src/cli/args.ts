// Minimal argv helpers. We intentionally don't reach for a third-party
// parser — the surface is small enough to hand-roll, and avoiding a dep
// keeps `npx @mysten-incubation/devstack` cold-starts fast.

const FLAGS_WITH_VALUES = new Set([
	'--config',
	'--network',
	'--stack',
	'--name',
]);

export interface CommonFlags {
	configPath?: string;
	network?: string;
	stack?: string;
	help?: boolean;
	json?: boolean;
}

// Split `--flag=value` into `--flag value` so per-flag readers don't each
// reimplement the inline-value form. Idempotent.
export function expandEqualsForms(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith('--') && arg.includes('=')) {
			const eq = arg.indexOf('=');
			out.push(arg.slice(0, eq), arg.slice(eq + 1));
		} else {
			out.push(arg);
		}
	}
	return out;
}

// Read `--<name> <value>`. Returns the LAST occurrence so a later flag
// wins (matches typical CLI semantics). Skips past values of other known
// value-flags so `--network testnet --stack foo` doesn't read 'foo' as
// the network value or vice-versa.
export function readValueFlag(argv: readonly string[], name: string): string | undefined {
	const expanded = expandEqualsForms(argv);
	let found: string | undefined;
	for (let i = 0; i < expanded.length; i++) {
		const arg = expanded[i];
		if (arg === undefined) continue;
		if (arg === name) {
			const next = expanded[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				found = next;
				i++;
			}
		} else if (FLAGS_WITH_VALUES.has(arg)) {
			i++;
		}
	}
	return found;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
	return expandEqualsForms(argv).includes(name);
}

export function parseCommonFlags(argv: readonly string[]): CommonFlags {
	const out: CommonFlags = {};
	const cfg = readValueFlag(argv, '--config');
	if (cfg !== undefined) out.configPath = cfg;
	const net = readValueFlag(argv, '--network');
	if (net !== undefined) out.network = net;
	const stack = readValueFlag(argv, '--stack');
	if (stack !== undefined) out.stack = stack;
	if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) out.help = true;
	if (hasFlag(argv, '--json')) out.json = true;
	return out;
}

// Read trailing positional arguments (everything that isn't a `--flag` or
// the value of a known value-flag). Useful for subcommands like
// `snapshot save <label>`.
export function readPositionals(argv: readonly string[]): string[] {
	const expanded = expandEqualsForms(argv);
	const out: string[] = [];
	for (let i = 0; i < expanded.length; i++) {
		const arg = expanded[i];
		if (arg === undefined) continue;
		if (arg.startsWith('--') || arg === '-h') {
			if (FLAGS_WITH_VALUES.has(arg)) i++;
			continue;
		}
		out.push(arg);
	}
	return out;
}
