// The APP-SPECIFIC strict deployment type — emitted as
// `src/generated/deployment.ts`.
//
// Unlike `config-runtime.ts` (a verbatim constant string), THIS file is
// RENDERED FROM DATA: it narrows the generic `NetworkDeployment` (from
// `config-runtime.ts`) to exactly the package names + MVR placeholders the
// app declares, and enumerates the live networks the app ships from the
// `deployments/` directory filenames.
//
// Four exported types/values:
//   - `AppPackages`           — exhaustive over THIS app's declared package
//                               names.
//   - `AppNetworkDeployment`  — the per-network shape a prod author hand-
//                               writes in `deployments/<net>.ts`: a
//                               `NetworkDeployment` with `packages: AppPackages`
//                               and `mvrOverrides` requiring the declared
//                               `@local/*` placeholder keys. NO `accounts`
//                               (those ride the runtime envelope, dev-only).
//   - `ProvidedNetwork`       — a union of the LIVE network names (the
//                               `deployments/*.ts` filenames, local excluded);
//                               `never` when none.
//   - `ProvidedDeployments`   — `Partial<Record<ProvidedNetwork,
//                               AppNetworkDeployment>>`.
//   - `NETWORK_NAMES`         — a literal `as const` tuple
//                               `[<localNetworkName>, ...<deployments files>]`
//                               for dapp-kit's typed `switchNetwork` (D2).
//
// Types-only + zero runtime: on a clean clone (no `deployments/` dir) this is
// the local network alone — `ProvidedNetwork = never`, `ProvidedDeployments`
// empty — so `tsc` stays green.

/** Input the renderer derives the strict types from. All values are
 *  CONFIG-known (no chain / no live resolution): the declared package names
 *  + MVR placeholders come from the `config.ts` aggregate bucket, the local
 *  network name from the sui binding, the live network names from the
 *  `deployments/*.ts` filenames. */
