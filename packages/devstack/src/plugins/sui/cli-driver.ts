// Compatibility re-export. The single implementation lives in the
// L1-adjacent shared Move-build helper.

export {
	containerInnerScript,
	extractTrailingJson,
	hostBuildArgv,
	shellQuote,
	stripPinnedSections,
	type MoveBuildInput,
	type MoveBuildOutput,
} from '../../substrate/runtime/sui-move-build/index.ts';
