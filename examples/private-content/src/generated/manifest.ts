// Re-exports the devstack-emitted manifest from the Vite virtual module
// `virtual:devstack-manifest`. The real values live in
// `.devstack/stacks/<active>/manifest.json` written by `devstack up`; the plugin
// in `@mysten-incubation/devstack/vite` reads that file at dev/build time and
// falls back to a typed empty manifest before first bring-up.

export { manifest, type Manifest } from 'virtual:devstack-manifest';
