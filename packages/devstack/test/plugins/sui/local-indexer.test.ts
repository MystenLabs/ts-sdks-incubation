// Sui local-mode GraphQL-indexer wiring.
//
// GraphQL/indexer/Postgres are ON BY DEFAULT: a bare `sui({ mode: 'local' })`
// owns a postgres SIDECAR (provisioned at start, labelled under sui) and
// composes the indexer DSN from the sidecar's NETWORK ALIAS (not the
// per-stack container DNS host). `indexer: false` opts out; `indexerDb`
// points GraphQL at a Postgres the caller already runs (no sidecar).

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	composeIndexerConfigHash,
	readValidatorChainConfig,
	sui,
	provisionLocalIndexer,
} from '../../../src/plugins/sui/index.ts';
import { makeSnapshotable } from '../../../src/plugins/sui/snapshot.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureContainerSpec,
	ImageRef,
} from '../../../src/contracts/container-runtime.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';

const identity: Identity = {
	app: appName('app'),
	stack: stackName('stack'),
	chain: 'sui:localnet',
};

// Stand-in resolved validator image the barrel would hand `provisionLocal-
// Indexer`. `tag` is the value `composeIndexerConfigHash` folds (`tag ??
// digest`); a different tag here models an image bump.
const VALIDATOR_IMAGE: ImageRef = { digest: 'sha256:validator', tag: 'sui:local' };
const BUMPED_VALIDATOR_IMAGE: ImageRef = { digest: 'sha256:validator2', tag: 'sui:local-v2' };

// Fake runtime that drives `bootPostgresSidecar` to success: image +
// network are no-ops, `ensureContainer` echoes the spec back as a handle,
// and exec returns exit 0 (pg_isready ready, createdb done).
//
// `inspectByLabels` returns one validator handle when `sink.validatorPresent`
// is set (so `readValidatorChainConfig` reads `present`), else none (absent →
// `null` → the `fresh` configHash token). `sink.validatorExitCode` surfaces a
// `lastExitCode` on that handle so the present+137 crash-recreate gate is
// testable (137 ⇒ re-genesis ⇒ `null`/`fresh`; any other code ⇒ `present`).
const sidecarRuntime = (sink: {
	spec?: EnsureContainerSpec;
	readonly validatorPresent?: boolean;
	readonly validatorExitCode?: number;
}): ContainerRuntime =>
	makeContainerRuntimeStub({
		ensureImage: () => Effect.succeed({ digest: 'sha256:pg', tag: 'postgres:local' }),
		ensureNetwork: () => Effect.succeed('net-id'),
		ensureContainer: (spec) => {
			sink.spec = spec;
			return Effect.succeed({
				id: 'pg-id',
				name: spec.name,
				labels: spec.labels,
				imageName: spec.image.tag ?? spec.image.digest,
				status: 'running',
				ips: [],
				ports: spec.ports,
			} satisfies ContainerHandle);
		},
		exec: () => Effect.succeed({ exitCode: 0, stdout: '1\n', stderr: '' }),
		inspectByLabels: () =>
			Effect.succeed(
				sink.validatorPresent
					? [
							{
								id: 'validator-id',
								name: 'devstack-app-stack-sui-validator',
								imageName: 'sui:local',
								status: 'running',
								ips: [],
								...(sink.validatorExitCode !== undefined
									? { lastExitCode: sink.validatorExitCode }
									: {}),
							} satisfies ContainerHandle,
						]
					: [],
			),
	});

