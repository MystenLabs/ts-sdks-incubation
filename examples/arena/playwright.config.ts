import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default await defineDevstackPlaywrightConfig({ port: 5176, manageStack: true });
