import { defineDevstackViteConfig } from '@mysten-incubation/devstack-rewrite/vite';

import { WALLET_REWRITE_DEV_SERVER_PORT } from './dev-origin.ts';

export default defineDevstackViteConfig({ port: WALLET_REWRITE_DEV_SERVER_PORT });
