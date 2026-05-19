// Pure-parser coverage for `parseDockerPullLine` — the line-by-line
// state machine that turns `docker pull <image>` stdout into the
// `setPhase('pulling K/N layers (<image>)')` strings the plain renderer
// surfaces while a long image pull is in flight. See
// `notes/long-acquire-progress.md §3.2B`.
//
// These tests are deliberately *pure* — no Effect, no spawner stubs —
// because the parser is the load-bearing pure-data piece. The Effect
// wiring (streaming subprocess + setPhase forwarding) is exercised by
// `capture-command.test.ts` and the existing integration tests.

import { describe, expect, it } from 'vitest';
import { initialDockerPullProgress, parseDockerPullLine } from './image.js';

const IMAGE = 'mysten/sui-tools:1.45.0';

// Replay a list of lines through the parser, collecting the phase
// strings the parser emits along the way. The terminal state is also
// returned so a few tests can assert it directly.
const replay = (lines: ReadonlyArray<string>, image: string = IMAGE) => {
	let state = initialDockerPullProgress();
	const phases: Array<string> = [];
	for (const line of lines) {
		const { state: next, phase } = parseDockerPullLine(state, line, image);
		state = next;
		if (phase !== undefined) phases.push(phase);
	}
	return { state, phases };
};

describe('parseDockerPullLine', () => {
	it('emits nothing for irrelevant lines', () => {
		const { phases } = replay([
			`${IMAGE}: Pulling from mysten/sui-tools`,
			'1.45.0: Pulling from somewhere/else',
			'Digest: sha256:abcdef',
			'',
		]);
		expect(phases).toEqual([]);
	});

	it('counts a single "Pulling fs layer" as 0/1', () => {
		const { phases } = replay(['abc123: Pulling fs layer']);
		expect(phases).toEqual([`pulling 0/1 layers (${IMAGE})`]);
	});

	it('two layer-pull lines fold into 0/2 (numerator stays at 0)', () => {
		const { phases } = replay([
			'abc123: Pulling fs layer',
			'def456: Pulling fs layer',
		]);
		expect(phases).toEqual([
			`pulling 0/1 layers (${IMAGE})`,
			`pulling 0/2 layers (${IMAGE})`,
		]);
	});

	it('a Pull complete on the first layer reads 1/2', () => {
		const { phases } = replay([
			'abc123: Pulling fs layer',
			'def456: Pulling fs layer',
			'abc123: Pull complete',
		]);
		expect(phases.at(-1)).toBe(`pulling 1/2 layers (${IMAGE})`);
	});

	it('all layers complete reads N/N', () => {
		const { phases } = replay([
			'abc123: Pulling fs layer',
			'def456: Pulling fs layer',
			'abc123: Pull complete',
			'def456: Pull complete',
		]);
		expect(phases.at(-1)).toBe(`pulling 2/2 layers (${IMAGE})`);
	});

	it('terminal Status line bumps the counter to N/N even mid-progress', () => {
		// `docker pull` sometimes prints a final "Status: Downloaded
		// newer image for X" without re-emitting Pull complete for the
		// last layer in some edge cases — the parser must still settle.
		const { phases } = replay([
			'abc123: Pulling fs layer',
			'def456: Pulling fs layer',
			'abc123: Pull complete',
			`Status: Downloaded newer image for ${IMAGE}`,
		]);
		expect(phases.at(-1)).toBe(`pulling 2/2 layers (${IMAGE})`);
	});

	it('"Image is up to date" emits a 1/1 even with no layer lines', () => {
		const { phases } = replay([`Status: Image is up to date for ${IMAGE}`]);
		expect(phases).toEqual([`pulling 1/1 layers (${IMAGE})`]);
	});

	it('a duplicate "Pulling fs layer" is a no-op', () => {
		const { phases } = replay([
			'abc123: Pulling fs layer',
			'abc123: Pulling fs layer',
		]);
		expect(phases).toEqual([`pulling 0/1 layers (${IMAGE})`]);
	});

	it('a duplicate "Pull complete" is a no-op', () => {
		const { phases } = replay([
			'abc123: Pulling fs layer',
			'abc123: Pull complete',
			'abc123: Pull complete',
		]);
		expect(phases).toEqual([
			`pulling 0/1 layers (${IMAGE})`,
			`pulling 1/1 layers (${IMAGE})`,
		]);
	});

	it('out-of-order Pull complete (cached layer with no prior Pulling fs layer) still counts', () => {
		// Cached layers can surface "Pull complete" without a preceding
		// "Pulling fs layer". The denominator follows the union of
		// seen+complete so it stays sensible.
		const { phases } = replay(['cached1: Pull complete']);
		expect(phases).toEqual([`pulling 1/1 layers (${IMAGE})`]);
	});

	it('realistic `docker pull` transcript replays end-to-end', () => {
		// Synthetic transcript modelled on real `docker pull` output —
		// the leading `Pulling from ...` is ignored, three layer
		// lifecycles fully resolve, and the terminal Status: line
		// settles the row.
		const transcript = [
			`${IMAGE}: Pulling from mysten/sui-tools`,
			'abc123: Pulling fs layer',
			'def456: Pulling fs layer',
			'ghi789: Pulling fs layer',
			'abc123: Downloading [==>     ] 1.234MB/45.67MB',
			'abc123: Pull complete',
			'def456: Downloading [==>     ] 2.345MB/56.78MB',
			'def456: Pull complete',
			'ghi789: Pull complete',
			'Digest: sha256:deadbeef',
			`Status: Downloaded newer image for ${IMAGE}`,
		];
		const { phases } = replay(transcript);
		expect(phases).toEqual([
			`pulling 0/1 layers (${IMAGE})`,
			`pulling 0/2 layers (${IMAGE})`,
			`pulling 0/3 layers (${IMAGE})`,
			`pulling 1/3 layers (${IMAGE})`,
			`pulling 2/3 layers (${IMAGE})`,
			`pulling 3/3 layers (${IMAGE})`,
			// Terminal Status line is a no-op once the counters already settled.
			`pulling 3/3 layers (${IMAGE})`,
		]);
	});

	it('threading state across calls is functional (no in-place mutation)', () => {
		// Verifies the returned `state` is fresh — caller holding the
		// original reference should not see its sets grow underfoot.
		const initial = initialDockerPullProgress();
		const { state: afterFirst } = parseDockerPullLine(
			initial,
			'abc123: Pulling fs layer',
			IMAGE,
		);
		expect(initial.layersSeen.size).toBe(0);
		expect(afterFirst.layersSeen.size).toBe(1);
	});
});
