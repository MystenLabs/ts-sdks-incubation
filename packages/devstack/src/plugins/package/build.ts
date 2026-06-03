// Package plugin bridge for shared Sui Move build helpers.

import { Effect, type Scope } from 'effect';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import type { ChainId, ContentHash } from '../../substrate/brand.ts';
import {
	hashMoveSources as hashMoveSourcesNeutral,
	runMoveBuild as runMoveBuildNeutral,
	scrubLocksHost as scrubLocksHostNeutral,
	type BuildOutput,
	type MoveBuildError,
	type MoveBuildContainer,
	type ChainBuildContainer,
} from '../sui/index.ts';
import { publishError, type PublishError } from './errors.ts';

export {
	containerInnerScript,
	extractTrailingJson,
	parseBuildOutput,
	stripPinnedSections,
	type MoveBuildContainer,
	type MoveBuildError,
	type MoveBuildPhase,
	type MoveBuildInput,
	type MoveBuildOutput,
} from '../sui/index.ts';
export type { BuildOutput };

export interface BuildInputs {
	readonly sourcePath: string;
	readonly packageName: string;
	readonly chainId: ChainId;
	readonly buildContainer?: ChainBuildContainer;
	readonly runtime?: ContainerRuntime;
	readonly buildImage?: ImageRef;
}

const toPublishError = (err: MoveBuildError): PublishError =>
	publishError(err.phase, {
		sourcePath: err.sourcePath,
		packageName: err.packageName,
		message: err.message,
		...(err.cause !== undefined ? { cause: err.cause } : { cause: err }),
	});

export const hashMoveSources = (sourcePath: string): Effect.Effect<ContentHash, PublishError> =>
	hashMoveSourcesNeutral(sourcePath).pipe(Effect.mapError(toPublishError));

export const scrubLocksHost = (
	sourcePath: string,
	moveHomeRoot: string,
): Effect.Effect<void, PublishError, Scope.Scope> =>
	scrubLocksHostNeutral(sourcePath, moveHomeRoot).pipe(Effect.mapError(toPublishError));

export const runMoveBuild = (
	inputs: BuildInputs,
): Effect.Effect<BuildOutput, PublishError, Scope.Scope> =>
	runMoveBuildNeutral({
		sourcePath: inputs.sourcePath,
		packageName: inputs.packageName,
		chainId: inputs.chainId,
		...(inputs.buildContainer !== undefined
			? { buildContainer: inputs.buildContainer satisfies MoveBuildContainer }
			: {}),
		...(inputs.runtime !== undefined ? { runtime: inputs.runtime } : {}),
		...(inputs.buildImage !== undefined ? { buildImage: inputs.buildImage } : {}),
	}).pipe(Effect.mapError(toPublishError));
