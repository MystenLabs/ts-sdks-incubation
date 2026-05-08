import { join } from 'node:path';
import type { Env } from '../engine/types.js';

// Path conventions for SnapshotRecord on disk. The engine has no I/O of its
// own — these helpers are the shared contract between L7 frontends (CLI,
// vitest, playwright) so multiple processes can read/write the same files
// without disagreeing about layout.
//
// Localnet — per-stack subdir. Stacks let multiple users coexist (`main`
//            for dev, `test` for vitest, `e2e-N` for playwright workers).
//
//   <appDir>/.devstack/stacks/<stack>/snapshot.json
//   <appDir>/.devstack/stacks/<stack>/snapshots/<id>-<label>.json   (labeled)
//
// Live nets (testnet, mainnet, …) — one record per network. There is no
//            stack dimension for shared remote networks.
//
//   <appDir>/.devstack/networks/<network>.json
//
// The `stack` field on Env is ignored on live nets even if present.

export function devstackDir(env: Env): string {
	return join(env.appDir, '.devstack');
}

export function snapshotPathFor(env: Env): string {
	if (env.network === 'localnet') {
		return join(devstackDir(env), 'stacks', stackNameOf(env), 'snapshot.json');
	}
	return join(devstackDir(env), 'networks', `${env.network}.json`);
}

export function labeledSnapshotsDir(env: Env): string {
	if (env.network !== 'localnet') {
		throw new Error(
			`labeledSnapshotsDir: labeled snapshots are only supported on localnet (got "${env.network}")`,
		);
	}
	return join(devstackDir(env), 'stacks', stackNameOf(env), 'snapshots');
}

export function labeledSnapshotPath(env: Env, id: string, label?: string): string {
	const filename = label ? `${id}-${label}.json` : `${id}.json`;
	return join(labeledSnapshotsDir(env), filename);
}

function stackNameOf(env: Env): string {
	return env.stack ?? 'main';
}
