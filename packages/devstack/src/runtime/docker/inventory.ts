// Label-driven inventory.
//
// Architecture § Container runtime § Label-driven inventory:
//   inventory NEVER greps stdout for container names; it ALWAYS
//   filters by labels via `--filter label=...`. The output format is
//   the `--format` JSON line shape, which we parse line-by-line.
//
// Surface:
//   - `listContainers(match)` → ContainerSummary[]
//   - `listImages(match)`     → ImageSummary[]
//   - `listNetworks(match)`   → NetworkSummary[]
//   - `listVolumes(match)`    → VolumeSummary[]

import { Effect, Schema } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { decodeJsonTextSync } from '../../substrate/runtime/runtime-decode.ts';
import { DockerHost, DockerSpawner, dockerRunOk } from './client.ts';
import type { DockerRuntimeError } from './errors.ts';
import { LabelKey, renderFilterArgs } from './labels.ts';
import { wrapGeneric } from './wrap.ts';

// -----------------------------------------------------------------------------
// Summary shapes — what the label-filter listers return
// -----------------------------------------------------------------------------

export interface ContainerSummary {
	readonly id: string;
	readonly name: string;
	readonly image: string;
	readonly status: string;
	readonly state: string;
	readonly labels: Readonly<Record<string, string>>;
}

export interface ImageSummary {
	readonly id: string;
	readonly tag: string;
	readonly labels: Readonly<Record<string, string>>;
}

export interface NetworkSummary {
	readonly id: string;
	readonly name: string;
	readonly driver: string;
	readonly labels: Readonly<Record<string, string>>;
}

export interface VolumeSummary {
	readonly name: string;
	readonly driver: string;
	readonly mountpoint: string;
	readonly labels: Readonly<Record<string, string>>;
}

// -----------------------------------------------------------------------------
// JSON-line schemas (docker --format '{{json .}}')
// -----------------------------------------------------------------------------

const PsLine = Schema.Struct({
	ID: Schema.String,
	Names: Schema.String,
	Image: Schema.String,
	Status: Schema.String,
	State: Schema.String,
	Labels: Schema.optional(Schema.String),
});

const ImagesLine = Schema.Struct({
	ID: Schema.String,
	Repository: Schema.String,
	Tag: Schema.String,
	Labels: Schema.optional(Schema.String),
});

const NetworksLine = Schema.Struct({
	ID: Schema.String,
	Name: Schema.String,
	Driver: Schema.String,
	Labels: Schema.optional(Schema.String),
});

const VolumesLine = Schema.Struct({
	Name: Schema.String,
	Driver: Schema.String,
	Mountpoint: Schema.String,
	Labels: Schema.optional(Schema.String),
});

// -----------------------------------------------------------------------------
// Label parsing — docker's `Labels` field is a comma-joined `k=v,k=v`
// -----------------------------------------------------------------------------

