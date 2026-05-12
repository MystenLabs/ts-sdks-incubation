import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `manageStack: false` so the webServer's `pnpm dev` (which runs the
// devstack-next supervisor) owns stack bring-up — keeps a single
// supervisor in the loop instead of forking a separate apply pass
// against the legacy CLI which doesn't know how to load the new
// `devstack.config.ts` shape.
export default await defineDevstackPlaywrightConfig({ port: 5180 });
