// CapabilitySinks — kind→sink registry barrel.
//
// Architecture § Substrate name-blindness (STYLE_GUIDE Open slot O6):
// inverts the supervisor's hardcoded contract-name switch into a
// substrate-owned registry. Plugin authors extend by composing a
// Layer that yields `CapabilitySinksService` and calls
// `registerSink({ kind, accept })`.

export * from './service.ts';
export * from './layer.ts';
