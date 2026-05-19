import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `pnpm dev` (the devstack supervisor) owns stack bring-up + writes the
// manifest. Fork-mode boot adds ~30–60s on top of localnet for the
// upstream system-state warm — the supervisor's own readyTimeoutMs
// covers that, and playwright's 300s default webServer timeout is
// already generous enough.
export default defineDevstackPlaywrightConfig();
