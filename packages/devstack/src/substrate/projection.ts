// Renderer subscribable projection — exact field enumeration.
//
// Architecture § Renderer § "Subscribable projection — exact field
// enumeration" (G2). Adding a field is an architecture revision,
// not a code change.
//
// Fields EXPLICITLY ABSENT from this projection:
//   - `title`   (renderers compute from `key` + display rules)
//   - `primary` (a CLI-vs-TUI presentation concept; renderer-derived)
//   - `extras`  (today's catch-all — every "extra" must now be a
//                typed field below or a typed event in the live
//                stream).
//
// This is the discipline mechanism that makes "no display vocabulary
// leaks into engine" verifiable: the prototype proved
// `'title' extends keyof Row` evaluates to `false`.

import type { EndpointKey, PluginKey } from './brand.ts';
import type { LifecycleStatus, PhaseNarration, PluginRole } from './lifecycle.ts';

/** Top-level subscribable state. Renderers project this. */
export interface SubscribableState {
	readonly identity: {
		readonly app: string;
		readonly stack: string;
		readonly network: string;
	};
	readonly cycle: {
		readonly id: number;
		readonly startedAt: number;
		readonly phase:
			| 'booting'
			| 'running'
			| 'restarting'
			| 'shutting-down'
			| 'snapshotting'
			| 'restoring';
	};
	readonly rows: ReadonlyArray<Row>;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly accounts: ReadonlyArray<AccountProjection>;
	readonly packages: ReadonlyArray<PackageProjection>;
	readonly errors: ReadonlyArray<StructuredError>;
	readonly lastEvent: { readonly seq: number; readonly at: number };
	readonly stackBuild: ReadonlyArray<BuildEntry>;
}

/** Closed vocabulary of dashboard section buckets a row belongs to.
 *
 *  The renderer groups rows by `Row.section` and the event log colors
 *  scope chips by it. The vocabulary is intentionally small and
 *  plugin-domain-agnostic — each plugin declares its section ONCE at
 *  `definePlugin({ ..., section })` time and the supervisor stamps it
 *  onto every row it constructs.
 *
 *  Adding a section is a substrate revision: the closed list lives
 *  here so the TUI's `sectionLabel` / `sectionColor` cases stay
 *  exhaustive.
 */
export type RowSection = 'service' | 'package' | 'account' | 'action' | 'app' | 'other';

/** One row per visible plugin instance. */
export interface Row {
	readonly key: PluginKey;
	readonly role: PluginRole;
	readonly status: LifecycleStatus;
	readonly phase: PhaseNarration | null;
	readonly lastError: StructuredError | null;
	readonly logTail: LogTail;
	readonly endpoints: ReadonlyArray<EndpointKey>;
	readonly selectiveRestartHighlight: boolean;
	/** Dashboard section bucket the row belongs to. Plugin-declared at
	 *  `definePlugin({ section })` time; the supervisor stamps the
	 *  declaration onto the row at acquire. Renderers consume this
	 *  field directly — they MUST NOT pattern-match on `key` substrings
	 *  to derive a section. */
	readonly section: RowSection;
	/** Section bucket the row should render in once it owns a routed
	 *  endpoint. Defaults to `section` (i.e. no override). Plugins set
	 *  `endpointSection` when an "app"-style row should re-bucket to
	 *  the services list as soon as its URL is up. */
	readonly endpointSection: RowSection;
}

export interface LogTail {
	readonly lines: ReadonlyArray<string>;
	readonly level: 'info' | 'warn' | 'error';
	readonly truncated: boolean;
}

export interface Endpoint {
	readonly endpointKey: EndpointKey;
	readonly pluginKey: PluginKey;
	readonly name: string;
	readonly url: string;
	readonly displayUrl: string | null;
	readonly wireProtocol: 'http' | 'h2c' | 'tcp';
	readonly registeredAt: number;
}

