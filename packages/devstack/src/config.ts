import type { DevstackConfig, Producer } from './engine/types.js';

// `defineDevstackConfig` is the typed entrypoint for an app's devstack
// definition. It's a typed identity — there's no runtime work — but it
// gives editors a single named factory to pivot on for `Go to definition`,
// JSDoc completions, and auto-imports.
//
//   defineDevstackConfig({
//     stack: [
//       sui.create({ network: 'localnet' }),
//       manifest({ packages: [token.get('package')] }),
//     ],
//   });
//
// The engine deduplicates producers by `__id` and pulls in transitive
// upstreams via Dep back-references, so the array only needs to list the
// leaf consumers.
export function defineDevstackConfig(config: { stack: Producer<any, any>[] }): DevstackConfig {
	return { stack: [...config.stack] };
}
