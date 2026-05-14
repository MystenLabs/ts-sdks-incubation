import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Keypair } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import type { PublishMoveContext, PublishedPackage } from './publish-move.js';

const exec = promisify(execFile);

/** Capture callback for `publishViaSuiCli`. Receives the publish tx's
 * object changes (`created` + `mutated` records); returns a flat map
 * of named object IDs to thread into `PublishedPackage.objects`.
 * Plugins like deepbook use this to surface the `Registry` + admin-cap
 * objects the publish tx creates alongside the package. */
export type PublishCaptureCallback = (changes: SuiObjectChange[]) => Record<string, string>;

// Default `publishMove` callback — host `sui move build
// --dump-bytecode-as-base64` to compile the package, then `tx.publish`
// + sign + execute via the supplied keypair. Same flow the old
// devstack's `publishMovePackage` follows; lifted into a shared helper
// so plugins (`seal`, `deepbook`, future ones) reach for one
// authoritative implementation rather than each rolling its own
// publish callback.
//
// Requires `sui` on PATH (host CLI). Plugins that compose this should
// document the prerequisite. Plugins that build their own image with
// sui baked in (e.g. seal once Chunk 4 lands) can swap to a
// container-build variant of this helper without touching the
// publishMove call site.
//
// Use directly as the publish callback when no captured-objects
// metadata is needed:
//
//   publishMove({ ..., publish: publishViaSuiCli })
//
// Pass `{ capture }` (via a thin arrow) when the plugin wants secondary
// objects like a Registry / AdminCap surfaced on `PublishedPackage.objects`:
//
//   publishMove({
//     ...,
//     publish: (ctx) => publishViaSuiCli(ctx, {
//       capture: (changes) => ({
//         registryId: pickByType(changes, '::pool::Registry'),
//         adminCapId: pickByType(changes, '::pool::AdminCap'),
//       }),
//     }),
//   })
export async function publishViaSuiCli(
	ctx: PublishMoveContext<Keypair>,
	opts?: { capture?: PublishCaptureCallback },
): Promise<PublishedPackage> {
	// Scrub `[env.testnet]` / `[env.mainnet]` entries from any cached
	// vendored Move.lock files. Reason: sui-cli's legacy-manifest
	// resolver reads those entries and treats the dep as
	// already-published-on-chain. For deepbook's `token` dep, that
	// pulls the testnet id `0x36dbef…` and embeds it in the publish
	// tx's `dependencies` array — which then fails on a fresh localnet
	// where that package id doesn't exist. With the entries stripped,
	// `--with-unpublished-dependencies` correctly inlines token's
	// bytecode and the deps array contains only `0x1` + `0x2`.
	// Idempotent: re-stripping a scrubbed lockfile is a no-op.
	await scrubCachedMoveLocks();

	const { stdout } = await exec(
		'sui',
		[
			'move',
			'build',
			'--dump-bytecode-as-base64',
			// Inline unpublished deps' bytecode into the publish so
			// `sui-cli`'s package-resolution doesn't try to look them
			// up on-chain. Combined with `scrubCachedMoveLocks()` above
			// this is what makes vendored Move trees (deepbook + token)
			// publishable on a fresh localnet.
			'--with-unpublished-dependencies',
			'--path',
			ctx.sourcePath,
		],
		// `sui` writes plenty of progress to stderr; we only care about
		// stdout, which is the JSON dump.
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	const built = JSON.parse(extractTrailingJson(stdout)) as {
		modules: string[];
		dependencies: string[];
	};
	const tx = new Transaction();
	const upgradeCap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
	tx.transferObjects([upgradeCap], ctx.signer.toSuiAddress());
	const client = new SuiJsonRpcClient({ url: ctx.rpcUrl, network: 'localnet' });
	const result = await client.signAndExecuteTransaction({
		signer: ctx.signer,
		transaction: tx,
		options: { showObjectChanges: true, showEffects: true },
	});
	if (result.effects?.status.status !== 'success') {
		throw new Error(`publishMove: ${result.effects?.status.error ?? 'unknown'}`);
	}
	await client.waitForTransaction({ digest: result.digest });
	const changes = result.objectChanges ?? [];
	const published = changes.find((c: SuiObjectChange) => c.type === 'published');
	if (published === undefined || published.type !== 'published') {
		throw new Error('publishMove: no "published" change in result');
	}
	const captured = opts?.capture?.(changes);
	const out: PublishedPackage = { packageId: published.packageId };
	if (captured !== undefined && Object.keys(captured).length > 0) {
		out.objects = captured;
	}
	return out;
}

/** Helper for capture callbacks: pick the first `created` change whose
 * type ends with the given suffix (e.g. `'::pool::Registry'`). Returns
 * the object id, or undefined if no match. Suffix-match is the right
 * grain for monomorphic types because the package id portion isn't
 * known until publish completes. */
export function pickCreatedByTypeSuffix(
	changes: SuiObjectChange[],
	typeSuffix: string,
): string | undefined {
	for (const c of changes) {
		if (c.type !== 'created') continue;
		if (typeof c.objectType !== 'string') continue;
		if (!c.objectType.endsWith(typeSuffix)) continue;
		return c.objectId;
	}
	return undefined;
}

/** Helper for capture callbacks targeting generic-typed objects (e.g.
 * `'::coin::TreasuryCap<'` where the type arg makes a strict suffix
 * match impossible). Matches when `objectType.includes(fragment)` —
 * pass a fragment specific enough to uniquely identify the object
 * (`'::coin::TreasuryCap<'` is enough on a single-coin publish). */
export function pickCreatedByTypeIncludes(
	changes: SuiObjectChange[],
	fragment: string,
): string | undefined {
	for (const c of changes) {
		if (c.type !== 'created') continue;
		if (typeof c.objectType !== 'string') continue;
		if (!c.objectType.includes(fragment)) continue;
		return c.objectId;
	}
	return undefined;
}

// `sui move build --dump-bytecode-as-base64` writes the JSON object
// to stdout but other commands sometimes emit warnings on stdout
// before the JSON. Find the last balanced JSON object in the buffer
// and parse that.
export function extractTrailingJson(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith('{')) return trimmed;
	const idx = trimmed.lastIndexOf('{');
	if (idx === -1) return trimmed;
	return trimmed.slice(idx);
}

