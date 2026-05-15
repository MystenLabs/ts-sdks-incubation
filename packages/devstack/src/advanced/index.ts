// `@mysten-incubation/devstack/advanced` — escape hatch surface for
// plugin authors and Effect-native consumers who need to drop down
// below the high-level Ref factories.
//
// Three groups, in increasing distance from the common path:
//
// 1. **Tag primitives** (`tag`, `provide`, `composeTag`,
//    `composeLayers`, `setPhase`, plus `Ref` / `TagIdentity`
//    types). The substrate every built-in factory uses; reach here if
//    you're writing a custom factory that returns its own Ref.
// 2. **Plugin-author helpers** (`dockerImage`, `gitFetch`, `hostScript`,
//    `dockerOneShot`). Convenience builders for the common shapes a
//    custom service factory will need (docker image build, git fetch,
//    host-side script invocation).
// 3. **Lower-level process / container primitives** (`HostProcess`,
//    `DockerContainer`) — moved here from the `services/` tier because
//    the typical user reaches for `Dev(...)` or `Wallet(...)` instead.
//    Available for one-off custom processes that don't fit a higher-
//    level slot.

export * from './tag.js';
export * from './plugin-author/index.js';
