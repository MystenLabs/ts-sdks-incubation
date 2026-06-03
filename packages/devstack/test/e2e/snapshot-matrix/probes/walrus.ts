// Walrus blob-storage probe.
//
// State = an encrypted-bytes-agnostic blob stored on Walrus (slivers across
// the storage committee + an on-chain Blob object). createState writes a
// label-unique payload (so each S1/S2/S3 gets a distinct content-addressed
// blobId); exists = the blob reads back. A snapshot between S1 and S2 must,
// after restore, leave S1's blob readable and drop S2's (both the slivers on
// the paused+committed node containers and the on-chain Blob roll back
// together).
//
// Requires the real router (`useRealRouter`) — the SDK writes slivers
// directly to each `walrus-node-i` vhost, which only routes through the real
// Traefik, not the harness's host-loopback fake resolver.

import { makeWalrusClient, writeBlobWithRetry, type ProbeEnv } from '../clients.ts';
import type { Probe } from '../probe.ts';

interface WalrusHandle {
	readonly blobId: string;
}

export const walrusProbe: Probe<WalrusHandle> = {
	name: 'walrus',
	// Walrus identity IS deploy-cache-derived: the WAL coin type and the storage
	// committee / system object ids are minted on deploy and cached (observable
	// in the matrix run log as a fresh walCoinType after the cache wipe). With no
	// cache to reuse the deploy re-runs with FRESH ids, so the pre-snapshot S1
	// blob — written against the OLD committee — no longer reads back. Walrus is
	// thus one of the two probes that PROVE the loud-divergence teeth: cache loss
	// MUST orphan its S1.
	orphansOnCacheLoss: true,
	async createState(env: ProbeEnv, label: string): Promise<WalrusHandle> {
		const walrusClient = makeWalrusClient(env.suiClient, env.walrus);
		// Label + actor address make the content (and thus the content-addressed
		// blobId) unique per S1/S2/S3 so the three are independently checkable.
		const payload = new TextEncoder().encode(
			`snapshot-matrix walrus ${label} ${env.address} ${'z'.repeat(48)}`,
		);
		const written = await writeBlobWithRetry(walrusClient, {
			blob: payload,
			signer: env.keypair,
			epochs: 5,
			deletable: true,
		});
		return { blobId: written.blobId };
	},
	async exists(env: ProbeEnv, handle: WalrusHandle): Promise<boolean> {
		const walrusClient = makeWalrusClient(env.suiClient, env.walrus);
		// readBlob can briefly race a just-certified write, so retry a few times
		// before concluding the blob is absent. A rolled-back blob (S2 after a
		// restore) also lands here — readBlob throws and we return false, which
		// is the correct "did not survive" answer.
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const read = await walrusClient.readBlob({ blobId: handle.blobId });
				if (read.length > 0) return true;
			} catch {
				// transient, or a genuinely-absent blob — fall through to retry.
			}
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		return false;
	},
};
