import { Effect } from 'effect';

import {
	capabilitySink,
	codegenable,
	defineNetwork,
	definePlugin,
	liftedSibling,
	routable,
	type ConflictingSiblingGroups,
	type ProvidesWitness,
	type RequiresWitness,
} from '../core.ts';
import {
	account,
	accountRef,
	action,
	defineDevstack,
	hostService,
	localPackage,
	sui,
	type AccountRef,
	type AccountValue,
	type AnyAccountRef,
	type PackageRef,
} from '../builtins.ts';
import { alice, connectFour, publisher } from './arena.config.ts';
import { healthCheck as localHealthCheck } from './health-check-capability.ts';
import { redisUrl } from './custom-plugin.config.ts';

declare module '../core.ts' {
	interface DevstackNetworkModeRegistry {
		readonly simnet: { readonly faucetUrl: string };
	}

	interface DevstackRoutableUpstreamRegistry {
		readonly 'unix-socket': { readonly path: string };
	}

	interface DevstackPluginKindRegistry {
		readonly operator: {};
	}

	interface DevstackLiftedSiblingScopeRegistry {
		readonly 'per-worktree': {};
	}
}

// Auto-Sui allows plugins that depend on Sui to work without spelling `sui()`.
defineDevstack({ members: [alice] });

// Explicit Sui still works and is not duplicated.
defineDevstack({ members: [sui(), alice] });

// @ts-expect-error duplicateProviders: "sui"
defineDevstack({ members: [sui(), sui()] });

const firstHost = hostService({
	name: 'first-host',
	command: 'pnpm dev:first',
	port: 5211,
});
const secondHost = hostService({
	name: 'second-host',
	command: 'pnpm dev:second',
	port: 5212,
});

// Distinct host service names preserve distinct resource ids.
defineDevstack({ members: [firstHost, secondHost] });

const duplicateAliceProvider = account('alice');

// @ts-expect-error duplicateProviders: "account/alice"
defineDevstack({ members: [alice, duplicateAliceProvider] });

const externalMissingAlice = accountRef('external-missing-alice');
const appUsingMissingProvider = hostService({
	name: 'uses-missing-provider',
	command: 'pnpm dev',
	port: 5203,
	dependsOn: externalMissingAlice,
});

// @ts-expect-error missingProviders: "account/external-missing-alice"
defineDevstack({ members: [appUsingMissingProvider] });

// @ts-expect-error package publisher must be an account resource
localPackage('bad_package', { sourcePath: './move/bad', publisher: connectFour });

const notAnAccount: PackageRef = connectFour;
void notAnAccount;

action('single.dependency', {
	dependsOn: alice,
	body: (ctx, signer) => ctx.signAndExecute(signer, () => {}),
});

action('object.keys.named.like.refs', {
	dependsOn: { id: alice, pluginKey: publisher },
	body: (ctx, deps) => ctx.signAndExecute(deps.id, () => {}),
});

action('bad.missingNeed', {
	dependsOn: [alice],
	body: (ctx, deps) => {
		const [signer] = deps;
		// @ts-expect-error only one dependency is available
		const missing = deps[1];
		void missing;
		return ctx.signAndExecute(signer as AccountValue, () => {});
	},
});

const requiresAccount = (accountRef: AccountRef): AccountValue => ({
	name: accountRef.id.slice('account/'.length),
	address: '0x0',
	sign: (bytes) => Effect.succeed(bytes),
});

const acceptsAnyAccount = (accountRef: AnyAccountRef): string => accountRef.id;

requiresAccount(alice);
acceptsAnyAccount(publisher);

// @ts-expect-error package refs are not accounts
requiresAccount(connectFour);

const codegenDecl = codegenable({
	emitterName: 'redis/cache',
	outputPath: 'redis/cache.ts',
	emit: (writer) =>
		writer.writeTypeScript(
			`export const redis = ${JSON.stringify(
				{
					name: 'cache',
					url: redisUrl,
				},
				null,
				2,
			)};\n`,
		),
});
void codegenDecl;

const simnet = defineNetwork({
	mode: 'simnet',
	name: 'simnet',
	faucetUrl: 'http://127.0.0.1:9124',
});
const simnetFaucetUrl: string = simnet.faucetUrl;
void simnetFaucetUrl;

defineNetwork({
	mode: 'local',
	name: 'localnet',
	// @ts-expect-error checkpoint is fork-mode only
	checkpoint: '1',
});

const unixRoutable = routable({
	endpointName: 'redis-socket',
	dispatchId: { groupKey: 'redis', role: 'socket' },
	upstream: { type: 'unix-socket', path: '/tmp/redis.sock' },
	cors: true,
});
void unixRoutable;

