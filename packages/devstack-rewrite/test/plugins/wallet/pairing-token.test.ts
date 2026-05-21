// Wallet plugin — pairing-token persistence end-to-end.
//
// Pins the load-bearing invariant that the wallet's pairing-token
// file is written to disk via the substrate's `atomicWriteFile`
// (mode 0o600) and rehydrated unchanged across "restarts" — i.e.
// the second `acquirePairingToken` call against the same path reads
// the previously-minted value rather than minting a fresh one.
//
// The wallet's HTTP server cannot be torn down + brought up without
// invalidating in-flight browser pairings if the token rotates on
// every boot; this test guards against a regression where the
// disk-write surface (an effect dependency on `FileSystem`) is not
// correctly threaded by callers — the failure mode the PR1.5 work
// surfaced.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';

import { acquirePairingToken, tokenPath } from '../../../src/plugins/wallet/pairing.ts';

const freshStateRoot = (): string => mkdtempSync(join(tmpdir(), 'wallet-token-test-'));

const TOKEN_RE = /^[0-9a-f]{32}$/;

describe('plugins/wallet/pairing — token persistence', () => {
	it.effect('writes token file under <stateRoot>/wallet/token on first boot', () =>
		Effect.gen(function* () {
			const stateRoot = freshStateRoot();
			try {
				const path = tokenPath(stateRoot);
				const token = yield* acquirePairingToken(path);

				// Token shape — 32 lowercase-hex chars.
				expect(TOKEN_RE.test(token)).toBe(true);

				// On disk at the expected path.
				expect(existsSync(path)).toBe(true);
				expect(path).toBe(join(stateRoot, 'wallet', 'token'));

				// File contents match the in-memory value.
				expect(readFileSync(path, 'utf8')).toBe(token);
			} finally {
				rmSync(stateRoot, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('applies mode 0o600 to the token file', () =>
		Effect.gen(function* () {
			const stateRoot = freshStateRoot();
			try {
				const path = tokenPath(stateRoot);
				yield* acquirePairingToken(path);
				const stat = statSync(path);
				expect(stat.mode & 0o777).toBe(0o600);
			} finally {
				rmSync(stateRoot, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('rehydrates the same token after restart (same stateRoot)', () =>
		Effect.gen(function* () {
			const stateRoot = freshStateRoot();
			try {
				const path = tokenPath(stateRoot);
				const first = yield* acquirePairingToken(path);

				// Second call simulates a wallet "restart" — the supervisor
				// rebuilds the plugin, the scope finalizers fire, and a new
				// acquire reads the on-disk token instead of re-minting.
				const second = yield* acquirePairingToken(path);

				expect(second).toBe(first);
			} finally {
				rmSync(stateRoot, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('re-mints when the on-disk token is malformed', () =>
		Effect.gen(function* () {
			const stateRoot = freshStateRoot();
			try {
				const path = tokenPath(stateRoot);
				const first = yield* acquirePairingToken(path);

				// Corrupt the file in place (non-hex content). The
				// `acquirePairingToken` body falls through to the mint +
				// overwrite branch — distinct value, same path.
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, 'not-a-valid-token');

				const second = yield* acquirePairingToken(path);
				expect(TOKEN_RE.test(second)).toBe(true);
				expect(second).not.toBe(first);
				// File rewritten to the new value.
				expect(readFileSync(path, 'utf8')).toBe(second);
			} finally {
				rmSync(stateRoot, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
