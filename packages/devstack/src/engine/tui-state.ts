// Engine-side state shapes the TUI / plain renderer / ink components
// render FROM. These describe engine lifecycle state (per-tag status,
// per-tag phase, whole-stack build status, header identity, log tail) —
// they're produced by the engine and consumed by `tui/*`, so they live
// here.
//
// Renderers under `tui/` (ink components, plain text renderer) import
// these types as inputs. The reverse — engine importing tui/ — would
// invert the dependency. Previously these types sat in `tui/render.ts`
// with engine/engine.ts importing them back; `tui/render.ts` is now a
// re-export shim for back-compat.

export type TagStatus = 'pending' | 'acquiring' | 'ready' | 'failed';

export type TuiEntryKind = 'service' | 'package' | 'account' | 'action' | 'app' | 'other';

/** Whole-stack lifecycle phase — drives the header tint and footer copy.
 *
 * `shutting-down` flashes briefly between the user's quit gesture (q / SIGINT)
 * and process exit so the freeze that scope teardown introduces is explained
 * by a visible state change rather than reading like a hang. */
export type BuildStatus = 'idle' | 'running' | 'failed' | 'restarting' | 'shutting-down';

export interface TuiEntry {
	readonly key: string;
	readonly kind: TuiEntryKind;
	readonly status: TagStatus;
	/** Optional sub-phase surfaced while `status === 'acquiring'`. */
	readonly phase?: string;
	/** Short (~60 char) one-line error summary the dashboard row can render
	 * without wrapping. Full multi-line cause walk lives in `engine.appendLog`. */
	readonly error?: string;
	/** Friendly label projected by the primitive's `display` selector. */
	readonly title?: string;
	/** Primary artifact — URL for services, packageId/address/digest for actions. */
	readonly primary?: string;
	/** Secondary chips rendered to the right of `primary`. */
	readonly extras?: ReadonlyArray<string>;
	/** Multiple labelled endpoints — used by primitives that expose several
	 * URLs (sui's rpc + faucet + graphql). Rendered as indented lines below
	 * the primary row. When present, `primary` is omitted from the detail
	 * column to avoid duplication. */
	readonly endpoints?: ReadonlyArray<{ readonly label: string; readonly url: string }>;
	/** Per-primitive log tail — the engine pushes one entry per `Effect.log*`
	 * call inside the wrapped build effect. The dashboard surfaces the LAST
	 * entry in the detail column when the primitive has no `error`, `phase`,
	 * or `primary` to show. */
	readonly lastLog?: string;
}

export interface TuiHeader {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	readonly buildStatus: BuildStatus;
	/** Monotonic counter incremented per launch iteration. Surfaces in the
	 * header so the user can see hot-restart cycles fire. */
	readonly cycle: number;
}

export interface TuiEndpoint {
	readonly name: string;
	readonly url: string;
	readonly kind?: string;
}

export interface TuiLog {
	readonly ts: number;
	readonly level: string;
	readonly message: string;
}

export interface TuiState {
	readonly entries: ReadonlyArray<TuiEntry>;
	readonly endpoints: ReadonlyArray<TuiEndpoint>;
	readonly logs: ReadonlyArray<TuiLog>;
	readonly header: TuiHeader;
}

export interface TuiDimensions {
	readonly rows: number;
	readonly columns: number;
}
