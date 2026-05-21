// Channel-backed CLI deps — publisher fails fast when no supervisor
// is live; subscribe path tails the events file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { makeChannelPublisher } from '../../../../src/surfaces/cli/commands/channel-deps.ts';
import { CliNoSupervisorError } from '../../../../src/surfaces/cli/errors.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'channel-deps-test-'));

describe('makeChannelPublisher', () => {
	it.live('fails with CliNoSupervisorError when no roster exists', () =>
		Effect.gen(function* () {
			const root = fresh();
			try {
				const publisher = makeChannelPublisher({
					app: 'demo',
					stack: 'main',
					stackRoot: root,
					rosterFile: join(root, 'roster.json'),
				});
				const exit = yield* Effect.exit(publisher.publish({ tag: 'shutdown.requested' }));
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const err = Exit.findErrorOption(exit);
					expect(err._tag).toBe('Some');
					if (err._tag === 'Some') {
						expect(err.value).toBeInstanceOf(CliNoSupervisorError);
					}
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
