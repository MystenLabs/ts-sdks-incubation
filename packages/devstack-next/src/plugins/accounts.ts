import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Env, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from './sui.js';

// Per-account spec. Empty today; reserved for future per-account knobs
// (role: 'publisher' | …, target balance, funding strategy). Keeping the
// type stable now means callers don't have to migrate when those land.
export interface AccountSpec {
	/** Optional human-readable role for TUI / observability. Doesn't
	 * affect funding, just gets surfaced in `represents.accounts`. */
	role?: string;
}

export interface AccountEntry {
	/** Sui address (`0x…`) derived from the secret key. */
	address: string;
	/** Bech32-encoded `suiprivkey1…` secret. The disk-backed `.key` file
	 * holds the same value; persisted in state so consumer Deps can
	 * re-hydrate an Ed25519Keypair without I/O. */
	secretKey: string;
	role?: string;
}

export interface AccountsState {
	signers: Record<string, AccountEntry>;
}

export interface AccountsFundResult {
	fundedAt: number;
	addresses: string[];
}

export interface AccountsOptions {
	specs: Record<string, AccountSpec>;
	/** Per-faucet-call timeout. Default 30s. */
	faucetTimeoutMs?: number;
}

const provides = {
	signer: dep((s: AccountsState, d: { name: string }) => {
		const entry = s.signers[d.name];
		if (entry === undefined) {
			throw new Error(`accounts.pool: signer '${d.name}' not in pool`);
		}
		return Ed25519Keypair.fromSecretKey(entry.secretKey);
	}),
	address: dep((s: AccountsState, d: { name: string }): string => {
		const entry = s.signers[d.name];
		if (entry === undefined) {
			throw new Error(`accounts.pool: signer '${d.name}' not in pool`);
		}
		return entry.address;
	}),
	all: dep((s: AccountsState) =>
		Object.entries(s.signers).map(([name, e]) => ({ name, address: e.address })),
	),
	full: dep((s: AccountsState) => s),
} satisfies Provides<AccountsState>;

