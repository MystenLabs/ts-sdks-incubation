// `devstack console` — REPL with the app's prior manifest pre-bound. Reads
// the active-stack manifest at `<appDir>/.devstack/stacks/<stack>/manifest.json`
// for localnet, or `<appDir>/.devstack/manifests/<network>.json` for
// testnet/mainnet (live networks are stack-independent — only one
// testnet/mainnet exists per app). Materializes a `SuiClient`, resolves
// `Signer`s from `config.accounts` via `resolveAccounts`, and dynamically
// imports the codegen-generated package bindings under
// `<appDir>/<codegenDir>/<pkg>/`. The REPL walks every `.ts` file in
// each package's subdir, merges named exports under `packages.<name>`,
// and auto-wraps functions to default `package:` to the live `packageId`,
// so a REPL session reads like:
//
//   devstack> tx = new Transaction()
//   devstack> packages.managed_coin.mint({ arguments: [t, 1000n, accounts.alice.toSuiAddress()] })(tx)
//   devstack> client.signAndExecuteTransaction({ transaction: tx, signer: accounts.alice })
//
// Codegen output is loaded via plain `await import()` — Node 24+ strips
// types from `.ts` files natively, and the codegen plugin emits `.ts`
// import specifiers (rather than `.js`) so the in-tree bindings resolve
// without any custom loader.
//
// One-shot lifecycle: print banner, start REPL, resolve on `.exit` / Ctrl-D.
// The console does not run actions and never writes a manifest — it is a
// read-only consumer of the manifest + registry.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { start as startRepl } from 'node:repl';
import { pathToFileURL } from 'node:url';

import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import type { DevstackConfig, Network, Package, Service } from '../core/types.js';
import { resolveAccounts } from '../runtime/accounts.js';
import { readManifest } from '../runtime/manifest-reader.js';
import type { Manifest } from '../runtime/manifest-types.js';
import { manifestPath } from '../runtime/manifest-writer.js';
import {
	loadConfig,
	parseConfigArg,
	parseNetworkArg,
	parseStackArg,
	parseTargetArg,
	runIfMain,
} from './args.js';
import { resolveTarget } from './target.js';

const DEFAULT_CODEGEN_DIR = 'src/generated/sui';

interface ConsoleFlags {
	configPath: string;
	network: Network;
	codegenDir: string;
	stack?: string | undefined;
	target?: string | undefined;
}

async function runConsole(flags: ConsoleFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);

	const target = resolveTarget({
		config,
		appDir,
		raw: flags.target,
		fallbackNetwork: flags.network,
		fallbackStack: flags.stack,
	});
	const network = target.network;
	const stack = target.stack;

	let manifest: ReturnType<typeof readManifest>;
	try {
		manifest = readManifest({ appDir, stack, network });
	} catch (err) {
		throw new Error(
			`devstack console: ${err instanceof Error ? err.message : 'failed to load manifest'}`,
		);
	}
	if (manifest === null) {
		const expected = manifestPath({ appDir, stack, network });
		throw new Error(
			`devstack console: no manifest at ${expected} — run \`devstack apply\` (localnet) or \`devstack deploy --network ${network}\` first`,
		);
	}

	const rpcUrl = pickRpcUrl({ manifest, network, config, fromTarget: target.rpcUrl });
	const client = new SuiJsonRpcClient({ url: rpcUrl, network });
	const accounts = loadAccounts({
		specs: config.accounts ?? {},
		appDir,
		stack,
		network,
		rpcUrl,
	});
	const packages = await loadPackageBindings({
		appDir,
		manifest,
		codegenDir: flags.codegenDir,
	});

	printBanner({
		appName: manifest.app,
		network,
		stack,
		manifestFile: manifestPath({ appDir, stack, network }),
		rpcUrl,
		accounts,
		packages,
	});

	const repl = startRepl({ prompt: 'devstack> ', useGlobal: false, terminal: true });
	repl.context.manifest = manifest;
	repl.context.client = client;
	repl.context.accounts = accounts;
	repl.context.packages = packages;
	repl.context.Transaction = Transaction;
	repl.context.bcs = bcs;
	repl.context.Ed25519Keypair = Ed25519Keypair;

	// `.deploy [pkg]` — runs `runApply` against the resolved target. Without
	// args, runs every action; with a package name, scopes to that package's
	// Publish action and its codegen Emit cascade. Lets users tighten the
	// edit-deploy-test loop without leaving the REPL.
	repl.defineCommand('deploy', {
		help: 'Run apply against the active target. Optional <pkg> scopes to one Publish.',
		action: function deployCmd(arg: string) {
			this.clearBufferedCommand();
			const trimmed = arg.trim();
			runReplDeploy({ configPath: abs, target, scope: trimmed.length > 0 ? trimmed : undefined })
				.then((code) => {
					this.output.write(`apply exited ${code}\n`);
					this.displayPrompt();
				})
				.catch((err) => {
					this.output.write(`apply failed: ${err instanceof Error ? err.message : String(err)}\n`);
					this.displayPrompt();
				});
		},
	});

	return new Promise((resolveExit) => {
		repl.on('exit', () => resolveExit(0));
	});
}

