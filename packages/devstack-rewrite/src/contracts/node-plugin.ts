// Node plugin contract — surface re-export.
//
// The substrate-level `StackMember` shape (`substrate/plugin.ts`) is
// the universal plugin contract; this file re-exports it under the
// `NodePlugin` name that matches the architecture's vocabulary.

export type { AnyMember as AnyNodePlugin, StackMember as NodePlugin } from '../substrate/plugin.ts';