describe('Sui local indexer wiring', () => {
	it('plain sui() declares no sibling dependsOn', () => {
		const plugin = sui();
		// On-by-default indexer is a sui-owned sidecar, NOT a cross-plugin
		// dependency: the plugin demands no postgres provider from the stack.
		expect(plugin.dependsOn ?? []).toHaveLength(0);
	});

	it('indexer:false drops the indexer-db sidecar from the snapshot + leaves GraphQL off', () => {
		const off = makeSnapshotable('local', 'app', 'stack', 'sui:localnet', false);
		expect(off.managedContainers).toEqual([
			{ app: 'app', stack: 'stack', plugin: 'sui', role: 'validator' },
		]);
		// `indexer: false` is a zero-arg start path; no sibling dependsOn.
		const plugin = sui({ mode: 'local', indexer: false });
		expect(plugin.dependsOn ?? []).toHaveLength(0);
	});

	it('default local snapshot captures BOTH validator + indexer-db', () => {
		const on = makeSnapshotable('local', 'app', 'stack', 'sui:localnet', true);
		expect(on.managedContainers).toEqual([
			{ app: 'app', stack: 'stack', plugin: 'sui', role: 'validator' },
			{ app: 'app', stack: 'stack', plugin: 'sui', role: 'indexer-db' },
		]);
	});

	it('BYO indexerDb passes {url,network} through and appends the default db', async () => {
		const indexer = await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(
					sidecarRuntime({}),
					identity,
					{
						mode: 'local',
						indexerDb: { url: 'postgres://u:p@host:5432', network: 'caller-net' },
					},
					VALIDATOR_IMAGE,
				),
			),
		);
		expect(indexer.url).toBe('postgres://u:p@host:5432/sui_indexer');
		expect(indexer.network).toBe('caller-net');
	});

	it('BYO indexerDb respects a caller-supplied database path', async () => {
		const indexer = await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(
					sidecarRuntime({}),
					identity,
					{
						mode: 'local',
						indexerDb: { url: 'postgres://u:p@host:5432/mydb', network: 'caller-net' },
					},
					VALIDATOR_IMAGE,
				),
			),
		);
		expect(indexer.url).toBe('postgres://u:p@host:5432/mydb');
	});

	it('default sidecar composes the DSN from the in-network ALIAS, not the per-stack DNS host', async () => {
		const sink: { spec?: EnsureContainerSpec } = {};
		const indexer = await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(sidecarRuntime(sink), identity, { mode: 'local' }, VALIDATOR_IMAGE),
			),
		);
		// DSN dials the alias `sui-indexer-db`, not `app-stack-indexer-db`.
		expect(indexer.url).toContain('@sui-indexer-db:5432/sui_indexer');
		expect(indexer.url).not.toContain('app-stack-indexer-db');
		expect(indexer.network).toBe('devstack-app-stack-sui-indexer');
		// The sidecar container is labelled under sui's `indexer-db` role so
		// sui's own snapshotable captures it.
		expect(sink.spec?.labels).toEqual({
			app: 'app',
			stack: 'stack',
			plugin: 'sui',
			role: 'indexer-db',
		});
		expect(sink.spec?.name).toBe('app-stack-indexer-db');
		expect(sink.spec?.networkAttach).toEqual([
			{ name: 'devstack-app-stack-sui-indexer', aliases: ['sui-indexer-db'] },
		]);
	});
});

describe('appendDatabaseIfMissing (BYO DSN normalization)', () => {
	// Driven through `provisionLocalIndexer`'s BYO branch (the only public
	// entry to `appendDatabaseIfMissing`). The default db is `sui_indexer`.
	const normalize = async (url: string): Promise<string> => {
		const indexer = await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(
					sidecarRuntime({}),
					identity,
					{
						mode: 'local',
						indexerDb: { url, network: 'caller-net' },
					},
					VALIDATOR_IMAGE,
				),
			),
		);
		return indexer.url;
	};

	it('appends the db into pathname BEFORE the query (no path, with query)', async () => {
		// Regression: the old impl yielded `...?x=1/sui_indexer`.
		expect(await normalize('postgres://h:5432?x=1')).toBe('postgres://h:5432/sui_indexer?x=1');
	});

	it('appends the db when there is no path and no query', async () => {
		expect(await normalize('postgres://h:5432')).toBe('postgres://h:5432/sui_indexer');
	});

	it('appends the db when the path is a bare slash', async () => {
		expect(await normalize('postgres://h:5432/')).toBe('postgres://h:5432/sui_indexer');
	});

	it('leaves an existing db path unchanged', async () => {
		expect(await normalize('postgres://h:5432/mydb')).toBe('postgres://h:5432/mydb');
	});

	it('leaves an existing db path + query unchanged', async () => {
		expect(await normalize('postgres://h:5432/mydb?x=1')).toBe('postgres://h:5432/mydb?x=1');
	});

	it('preserves credentials when appending into a path-less DSN with a query', async () => {
		expect(await normalize('postgres://u:p@h:5432?x=1')).toBe(
			'postgres://u:p@h:5432/sui_indexer?x=1',
		);
	});
});

