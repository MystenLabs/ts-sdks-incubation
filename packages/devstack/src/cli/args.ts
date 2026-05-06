// Shared argv parsers for the devstack CLIs. Each `cli/<verb>.ts` module
// can compose these instead of hand-rolling its own walk: every parser
// here ignores other known double-flags so positional fallbacks behave
// the same regardless of flag order.
//
// Design notes:
//   - `parseConfigArg` falls back to a trailing positional path so the
//     existing `tsx ... up.ts ./devstack.config.ts` invocation still works.
//   - `parseNetworkArg` throws on unrecognized values; callers decide
//     whether undefined-result is a hard error or fine to default.
//   - `parseTargetArg` only extracts the raw string; resolution lives in
//     `cli/target.ts:resolveTarget` so the precedence rules are in one place.
//   - `loadConfig` does the strict shape check every CLI relies on
//     (`{ app, plugins[] }`). The `cli/stack.ts` loader has a looser
//     check (no `plugins[]` requirement) — left intact since `stack`
//     subcommands don't construct an action graph.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { DevstackConfig, Network } from '../core/types.js';

// Names that flow into Docker resource names, container labels, and on-disk
// state directories. Strict charsets at the config-load boundary so a typo
// or hostile value can't slip through into a `docker run --name <X>` or a
// `<stackDir>/.keys/<account>.key` path. APP_NAME_RE permits leading `_`
// to accommodate the `_template` scaffold directory's name; container-name
// rejection from Docker itself surfaces if anyone tries to bring up a
// non-runnable name.
const APP_NAME_RE = /^[a-z0-9_][a-z0-9._-]{0,30}$/;
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9_-]*$/;

const RAN_REGISTRY = Symbol.for('@mysten-incubation/devstack/cli/ran-registry');

interface RanRegistry {
	[moduleUrl: string]: true;
}

/**
 * If the calling module is being run as the entry point (via
 * `pnpm exec tsx <abs>/cli/<verb>.ts`), dispatch to `main(argv)` once and
 * `process.exit` with its result. Idempotent across duplicate module
 * evaluations: tsx + workspace symlinks can produce two ESM module records
 * for the same `import.meta.url` (entry load + barrel re-export), so a
 * naive `if (isMain) main(...)` runs twice. The dedupe key is keyed on the
 * symmetric `moduleUrl` so each verb's entry is independent.
 *
 * Pass `import.meta.url` as `moduleUrl` and the module's local `main`.
 */
export function runIfMain(moduleUrl: string, main: (argv: string[]) => Promise<number>): void {
	const entry = process.argv[1];
	if (entry === undefined) return;
	if (moduleUrl !== pathToFileURL(entry).href) return;
	const registry = ((globalThis as unknown as Record<symbol, RanRegistry | undefined>)[
		RAN_REGISTRY
	] ??= {});
	if (registry[moduleUrl] === true) return;
	registry[moduleUrl] = true;
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
}

const FLAGS_WITH_VALUES = new Set([
	'--config',
	'--network',
	'--stack',
	'--target',
	'--codegen-dir',
]);

/** Split `--flag=value` argv tokens into the equivalent `--flag value`
 * pair so the per-flag parsers below (and the verb dispatchers in
 * `cli/{up,apply,deploy,...}.ts`) don't each need their own
 * inline-value handling. Tokens without `=` (or non-`--`-prefixed) pass
 * through unchanged. Idempotent. */
export function expandEqualsForms(argv: string[]): string[] {
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

const NETWORKS: ReadonlyArray<Network> = ['localnet', 'testnet', 'mainnet'];

/** Pick `--config <path>` or a trailing positional config path; defaults to
 * `'./devstack.config.ts'`. Skips past values of other known flags so
 * `--network testnet ./foo.ts` doesn't misread `testnet` as a positional.
 *
 * Bare positionals are only accepted when they look like a path: contain a
 * `/`, end with `.ts`/`.js`, or actually exist on disk. This stops
 * `devstack up scratch` (where `scratch` is a stack name) from being
 * misinterpreted as a config path; bare tokens fall through for verb-
 * specific positional handling. */
export function parseConfigArg(argv: string[]): string {
	let configPath = './devstack.config.ts';
	argv = expandEqualsForms(argv);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === '--config') {
			const next = argv[i + 1];
			if (next !== undefined) {
				configPath = next;
				i++;
			}
		} else if (FLAGS_WITH_VALUES.has(arg)) {
			i++;
		} else if (!arg.startsWith('--') && looksLikeConfigPath(arg)) {
			configPath = arg;
		}
	}
	return configPath;
}

function looksLikeConfigPath(arg: string): boolean {
	if (arg.includes('/')) return true;
	if (arg.endsWith('.ts') || arg.endsWith('.js') || arg.endsWith('.mts') || arg.endsWith('.mjs')) {
		return true;
	}
	return existsSync(arg);
}

