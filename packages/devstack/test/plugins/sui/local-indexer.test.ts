// Sui local-mode GraphQL-indexer wiring.
//
// GraphQL/indexer/Postgres are ON BY DEFAULT: a bare `sui({ mode: 'local' })`
// owns a postgres SIDECAR (provisioned at start, labelled under sui) and
// composes the indexer DSN from the sidecar's NETWORK ALIAS (not the
// per-stack container DNS host). `indexer: false` opts out; `indexerDb`
// points GraphQL at a Postgres the caller already runs (no sidecar).

import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import { sui, provisionLocalIndexer } from '../../../src/plugins/sui/index.ts';
import { makeSnapshotable } from '../../../src/plugins/sui/snapshot.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';

const identity: Identity = {
	app: appName('app'),
	stack: stackName('stack'),
	chain: 'sui:localnet',
};

// Fake runtime that drives `bootPostgresSidecar` to success: image +
// network are no-ops, `ensureContainer` echoes the spec back as a handle,
// and exec returns exit 0 (pg_isready ready, createdb done).
const sidecarRuntime = (sink: { spec?: EnsureContainerSpec }): ContainerRuntime => ({
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
	inspectByLabels: () => Effect.succeed([]),
	runOneShot: () => Effect.die('runOneShot not used'),
	followLogs: () => Stream.die('followLogs not used'),
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.die('saveImage not used'),
	saveImages: () => Stream.die('saveImages not used'),
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
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
				provisionLocalIndexer(sidecarRuntime({}), identity, '/stack/root', {
					mode: 'local',
					indexerDb: { url: 'postgres://u:p@host:5432', network: 'caller-net' },
				}),
			),
		);
		expect(indexer.url).toBe('postgres://u:p@host:5432/sui_indexer');
		expect(indexer.network).toBe('caller-net');
	});

	it('BYO indexerDb respects a caller-supplied database path', async () => {
		const indexer = await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(sidecarRuntime({}), identity, '/stack/root', {
					mode: 'local',
					indexerDb: { url: 'postgres://u:p@host:5432/mydb', network: 'caller-net' },
				}),
			),
		);
		expect(indexer.url).toBe('postgres://u:p@host:5432/mydb');
	});

	it('default sidecar composes the DSN from the in-network ALIAS, not the per-stack DNS host', async () => {
		const sink: { spec?: EnsureContainerSpec } = {};
		const indexer = await Effect.runPromise(
			Effect.scoped(
				provisionLocalIndexer(sidecarRuntime(sink), identity, '/stack/root', { mode: 'local' }),
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