describe('composeIndexerConfigHash (native sidecar reset/restore key)', () => {
	const img = 'sui:local';
	const img2 = 'sui:local-v2';

	it('is STABLE for the same chain + same image (restart / restore → resume → rows kept)', () => {
		expect(composeIndexerConfigHash('present', img)).toBe(composeIndexerConfigHash('present', img));
	});

	it('DIFFERS for different chains (re-genesis → recreate → empty DB)', () => {
		expect(composeIndexerConfigHash('present', img)).not.toBe(
			composeIndexerConfigHash('other', img),
		);
	});

	it('null (validator absent OR exited-137 ⇒ regenesis) yields a DISTINCT `fresh` token', () => {
		const fresh = composeIndexerConfigHash(null, img);
		expect(fresh).toContain('chain=fresh');
		expect(fresh).not.toBe(composeIndexerConfigHash('present', img));
		expect(fresh).not.toBe(composeIndexerConfigHash('sui:0xabc', img));
	});

	// The image-ref fold: an image bump recreates the validator (image-mismatch
	// → fresh layer → re-genesis) WHILE the disposition still reads `present`.
	// The token must change so the sidecar resets in lockstep.
	it('DIFFERS for a different validator image at the SAME present disposition (image bump → recreate → empty DB)', () => {
		expect(composeIndexerConfigHash('present', img)).not.toBe(
			composeIndexerConfigHash('present', img2),
		);
	});

	it('is STABLE for the SAME image ref (restore replays the same content-addressed ref → resume)', () => {
		// Restore runs the committed validator at the SAME resolved image ref, so
		// `present` + same `img` ⇒ identical token ⇒ resume (rows intact).
		expect(composeIndexerConfigHash('present', img)).toBe(composeIndexerConfigHash('present', img));
	});

	it('folds BOTH the chain disposition AND the image ref into the token shape', () => {
		const token = composeIndexerConfigHash('present', img);
		expect(token).toContain('chain=present');
		expect(token).toContain(`img=${img}`);
	});
});

// The disposition → configHash mapping is what closes the gap: presence ≠
// "same chain" when the validator was SIGKILLed (137) — the runtime recreates
// it (re-genesis), so we must reset rather than resume stale rows. Gate on
// EXACTLY 137, mirroring `decideRunAction`.
describe('readValidatorChainConfig (pre-boot disposition → chain token)', () => {
	const dispositionOf = (sink: {
		validatorPresent?: boolean;
		validatorExitCode?: number;
	}): Promise<string | null> =>
		Effect.runPromise(readValidatorChainConfig(sidecarRuntime(sink), identity));

	it('absent → null (fresh / wiped ⇒ re-genesis incoming)', async () => {
		expect(await dispositionOf({ validatorPresent: false })).toBeNull();
	});

	it('present + running (no exit code) → `present` (same chain → resume)', async () => {
		expect(await dispositionOf({ validatorPresent: true })).toBe('present');
	});

	it('present + 137 (SIGKILL/OOM crash-recreate) → null (re-genesis incoming)', async () => {
		expect(await dispositionOf({ validatorPresent: true, validatorExitCode: 137 })).toBeNull();
	});

	it('present + clean exit 0 → `present` (writable layer kept → same chain)', async () => {
		expect(await dispositionOf({ validatorPresent: true, validatorExitCode: 0 })).toBe('present');
	});

	it('present + 130 (SIGINT) → `present` (non-137 ⇒ runtime resumes ⇒ same chain)', async () => {
		expect(await dispositionOf({ validatorPresent: true, validatorExitCode: 130 })).toBe('present');
	});

	it('present + other non-137 exit (1) → `present` (runtime does NOT recreate)', async () => {
		expect(await dispositionOf({ validatorPresent: true, validatorExitCode: 1 })).toBe('present');
	});
});

