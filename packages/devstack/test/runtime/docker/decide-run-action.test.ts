// Pure state machine for ensureContainer lifecycle.
//
// Architecture invariants under test:
//   - missing → fresh (regardless of policy)
//   - running + image-match → adopt
//   - running/stopped + image-match + port-mismatch → recreate
//   - running + image-mismatch → recreate (or refuse on 'never' policy)
//   - stopped-clean + image-match → resume (any policy)
//   - stopped-unclean + image-match → policy-routed:
//       * on-failure → recreate(unclean-shutdown)
//       * never → refuse(unclean-shutdown)
//       * on-config-change → resume
//   - stopped + image-mismatch → recreate (or refuse on 'never')

import { describe, expect, it } from 'vitest';

import { decideRunAction, type InspectFacts } from '../../../src/runtime/docker/container.ts';

const factsRunning = (image: string): InspectFacts => ({
	id: 'c1',
	lifecycle: { kind: 'running', exitCode: 0 },
	running: true,
	paused: false,
	exitCode: 0,
	image,
});

const factsPaused = (image: string): InspectFacts => ({
	id: 'c1',
	lifecycle: { kind: 'paused', exitCode: 0 },
	running: true,
	paused: true,
	exitCode: 0,
	image,
});

const factsStopped = (image: string, exitCode: number): InspectFacts => ({
	id: 'c1',
	lifecycle: { kind: 'stopped', exitCode },
	running: false,
	paused: false,
	exitCode,
	image,
});

describe('decideRunAction — null facts', () => {
	for (const policy of ['on-failure', 'never', 'on-config-change'] as const) {
		it(`missing container → fresh under ${policy}`, () => {
			expect(decideRunAction(null, 'img:1', policy)).toEqual({ kind: 'fresh' });
		});
	}
});

describe('decideRunAction — running container', () => {
	it('image match → adopt', () => {
		expect(decideRunAction(factsRunning('img:1'), 'img:1', 'on-failure')).toEqual({
			kind: 'adopt',
			id: 'c1',
		});
	});

	it('paused image match → unpause and adopt', () => {
		expect(decideRunAction(factsPaused('img:1'), 'img:1', 'on-failure')).toEqual({
			kind: 'unpause-adopt',
			id: 'c1',
		});
	});

	it('paused image mismatch under on-failure → recreate(image-mismatch)', () => {
		expect(decideRunAction(factsPaused('img:0'), 'img:1', 'on-failure')).toEqual({
			kind: 'recreate',
			id: 'c1',
			reason: 'image-mismatch',
		});
	});

	it('port binding mismatch under on-config-change → recreate(config-mismatch)', () => {
		expect(
			decideRunAction(
				{ ...factsRunning('img:1'), portBindings: ['9000/tcp=0.0.0.0:9000'] },
				'img:1',
				'on-config-change',
				['9000/tcp=0.0.0.0:51000'],
			),
		).toEqual({ kind: 'recreate', id: 'c1', reason: 'config-mismatch' });
	});

	it('port binding mismatch with adopt-existing reconciliation → adopt', () => {
		expect(
			decideRunAction(
				{ ...factsRunning('img:1'), portBindings: ['9000/tcp=0.0.0.0:9000'] },
				'img:1',
				'on-config-change',
				['9000/tcp=0.0.0.0:51000'],
				'adopt-existing',
			),
		).toEqual({ kind: 'adopt', id: 'c1' });
	});

	it('adopt-existing reconciliation still recreates when published container ports differ', () => {
		expect(
			decideRunAction(
				{ ...factsRunning('img:1'), portBindings: ['8080/tcp=0.0.0.0:9000'] },
				'img:1',
				'on-config-change',
				['9000/tcp=0.0.0.0:51000'],
				'adopt-existing',
			),
		).toEqual({ kind: 'recreate', id: 'c1', reason: 'config-mismatch' });
	});

	it('port binding mismatch under never → refuse(config-mismatch)', () => {
		expect(
			decideRunAction(
				{ ...factsStopped('img:1', 0), portBindings: ['9123/tcp=0.0.0.0:9123'] },
				'img:1',
				'never',
				['9123/tcp=0.0.0.0:50000'],
			),
		).toEqual({ kind: 'refuse', reason: 'config-mismatch' });
	});

	it('image mismatch under on-failure → recreate(image-mismatch)', () => {
		expect(decideRunAction(factsRunning('img:0'), 'img:1', 'on-failure')).toEqual({
			kind: 'recreate',
			id: 'c1',
			reason: 'image-mismatch',
		});
	});

	it('image mismatch under never → refuse(image-mismatch)', () => {
		expect(decideRunAction(factsRunning('img:0'), 'img:1', 'never')).toEqual({
			kind: 'refuse',
			reason: 'image-mismatch',
		});
	});

	it('image mismatch under on-config-change → recreate', () => {
		expect(decideRunAction(factsRunning('img:0'), 'img:1', 'on-config-change')).toEqual({
			kind: 'recreate',
			id: 'c1',
			reason: 'image-mismatch',
		});
	});
});

describe('decideRunAction — stopped container, image match', () => {
	it('exit 0 under any policy → resume', () => {
		expect(decideRunAction(factsStopped('img:1', 0), 'img:1', 'on-failure')).toEqual({
			kind: 'resume',
			id: 'c1',
		});
		expect(decideRunAction(factsStopped('img:1', 0), 'img:1', 'never')).toEqual({
			kind: 'resume',
			id: 'c1',
		});
		expect(decideRunAction(factsStopped('img:1', 0), 'img:1', 'on-config-change')).toEqual({
			kind: 'resume',
			id: 'c1',
		});
	});

	it('stopped port mismatch with adopt-existing reconciliation → resume', () => {
		expect(
			decideRunAction(
				{ ...factsStopped('img:1', 0), portBindings: ['9123/tcp=0.0.0.0:9123'] },
				'img:1',
				'on-config-change',
				['9123/tcp=0.0.0.0:50000'],
				'adopt-existing',
			),
		).toEqual({ kind: 'resume', id: 'c1' });
	});

	it('exit 137 (unclean) under on-failure → recreate(unclean-shutdown)', () => {
		expect(decideRunAction(factsStopped('img:1', 137), 'img:1', 'on-failure')).toEqual({
			kind: 'recreate',
			id: 'c1',
			reason: 'unclean-shutdown',
		});
	});

	it('exit 137 under never → refuse(unclean-shutdown)', () => {
		expect(decideRunAction(factsStopped('img:1', 137), 'img:1', 'never')).toEqual({
			kind: 'refuse',
			reason: 'unclean-shutdown',
		});
	});

	it('exit 137 under on-config-change → resume (kept until config change)', () => {
		expect(decideRunAction(factsStopped('img:1', 137), 'img:1', 'on-config-change')).toEqual({
			kind: 'resume',
			id: 'c1',
		});
	});
});

describe('decideRunAction — stopped container, image mismatch', () => {
	it('image-mismatch wins over exit code under on-failure', () => {
		expect(decideRunAction(factsStopped('img:0', 0), 'img:1', 'on-failure')).toEqual({
			kind: 'recreate',
			id: 'c1',
			reason: 'image-mismatch',
		});
		expect(decideRunAction(factsStopped('img:0', 137), 'img:1', 'on-failure')).toEqual({
			kind: 'recreate',
			id: 'c1',
			reason: 'image-mismatch',
		});
	});

	it('image-mismatch under never → refuse', () => {
		expect(decideRunAction(factsStopped('img:0', 0), 'img:1', 'never')).toEqual({
			kind: 'refuse',
			reason: 'image-mismatch',
		});
	});
});
