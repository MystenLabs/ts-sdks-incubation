// `defaultMvrName` — pure utility lifted out of `plugins/codegen/index.ts`
// so it can be re-exported from `@mysten-incubation/devstack/react`
// without dragging the codegen plugin's Node-only deps (`node:child_
// process`, `node:fs`, `@mysten/codegen`'s emitter) into the browser
// bundle.
//
// Apps configure `codegen({ mvrName })` AND `localnetDappKitConfig({
// mvrName })` with the same mapper so the codegen output and the
// SuiClient's named-packages overrides agree on placeholder names.

/**
 * Default MVR-shape placeholder for a registry package. Move package
 * names typically use snake_case (`mock_usdc`); MVR app-name validation
 * requires kebab (`mock-usdc`). The default kebabizes and prefixes
 * `@local/`.
 */
export function defaultMvrName(pkgName: string): string {
	return `@local/${pkgName.replace(/_/g, '-')}`;
}
