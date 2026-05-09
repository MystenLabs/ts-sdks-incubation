import { execFile } from 'node:child_process';
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
	const { stdout } = await exec(
		'sui',
		['move', 'build', '--dump-bytecode-as-base64', '--path', ctx.sourcePath],
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
 * grain because the package id portion of the type isn't known until
 * publish completes. */
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