// Walk `~/.move/git/` (sui-cli's content-addressed dep cache) and
// strip `[env.<name>]` sections from every `Move.lock` whose entries
// declare a published-id. This is irreversible per cache entry but
// safe — the cache is keyed by `<repo>@<rev>` so the same scrubbed
// state is reused across builds, and a user-driven `sui move build`
// against testnet/mainnet would simply re-resolve the dep's
// publication info from `Published.toml` (newer scheme) or refetch
// the lockfile. Tradeoff documented; we prefer the surgical scrub
// over copying every vendored dep tree into a per-build sandbox.
async function scrubCachedMoveLocks(): Promise<void> {
	const root = join(homedir(), '.move', 'git');
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return;
	}
	const tasks: Array<Promise<void>> = [];
	for (const entry of entries) {
		tasks.push(scrubDirectory(join(root, entry)));
	}
	await Promise.all(tasks);
}

async function scrubDirectory(dir: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const tasks: Array<Promise<void>> = [];
	for (const name of entries) {
		if (name === '.git') continue;
		const full = join(dir, name);
		const st = await stat(full).catch(() => undefined);
		if (st === undefined) continue;
		if (st.isDirectory()) {
			tasks.push(scrubDirectory(full));
		} else if (name === 'Move.lock') {
			tasks.push(scrubMoveLock(full));
		}
	}
	await Promise.all(tasks);
}

async function scrubMoveLock(path: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(path, 'utf8');
	} catch {
		return;
	}
	const scrubbed = stripEnvSections(contents);
	if (scrubbed === contents) return;
	await writeFile(path, scrubbed, 'utf8');
}

/** Strip top-level `[env]` / `[env.<name>]` sections from a Move.lock
 * (TOML) string. Preserves the rest of the file. Stops stripping at
 * the next non-`[env...]` section header.
 *
 * Exported for unit tests. */
export function stripEnvSections(source: string): string {
	const lines = source.split('\n');
	const out: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith('[')) {
			const header = trimmed.replace(/\s+/g, '');
			if (header === '[env]' || header.startsWith('[env.')) {
				skipping = true;
				continue;
			}
			skipping = false;
		}
		if (!skipping) out.push(line);
	}
	return out.join('\n');
}
