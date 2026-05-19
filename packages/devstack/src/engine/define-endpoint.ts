// `defineEndpoint` — single source of truth for every externally-
// addressable URL devstack publishes. One declaration carries enough
// data for three downstream consumers:
//
//   1. `EndpointName` — the string constant a primitive passes to
//      `publishEndpoint({name, url})`.
//   2. `CONVENTIONAL_ROUTES` — the `{service, port}` pair that drives
//      cold-start fallback URLs (playwright's `webServer({endpoint})`
//      resolves at config-load time, BEFORE a manifest exists on disk).
//   3. `MANIFEST_FIELD` — the location inside the manifest the
//      grouper projects the endpoint into. The manifest grouper in
//      `runtime/service.ts` walks this metadata instead of carrying a
//      separate hand-maintained SUI_FIELDS map alongside the Walrus /
//      Seal / App finds.
//
// Adding a new endpoint becomes one declaration:
//
// ```ts
// export const POSTGRES = defineEndpoint({
//   name: 'postgres',
//   conventional: { service: 'postgres', port: 5432 },
//   manifestField: { in: 'services.postgres.endpoint' },
// });
// ```
//
// `EndpointName.POSTGRES` is the declaration's `.name`; the
// conventional-route + manifest-field tables are derived from the
// registry of declarations rather than maintained in three files.

/** Location inside the manifest a flat `EndpointRegistry` record
 *  projects into. The grouper in `runtime/service.ts` reads this
 *  metadata; declarations with `manifestField: undefined` are flat-only
 *  (the endpoint surfaces in `gatherManifest`'s endpoint snapshot but
 *  not under `services.*` / `app.*`). */
export interface ManifestFieldLocation {
	/** Dotted path inside the manifest the endpoint surfaces at, e.g.
	 *  `'services.sui.rpc'` or `'app.dev'`. Used by groupers + tests
	 *  asserting the structured projection lands where consumers
	 *  expect. */
	readonly path: string;
}

/** Conventional-route pair — service name (becomes the `<service>`
 *  segment of `<stack>.<service>.<app>.localhost`) and host port
 *  (matches traefik's entrypoint port). Drives cold-start URL
 *  resolution when a manifest doesn't exist on disk yet. */
export interface ConventionalRoute {
	readonly service: string;
	readonly port: number;
}

/** One endpoint declaration. The `name` is the string constant
 *  primitives pass to `publishEndpoint({name, url})`; downstream
 *  consumers read it back via `EndpointName.X`. */
export interface EndpointDeclaration {
	readonly name: string;
	readonly conventional?: ConventionalRoute;
	readonly manifestField?: ManifestFieldLocation;
	/** Short prose surfacing in `playwright/web-server.ts`'s error
	 *  output ("no endpoint 'X' in manifest"). Optional — when present,
	 *  it points the user at the factory that's supposed to publish. */
	readonly publishedBy?: string;
}

const declarations = new Map<string, EndpointDeclaration>();

/** Declare an endpoint. Registers it into the lookup tables read by the
 *  conventional-route map + the manifest grouper. Idempotent on the
 *  `name` (re-declaring the same name overwrites — this is how tests +
 *  fork variants of a service can re-stamp the metadata). */
export const defineEndpoint = <D extends EndpointDeclaration>(decl: D): D => {
	declarations.set(decl.name, decl);
	return decl;
};

/** Look up the declaration for a given endpoint name. `undefined` for
 *  ad-hoc endpoints published without a `defineEndpoint(...)` call. */
export const findEndpointDeclaration = (name: string): EndpointDeclaration | undefined =>
	declarations.get(name);

/** All declarations registered so far. Snapshot — callers shouldn't
 *  rely on stable order between platform releases. Used by the
 *  conventional-route derivation in `runtime/conventional-routes.ts`
 *  and the grouper introspection in `runtime/service.ts`. */
export const listEndpointDeclarations = (): ReadonlyArray<EndpointDeclaration> =>
	Array.from(declarations.values());
