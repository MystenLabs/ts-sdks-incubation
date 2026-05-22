import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

import { WALLET_DEV_SERVER_PORT } from './dev-origin.ts';

export default defineDevstackViteConfig({
	port: WALLET_DEV_SERVER_PORT,
	plugins: [react(), tailwindcss()],
});
