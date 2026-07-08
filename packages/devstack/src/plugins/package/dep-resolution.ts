// Move-dep helpers.
//
// `mvrSlugify` normalises a package name into the slug shape that
// devstack uses for its default local MVR placeholders.
// Distilled doc Invariant 13: the result MUST satisfy `[a-z0-9-]+`
// (downstream validators reject underscores).

import { isValidNamedPackage } from '@mysten/sui/utils';

/**
 * Slugify a package name into the bare slug shape (`[a-z0-9-]+`).
 *
 * This bare slug is what codegen writes into Move-source file stems /
 * the dead `package/<slug>.ts` output path, and is the `{app}`
 * component of the MVR named form (`mvrNamedForm` below).
 */
export const mvrSlugify = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');

/**
 * Local-org used for the MVR named form devstack emits as the binding
 * package default + `config.packages.<name>.mvr`. It is syntactically
 * valid per `@mysten/sui`'s `isValidSuiNSName` (it contains `@`), so
 * the resulting `@local/<slug>` passes BOTH `hasMvrName` and
 * `isValidNamedPackage`. Resolution never hits a real registry — the
 * dapp-kit/`MvrClient` override map keys on this exact string and
 * short-circuits to the active network's resolved package id.
 */
const MVR_LOCAL_ORG = '@local';

/**
 * Build the MVR NAMED form (`@local/<slug>`) from a package name.
 *
 * This is the value emitted as BOTH the generated-binding package
 * default (`options.package ?? '@local/<slug>'`) AND
 * `config.packages.<name>.mvr` — the two MUST match so a dapp can key
 * an `MvrClient` override on `config.mvr` and have generated functions
 * resolve by name alone. Verified to satisfy `isValidNamedPackage` and
 * `hasMvrName` (see `test/plugins/package/mvr-named-form.test.ts`).
 */
export const mvrNamedForm = (name: string): string => `${MVR_LOCAL_ORG}/${mvrSlugify(name)}`;

/** Normalize the user-facing `mvrPlaceholder` option.
 *
 * Devstack's default remains `@local/<slug>`, derived from the package's
 * symbolic name. An explicit override is different: it is already a full
 * MVR named package (`@org/package`) and must be preserved verbatim so it
 * matches `@mysten/codegen`'s documented `@local-pkg/counter` style.
 */
export const normalizeMvrPlaceholder = (
	packageName: string,
	placeholder: string | undefined,
): string => {
	if (placeholder === undefined) return mvrNamedForm(packageName);
	if (isValidNamedPackage(placeholder)) return placeholder;
	throw new Error(
		`package '${packageName}' mvrPlaceholder '${placeholder}' is not a valid MVR named package; ` +
			`use a full name like '@local/${mvrSlugify(packageName)}' or '@local-pkg/${mvrSlugify(packageName)}'.`,
	);
};

/**
 * Coerce a (possibly STALE) persisted MVR placeholder into a valid named
 * package form.
 *
 * The package-publish cache (`projection.v4.json`'s `mvrPlaceholder`)
 * persists whatever placeholder shape was current at publish time. A
 * stack created BEFORE the `mvrSlugify`→`mvrNamedForm` change carries a
 * BARE slug (e.g. `'vault'`), which an INCREMENTAL re-apply would
 * otherwise emit verbatim — and a bare slug fails `hasMvrName`, so the
 * generated binding's `package:` default never resolves through the
 * `MvrClient` override map. We MUST always emit the named form.
 *
 * `mvrNamedForm` is not idempotent over an already-named string
 * (`mvrSlugify('@local/vault')` → `'local-vault'`), so we cannot blindly
 * re-wrap. Instead, preserve anything the SDK accepts as a full MVR named
 * package and wrap only legacy bare names.
 *
 * Pure + deterministic over its input, so recomputing at the emit seam is
 * always safe and always current regardless of cached projection state.
 */
export const mvrNamedFormFrom = (placeholder: string): string =>
	isValidNamedPackage(placeholder) ? placeholder : mvrNamedForm(placeholder);