interface ReplDeployOptions {
	configPath: string;
	target: { network: Network; stack: string };
	scope?: string;
}

async function runReplDeploy(opts: ReplDeployOptions): Promise<number> {
	const { runApply } = await import('./apply.js');
	const targetArg =
		opts.target.network === 'localnet' ? `localnet:${opts.target.stack}` : opts.target.network;
	const actions = opts.scope !== undefined ? resolveScopeToActions(opts.scope) : undefined;
	return runApply({ configPath: opts.configPath, target: targetArg, actions });
}

/**
 * Resolve a bare scope arg from `.deploy <scope>` to one or more action
 * names. The arg may be:
 *   - bare action name (`connect_four`) → tries `<plugin>.connect_four`
 *     across loaded plugins; ambiguous matches throw with the candidates
 *     listed.
 *   - dotted FQN (`arena.connect_four`) → used as-is.
 *   - `imports/<name>` shorthand → `imports.<name>`.
 *
 * The actual filtering happens inside `runOneShot` via `actionScope`,
 * which silently drops names that don't resolve (the user gets back a
 * normal apply summary with the empty set if they typo'd).
 */
function resolveScopeToActions(scope: string): string[] {
	if (scope.includes('.')) return [scope];
	if (scope.startsWith('imports/')) return [`imports.${scope.slice('imports/'.length)}`];
	// Bare name: pass through; runOneShot's scoping will look it up
	// against its own action graph and silently drop on miss. The REPL
	// caller doesn't have the action graph here.
	return [scope];
}

interface PickRpcUrlOptions {
	manifest: Manifest;
	network: Network;
	config: DevstackConfig;
	/** RPC URL `resolveTarget` produced. Empty string for localnet (the
	 * sui plugin registers it lazily); a real URL for live nets when the
	 * config declares one. Preferred over the manifest fallback when set. */
	fromTarget: string;
}

function pickRpcUrl(opts: PickRpcUrlOptions): string {
	if (opts.fromTarget.length > 0) return opts.fromTarget;
	const override = opts.config.networks?.[opts.network];
	if (override !== undefined) return override;
	const services = (opts.manifest.registry.services ?? []) as Service[];
	const rpc = services.find((s) => s.name === 'sui-rpc' || s.kind === 'sui-rpc');
	if (rpc !== undefined) return rpc.url;
	return getJsonRpcFullnodeUrl(opts.network);
}

interface LoadAccountsOptions {
	specs: NonNullable<DevstackConfig['accounts']>;
	appDir: string;
	stack: string;
	network: Network;
	rpcUrl: string;
}

function loadAccounts(opts: LoadAccountsOptions): Record<string, Signer> {
	const ctx = resolveAccounts(opts);
	const out: Record<string, Signer> = {};
	for (const name of ctx.names()) {
		try {
			out[name] = ctx.get(name);
		} catch (err) {
			// Surface the captured factory error as a console warning rather
			// than crashing the REPL — the user can still inspect manifest +
			// run read-only queries with the remaining bindings.
			process.stderr.write(
				`devstack console: account '${name}' could not be resolved (${err instanceof Error ? err.message : String(err)})\n`,
			);
		}
	}
	return out;
}

interface LoadPackageBindingsOptions {
	appDir: string;
	manifest: Manifest;
	codegenDir: string;
}

export async function loadPackageBindings(
	opts: LoadPackageBindingsOptions,
): Promise<Record<string, unknown>> {
	const root = isAbsolute(opts.codegenDir)
		? opts.codegenDir
		: resolve(opts.appDir, opts.codegenDir);
	if (!existsSync(root)) return {};

	// `@mysten/codegen` emits one `.ts` file per Move module under
	// `<codegenDir>/<pkg>/<module>.ts`, plus a sibling `<codegenDir>/utils/`
	// with shared helpers. Walk the package subdirs and merge module-level
	// named exports under `packages.<pkg>`. Codegen is configured with
	// `importExtension: '.ts'` so Node 24's native type-stripping resolves
	// the in-tree imports without a custom loader.
	const out: Record<string, unknown> = {};
	for (const pkg of (opts.manifest.registry.packages ?? []) as Package[]) {
		const pkgDir = join(root, pkg.name);
		if (!existsSync(pkgDir) || !statSync(pkgDir).isDirectory()) continue;
		const moduleFiles = readdirSync(pkgDir).filter(
			(name) => (name.endsWith('.ts') || name.endsWith('.mts')) && !name.endsWith('.d.ts'),
		);
		if (moduleFiles.length === 0) continue;
		const merged: Record<string, unknown> = {};
		for (const file of moduleFiles) {
			const full = join(pkgDir, file);
			try {
				const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
				for (const [key, val] of Object.entries(mod)) {
					if (key === 'default') continue;
					merged[key] = val;
				}
			} catch (err) {
				process.stderr.write(
					`devstack console: failed to import bindings for ${pkg.name}/${file}: ${
						err instanceof Error ? err.message : String(err)
					}\n`,
				);
			}
		}
		if (Object.keys(merged).length === 0) continue;
		out[pkg.name] = wrapWithDefaultPackage(merged, pkg.packageId);
	}
	return out;
}

