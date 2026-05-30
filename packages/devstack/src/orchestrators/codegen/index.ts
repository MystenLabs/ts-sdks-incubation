// Codegen orchestrator barrel.
//
// The orchestrator is the L4 surface that turns plugin-emitted
// `Codegenable` contributions into TS source files in the user's
// `<app>/src/generated/` tree. Apps consume these files; apps NEVER
// import devstack.

export * from './errors.ts';
export * from './paths.ts';
export * from './permissions.ts';
export * from './format.ts';
export * from './emit.ts';
export * from './gitignore.ts';
export * from './manifest-bridge.ts';
export * from './bindings.ts';
export * from './service.ts';
