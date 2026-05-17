// State shapes the TUI / plain renderer / ink components render from.
//
// The types moved to `engine/tui-state.ts` — they describe engine state
// (per-tag status, header identity, log tail) and are produced by the
// engine. This file stays as a re-export shim so existing imports
// `from '../tui/render.js'` keep working; new code should import from
// `../engine/tui-state.js` directly.

export type {
	BuildStatus,
	TagStatus,
	TuiDimensions,
	TuiEndpoint,
	TuiEntry,
	TuiEntryKind,
	TuiHeader,
	TuiLog,
	TuiState,
} from '../engine/tui-state.js';
