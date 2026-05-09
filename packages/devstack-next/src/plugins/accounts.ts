import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
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
	/** Per-account address-balance target in MIST. Default `0n` (skip
	 * AB-deposit). When set, after faucet the `fund` step pushes the
	 * account's free SUI into its address-balance accumulator until it
	 * holds at least this much. Localnet only — when the sui RPC isn't
	 * reachable from the engine host, AB-deposit silently skips so
	 * `accounts.fund` doesn't gate on chain liveness when only the
	 * faucet matters. The accumulator is what the modern SDK draws
	 * from in AB-gas mode (`useGasCoin: false` resolvers). */
	abMinBalanceMist?: bigint;
	/** Hard cap on a single AB-deposit tx submission. Default 30s — a
	 * stale gas-coin retry queue surfaces as an actionable timeout
	 * rather than wedging the cycle. */
	abDepositTimeoutMs?: number;
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

	const abMinBalanceMist = opts.abMinBalanceMist ?? 0n;
	const abDepositTimeoutMs = opts.abDepositTimeoutMs ?? 30_000;

	const fund = define<
		AccountsFundResult,
		Provides<AccountsFundResult>,
		{
			faucet: ReturnType<typeof sui.get<'faucet'>>;
			rpc: ReturnType<typeof sui.get<'rpc'>>;
			pool: ReturnType<typeof pool.get<'full'>>;
		}
	>({
		name: 'accounts.fund',
		deps: { faucet: sui.get('faucet'), rpc: sui.get('rpc'), pool: pool.get('full') },
		// `inputs` is what feeds the input hash. Faucet URL + account
		// addresses cover everything that should re-fire fund — fresh
		// account, swapped network, anything that flips a URL or address.
		// AB target is folded in too so a target bump invalidates.
		inputs: ({ deps }) => ({
			faucetUrl: deps.faucet.url,
			rpcUrl: deps.rpc.url,
			addresses: Object.values(deps.pool.signers).map((s) => s.address).sort(),
			abMinBalanceMist: abMinBalanceMist.toString(),
		}),
		run: async ({ deps, env, log }) => {
			const entries = Object.entries(deps.pool.signers);
			const addresses = entries.map(([, e]) => e.address);
			for (const address of addresses) {
				log(`faucet → ${address}`);
				await faucetRequest(deps.faucet.url, address, faucetTimeoutMs);
			}

			// AB-deposit is opt-in via `abMinBalanceMist`. It only runs on
			// localnet AND only when the RPC is reachable — keeps
			// `accounts.fund` from gating on chain liveness when only the
			// faucet matters (e.g. tests pointed at an unreachable sui
			// container). A live RPC + non-zero target deposits each
			// account's free SUI into its address-balance accumulator.
			if (abMinBalanceMist > 0n && env.network === 'localnet') {
				const reachable = await probeRpc(deps.rpc.url);
				if (!reachable) {
					log(`AB-deposit skipped — RPC ${deps.rpc.url} unreachable`);
				} else {
					for (const [name, entry] of entries) {
						const signer = Ed25519Keypair.fromSecretKey(entry.secretKey);
						try {
							const result = await ensureAddressBalance({
								rpcUrl: deps.rpc.url,
								signer,
								target: abMinBalanceMist,
								timeoutMs: abDepositTimeoutMs,
							});
							if (result.deposited) {
								log(`AB-deposit → ${name} (${entry.address.slice(0, 10)}…)`);
							}
						} catch (err) {
							// Per-account failure shouldn't poison the whole step
							// — log and move on. The next cycle picks it back up
							// once the chain heals.
							log(`AB-deposit failed for ${name}: ${(err as Error).message}`);
						}
					}
				}
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

const SUI_COIN_TYPE = '0x2::sui::SUI';
/** Reserve a fixed amount on the gas coin so we don't over-deposit and
 * leave the account unable to pay for the next tx. 1 SUI is plenty for
 * a few txs at localnet gas prices. */
const COIN_RESERVE_MIST = 1_000_000_000n;
/** Tolerance band for AB target — post-fee AB lands a few MIST below
 * the requested target; without this skip every cycle re-deposits
 * forever. */
const AB_TOLERANCE_MIST = 1_000_000_000n;

interface EnsureAddressBalanceOpts {
	rpcUrl: string;
	signer: Ed25519Keypair;
	target: bigint;
	timeoutMs: number;
}

/** Push the account's free SUI balance into its address-balance
 * accumulator until it holds at least `target` MIST. Idempotent:
 * skips when the AB is already within `AB_TOLERANCE_MIST` of the
 * target. Submission is capped at `timeoutMs`; a stuck retry queue
 * surfaces as a clean timeout rather than a long hang. Throws on
 * tx failure; returns `{ deposited: false }` when no work was needed. */
async function ensureAddressBalance(
	opts: EnsureAddressBalanceOpts,
): Promise<{ deposited: boolean }> {
	const address = opts.signer.toSuiAddress();
	if (opts.target <= 0n) return { deposited: false };

	const client = new SuiJsonRpcClient({ url: opts.rpcUrl, network: 'localnet' });
	const ab = await fetchAddressBalance(opts.rpcUrl, address);
	if (ab + AB_TOLERANCE_MIST >= opts.target) return { deposited: false };

	const coins = await client.getCoins({ owner: address, coinType: SUI_COIN_TYPE });
	const sorted = [...coins.data].sort((a, b) =>
		BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
	);
	const gas = sorted[0];
	if (gas === undefined) {
		throw new Error(`AB-deposit: ${address} owns no SUI coins to deposit (faucet failed?)`);
	}
	const movable = BigInt(gas.balance) - COIN_RESERVE_MIST;
	const deficit = opts.target - ab;
	const send = movable < deficit ? movable : deficit;
	if (send <= 0n) {
		throw new Error(
			`AB-deposit: ${address} largest coin ${gas.balance} below COIN_RESERVE_MIST + target — faucet first`,
		);
	}

	const tx = new Transaction();
	const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(send)]);
	if (chunk === undefined) throw new Error('AB-deposit: splitCoins returned no result');
	tx.moveCall({
		target: '0x2::coin::send_funds',
		typeArguments: [SUI_COIN_TYPE],
		arguments: [chunk, tx.pure.address(address)],
	});
	tx.setGasBudget(50_000_000n);

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
	try {
		const result = await client.signAndExecuteTransaction({
			signer: opts.signer,
			transaction: tx,
			options: { showEffects: true },
		});
		if (result.effects?.status?.status !== 'success') {
			throw new Error(
				`AB-deposit: tx for ${address} failed: ${result.effects?.status?.error ?? 'unknown'}`,
			);
		}
		await client.waitForTransaction({ digest: result.digest });
	} finally {
		clearTimeout(timer);
	}
	return { deposited: true };
}

/** Probe the JSON-RPC endpoint with `sui_getChainIdentifier`. Used as
 * the AB-deposit gate: a fast yes/no on whether the chain is up
 * without a multi-second timeout. */
async function probeRpc(url: string): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 1500);
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'sui_getChainIdentifier',
					params: [],
				}),
				signal: ctrl.signal,
			});
			if (!res.ok) return false;
			const json = (await res.json().catch(() => undefined)) as { result?: string } | undefined;
			return typeof json?.result === 'string';
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

/** Read the address-balance accumulator for `address`. Returns `0n`
 * when the chain hasn't seen a deposit yet (the JSON-RPC endpoint
 * returns `null` for a missing accumulator). */
async function fetchAddressBalance(url: string, address: string): Promise<bigint> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'sui_getBalance',
			params: [address, SUI_COIN_TYPE],
		}),
	});
	if (!res.ok) throw new Error(`fetchAddressBalance: HTTP ${res.status}`);
	const json = (await res.json()) as {
		result?: { addressBalance?: string | null };
	};
	const ab = json.result?.addressBalance;
	if (typeof ab !== 'string') return 0n;
	try {
		return BigInt(ab);
	} catch {
		return 0n;
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
