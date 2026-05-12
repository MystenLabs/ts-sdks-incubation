import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DevstackConfig, Env } from '../engine/types.js';

// Names that flow into Docker resource names, container labels, and on-disk
// state directories. Strict charset at the config-load boundary so a typo
// or hostile value can't slip through into a `docker run --name <X>`.
const APP_NAME_RE = /^[a-z0-9_][a-z0-9._-]{0,30}$/;

const SUPPORTED_NETWORKS = new Set(['localnet', 'testnet', 'mainnet', 'devnet']);

const CONFIG_FILENAMES = [
	'devstack.config.ts',
	'devstack.config.mts',
	'devstack.config.js',
	'devstack.config.mjs',
];

export interface ResolveOptions {
	cwd: string;
	configPath?: string;
	network?: string;
	stack?: string;
}

export interface LoadedConfig {
	config: DevstackConfig;
	env: Env;
	configPath: string;
}

// Walk upward from `cwd` looking for a devstack.config file, then dynamic-
// import it. Node 24+ strips TypeScript annotations natively, so .ts loads
// directly without a transformer.
export async function loadConfigAndEnv(opts: ResolveOptions): Promise<LoadedConfig> {
	const network = opts.network ?? 'localnet';
	if (!SUPPORTED_NETWORKS.has(network)) {
		throw new Error(
			`--network must be one of ${[...SUPPORTED_NETWORKS].join('|')}; got '${network}'`,
		);
	}
	const configPath = opts.configPath
		? resolve(opts.configPath)
		: await findConfig(resolve(opts.cwd));
	const config = await importConfig(configPath);
	const env = await buildEnv(configPath, network, opts.stack);
	return { config, env, configPath };
}

// Build an `Env` without loading a config — for read-only commands like
// `status` and `reset` that only need the snapshot path.
export async function resolveEnvOnly(opts: ResolveOptions): Promise<{
	env: Env;
	configPath: string;
}> {
	const network = opts.network ?? 'localnet';
	if (!SUPPORTED_NETWORKS.has(network)) {
		throw new Error(
			`--network must be one of ${[...SUPPORTED_NETWORKS].join('|')}; got '${network}'`,
		);
	}
	const configPath = opts.configPath
		? resolve(opts.configPath)
		: await findConfig(resolve(opts.cwd));
	const env = await buildEnv(configPath, network, opts.stack);
	return { env, configPath };
}

async function buildEnv(
	configPath: string,
	network: string,
	stack: string | undefined,
): Promise<Env> {
	const appDir = dirname(configPath);
	const appName = await resolveAppName(appDir);
	const env: Env = { appName, appDir, network };
	// Precedence: explicit `--stack` flag > `DEVSTACK_STACK` env var >
	// active-stack pointer at `<appDir>/.devstack/active` (written by
	// `stack use`). Subcommands that want a hard default ('main') still
	// apply theirs after this — callers see `env.stack` as the user's
	// expressed preference.
	let resolved = stack;
	if (resolved === undefined) {
		const fromEnv = process.env.DEVSTACK_STACK;
		if (typeof fromEnv === 'string' && fromEnv.length > 0 && STACK_NAME_RE.test(fromEnv)) {
			resolved = fromEnv;
		}
	}
	if (resolved === undefined) {
		resolved = await readActiveStack(appDir);
	}
	if (resolved !== undefined) env.stack = resolved;
	return env;
}

const ACTIVE_STACK_FILENAME = 'active';
const STACK_NAME_RE = /^[a-z0-9_][a-z0-9._-]{0,63}$/;

/** Read the per-app active-stack pointer at
 * `<appDir>/.devstack/active`, or `undefined` if the file isn't
 * present / readable. Written by the `stack use <name>` CLI; consumed
 * by `buildEnv` so unflagged commands default to the user's last
 * `stack use`. */
export async function readActiveStack(appDir: string): Promise<string | undefined> {
	const path = join(appDir, '.devstack', ACTIVE_STACK_FILENAME);
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	if (!STACK_NAME_RE.test(trimmed)) return undefined;
	return trimmed;
}

/** Write the active-stack pointer. Used by `stack use`. The `<name>`
 * is charset-validated by callers (CLI surface) — we only write valid
 * names from this function. */
export async function writeActiveStack(appDir: string, name: string): Promise<void> {
	const dir = join(appDir, '.devstack');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, ACTIVE_STACK_FILENAME), `${name}\n`, 'utf8');
}

/** Charset gate for stack names. Lowercase + digits + `_-.`, 1–64
 * chars. Same shape as the app-name gate so per-stack values flow
 * cleanly into Docker labels / paths. */
export function isValidStackName(name: string): boolean {
	return STACK_NAME_RE.test(name);
}

async function findConfig(start: string): Promise<string> {
	let dir = start;
	while (true) {
		for (const name of CONFIG_FILENAMES) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				`no devstack.config file found searching upward from ${start}. Pass --config <path>.`,
			);
		}
		dir = parent;
	}
}

async function importConfig(abs: string): Promise<DevstackConfig> {
	const url = pathToFileURL(abs).href;
	const mod = (await import(url)) as Record<string, unknown>;
	const cfg = (mod.default ?? mod.config) as DevstackConfig | undefined;
	if (!cfg || typeof cfg !== 'object' || !Array.isArray((cfg as DevstackConfig).stack)) {
		throw new Error(
			`config at ${abs} did not export a DevstackConfig — wrap with defineDevstackConfig({ stack: [...] }) and export as default.`,
		);
	}
	return cfg;
}

// Derive an app name. Try `<appDir>/package.json#name` (stripping any
// scope), fall back to the directory's basename. The result is what flows
// into snapshot paths and container labels, so it's charset-checked.
async function resolveAppName(appDir: string): Promise<string> {
	const fromPkg = await readPackageName(appDir);
	const candidate = fromPkg ?? basename(appDir);
	if (!APP_NAME_RE.test(candidate)) {
		throw new Error(
			`cannot derive a valid app name (got '${candidate}'). Set "name" in ${appDir}/package.json — must match ${APP_NAME_RE}.`,
		);
	}
	return candidate;
}

async function readPackageName(appDir: string): Promise<string | undefined> {
	const pkgPath = join(appDir, 'package.json');
	let raw: string;
	try {
		raw = await readFile(pkgPath, 'utf8');
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const name = (parsed as { name?: unknown }).name;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	const bare = name.includes('/') ? (name.split('/').pop() ?? name) : name;
	return bare;
}
