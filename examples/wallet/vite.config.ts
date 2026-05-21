import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';

import { WALLET_DEV_SERVER_PORT } from './dev-origin.ts';

export default defineDevstackViteConfig({ port: WALLET_DEV_SERVER_PORT });