const parseLabelString = (s: string | undefined): Record<string, string> => {
	if (!s) return {};
	const out: Record<string, string> = {};
	for (const part of s.split(',')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
};

const parseJsonLines = <S extends Schema.Decoder<unknown>>(
	schema: S,
	stdout: string,
): ReadonlyArray<S['Type']> => {
	const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
	const out: Array<S['Type']> = [];
	for (const [index, line] of lines.entries()) {
		try {
			out.push(
				decodeJsonTextSync(schema, line, {
					source: `docker inventory:${index + 1}`,
					mkError: (issue) => issue,
				}),
			);
		} catch {
			// Malformed line — skip. Inventory is best-effort; a single
			// torn line shouldn't poison the whole sweep.
		}
	}
	return out;
};

// -----------------------------------------------------------------------------
// Listers
// -----------------------------------------------------------------------------

const toContainerSummaries = (stdout: string): ReadonlyArray<ContainerSummary> => {
	const lines = parseJsonLines(PsLine, stdout);
	return lines.map(
		(l): ContainerSummary => ({
			id: l.ID,
			name: l.Names.split(',')[0] ?? l.Names,
			image: l.Image,
			status: l.Status,
			state: l.State,
			labels: parseLabelString(l.Labels),
		}),
	);
};

const toImageSummaries = (stdout: string): ReadonlyArray<ImageSummary> => {
	const lines = parseJsonLines(ImagesLine, stdout);
	return lines.map(
		(l): ImageSummary => ({
			id: l.ID,
			tag: `${l.Repository}:${l.Tag}`,
			labels: parseLabelString(l.Labels),
		}),
	);
};

const toNetworkSummaries = (stdout: string): ReadonlyArray<NetworkSummary> => {
	const lines = parseJsonLines(NetworksLine, stdout);
	return lines.map(
		(l): NetworkSummary => ({
			id: l.ID,
			name: l.Name,
			driver: l.Driver,
			labels: parseLabelString(l.Labels),
		}),
	);
};

const toVolumeSummaries = (stdout: string): ReadonlyArray<VolumeSummary> => {
	const lines = parseJsonLines(VolumesLine, stdout);
	return lines.map(
		(l): VolumeSummary => ({
			name: l.Name,
			driver: l.Driver,
			mountpoint: l.Mountpoint,
			labels: parseLabelString(l.Labels),
		}),
	);
};

const devstackAppFilterArgs: ReadonlyArray<string> = ['--filter', `label=${LabelKey.app}`];

export const listContainers = (
	match: Partial<ContainerLabelTuple>,
): Effect.Effect<ReadonlyArray<ContainerSummary>, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const filters = renderFilterArgs(match);
		const res = yield* dockerRunOk('ps', ['-a', '--format', '{{json .}}', ...filters]).pipe(
			Effect.mapError(wrapGeneric('docker.ps')),
		);
		return toContainerSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.containers'));

export const listDevstackContainers = (): Effect.Effect<
	ReadonlyArray<ContainerSummary>,
	DockerRuntimeError,
	DockerHost | DockerSpawner
> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('ps', [
			'-a',
			'--format',
			'{{json .}}',
			...devstackAppFilterArgs,
		]).pipe(Effect.mapError(wrapGeneric('docker.ps')));
		return toContainerSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.devstackContainers'));

export const listImages = (
	match: Partial<ContainerLabelTuple>,
): Effect.Effect<ReadonlyArray<ImageSummary>, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const filters = renderFilterArgs(match);
		const res = yield* dockerRunOk('images', ['--format', '{{json .}}', ...filters]).pipe(
			Effect.mapError(wrapGeneric('docker.images')),
		);
		return toImageSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.images'));

export const listDevstackImages = (): Effect.Effect<
	ReadonlyArray<ImageSummary>,
	DockerRuntimeError,
	DockerHost | DockerSpawner
> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('images', [
			'--format',
			'{{json .}}',
			...devstackAppFilterArgs,
		]).pipe(Effect.mapError(wrapGeneric('docker.images')));
		return toImageSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.devstackImages'));

export const listNetworks = (
	match: Partial<ContainerLabelTuple>,
): Effect.Effect<ReadonlyArray<NetworkSummary>, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const filters = renderFilterArgs(match);
		const res = yield* dockerRunOk('network', ['ls', '--format', '{{json .}}', ...filters]).pipe(
			Effect.mapError(wrapGeneric('docker.network.ls')),
		);
		return toNetworkSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.networks'));

export const listDevstackNetworks = (): Effect.Effect<
	ReadonlyArray<NetworkSummary>,
	DockerRuntimeError,
	DockerHost | DockerSpawner
> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('network', [
			'ls',
			'--format',
			'{{json .}}',
			...devstackAppFilterArgs,
		]).pipe(Effect.mapError(wrapGeneric('docker.network.ls')));
		return toNetworkSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.devstackNetworks'));

export const listVolumes = (
	match: Partial<ContainerLabelTuple>,
): Effect.Effect<ReadonlyArray<VolumeSummary>, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const filters = renderFilterArgs(match);
		const res = yield* dockerRunOk('volume', ['ls', '--format', '{{json .}}', ...filters]).pipe(
			Effect.mapError(wrapGeneric('docker.volume.ls')),
		);
		return toVolumeSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.volumes'));

export const listDevstackVolumes = (): Effect.Effect<
	ReadonlyArray<VolumeSummary>,
	DockerRuntimeError,
	DockerHost | DockerSpawner
> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('volume', [
			'ls',
			'--format',
			'{{json .}}',
			...devstackAppFilterArgs,
		]).pipe(Effect.mapError(wrapGeneric('docker.volume.ls')));
		return toVolumeSummaries(res.stdout);
	}).pipe(Effect.withSpan('runtime.docker.inventory.devstackVolumes'));
