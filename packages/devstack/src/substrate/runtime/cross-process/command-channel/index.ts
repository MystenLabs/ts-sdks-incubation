// Cross-process command channel — barrel.
//
// Architecture § Cross-process safety protocol § Command channel.
// Filesystem-backed bidirectional pub/sub between CLI / TUI /
// programmable API and a running supervisor.

export * from './protocol.ts';
export * from './file-channel.ts';
export * from './channel.ts';
export * from './runtime-control-lock.ts';
