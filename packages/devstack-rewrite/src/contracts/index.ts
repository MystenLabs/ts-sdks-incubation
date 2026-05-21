// Capability contracts barrel.
//
// Nine contracts (architecture § Capability contracts):
//   1. NodePlugin              — substrate-level shape lives in
//                                 `substrate/plugin.ts`; this folder
//                                 carries the capability decls plugins
//                                 emit from acquire.
//   2. ContainerRuntime
//   3. Snapshotable
//   4. Routable
//   5. NetworkResolver
//   6. Codegenable
//   7. StrategyContributor
//   8. CompositePrimitive
//   9. ChainProbe
//
// Renderer is a sub-shape of NodePlugin and lives inline here.

export * from './capability-decl.ts';
export * from './container-runtime.ts';
export * from './snapshotable.ts';
export * from './routable.ts';
export * from './codegenable.ts';
export * from './network-resolver.ts';
export * from './chain-probe.ts';
export * from './strategy-contributor.ts';
export * from './composite-primitive.ts';
export * from './renderer.ts';
export * from './node-plugin.ts';