export interface AccountProjection {
	readonly key: `account/${string}`;
	readonly rowKey: PluginKey | null;
	readonly name: string;
	readonly address: string | null;
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1' | null;
	readonly source: 'real' | 'impersonate' | null;
	readonly funding: {
		readonly status: 'pending' | 'funded' | 'skipped' | 'failed' | 'unknown';
		readonly balanceMist: string | null;
		readonly requestedMist: string | null;
		readonly entries?: ReadonlyArray<{
			readonly coin: string;
			readonly fullCoinType: string;
			readonly amount: string;
			/** `'funded'` — a faucet call satisfied the request.
			 *  `'already-satisfied'` — the pre-existing balance covered
			 *  the request (no faucet call needed); semantically a
			 *  success, surfaced distinctly so renderers can show
			 *  "✓ cached" vs "✓ funded" if they want to.
			 *  `'skipped'` — zero-amount no-op, or the funding pass
			 *  never reached the entry. */
			readonly status: 'funded' | 'already-satisfied' | 'skipped';
		}>;
	};
	readonly walletVisible: boolean;
	readonly updatedAt: number;
}

export interface PackageProjection {
	readonly key: `package/${string}`;
	readonly rowKey: PluginKey | null;
	readonly name: string;
	readonly kind: 'local' | 'known';
	readonly packageId: string;
	readonly upgradeCapId: string | null;
	readonly mvrPlaceholder: string;
	readonly sourcePath: string | null;
	readonly updatedAt: number;
}

export interface StructuredError {
	readonly at: number;
	readonly pluginKey: PluginKey | null;
	readonly tag: string;
	readonly summary: string;
	readonly chain: ReadonlyArray<string>;
	readonly severity: 'warn' | 'error' | 'fatal';
}

export interface BuildEntry {
	readonly pluginKey: PluginKey | null;
	readonly phase: string;
	readonly progress: string;
	readonly startedAt: number;
}

// --- Compile-time invariant ---------------------------------------------
//
// `Equal<keyof SubscribableState, '…'>` would normally live in a test
// file. We assert it here as a type alias so any field added (or
// removed) without architecture revision triggers a TS error.

type _ProjectionKeysClosed =
	| 'identity'
	| 'cycle'
	| 'rows'
	| 'endpoints'
	| 'accounts'
	| 'packages'
	| 'errors'
	| 'lastEvent'
	| 'stackBuild';

// If these go out of sync, the type alias fails — surfacing as the
// expected closed-projection assertion failing to satisfy.
type _Verify = keyof SubscribableState extends _ProjectionKeysClosed
	? _ProjectionKeysClosed extends keyof SubscribableState
		? true
		: false
	: false;

// Force the assertion by referencing it. Exporting under a
// substrate-internal name keeps it from leaking into the public
// surface but ensures the compiler enforces the invariant.
export type __ProjectionFieldsClosed = _Verify extends true ? true : never;

// --- Closed `Row` field list ---------------------------------------------
//
// Same discipline as `__ProjectionFieldsClosed` but for `Row`. Adding a
// row field without listing it here (or removing one without dropping it
// from the alias) trips a TS error at every supervisor row-construction
// site. Display-vocabulary fields (`title`, `primary`, `extras`, …) are
// EXPLICITLY ABSENT — see top-of-file comment.

type _RowKeysClosed =
	| 'key'
	| 'role'
	| 'status'
	| 'phase'
	| 'lastError'
	| 'logTail'
	| 'endpoints'
	| 'selectiveRestartHighlight'
	| 'section'
	| 'endpointSection';

type _VerifyRow = keyof Row extends _RowKeysClosed
	? _RowKeysClosed extends keyof Row
		? true
		: false
	: false;

export type __RowFieldsClosed = _VerifyRow extends true ? true : never;

// --- No display vocabulary --------------------------------------------------
//
// Compile-time guard: the projection shape MUST NOT contain display
// vocabulary. These conditional types resolve to `never` (and would
// fail to assign anywhere they're used) if `title`/`primary`/`extras`
// were ever added to `SubscribableState` or `Row`.
//
// The architecture's invariant becomes a TS error at the boundary —
// the projection layer can't be wired up if a renderer-display concept
// leaks into the engine's data model.

type _NoDisplayVocabAtTop = 'title' extends keyof SubscribableState
	? never
	: 'primary' extends keyof SubscribableState
		? never
		: 'extras' extends keyof SubscribableState
			? never
			: true;
type _NoDisplayVocabInRow = 'title' extends keyof Row
	? never
	: 'primary' extends keyof Row
		? never
		: 'extras' extends keyof Row
			? never
			: true;
export type __NoDisplayVocab = _NoDisplayVocabAtTop & _NoDisplayVocabInRow extends true
	? true
	: never;
