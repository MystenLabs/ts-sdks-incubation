// Typed mirror of devstack's serialized `SubscribableState` projection.
//
// The dashboard GraphQL API exposes these as real object types; this module is
// the single client-side source of truth for their shapes. Field names and
// unions track `packages/devstack/src/substrate/projection.ts` exactly — keep
// them in sync (the schema SDL under `schema.graphql` is the contract).

export type LifecycleStatus =
	| 'pending'
	| 'acquiring'
	| 'ready'
	| 'failed'
	| 'stopping'
	| 'stopped'
	| 'done';

export type PluginRole = 'service' | 'task';

export type RowSection = 'service' | 'package' | 'account' | 'action' | 'app' | 'other';

export type CyclePhase = 'booting' | 'running' | 'restarting' | 'shutting-down';

export type WireProtocol = 'http' | 'h2c' | 'tcp';

export type LogLevel = 'info' | 'warn' | 'error';

export type ErrorSeverity = 'warn' | 'error' | 'fatal';

export type AccountScheme = 'ed25519' | 'secp256k1' | 'secp256r1';

export type AccountSource = 'real' | 'impersonate';

export type FundingStatus = 'pending' | 'funded' | 'skipped' | 'failed' | 'unknown';

export type FundingEntryStatus = 'funded' | 'already-satisfied' | 'skipped';

export interface Identity {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
}

export interface Cycle {
	readonly id: number;
	readonly startedAt: number;
	readonly phase: CyclePhase;
}

export interface Endpoint {
	readonly endpointKey: string;
	readonly pluginKey: string;
	readonly name: string;
	readonly url: string;
	readonly displayUrl: string | null;
	readonly wireProtocol: WireProtocol;
	readonly registeredAt: number;
}

export interface LogTail {
	readonly lines: ReadonlyArray<string>;
	readonly level: LogLevel;
	readonly truncated: boolean;
}

export interface StructuredError {
	readonly at: number;
	readonly pluginKey: string | null;
	readonly tag: string;
	readonly summary: string;
	readonly chain: ReadonlyArray<string>;
	readonly severity: ErrorSeverity;
}

export interface Row {
	readonly key: string;
	readonly role: PluginRole;
	readonly status: LifecycleStatus;
	readonly phase: string | null;
	readonly lastError: StructuredError | null;
	readonly logTail: LogTail;
	readonly endpoints: ReadonlyArray<string>;
	readonly selectiveRestartHighlight: boolean;
	readonly section: RowSection;
	readonly endpointSection: RowSection;
}

export interface FundingEntry {
	readonly coin: string;
	readonly fullCoinType: string;
	readonly amount: string;
	readonly status: FundingEntryStatus;
}

export interface AccountFunding {
	readonly status: FundingStatus;
	readonly balanceMist: string | null;
	readonly requestedMist: string | null;
	readonly entries: ReadonlyArray<FundingEntry>;
}

export interface AccountProjection {
	readonly key: string;
	readonly rowKey: string | null;
	readonly name: string;
	readonly address: string | null;
	readonly scheme: AccountScheme | null;
	readonly source: AccountSource | null;
	readonly funding: AccountFunding;
	readonly walletVisible: boolean;
	readonly updatedAt: number;
}

export interface PackageProjection {
	readonly key: string;
	readonly rowKey: string | null;
	readonly name: string;
	readonly kind: 'local' | 'known';
	readonly packageId: string;
	readonly upgradeCapId: string | null;
	readonly mvrPlaceholder: string;
	readonly sourcePath: string | null;
	readonly updatedAt: number;
}

export interface BuildEntry {
	readonly pluginKey: string | null;
	readonly phase: string;
	readonly progress: string;
	readonly startedAt: number;
}

export interface Projection {
	readonly identity: Identity;
	readonly cycle: Cycle;
	readonly rows: ReadonlyArray<Row>;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly accounts: ReadonlyArray<AccountProjection>;
	readonly packages: ReadonlyArray<PackageProjection>;
	readonly errors: ReadonlyArray<StructuredError>;
	readonly lastEvent: { readonly seq: number; readonly at: number } | null;
	readonly stackBuild: ReadonlyArray<BuildEntry>;
}

/** Closed ordering for section grouping in the UI. */
export const SECTION_ORDER: ReadonlyArray<RowSection> = [
	'service',
	'package',
	'account',
	'action',
	'app',
	'other',
];
