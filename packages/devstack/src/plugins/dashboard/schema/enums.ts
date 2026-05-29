// Pothos enums mirroring the closed unions in projection.ts / lifecycle.ts.
//
// Each `values` array is the EXACT string union from the source type — if
// a substrate union gains a member, the corresponding `satisfies` below
// stops compiling until this list is updated. That keeps the GraphQL
// vocabulary in lockstep with the projection vocabulary.

import { builder } from './builder.ts';
import type {
	LifecycleStatus as LifecycleStatusUnion,
	PluginRole as PluginRoleUnion,
} from '../../../substrate/lifecycle.ts';
import type {
	AccountProjection,
	Endpoint,
	LogTail,
	PackageProjection,
	RowSection as RowSectionUnion,
	StructuredError,
} from '../../../substrate/projection.ts';

// NOTE: CyclePhase ('shutting-down') and FundingEntryStatus ('already-satisfied')
// are intentionally NOT GraphQL enums — their values contain hyphens, which are
// illegal in GraphQL enum value names. Those fields are exposed as String (the
// raw union string is the wire contract). See schema/types.ts.
type WireProtocol = Endpoint['wireProtocol'];
type LogLevel = LogTail['level'];
type ErrorSeverity = StructuredError['severity'];
type AccountScheme = NonNullable<AccountProjection['scheme']>;
type AccountSource = NonNullable<AccountProjection['source']>;
type FundingStatus = AccountProjection['funding']['status'];
type PackageKind = PackageProjection['kind'];

/** Derived health classification for a single service row + the stack. */
export type Health = 'ready' | 'active' | 'blocked' | 'empty';

export const LifecycleStatus = builder.enumType('LifecycleStatus', {
	values: [
		'pending',
		'acquiring',
		'ready',
		'failed',
		'stopping',
		'stopped',
		'done',
	] satisfies LifecycleStatusUnion[],
});

export const PluginRole = builder.enumType('PluginRole', {
	values: ['service', 'task'] satisfies PluginRoleUnion[],
});

export const RowSection = builder.enumType('RowSection', {
	values: ['service', 'package', 'account', 'action', 'app', 'other'] satisfies RowSectionUnion[],
});

export const WireProtocol = builder.enumType('WireProtocol', {
	values: ['http', 'h2c', 'tcp'] satisfies WireProtocol[],
});

export const LogLevel = builder.enumType('LogLevel', {
	values: ['info', 'warn', 'error'] satisfies LogLevel[],
});

export const ErrorSeverity = builder.enumType('ErrorSeverity', {
	values: ['warn', 'error', 'fatal'] satisfies ErrorSeverity[],
});

export const AccountScheme = builder.enumType('AccountScheme', {
	values: ['ed25519', 'secp256k1', 'secp256r1'] satisfies AccountScheme[],
});

export const AccountSource = builder.enumType('AccountSource', {
	values: ['real', 'impersonate'] satisfies AccountSource[],
});

export const FundingStatus = builder.enumType('FundingStatus', {
	values: ['pending', 'funded', 'skipped', 'failed', 'unknown'] satisfies FundingStatus[],
});

export const PackageKind = builder.enumType('PackageKind', {
	values: ['local', 'known'] satisfies PackageKind[],
});

export const Health = builder.enumType('Health', {
	values: ['ready', 'active', 'blocked', 'empty'] satisfies Health[],
});

// --- Plugin-domain enums (control-plane `domain` surface) ------------------
//
// These mirror the closed unions on the control-plane domain shapes. They
// carry no hyphenated members EXCEPT seal's `fork-known` / `local-keygen`,
// which would be illegal GraphQL enum names — so SealMode is exposed as a
// raw String field (see schema/types.ts), NOT an enum.

/** Fork-vs-local stack mode (advance-clock gating). Derived from the sui
 *  plugin's resolved mode; `local-rpc` collapses to `local`. */
export const StackMode = builder.enumType('StackMode', {
	values: ['fork', 'local', 'live'] as const,
});

/** DeepBook deployment mode. */
export const DeepbookMode = builder.enumType('DeepbookMode', {
	values: ['local', 'override', 'known'] as const,
});

// NOTE: CoinSource ('on-chain') and SealMode ('local-keygen' / 'fork-known')
// are intentionally NOT GraphQL enums — their values contain hyphens, which
// are illegal in GraphQL enum value names. Those fields are exposed as String
// (the raw union string is the wire contract). See schema/types.ts.
