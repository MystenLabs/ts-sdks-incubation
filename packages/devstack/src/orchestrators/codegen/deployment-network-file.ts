// The typed per-network deployment file `dump-deployment --network <net>`
// emits — a committed `deployments/<net>.ts` a prod build / dev serve loads.
//
// Unlike the boot-written `deployment.json` (the untyped multi-network
// ENVELOPE), this is the SINGLE-network, hand-editable, type-checked authoring
// surface: `export const deployment = {…} satisfies AppNetworkDeployment`. The
// `satisfies` ties it to the app's strict generated `deployment.ts`, so a
// missing/typo'd package id or MVR placeholder fails `tsc` against the app's
// own `AppNetworkDeployment`.
//
// Sourced from one `networks.<net>` entry of the resolved envelope (the same
// data `assembleDeployment` produces). The dev-only `accounts` are NOT part of
// a `NetworkDeployment` (they live on the envelope), so they never appear here;
// the `local` marker (a dev-stack flag) is also dropped — a committed
// deployment is non-local by definition.
//
// This file is COMMITTED (not under `generated/`), so unlike the codegen
// renderer (`format.ts`, double-quoted JSON literals in a prettier-IGNORED
// tree) the output must be prettier-clean: SINGLE-quoted strings, tab indent,
// trailing commas, sorted keys. A prettier-on-write hook is then a no-op.

import type { NetworkDeployment } from './deployment.ts';
import { CodegenRenderError } from './errors.ts';

/** Canonical directory (relative to the project root) committed per-network
 *  deployments live under — the convention the Vite plugin auto-discovers. */
export const DEPLOYMENTS_DIRNAME = 'deployments';

/** The header every emitted `deployments/<net>.ts` carries. Hand-editable —
 *  this is an authoring surface — so it is NOT marked auto-generated. */
const HEADER = [
	'// Committed per-network deployment for a real-network deploy.',
	'//',
	'// Emitted by `devstack dump-deployment --network <net>` from a resolved',
	'// stack, then committed. Hand-editable: the `satisfies AppNetworkDeployment`',
	'// type-checks it against this app declared packages + MVR placeholders, so a',
	'// missing or mistyped id fails `tsc`. No dev `accounts` (those ride the',
	'// runtime envelope, never the committed authoring surface).',
].join('\n');

const INDENT = '\t';
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A single-quoted TS string literal (prettier `singleQuote: true`). Falls
 *  back to a double-quoted literal only when the value itself contains a
 *  single quote but no double quote (prettier's own preference), else escapes
 *  within single quotes. */
const quote = (s: string): string => {
	if (!s.includes("'")) return `'${s.replace(/\\/g, '\\\\')}'`;
	if (!s.includes('"')) return `"${s.replace(/\\/g, '\\\\')}"`;
	return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

const key = (k: string): string => (IDENT_RE.test(k) ? k : quote(k));

/** Render a JSON value to a prettier-compatible, SINGLE-quoted TS literal at
 *  the given indent `depth`. The deployment value space is exactly JSON
 *  (strings/numbers/booleans/null/arrays/objects), so no function/bigint/
 *  symbol handling is needed. */
const renderValue = (value: unknown, depth: number): string => {
	if (value === null) return 'null';
	const t = typeof value;
	if (t === 'string') return quote(value as string);
	if (t === 'number' || t === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const inner = value.map((v) => INDENT.repeat(depth) + renderValue(v, depth + 1)).join(',\n');
		return `[\n${inner},\n${INDENT.repeat(depth - 1)}]`;
	}
	if (t === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		if (keys.length === 0) return '{}';
		const lines = keys
			.map((k) => `${INDENT.repeat(depth)}${key(k)}: ${renderValue(obj[k], depth + 1)}`)
			.join(',\n');
		return `{\n${lines},\n${INDENT.repeat(depth - 1)}}`;
	}
	// `undefined` / symbol / function — not JSON. The deployment schema admits
	// only JSON, so this is unreachable for a schema-decoded unit; throw rather
	// than emit a broken file.
	throw new CodegenRenderError({
		emitterName: 'dump-deployment',
		outputPath: `${DEPLOYMENTS_DIRNAME}/<net>.ts`,
		detail: `value of type ${t} is not JSON-serialisable`,
	});
};

/** The ordered, JSON-ish object the file body renders. Built explicitly (NOT a
 *  spread of the decoded unit) so the field order is stable and the dev-only
 *  `local` marker is dropped. Optional connection diagnostics are omitted when
 *  absent. `accounts` is structurally absent from `NetworkDeployment`, so it
 *  can never leak in. */
const deploymentBody = (network: string, unit: NetworkDeployment): Record<string, unknown> => {
	const body: Record<string, unknown> = { network, rpc: unit.rpc };
	if (unit.chainId !== undefined) body.chainId = unit.chainId;
	if (unit.faucet !== undefined) body.faucet = unit.faucet;
	if (unit.graphql !== undefined) body.graphql = unit.graphql;
	body.packages = unit.packages;
	body.mvrOverrides = unit.mvrOverrides;
	if (unit.values !== undefined) body.values = unit.values;
	return body;
};

/** Result of rendering — discriminated so the caller dispatches on `ok`
 *  without `instanceof` (STYLE_GUIDE §2). */
export type NetworkFileRenderResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly error: CodegenRenderError };

/**
 * Render a typed `deployments/<net>.ts` for `network` from its resolved
 * `NetworkDeployment` unit.
 *
 * `importPath` is the module specifier the emitted `import type` points at —
 * the app's generated `deployment.js` relative to the `deployments/` dir
 * (default `../src/generated/deployment.js`). Output is prettier-compatible
 * (tab indent, single quotes, trailing commas) so a prettier-on-write hook is
 * a no-op.
 */
export const renderNetworkDeploymentFile = (
	network: string,
	unit: NetworkDeployment,
	importPath = '../src/generated/deployment.js',
): NetworkFileRenderResult => {
	try {
		const body = renderValue(deploymentBody(network, unit), 1);
		const text = `${HEADER}

import type { AppNetworkDeployment } from ${quote(importPath)};

export const deployment = ${body} satisfies AppNetworkDeployment;
`;
		return { ok: true, text };
	} catch (cause) {
		if (cause instanceof CodegenRenderError) return { ok: false, error: cause };
		return {
			ok: false,
			error: new CodegenRenderError({
				emitterName: 'dump-deployment',
				outputPath: `${DEPLOYMENTS_DIRNAME}/${network}.ts`,
				detail: 'failed to render network deployment file',
				cause,
			}),
		};
	}
};
