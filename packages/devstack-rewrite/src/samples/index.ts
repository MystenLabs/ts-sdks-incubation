// Sample plugins barrel.
//
// Generic-named demonstrations of the user-facing API surface — used
// by `examples-test/` to prove the substrate surface in isolation from
// any real L2 service. The real plugins live under `src/plugins/`.

export * from './trivial-leaf-plugin.ts';
export * from './composite-plugin.ts';