/** Parse `--network <localnet|testnet|mainnet>`. Throws on unrecognized
 * values; returns undefined when not set. */
export function parseNetworkArg(argv: string[]): Network | undefined {
	argv = expandEqualsForms(argv);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === '--network') {
			const n = argv[++i];
			if (n === undefined) continue;
			if (!NETWORKS.includes(n as Network)) {
				throw new Error(`--network must be localnet|testnet|mainnet, got '${n}'`);
			}
			return n as Network;
		} else if (FLAGS_WITH_VALUES.has(arg)) {
			i++;
		}
	}
	return undefined;
}

/** Parse `--stack <name>`. Returns undefined when not set or empty. */
export function parseStackArg(argv: string[]): string | undefined {
	argv = expandEqualsForms(argv);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === '--stack') {
			const next = argv[++i];
			if (next !== undefined && next.length > 0) return next;
		} else if (FLAGS_WITH_VALUES.has(arg)) {
			i++;
		}
	}
	return undefined;
}

/** Parse `--target <value>`. The raw string is returned verbatim — its
 * interpretation (network, stack, or `<network>:<stack>`) lives in
 * `cli/target.ts:resolveTarget`. */
export function parseTargetArg(argv: string[]): string | undefined {
	argv = expandEqualsForms(argv);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === '--target') {
			const next = argv[++i];
			if (next !== undefined && next.length > 0) return next;
		} else if (FLAGS_WITH_VALUES.has(arg)) {
			i++;
		}
	}
	return undefined;
}

function validateAccountNames(abs: string, accounts: DevstackConfig['accounts']): void {
	if (accounts === undefined) return;
	const names = Array.isArray(accounts) ? accounts : Object.keys(accounts);
	for (const name of names) {
		if (typeof name !== 'string' || !ACCOUNT_NAME_RE.test(name)) {
			throw new Error(
				`config at ${abs}: invalid account name '${name}'. Must match ${ACCOUNT_NAME_RE} — ` +
					"lowercase letters, digits, '_' or '-'; account names flow into " +
					'`<stackDir>/.keys/<name>.key` so charset is enforced to keep them inside that dir.',
			);
		}
	}
}

/** Dynamic-import the config from `abs` and validate the minimum shape every
 * action-graph CLI relies on (`app: string`, `plugins: Plugin[]`).
 *
 * If the config declares `setup: [...]`, those actions are wrapped into a
 * synthetic plugin named `<app>-setup` and appended to `plugins`. From the
 * rest of the system's perspective it's a normal plugin — same expansion
 * rules, same filter chain, same snapshot capture path.
 *
 * The bin re-execs itself with `--import tsx` (see `cli/index.ts`) when
 * the runtime needs TS loading, so by the time `loadConfig` runs, the
 * tsx loader is active. We just call plain `import()` here. */
export async function loadConfig(abs: string): Promise<DevstackConfig> {
	const url = pathToFileURL(abs).href;
	const mod = (await import(url)) as Record<string, unknown>;
	const cfg = (mod.default ?? mod.config) as DevstackConfig | undefined;
	if (cfg === undefined || typeof cfg !== 'object') {
		throw new Error(`config at ${abs} did not export a default DevstackConfig`);
	}
	if (typeof cfg.app !== 'string' || !Array.isArray(cfg.plugins)) {
		throw new Error(`config at ${abs} is missing required fields { app, plugins[] }`);
	}
	if (!APP_NAME_RE.test(cfg.app)) {
		throw new Error(
			`config at ${abs}: invalid app name '${cfg.app}'. Must match ${APP_NAME_RE} — ` +
				'lowercase letters, digits, dashes; up to 31 chars; no leading dash.',
		);
	}
	validateAccountNames(abs, cfg.accounts);
	if (cfg.setup !== undefined && cfg.setup.length > 0) {
		const setupActions = cfg.setup;
		const setupPlugin = {
			name: `${cfg.app.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-setup`,
			// Folded into the snapshot id. Each setup action contributes its
			// name + needs + inputs (the input bag the user passed); editing
			// any of those invalidates the cached snapshot. `runTransaction`
			// build callbacks are hashed via `Function.toString()` separately
			// in the action's own input hash — that catches inline edits but
			// not closure-captured constants (see notes/friction.md).
			inputs: setupActions.map((a) => ({
				name: a.name,
				type: a.type,
				needs: a.needs ?? null,
				inputs: a.inputs ?? null,
				scope: a.scope ?? null,
			})),
			actions: () => setupActions,
		};
		return { ...cfg, plugins: [...cfg.plugins, setupPlugin] };
	}
	return cfg;
}
