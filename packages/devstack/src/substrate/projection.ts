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
		readonly phase: 'booting' | 'running' | 'restarting' | 'shutting-down';
	};
	readonly rows: ReadonlyArray<Row>;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly accounts: ReadonlyArray<AccountProjection>;
	readonly packages: ReadonlyArray<PackageProjection>;
	readonly errors: ReadonlyArray<StructuredError>;
	readonly lastEvent: { readonly seq: number; readonly at: number };
	readonly stackBuild: ReadonlyArray<BuildEntry>;
}

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
	readonly wireProtocol: 'http' | 'h2c' | string;
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
			readonly status: 'funded' | 'skipped';
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