describe('provisionLocalIndexer stamps the sidecar configHash', () => {
	const stampedHash = async (
		sink: {
			spec?: EnsureContainerSpec;
			validatorPresent?: boolean;
			validatorExitCode?: number;
		},
		image: ImageRef = VALIDATOR_IMAGE,
	): Promise<string | undefined> => {
		await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(sidecarRuntime(sink), identity, { mode: 'local' }, image),
			),
		);
		return sink.spec?.configHash;
	};

	const imgRef = VALIDATOR_IMAGE.tag ?? VALIDATOR_IMAGE.digest;
	const bumpedRef = BUMPED_VALIDATOR_IMAGE.tag ?? BUMPED_VALIDATOR_IMAGE.digest;

	it('absent validator → the `fresh` configHash token (so a re-boot resets)', async () => {
		const sink: { spec?: EnsureContainerSpec; validatorPresent?: boolean } = {
			validatorPresent: false,
		};
		const hash = await stampedHash(sink);
		expect(sink.spec?.recreate).toBe('on-config-change');
		expect(hash).toBe(composeIndexerConfigHash(null, imgRef));
	});

	it('present validator → the `present` configHash token (so a restart resumes)', async () => {
		expect(await stampedHash({ validatorPresent: true })).toBe(
			composeIndexerConfigHash('present', imgRef),
		);
	});

	it('present + 137 → the `fresh` token, DIFFERING from present+clean (so the sidecar RECREATES)', async () => {
		const crashed = await stampedHash({ validatorPresent: true, validatorExitCode: 137 });
		const clean = await stampedHash({ validatorPresent: true, validatorExitCode: 0 });
		expect(crashed).toBe(composeIndexerConfigHash(null, imgRef));
		// present+137 ≠ present+clean ⇒ `decideRunAction` `===` mismatch ⇒ recreate.
		expect(crashed).not.toBe(clean);
	});

	// The closed door: a different validator image at the SAME present+clean
	// disposition must stamp a DIFFERENT token, so an image bump (which recreates
	// the present+non-137 validator → re-genesis) resets the sidecar instead of
	// resuming stale rows against the new chain.
	it('present + bumped image → DIFFERS from present + original image (image bump ⇒ recreate)', async () => {
		const original = await stampedHash({ validatorPresent: true, validatorExitCode: 0 });
		const bumped = await stampedHash(
			{ validatorPresent: true, validatorExitCode: 0 },
			BUMPED_VALIDATOR_IMAGE,
		);
		expect(original).toBe(composeIndexerConfigHash('present', imgRef));
		expect(bumped).toBe(composeIndexerConfigHash('present', bumpedRef));
		expect(bumped).not.toBe(original);
	});

	it('present + SAME image (restart / restore) → SAME token (so the sidecar RESUMES, rows kept)', async () => {
		const first = await stampedHash({ validatorPresent: true, validatorExitCode: 0 });
		const second = await stampedHash({ validatorPresent: true, validatorExitCode: 0 });
		expect(first).toBe(second);
	});

	it('falls back to the digest when the resolved image has no tag', async () => {
		const digestOnly: ImageRef = { digest: 'sha256:digest-only' };
		const hash = await stampedHash({ validatorPresent: true, validatorExitCode: 0 }, digestOnly);
		expect(hash).toBe(composeIndexerConfigHash('present', digestOnly.digest));
	});
});
