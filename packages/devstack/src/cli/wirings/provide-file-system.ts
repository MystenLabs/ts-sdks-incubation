// Shared `provideFileSystem` helper for verb wirings.
//
// Several wirings (`up`, `snapshot`, `wipe`) hoist a `FileSystem.FileSystem`
// out of an enclosing Effect and re-thread it into sub-Effects that depend
// on it. Factor the one-liner so we don't drift on signature/import (and so
// later changes — e.g. tagging the call site with a span — happen in one
// place).

import { Effect, FileSystem } from 'effect';

export const provideFileSystem = <A, E, R>(
	fs: FileSystem.FileSystem,
	effect: Effect.Effect<A, E, R | FileSystem.FileSystem>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem>> =>
	effect.pipe(Effect.provideService(FileSystem.FileSystem, fs)) as Effect.Effect<
		A,
		E,
		Exclude<R, FileSystem.FileSystem>
	>;