routable({
	endpointName: 'bad-socket',
	dispatchId: { groupKey: 'redis', role: 'socket' },
	// @ts-expect-error unix-socket upstreams require a path
	upstream: { type: 'unix-socket' },
	cors: true,
});

definePlugin({
	id: 'operator/metrics',
	kind: 'operator',
	start: () => Effect.succeed({}),
});

definePlugin({
	id: 'operator/bad-kind',
	// @ts-expect-error unknown plugin kinds are rejected unless registered
	kind: 'unregistered-kind',
	start: () => Effect.succeed({}),
});

const worktreeSibling = liftedSibling({
	plugin: 'redis',
	kind: 'image',
	scope: 'per-worktree',
	inputHash: 'sha256:worktree',
});
void worktreeSibling;

liftedSibling({
	plugin: 'redis',
	kind: 'image',
	// @ts-expect-error unknown lifted sibling scopes are rejected unless registered
	scope: 'per-unknown',
	inputHash: 'sha256:unknown',
});

// @ts-expect-error custom capability payloads cannot override the helper's kind
localHealthCheck({ kind: 'other-health-check', url: redisUrl, intervalMs: 1000 });

localHealthCheck({
	url: redisUrl,
	intervalMs: 1000,
	// @ts-expect-error registered capability payloads reject unknown fields
	typoIntervalMs: 1000,
});

capabilitySink('health-check', (capability) => {
	const url: string = capability.url;
	void url;
	// @ts-expect-error health-check capabilities do not have a missing field
	capability.missing;
	return Effect.void;
});

codegenable({
	// @ts-expect-error capability payloads cannot override the helper's kind
	kind: 'not-codegenable',
	emitterName: 'bad',
	outputPath: 'bad.ts',
	emit: (writer) => writer.writeTypeScript(''),
});

interface ProvidesIndexerWitness extends ProvidesWitness<'indexer-ready'> {
	readonly url: string;
}

interface RequiresIndexerWitness extends RequiresWitness<'indexer-ready'> {
	readonly url: string;
}

const indexerWitnessProvider = definePlugin({
	id: 'witness/indexer-provider',
	kind: 'leaf-one-shot',
	start: () => {
		const value: ProvidesIndexerWitness = { url: 'http://127.0.0.1:5190' };
		return Effect.succeed(value);
	},
});

const indexerWitnessConsumer = definePlugin({
	id: 'witness/indexer-consumer',
	kind: 'leaf-one-shot',
	start: () => {
		const value: RequiresIndexerWitness = { url: 'http://127.0.0.1:5191' };
		return Effect.succeed(value);
	},
});

defineDevstack({ members: [indexerWitnessProvider, indexerWitnessConsumer] });

// @ts-expect-error unsatisfiedWitnesses: "indexer-ready"
defineDevstack({ members: [indexerWitnessConsumer] });

const sameSiblingA = definePlugin({
	id: 'sibling/same-a',
	kind: 'hidden-leaf',
	liftedSiblings: [
		liftedSibling({
			plugin: 'redis',
			kind: 'image',
			scope: 'per-app',
			inputHash: 'sha256:same',
		}),
	],
	start: () => Effect.succeed({}),
});

const sameSiblingB = definePlugin({
	id: 'sibling/same-b',
	kind: 'hidden-leaf',
	liftedSiblings: [
		liftedSibling({
			plugin: 'redis',
			kind: 'image',
			scope: 'per-app',
			inputHash: 'sha256:same',
		}),
	],
	start: () => Effect.succeed({}),
});

const conflictingSibling = definePlugin({
	id: 'sibling/conflicting',
	kind: 'hidden-leaf',
	liftedSiblings: [
		liftedSibling({
			plugin: 'redis',
			kind: 'image',
			scope: 'per-app',
			inputHash: 'sha256:different',
		}),
	],
	start: () => Effect.succeed({}),
});

defineDevstack({ members: [sameSiblingA, sameSiblingB] });

const sameSiblingHash: NonNullable<
	typeof sameSiblingA.liftedSiblings
>[number]['inputHash'] = 'sha256:same';
void sameSiblingHash;

// @ts-expect-error literal sibling input hash is preserved
const badSameSiblingHash: NonNullable<
	typeof sameSiblingA.liftedSiblings
>[number]['inputHash'] = 'sha256:different';
void badSameSiblingHash;

const siblingConflictGroup: ConflictingSiblingGroups<
	readonly [typeof sameSiblingA, typeof conflictingSibling]
> = 'redis|image|per-app';
void siblingConflictGroup;

// @ts-expect-error siblingHashConflicts: "redis|image|per-app"
defineDevstack({ members: [sameSiblingA, conflictingSibling] });