// `accounts({ specs })` — disk-backed Sui Ed25519 keystore plugin.
//
// Returns two producers:
//   - `pool`: materializes one Ed25519 keypair per spec under
//     `<appDir>/.devstack/stacks/<stack>/.keys/<name>.key` (perms 0600,
//     content is the Bech32 `suiprivkey1…` secret). Warm restarts
//     re-read the disk file rather than regenerating, so addresses are
//     stable across cycles. Localnet only (live nets supply their own
//     pre-funded signers).
//   - `fund`: faucets every account up to the localnet faucet's default
//     dispense amount. Idempotent on warm cycles; the faucet itself
//     short-circuits if the address has been seen recently.
//
// Provides exposed by `pool`:
//   pool.get('signer', { name })   → Ed25519Keypair (re-hydrated each call)
//   pool.get('address', { name })  → string
//   pool.get('all')                → Array<{name, address}>
//   pool.get('full')               → AccountsState (for downstream caches)
export function accounts(opts: AccountsOptions) {
	if (Object.keys(opts.specs).length === 0) {
		throw new Error('accounts: at least one spec is required');
	}
	for (const name of Object.keys(opts.specs)) {
		if (!ACCOUNT_NAME_RE.test(name)) {
			throw new Error(
				`accounts: spec name '${name}' must match ${ACCOUNT_NAME_RE} (alnum + . _ -, 1–63 chars)`,
			);
		}
	}
	const faucetTimeoutMs = opts.faucetTimeoutMs ?? 30_000;

	const pool = define<AccountsState, typeof provides>({
		name: 'accounts.pool',
		provides,
		start: async ({ env, prior }) => {
			requireLocalnet(env);
			const dir = keystoreDir(env);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const next: Record<string, AccountEntry> = { ...(prior?.signers ?? {}) };

			for (const [name, spec] of Object.entries(opts.specs)) {
				const path = join(dir, `${name}.key`);
				const fromDisk = await readKey(path);
				if (fromDisk !== undefined) {
					// Disk wins on warm-start: a user can hand-edit a key file
					// (e.g. import a known account) and the next cycle picks it
					// up automatically. The address might not match `prior` —
					// re-derive from the disk secret instead of trusting prior.
					next[name] = entryFor(fromDisk, spec);
					continue;
				}
				const priorEntry = next[name];
				if (priorEntry !== undefined) {
					await writeKey(path, priorEntry.secretKey);
					next[name] = entryFor(priorEntry.secretKey, spec);
					continue;
				}
				const fresh = Ed25519Keypair.generate();
				const secretKey = fresh.getSecretKey();
				await writeKey(path, secretKey);
				next[name] = entryFor(secretKey, spec);
			}

			// Drop signers whose specs are no longer declared. We don't
			// touch the .key file on disk — the user may revert the spec
			// list and want the same address back.
			for (const name of Object.keys(next)) {
				if (opts.specs[name] === undefined) delete next[name];
			}

			return { signers: next };
		},
		represents: {
			accounts: (s: AccountsState) =>
				Object.entries(s.signers).map(([name, e]) => {
					const out: { name: string; address: string; role?: string } = {
						name,
						address: e.address,
					};
					if (e.role !== undefined) out.role = e.role;
					return out;
				}),
		},
	});

	const fund = define<
		AccountsFundResult,
		Provides<AccountsFundResult>,
		{ faucet: ReturnType<typeof sui.get<'faucet'>>; allAccounts: ReturnType<typeof pool.get<'all'>> }
	>({
		name: 'accounts.fund',
		deps: { faucet: sui.get('faucet'), allAccounts: pool.get('all') },
		// `inputs` is what feeds the input hash. Faucet URL + account
		// addresses cover everything that should re-fire fund — fresh
		// account, swapped network, anything that flips a URL or address.
		inputs: ({ deps }) => ({
			faucetUrl: deps.faucet.url,
			addresses: deps.allAccounts.map((a) => a.address).sort(),
		}),
		run: async ({ deps, log }) => {
			const addresses = deps.allAccounts.map((a) => a.address);
			for (const address of addresses) {
				log(`faucet → ${address}`);
				await faucetRequest(deps.faucet.url, address, faucetTimeoutMs);
			}
			return { fundedAt: Date.now(), addresses };
		},
	});

	return { pool, fund };
}

const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

function entryFor(secretKey: string, spec: AccountSpec): AccountEntry {
	const kp = Ed25519Keypair.fromSecretKey(secretKey);
	const entry: AccountEntry = { address: kp.toSuiAddress(), secretKey };
	if (spec.role !== undefined) entry.role = spec.role;
	return entry;
}

export function keystoreDir(env: Env): string {
	requireLocalnet(env);
	return join(env.appDir, '.devstack', 'stacks', env.stack ?? 'main', '.keys');
}

async function readKey(path: string): Promise<string | undefined> {
	try {
		const raw = await readFile(path, 'utf8');
		const trimmed = raw.trim();
		if (trimmed.length === 0) return undefined;
		return trimmed;
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') return undefined;
		throw err;
	}
}

async function writeKey(path: string, secretKey: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, secretKey, { encoding: 'utf8', mode: 0o600 });
}

function requireLocalnet(env: Env): void {
	if (env.network !== 'localnet') {
		throw new Error(
			`accounts: only supported on localnet (got '${env.network}'). ` +
				`Live-net stacks supply pre-funded signers via per-network factories.`,
		);
	}
}

// Hit the faucet. The localnet faucet is the dispatch endpoint at
// /v2/gas accepting `{ FixedAmountRequest: { recipient } }`. We use
// fetch directly (Node 24 ships it natively); no SDK import to keep
// the plugin's runtime cost low.
async function faucetRequest(url: string, recipient: string, timeoutMs: number): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${url.replace(/\/$/, '')}/v2/gas`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ FixedAmountRequest: { recipient } }),
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`faucet ${url} → ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
		}
		// Drain the body so the connection is released cleanly.
		await res.text().catch(() => undefined);
	} finally {
		clearTimeout(timer);
	}
}