export interface DeploymentStrictInput {
	/** The local (dev-stack) network name — the sui binding's `network`
	 *  field. Always the head of `NETWORK_NAMES`. */
	readonly localNetworkName: string;
	/** This app's declared package names (the `config.packages.<name>`
	 *  keys), in stable order. */
	readonly packageNames: ReadonlyArray<string>;
	/** This app's declared MVR placeholders (the `@local/<slug>` keys an app
	 *  feeds dapp-kit's `mvr.overrides.packages`), in stable order. */
	readonly mvrPlaceholders: ReadonlyArray<string>;
	/** This app's declared MVR `types` keys — fully-qualified
	 *  `@local/<slug>::<module>::<Name>` named struct tags (the @mysten MVR
	 *  `types` override surface), in stable order. Empty when the app declares
	 *  no Move datatypes. Drives `AppNetworkDeployment.mvrOverrides.types`. */
	readonly mvrTypeTags: ReadonlyArray<string>;
	/** The LIVE network names — `deployments/*.ts` filenames (sans `.ts`),
	 *  with the local network name excluded. Empty on a clean clone. */
	readonly providedNetworks: ReadonlyArray<string>;
	/** The structured SERVICE-VALUE channel: `values[namespace][key] = <tsType>`
	 *  — every generic (non-sugar) config-binding the app's service plugins
	 *  declare (deepbook ids/pools, walrus/seal endpoints, coin decimals +
	 *  full coin type, package object captures). Drives a REQUIRED `values`
	 *  shape on `AppNetworkDeployment` so a hand-written `deployments/<net>.ts`
	 *  is compile-checked for every service value. Empty for a service-less
	 *  (counter-style) app — then `values` stays optional/loose. */
	readonly serviceValues: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Output path (relative to the generated tree) of the emitted strict type. */
export const DEPLOYMENT_STRICT_OUTPUT_PATH = 'deployment.ts';

/** Render the app-specific strict deployment type from data. Pure +
 *  deterministic (stable key ordering), types-only output. */
export const renderDeploymentStrict = (input: DeploymentStrictInput): string => {
	const { localNetworkName, packageNames, mvrPlaceholders, mvrTypeTags } = input;

	// Defensive: the local network is the head of `NETWORK_NAMES` and is never a
	// committed/provided network, so drop it (and any duplicate) from
	// `providedNetworks` even if a caller passes it in. The source discovery
	// (`discoverProvidedNetworks`) already filters it, but a hand-supplied set
	// (tests, future callers) must not yield a duplicate `localnet` tuple element
	// or pollute the `ProvidedNetwork` union.
	const providedNetworks = [...new Set(input.providedNetworks)].filter(
		(n) => n !== localNetworkName,
	);

	// `AppPackages` — exhaustive over the declared package names. Each entry
	// carries `{ id; objects? }`. An app with no packages still declares the
	// interface (empty), so `AppNetworkDeployment.packages` stays a concrete
	// type.
	const packagesBody =
		packageNames.length > 0
			? packageNames
					.map(
						(name) =>
							`\treadonly ${JSON.stringify(name)}: { readonly id: string; readonly objects?: Record<string, string> };`,
					)
					.join('\n')
			: '\treadonly [packageName: string]: never;';

	// `mvrOverrides.packages` requires every declared `@local/<slug>` placeholder
	// key (resolved package id). The @mysten MVR override shape exactly:
	// `{ packages: Record<mvr, id>; types: Record<namedType, resolvedType> }`.
	const mvrPackagesBody =
		mvrPlaceholders.length > 0
			? mvrPlaceholders.map((mvr) => `\t\t\t${JSON.stringify(mvr)}: string;`).join('\n')
			: '\t\t\t// (this app declares no MVR placeholders)';
	// `mvrOverrides.types` is OPT-IN. When the app DECLARES named types, the
	// field is REQUIRED and exhaustively narrowed over the declared tags (a
	// hand-written `deployments/<net>.ts` must provide exactly those, valued by
	// the resolved `<packageId>::<module>::<Name>`), plus the permissive trailing
	// index. When NONE are declared, the field is OPTIONAL + loose so an app that
	// exposes no Move datatypes need not write a `types` block at all.
	const hasMvrTypes = mvrTypeTags.length > 0;
	const mvrTypesBody = hasMvrTypes
		? mvrTypeTags.map((tag) => `\t\t\t${JSON.stringify(tag)}: string;`).join('\n')
		: '';
	const mvrTypesField = hasMvrTypes
		? `\t\treadonly types: {\n${mvrTypesBody}\n\t\t} & { readonly [namedType: string]: string };`
		: `\t\treadonly types?: { readonly [namedType: string]: string };`;

	// The structured `values` channel — required per service namespace/key with
	// its concrete TS type, so a hand-written deployment is compile-checked for
	// every service value (deepbook/coin/seal/walrus/package-objects). A
	// service-less app contributes nothing → `values` stays optional/loose.
	const valueNamespaces = Object.keys(input.serviceValues).sort();
	const hasServiceValues = valueNamespaces.length > 0;
	const valuesBody = hasServiceValues
		? valueNamespaces
				.map((ns) => {
					const keys = Object.keys(input.serviceValues[ns]!).sort();
					const fields = keys
						.map((k) => `\t\t\t${JSON.stringify(k)}: ${input.serviceValues[ns]![k]!};`)
						.join('\n');
					return `\t\t${JSON.stringify(ns)}: {\n${fields}\n\t\t};`;
				})
				.join('\n')
		: '';

	// The emitted `values` field. With service values it is REQUIRED and
	// narrowed per namespace/key (a missing service value fails `tsc`), plus a
	// permissive trailing index so an app can carry extra namespaces. With NO
	// service values (a counter-style app) it stays OPTIONAL + loose so a
	// service-less clean clone stays `tsc`-green.
	const valuesField = hasServiceValues
		? `\treadonly values: {\n${valuesBody}\n\t} & {\n\t\treadonly [namespace: string]: { readonly [key: string]: unknown };\n\t};`
		: `\treadonly values?: NetworkDeployment['values'];`;

	// `ProvidedNetwork` — the live (committed) network union; `never` when
	// the app ships none (a clean clone with no `deployments/` dir).
	const providedUnion =
		providedNetworks.length > 0
			? providedNetworks.map((n) => JSON.stringify(n)).join(' | ')
			: 'never';

	// `NETWORK_NAMES` — `[<local>, ...<provided>]` as a literal tuple.
	const networkNamesTuple = [localNetworkName, ...providedNetworks]
		.map((n) => JSON.stringify(n))
		.join(', ');

	return `// THIS FILE IS AUTO-GENERATED BY @mysten/devstack.
// Do not edit by hand — your changes will be overwritten by the next
// \`devstack codegen\`. Apps consume codegen output; codegen output never
// imports from devstack.
//
// The APP-SPECIFIC strict deployment type. A prod author writes a
// \`deployments/<net>.ts\` that \`satisfies AppNetworkDeployment\` — the type
// is exhaustive over this app's declared packages + MVR placeholders, so a
// missing/typo'd id fails \`tsc\`. The live network set
// (\`ProvidedNetwork\` / \`NETWORK_NAMES\`) is derived from the
// \`deployments/*.ts\` filenames. Types-only — zero runtime — except the
// \`NETWORK_NAMES\` literal tuple (for dapp-kit's typed \`switchNetwork\`).

import type { NetworkDeployment } from './config-runtime.js';

/** Exhaustive over THIS app's declared package names. */
export interface AppPackages {
${packagesBody}
}

/** The per-network shape a prod author hand-writes in
 *  \`deployments/<net>.ts\`: a \`NetworkDeployment\` narrowed so \`packages\` is
 *  exhaustive over this app's packages, \`mvrOverrides\` is the @mysten MVR
 *  override surface (\`{ packages, types }\`) requiring every declared
 *  \`@local/<slug>\` placeholder + named-type tag, and \`values\` requires every
 *  service value namespace/key (when the app declares any). NO \`accounts\` —
 *  dev accounts ride the runtime envelope, never the per-network authoring
 *  surface. */
export interface AppNetworkDeployment
	extends Omit<NetworkDeployment, 'packages' | 'mvrOverrides' | 'values'> {
	readonly packages: AppPackages;
	readonly mvrOverrides: {
		readonly packages: {
${mvrPackagesBody}
		} & { readonly [mvrPlaceholder: string]: string };
${mvrTypesField}
	};
${valuesField}
}

/** The LIVE network names this app ships — the \`deployments/*.ts\` filenames
 *  (local excluded). \`never\` when the app ships no committed deployments. */
export type ProvidedNetwork = ${providedUnion};

/** The committed per-network deployments map a prod build / dev serve loads.
 *  Partial — an app need not ship every live network at once. */
export type ProvidedDeployments = Partial<Record<ProvidedNetwork, AppNetworkDeployment>>;

/** The full network-name set, local-first: \`[<local>, ...<provided>]\`.
 *  dapp-kit's \`networks\` / \`switchNetwork\` type-check against this tuple
 *  (D2). */
export const NETWORK_NAMES = [${networkNamesTuple}] as const;
`;
};