// The codegen output exports MoveCall factories shaped `(options: { package?:
// string; arguments: ... }) => (tx) => tx.moveCall(...)`. Default `package:`
// to the live `packageId` so REPL users don't have to thread it through every
// call. Non-function exports (BCS structs, type re-exports) pass through.
export function wrapWithDefaultPackage(
	mod: Record<string, unknown>,
	packageId: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = { $id: packageId };
	for (const [key, val] of Object.entries(mod)) {
		if (key === 'default') continue;
		if (typeof val === 'function') {
			const fn = val as (...args: unknown[]) => unknown;
			out[key] = (options?: Record<string, unknown>) => {
				const merged: Record<string, unknown> = { ...(options ?? {}) };
				if (merged.package === undefined) merged.package = packageId;
				return fn(merged);
			};
			continue;
		}
		out[key] = val;
	}
	return out;
}

interface BannerOptions {
	appName: string;
	network: Network;
	stack: string;
	manifestFile: string;
	rpcUrl: string;
	accounts: Record<string, Signer>;
	packages: Record<string, unknown>;
}

function printBanner(opts: BannerOptions): void {
	const accountNames = Object.keys(opts.accounts);
	const packageNames = Object.keys(opts.packages);
	const out = process.stdout;
	out.write(`devstack console — ${opts.appName} (${opts.network}, stack=${opts.stack})\n`);
	out.write(`  manifest  ${opts.manifestFile}\n`);
	out.write(`  rpc       ${opts.rpcUrl}\n`);
	out.write('\n');
	out.write('bound:\n');
	out.write('  client          SuiClient\n');
	out.write('  manifest        parsed manifest\n');
	out.write(`  accounts.<name> ${accountNames.length > 0 ? accountNames.join(', ') : '(none)'}\n`);
	out.write(
		`  packages.<name> ${packageNames.length > 0 ? `${packageNames.join(', ')} (auto-bound)` : '(no codegen output found)'}\n`,
	);
	out.write('  Transaction, bcs, Ed25519Keypair\n');
	out.write('\n');
	out.write('  .help to list REPL commands;  .exit (or Ctrl-D) to quit\n');
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runConsole(parseArgs(argv));
}

const USAGE = `devstack console [config] [options]

Open a Node REPL with the active stack's manifest, RPC client, account
signers, and codegen-generated package bindings pre-bound. Reads the
manifest from the active stack on localnet, or from
\`<appDir>/.devstack/manifests/<network>.json\` for live nets.

Bound names:
  manifest          parsed Manifest
  client            SuiClient pointed at the resolved RPC URL
  accounts.<name>   resolved Signer per declared account
  packages.<name>   per-package codegen module (auto-defaults
                    \`package: <packageId>\` so callers don't thread it)
  Transaction, bcs, Ed25519Keypair

REPL commands:
  .deploy [<pkg>]   Run \`apply\` against the active target. Optional
                    <pkg> scopes to a single Publish + its cascade.
  .help             List built-in REPL commands.
  .exit (Ctrl-D)    Quit.

Options:
  --target <network[:stack]>   Override the active target
  --stack <name>               Override the active stack (alternative)
  --network <name>             Override the network (defaults localnet)
  --codegen-dir <path>         Override the codegen output dir
                               (default: src/generated/sui)
  --config <path>              Override the config path

Examples:
  devstack console
  devstack console --target testnet
  devstack console --target localnet:scratch
`;

function parseArgs(argv: string[]): ConsoleFlags {
	let codegenDir = DEFAULT_CODEGEN_DIR;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--codegen-dir') {
			const next = argv[++i];
			if (next !== undefined) codegenDir = next;
		}
	}
	return {
		configPath: parseConfigArg(argv),
		network: parseNetworkArg(argv) ?? 'localnet',
		codegenDir,
		stack: parseStackArg(argv),
		target: parseTargetArg(argv),
	};
}

runIfMain(import.meta.url, main);
