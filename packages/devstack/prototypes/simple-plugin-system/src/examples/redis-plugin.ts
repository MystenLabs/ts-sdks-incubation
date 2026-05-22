import { Effect } from 'effect';

import { codegenable, defineId, definePlugin, routable, snapshotable } from '../core.ts';
import { Sui } from '../builtins.ts';
import { healthCheck } from './health-check-capability.ts';

export interface RedisValue {
	name: string;
	url: string;
	flush: () => Effect.Effect<void>;
}

export const redis = <const Name extends string>(name: Name) => {
	const id = defineId(`redis/${name}`);

	return definePlugin({
		id,
		dependsOn: Sui,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		start: () =>
			Effect.succeed({
				name,
				url: `redis://127.0.0.1:6379/${name}`,
				flush: () => Effect.void,
			} satisfies RedisValue),
		capabilities: ({ value }) =>
			[
				snapshotable({
					subtrees: [id],
					missingTolerance: 'fine',
				}),
				routable({
					endpointName: `redis-${name}`,
					dispatchId: { groupKey: id, role: 'tcp' },
					upstream: { type: 'host-loopback', port: 6379 },
					wireProtocol: 'tcp',
				}),
				healthCheck({ url: value.url, intervalMs: 1000 }),
				codegenable({
					emitterName: id,
					outputPath: `${id}.ts`,
					emit: (writer) =>
						writer.writeTypeScript(
							`export const redis = ${JSON.stringify(
								{
									name,
									url: value.url,
								},
								null,
								2,
							)};\n`,
						),
				}),
			],
	});
};
